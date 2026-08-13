import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { pinyin } from 'pinyin-pro';
import { createSourceAdapters, loadSourceCatalog, sourceAdapterRevisions } from './source-adapters.mjs';
import { CatalogReverseGeocoder } from './catalog-reverse-geocoder.mjs';
import { isCountryDue, planCountryShards } from './country-plan.mjs';
import { ADDRESS_IMPORT_REVISION, PostgresAddressImporter } from './postgres-address-importer.mjs';
import { refreshResidentialCoverage } from '../database/residential-coverage.mjs';
import { PostgresCountryStateStore } from './postgres-country-state.mjs';
import {
  assertStorageBudget,
  DEFAULT_HARD_LIMIT_BYTES,
  DEFAULT_SOFT_LIMIT_BYTES,
  measureStorageBytes
} from './storage-budget.mjs';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';
import { matchesCustomBlacklist } from '../lib/custom-blacklist.mjs';
import { ADDRESS_POLICY_DEFAULTS, getRuntimePolicy, loadImportPolicy } from './address-policy.mjs';
import { normalizeAddressFacts } from '../../src/domain/address-quality.mjs';

const syncRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultCacheDir = resolve(syncRoot, '../../.data-cache/address-sync');

const nativeLanguage = {
  US: 'en', CA: 'en', MX: 'es', GB: 'en', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl',
  RU: 'ru', CN: 'zh-CN', HK: 'zh-HK', TW: 'zh-TW', JP: 'ja', SG: 'en', KR: 'ko', VN: 'vi',
  TH: 'th', PH: 'fil', MY: 'ms', SA: 'ar', IN: 'hi', AU: 'en', TR: 'tr', BR: 'pt-BR', NG: 'en', ZA: 'en'
};
const residentialBuildings = new Set(['apartments', 'bungalow', 'cabin', 'detached', 'dormitory', 'ger', 'house', 'residential', 'semidetached_house', 'terrace']);

const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const finiteCoordinate = (value, minimum, maximum) => Number.isFinite(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
const integer = (value, fallback, minimum = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
};
const boolean = (value, fallback = false) => value === undefined ? fallback : /^(1|true|yes)$/iu.test(String(value));
const sourceQualityFailureSignature = (shard, discovery, policy) => {
  const buildingAssets = Array.isArray(discovery.buildingAssets) ? discovery.buildingAssets.length : 0;
  const residentialBuildingAvailable = discovery.residentialBuildingAvailable
    ?? (discovery.adapter === 'geofabrik' || buildingAssets > 0);
  const policyInputs = {
    targetCount: policy.targetCount,
    levelLimits: policy.levelLimits,
    overrides: [...(policy.overrides || new Map())].sort(([left], [right]) => left.localeCompare(right)),
    floors: {
      level1Min: Number(policy.level1Min) || 0,
      level2Min: Number(policy.level2Min) || 0,
      minPerNode: Number(policy.minPerNode) || 0,
      nodes: [...(policy.nodeFloors || new Map())].sort(([left], [right]) => left.localeCompare(right))
    },
    qualityGate: shard.qualityGate || {}
  };
  return [
    shard.id,
    discovery.adapter,
    sourceAdapterRevisions[discovery.adapter] || 'external',
    discovery.version,
    `residential-buildings=${Number(Boolean(residentialBuildingAvailable))}`,
    `building-assets=${buildingAssets}`,
    `import=${ADDRESS_IMPORT_REVISION}`,
    `policy=${JSON.stringify(policyInputs)}`
  ].join(':');
};

export const mapConcurrent = async (values, concurrency, worker) => {
  const output = new Array(values.length);
  let cursor = 0;
  const count = Math.min(values.length, Math.max(1, integer(concurrency, 1)));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(values[index], index);
    }
  }));
  return output;
};

export const formattedAddress = (components, countryCode) => [
  [components.houseNumber, components.street].filter(Boolean).join(' '),
  components.buildingName,
  components.unit,
  components.district,
  components.locality,
  components.admin1,
  countryCode === 'CN' ? '' : components.postcode,
  countryCode
].filter(Boolean).join(', ');

const displayNames = {
  en: new Intl.DisplayNames(['en'], { type: 'region' }),
  zh: new Intl.DisplayNames(['zh-CN'], { type: 'region' })
};
export const localizedFields = ['admin1', 'locality', 'postalLocality', 'district', 'street', 'buildingName', 'unit'];
const nonLatinScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Thai}\p{Script=Cyrillic}]/u;
const han = /\p{Script=Han}/u;
const letters = /\p{L}/u;
const toSimplified = createSimplifier({ from: 'hk', to: 'cn' });
const usableTranslation = (value, target) => {
  const translated = clean(value);
  if (!translated) return false;
  if (target === 'en') return !nonLatinScript.test(translated);
  if (target === 'zh-CN') return !letters.test(translated) || han.test(translated);
  return true;
};

const hongKongBilingualComponent = (value) => {
  const source = clean(value);
  if (!/[\p{Script=Han}]/u.test(source) || !/[A-Za-z]/u.test(source)) return null;
  const native = clean(source.replace(/[A-Za-z][A-Za-z0-9 .,'’()\/-]*/gu, ' '));
  const en = clean(source.replace(/[\p{Script=Han}]+/gu, ' ').replace(/[，。；：、]/gu, ' '));
  return native && en ? { native, en } : null;
};

export const localizedFormattedAddress = (components, countryCode, language) => {
  const values = language === 'zh-CN'
    ? [displayNames.zh.of(countryCode), components.admin1, components.locality, components.postalLocality,
      components.district, components.street, components.houseNumber, components.buildingName,
      components.unit,
      countryCode === 'CN' ? '' : components.postcode]
    : [[components.houseNumber, components.street].filter(Boolean).join(' '), components.buildingName,
      components.unit,
      components.district, components.postalLocality || components.locality, components.admin1,
      countryCode === 'CN' ? '' : components.postcode, displayNames.en.of(countryCode)];
  return values.filter(Boolean).filter((value, index, all) => index === 0 || value !== all[index - 1])
    .join(language === 'zh-CN' ? '' : ', ');
};

const fillTranslations = (values, translations) => new Map(values.map((value, index) => [value, translations[index]]));
const withEnglishHints = (record, components) => ({ ...components, ...(record.englishComponentHints || {}) });
const withChineseHints = (record, components) => ({ ...components, ...(record.chineseComponentHints || {}) });

const chinaSuffixes = {
  admin1: [['自治区', 'Autonomous Region'], ['特别行政区', 'Special Administrative Region'], ['省', 'Province'], ['市', 'Municipality']],
  locality: [['自治州', 'Autonomous Prefecture'], ['地区', 'Prefecture'], ['市', 'City'], ['区', 'District'], ['县', 'County']],
  postalLocality: [['自治州', 'Autonomous Prefecture'], ['地区', 'Prefecture'], ['市', 'City'], ['区', 'District'], ['县', 'County']],
  district: [['自治县', 'Autonomous County'], ['新区', 'New Area'], ['区', 'District'], ['县', 'County'], ['镇', 'Town']],
  street: [['大道', 'Avenue'], ['大街', 'Street'], ['公路', 'Highway'], ['街', 'Street'], ['路', 'Road'], ['巷', 'Lane']]
};
const romanizeChineseName = (value) => pinyin(toSimplified(clean(value)), {
  toneType: 'none', type: 'array', nonZh: 'consecutive'
}).map((part) => part.trim()).filter(Boolean).join('')
  .replace(/^\p{Ll}/u, (initial) => initial.toLocaleUpperCase('en'));
const romanizeChinese = (field, value) => {
  const source = toSimplified(clean(value));
  const suffix = chinaSuffixes[field]?.find(([candidate]) => source.endsWith(candidate));
  return suffix ? [romanizeChineseName(source.slice(0, -suffix[0].length)), suffix[1]].filter(Boolean).join(' ') : romanizeChineseName(source);
};

const deferredLocalizations = (record) => {
  const native = { ...record.components };
  const english = withEnglishHints(record, ['CN', 'HK', 'TW'].includes(record.countryCode)
    ? Object.fromEntries(Object.entries(native).map(([field, value]) => [
      field,
      localizedFields.includes(field) && value ? romanizeChinese(field, value) : value
    ]))
    : native);
  const chinese = withChineseHints(record, ['CN', 'HK', 'TW'].includes(record.countryCode)
    ? Object.fromEntries(Object.entries(native).map(([field, value]) => [field, typeof value === 'string' ? toSimplified(value) : value]))
    : native);
  return {
    native: { components: native, formattedAddress: record.formattedAddress, source: 'source' },
    en: {
      components: english,
      formattedAddress: localizedFormattedAddress(english, record.countryCode, 'en'),
      source: record.nativeLanguage.toLowerCase().startsWith('en') ? 'source' : 'local-postal-fallback'
    },
    'zh-CN': {
      components: chinese,
      formattedAddress: localizedFormattedAddress(chinese, record.countryCode, 'zh-CN'),
      source: record.nativeLanguage === 'zh-CN' ? 'source' : 'local-postal-fallback'
    }
  };
};

const googleTranslate = async (values, target, fetchImpl) => {
  const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  Object.entries({ client: 'gtx', dt: 't', sl: 'auto', tl: target, q: values.join(`\n${boundary}\n`) })
    .forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'address-sync/1.0' },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const translations = Array.isArray(payload?.[0])
    ? payload[0].map((segment) => Array.isArray(segment) ? segment[0] || '' : '').join('')
      .split(boundary).map((value) => value.trim())
    : [];
  return translations.length === values.length && translations.every(Boolean) ? translations : null;
};

const youdaoTranslate = async (values, target, environment, fetchImpl) => {
  const appKey = environment.YOUDAO_APP_KEY?.trim();
  const appSecret = environment.YOUDAO_APP_SECRET?.trim();
  if (!appKey || !appSecret) return null;
  const salt = randomUUID();
  const curtime = String(Math.floor(Date.now() / 1000));
  const joined = Array.from(values.join(''));
  const input = joined.length <= 20 ? joined.join('') : `${joined.slice(0, 10).join('')}${joined.length}${joined.slice(-10).join('')}`;
  const sign = sha256(`${appKey}${input}${salt}${curtime}${appSecret}`);
  const body = new URLSearchParams({ appKey, salt, from: 'auto', to: target === 'zh-CN' ? 'zh-CHS' : target, sign, signType: 'v3', curtime });
  values.forEach((value) => body.append('q', value));
  const response = await fetchImpl('https://openapi.youdao.com/v2/api', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'address-sync/1.0' },
    body,
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const translations = payload?.errorCode === '0' && Array.isArray(payload.translateResults)
    ? payload.translateResults.map((item) => clean(item.translation))
    : [];
  return translations.length === values.length && translations.every(Boolean) ? translations : null;
};

export const translateValues = async (values, target, environment, fetchImpl, cache) => {
  const output = cache ? await cache.get(values, target) : new Map();
  const missing = values.filter((value) => !usableTranslation(output.get(value), target));
  for (let offset = 0; offset < missing.length; offset += 30) {
    const chunk = missing.slice(offset, offset + 30);
    let primary;
    try {
      if (!/^(0|false|no)$/iu.test(String(environment.GOOGLE_TRANSLATION_ENABLED ?? 'true'))) {
        primary = await googleTranslate(chunk, target, fetchImpl);
      }
    } catch {}
    const retry = chunk.filter((_, index) => !usableTranslation(primary?.[index], target));
    let secondary;
    if (retry.length) {
      try { secondary = await youdaoTranslate(retry, target, environment, fetchImpl); } catch {}
    }
    const fallback = fillTranslations(retry, secondary || []);
    const translated = new Map(chunk.map((value, index) => {
      const candidate = primary?.[index];
      const replacement = fallback.get(value);
      return [value, usableTranslation(candidate, target)
        ? candidate
        : usableTranslation(replacement, target) ? replacement : candidate || replacement || value];
    }));
    for (const [value, translation] of translated) output.set(value, translation);
    await cache?.set(translated, target);
  }
  return output;
};

export const localizeAddressRecords = async (records, {
  environment = process.env,
  fetchImpl = fetch,
  cache
} = {}) => {
  const selectedOnlineCountries = new Set(String(environment.ADDRESS_SYNC_TRANSLATION_COUNTRIES || '')
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean));
  const useOnlineTranslation = boolean(environment.ADDRESS_SYNC_TRANSLATION_ENABLED, false)
    || records.some((record) => selectedOnlineCountries.has(record.countryCode));
  if (!useOnlineTranslation) {
    return records.map((record) => ({ ...record, localizations: deferredLocalizations(record) }));
  }
  const values = [...new Set(records.flatMap((record) => localizedFields.map((field) => record.components[field]).filter(Boolean)))];
  const needsEnglish = records.some((record) => !record.nativeLanguage.toLowerCase().startsWith('en'));
  const needsChinese = records.some((record) => record.nativeLanguage !== 'zh-CN');
  const [english, chinese] = await Promise.all([
    needsEnglish ? translateValues(values, 'en', environment, fetchImpl, cache) : Promise.resolve(new Map(values.map((value) => [value, value]))),
    needsChinese ? translateValues(values, 'zh-CN', environment, fetchImpl, cache) : Promise.resolve(new Map(values.map((value) => [value, value])))
  ]);
  return records.map((record) => {
    const build = (translations) => Object.fromEntries(Object.entries(record.components).map(([field, value]) => [
      field,
      localizedFields.includes(field) && value ? translations.get(value) || value : value
    ]));
    const englishComponents = withEnglishHints(
      record,
      record.nativeLanguage.toLowerCase().startsWith('en') ? record.components : build(english)
    );
    const chineseComponents = record.nativeLanguage === 'zh-CN' ? { ...record.components } : withChineseHints(record, build(chinese));
    return {
      ...record,
      localizations: {
        native: { components: record.components, formattedAddress: record.formattedAddress, source: 'source' },
        en: { components: englishComponents, formattedAddress: localizedFormattedAddress(englishComponents, record.countryCode, 'en'), source: record.nativeLanguage.toLowerCase().startsWith('en') ? 'source' : 'google-youdao' },
        'zh-CN': { components: chineseComponents, formattedAddress: localizedFormattedAddress(chineseComponents, record.countryCode, 'zh-CN'), source: record.nativeLanguage === 'zh-CN' ? 'source' : 'google-youdao' }
      }
    };
  });
};

export class PostgresTranslationCache {
  constructor(database) {
    this.database = database;
  }

  async get(values, targetLanguage) {
    const originals = new Map(values.map((value) => [sha256(value), value]));
    const output = new Map();
    const keys = [...originals.keys()];
    for (let offset = 0; offset < keys.length; offset += 500) {
      const chunk = keys.slice(offset, offset + 500);
      const rows = await this.database.prepare(`SELECT cache_key,value FROM translation_cache
        WHERE target_language=? AND cache_key IN (${chunk.map(() => '?').join(',')})`)
        .bind(targetLanguage, ...chunk).all();
      for (const row of rows.results) {
        const original = originals.get(row.cache_key);
        if (original) output.set(original, row.value);
      }
    }
    return output;
  }

  async set(translations, targetLanguage) {
    const updatedAt = new Date().toISOString();
    await this.database.batch([...translations].map(([original, translated]) => this.database.prepare(`
      INSERT INTO translation_cache(cache_key,target_language,value,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(cache_key,target_language) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).bind(sha256(original), targetLanguage, translated, updatedAt)));
  }
}

const centroid = (geometry) => {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  if (geometry.type === 'Point') return geometry.coordinates;
  let longitude = 0;
  let latitude = 0;
  let count = 0;
  const visit = (coordinates) => {
    if (Array.isArray(coordinates) && coordinates.length >= 2 && Number.isFinite(Number(coordinates[0])) && Number.isFinite(Number(coordinates[1]))) {
      longitude += Number(coordinates[0]);
      latitude += Number(coordinates[1]);
      count += 1;
      return;
    }
    if (Array.isArray(coordinates)) coordinates.forEach(visit);
  };
  visit(geometry.coordinates);
  return count ? [longitude / count, latitude / count] : null;
};

const normalizeTaiwanHierarchy = (levels, postalCity, fallbackAdmin1, fallbackLocality, fallbackDistrict) => {
  const values = [...new Set(levels.map((value) => clean(value)).filter(Boolean))];
  const preferredAdmin1 = clean(postalCity);
  const adminIndex = preferredAdmin1 && /[縣市]$/u.test(preferredAdmin1)
    ? values.findIndex((value) => value === preferredAdmin1)
    : values.findIndex((value) => /[縣市]$/u.test(value));
  if (adminIndex < 0) return {
    admin1: fallbackAdmin1,
    locality: fallbackLocality,
    district: fallbackDistrict
  };
  const admin1 = values[adminIndex];
  const localityIndex = values.findIndex((value, index) => index > adminIndex && /[區鄉鎮市]$/u.test(value));
  if (localityIndex < 0) return { admin1, locality: '', district: '' };
  const locality = values[localityIndex];
  const district = values.find((value, index) => index > localityIndex && /[里村]$/u.test(value)) || '';
  return { admin1, locality, district };
};

export const normalizeSourceRecord = (value, shard, format) => {
  let sourceRecordId;
  let admin1;
  let locality;
  let postalLocality;
  let district;
  let postcode;
  let street;
  let houseNumber;
  let buildingName = '';
  let unit = '';
  let longitude;
  let latitude;
  let propertyType = 'unknown';
  let residentialSourceRecordId = '';
  let residentialSourceClass = '';
  let sourceDataset = shard.source.name;
  if (format === 'overture-jsonl') {
    const addressLevels = (Array.isArray(value.address_levels) ? value.address_levels : [])
      .map((level) => clean(typeof level === 'object' && level !== null ? level.value : level))
      .filter(Boolean);
    const postalCity = clean(value.postal_city);
    sourceRecordId = clean(value.source_record_id || value.id);
    admin1 = clean(value.admin1) || addressLevels[0] || '';
    if (['JP', 'MX', 'TW'].includes(shard.countryCode)) {
      locality = postalCity || (addressLevels.length >= 3 ? addressLevels.at(-2) : addressLevels.at(-1)) || '';
      district = addressLevels.length >= 3 ? addressLevels.at(-1) : '';
    } else if (shard.countryCode === 'IT') {
      locality = postalCity || addressLevels.at(-1) || clean(value.locality);
      district = addressLevels.length >= 2 ? addressLevels.at(-2) : '';
    } else {
      locality = clean(value.locality) || postalCity || addressLevels.at(-1) || '';
      const candidateDistrict = clean(value.district) || (addressLevels.length >= 3 ? addressLevels.at(-1) : '');
      district = candidateDistrict !== locality && candidateDistrict !== admin1 ? candidateDistrict : '';
    }
    if (shard.countryCode === 'TW') {
      const hierarchy = normalizeTaiwanHierarchy(addressLevels, postalCity, admin1, locality, district);
      ({ admin1, locality, district } = hierarchy);
      postalLocality = locality;
    } else {
      postalLocality = postalCity;
    }
    if (district && [admin1, locality, postalLocality].some((value) => clean(value) === clean(district))) district = '';
    postcode = shard.countryCode === 'CN' ? '' : clean(value.postcode);
    street = clean(value.street);
    houseNumber = clean(value.number).normalize('NFKC');
    buildingName = clean(value.building_name);
    unit = clean(value.unit);
    longitude = Number(value.longitude);
    latitude = Number(value.latitude);
    const overturePropertyType = clean(value.property_type).toLowerCase();
    if (overturePropertyType === 'residential' || overturePropertyType === 'apartment') {
      propertyType = overturePropertyType;
      residentialSourceRecordId = clean(value.residential_building_id);
      residentialSourceClass = clean(value.residential_building_class);
    }
    sourceDataset = clean(value.source_dataset) || sourceDataset;
  } else if (format === 'geofabrik-geojsonseq') {
    const properties = value.properties || {};
    const declaredCountry = clean(properties['addr:country']).toUpperCase();
    if (/^[A-Z]{2}$/u.test(declaredCountry) && declaredCountry !== shard.countryCode) return null;
    const point = centroid(value.geometry);
    sourceRecordId = clean(properties['@id'] || value.id);
    admin1 = clean(properties['addr:state'] || properties['addr:province']);
    const sourceLocality = clean(properties['addr:city'] || properties['addr:town']
      || properties['addr:village'] || properties['addr:municipality']);
    locality = sourceLocality;
    district = clean(properties['addr:district'] || properties['addr:suburb'] || properties['addr:county']);
    if (shard.countryCode === 'TH') {
      locality = clean(properties['addr:district']) || sourceLocality;
      district = clean(properties['addr:subdistrict'] || properties['addr:suburb'] || properties['addr:county']);
    } else if (shard.countryCode === 'PH') {
      district = clean(properties['addr:barangay'] || properties['addr:district']
        || properties['addr:suburb'] || properties['addr:county']);
    } else if (shard.countryCode === 'VN') {
      const ward = clean(properties['addr:ward'] || properties['addr:commune']
        || properties['addr:subdistrict']);
      locality = sourceLocality || ward;
      district = ward && clean(ward) !== clean(locality) ? ward : '';
    }
    postalLocality = locality;
    if (shard.countryCode === 'TW') {
      const hierarchy = normalizeTaiwanHierarchy([admin1, locality, district], locality, admin1, locality, district);
      ({ admin1, locality, district } = hierarchy);
      postalLocality = locality;
    }
    postcode = shard.countryCode === 'CN' ? '' : clean(properties['addr:postcode']);
    street = clean(properties['addr:street'] || properties['addr:place']);
    houseNumber = clean(properties['addr:housenumber']).normalize('NFKC');
    unit = clean(properties['addr:unit'] || properties['addr:flats']);
    buildingName = clean(properties.name);
    longitude = Number(point?.[0]);
    latitude = Number(point?.[1]);
    const building = clean(properties.building).toLowerCase();
    const matchedBuildingId = clean(properties.residential_building_id);
    const matchedBuildingClass = clean(properties.residential_building_class).toLowerCase();
    if (matchedBuildingId && properties['@type'] === 'node') buildingName = '';
    if (matchedBuildingId && residentialBuildings.has(matchedBuildingClass)) {
      propertyType = matchedBuildingClass === 'apartments' ? 'apartment' : 'residential';
      residentialSourceRecordId = matchedBuildingId;
      residentialSourceClass = `building=${matchedBuildingClass}`;
    } else if (residentialBuildings.has(building)) {
      propertyType = building === 'apartments' ? 'apartment' : 'residential';
      residentialSourceRecordId = sourceRecordId;
      residentialSourceClass = `building=${building}`;
    }
  } else {
    throw new Error(`Unsupported normalized source format: ${format}`);
  }
  if (!sourceRecordId || !street || !houseNumber || !finiteCoordinate(longitude, -180, 180) || !finiteCoordinate(latitude, -90, 90)) return null;
  const components = normalizeAddressFacts(shard.countryCode, {
    houseNumber, street, buildingName, unit, district, locality, postalLocality, admin1, postcode
  });
  const englishComponentHints = {};
  if (shard.countryCode === 'HK') {
    for (const field of localizedFields) {
      const split = hongKongBilingualComponent(components[field]);
      if (!split) continue;
      components[field] = split.native;
      englishComponentHints[field] = split.en;
    }
    ({ admin1, locality, postalLocality, district, street, buildingName, unit } = components);
  }
  if (findNonResidentialMatch({
    countryCode: shard.countryCode,
    buildingNames: [buildingName],
    formattedAddresses: [formattedAddress(components, shard.countryCode)],
    streets: [street]
  }).excluded) return null;
  if (matchesCustomBlacklist([buildingName, formattedAddress(components, shard.countryCode), street])) return null;
  const canonicalHash = sha256([
    shard.countryCode, admin1, locality, postcode, street, houseNumber, unit,
    longitude.toFixed(6), latitude.toFixed(6)
  ].map((part) => clean(part).toLocaleLowerCase('und')).join('\u001f'));
  return {
    id: `addr-${canonicalHash.slice(0, 40)}`,
    canonicalHash,
    sourceRecordId,
    sourceDataset,
    countryCode: shard.countryCode,
    admin1,
    admin1Code: '',
    locality,
    postalLocality,
    district,
    postcode,
    street,
    houseNumber,
    buildingName,
    unit,
    propertyType,
    residentialSourceRecordId,
    residentialSourceClass,
    evidenceClass: format === 'overture-jsonl' ? 'official-address-point' : 'open-address-point',
    qualityScore: format === 'overture-jsonl' ? 0.86 : 0.8,
    nativeLanguage: nativeLanguage[shard.countryCode] || 'und',
    longitude,
    latitude,
    formattedAddress: formattedAddress(components, shard.countryCode),
    components,
    englishComponentHints
  };
};

const loadState = async (file) => {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    return state.schemaVersion === 1 && state.shards ? state : { schemaVersion: 1, shards: {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, shards: {} };
    throw error;
  }
};

const saveState = async (file, state) => {
  await mkdir(resolve(file, '..'), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
};

const directorySize = async (directory) => {
  let total = 0;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size;
  }
  return total;
};

const pruneShardCache = async (cacheDir, shard, keepFile) => {
  const directory = resolve(cacheDir, 'normalized');
  let entries;
  try { entries = await readdir(directory); } catch { return; }
  await Promise.all(entries
    .filter((name) => name.startsWith(`${shard.id}-`) && resolve(directory, name) !== resolve(keepFile))
    .map((name) => rm(resolve(directory, name), { force: true })));
};

const prioritizeCachedShards = async (shards, cacheDir) => {
  let entries;
  try { entries = await readdir(resolve(cacheDir, 'normalized')); } catch { return shards; }
  return shards.map((shard, index) => ({
    shard,
    index,
    cached: entries.some((name) => name.startsWith(`${shard.id}-`) && !name.includes('.tmp'))
  })).sort((left, right) => Number(right.cached) - Number(left.cached) || left.index - right.index)
    .map(({ shard }) => shard);
};

const selectShards = (catalog, requested) => {
  if (!requested?.length || requested.includes('all')) return catalog.shards;
  const normalized = new Set(requested.flatMap((value) => String(value).split(',')).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const selected = catalog.shards.filter((shard) => normalized.has(shard.id.toLowerCase()) || normalized.has(shard.countryCode.toLowerCase()));
  const unresolved = [...normalized].filter((value) => !selected.some((shard) => shard.id.toLowerCase() === value || shard.countryCode.toLowerCase() === value));
  if (unresolved.length) throw new Error(`Unknown address source shard: ${unresolved.join(', ')}`);
  return selected;
};

export const runAddressEtl = async ({
  database: providedDatabase,
  environment = process.env,
  cacheDir = process.env.ADDRESS_SYNC_CACHE_DIR || defaultCacheDir,
  dataRoot = process.env.ADDRESS_DATA_ROOT || resolve('data'),
  requestedShards = process.env.ADDRESS_SYNC_SHARDS ? [process.env.ADDRESS_SYNC_SHARDS] : ['all'],
  dryRun = boolean(process.env.ADDRESS_SYNC_DRY_RUN),
  estimate = false,
  force = boolean(process.env.ADDRESS_SYNC_FORCE) || process.env.ADDRESS_SYNC_TRIGGER === 'manual',
  syncMode = process.env.ADDRESS_SYNC_MODE || (process.env.ADDRESS_SYNC_TRIGGER === 'initial' ? 'initial' : force ? 'manual' : 'daily'),
  softLimitBytes = integer(process.env.ADDRESS_STORAGE_SOFT_LIMIT_BYTES, DEFAULT_SOFT_LIMIT_BYTES),
  hardLimitBytes = integer(process.env.ADDRESS_STORAGE_HARD_LIMIT_BYTES, DEFAULT_HARD_LIMIT_BYTES),
  maxRecords = integer(process.env.ADDRESS_SYNC_MAX_RECORDS_PER_SHARD, 50_000),
  perLocality = integer(process.env.ADDRESS_SYNC_RECORDS_PER_LOCALITY, 64),
  maxShardsPerRun = integer(process.env.ADDRESS_SYNC_MAX_SHARDS_PER_RUN, !estimate && syncMode === 'daily' ? 1 : Number.MAX_SAFE_INTEGER),
  requireResidential = boolean(process.env.ADDRESS_SYNC_REQUIRE_RESIDENTIAL),
  retainRaw = boolean(process.env.ADDRESS_SYNC_RETAIN_RAW),
  prepareConcurrency = integer(process.env.ADDRESS_SYNC_PREPARE_CONCURRENCY, 1),
  cpuConcurrency = integer(process.env.ADDRESS_SYNC_CPU_CONCURRENCY, 1),
  maxPrepareConcurrency = integer(process.env.ADDRESS_SYNC_MAX_PREPARE_CONCURRENCY, 1),
  maxCpuConcurrency = integer(process.env.ADDRESS_SYNC_MAX_CPU_CONCURRENCY, 1),
  signal,
  now = () => new Date(),
  catalog: providedCatalog,
  adapters: providedAdapters,
  credentialPool = null,
  importer: providedImporter,
  localizeRecords = localizeAddressRecords,
  stateStore: providedStateStore,
  measureStorage = measureStorageBytes
} = {}) => {
  const catalog = providedCatalog || await loadSourceCatalog(undefined, environment);
  const requested = selectShards(catalog, requestedShards);
  const stateFile = resolve(cacheDir, 'manifest.json');
  const activeRun = !dryRun && !estimate;
  const database = providedDatabase;
  if (activeRun && !providedImporter && !database) throw new Error('PostgreSQL database is required for address synchronization');
  const runtimePolicy = database && activeRun
    ? await getRuntimePolicy(database)
    : { prepareConcurrency: Math.min(10, prepareConcurrency), cpuConcurrency: Math.min(4, cpuConcurrency) };
  runtimePolicy.prepareConcurrency = Math.min(runtimePolicy.prepareConcurrency, maxPrepareConcurrency);
  runtimePolicy.cpuConcurrency = Math.min(runtimePolicy.cpuConcurrency, maxCpuConcurrency);
  const loadSeedLocations = async (countryCode) => {
    if (!database) return [];
    return (await database.prepare(`SELECT latitude,longitude FROM catalog_postcodes
      WHERE country_code=? AND latitude IS NOT NULL AND longitude IS NOT NULL
      UNION SELECT latitude,longitude FROM catalog_cities
      WHERE country_code=? AND latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY latitude,longitude`).bind(countryCode, countryCode).all()).results;
  };
  const adapters = providedAdapters || createSourceAdapters({
    processConcurrency: runtimePolicy.cpuConcurrency,
    signal,
    environment,
    credentialPool,
    loadSeedLocations
  });
  const importer = activeRun ? providedImporter || new PostgresAddressImporter({
    database,
    normalizeRecord: normalizeSourceRecord,
    localizeRecords: (records) => localizeRecords(records, { cache: new PostgresTranslationCache(database) }),
    hash: sha256,
    reverseGeocoder: (countryCode) => CatalogReverseGeocoder.load(database, countryCode),
    rebuildFormattedAddress: formattedAddress
  }) : null;
  const stateStore = providedStateStore || (database && activeRun ? new PostgresCountryStateStore({ database, shards: catalog.shards, now }) : {
    load: () => loadState(stateFile),
    save: (value) => saveState(stateFile, value)
  });
  const state = await stateStore.load();
  if (!state || typeof state !== 'object' || !state.shards || typeof state.shards !== 'object') {
    throw new Error('Address sync state store returned an invalid state');
  }
  const checkedAt = now();
  let selected = estimate
    ? requested.slice(0, maxShardsPerRun)
    : planCountryShards({ shards: requested, state, mode: syncMode, now: checkedAt, maxCountries: maxShardsPerRun });
  if (!estimate && syncMode === 'initial' && requireResidential) {
    const selectedIds = new Set(selected.map(({ id }) => id));
    for (const shard of requested) {
      if (Number(state.shards[shard.id]?.residentialCount || 0) < 1 && !selectedIds.has(shard.id)) {
        selected.push(shard);
      }
    }
  }
  if (syncMode === 'initial' && selected.length > 1) selected = await prioritizeCachedShards(selected, cacheDir);
  const cacheBytesBefore = await directorySize(cacheDir);
  let plannedCacheBytes = cacheBytesBefore;
  const storageBytesBefore = await measureStorage([dataRoot]);
  let plannedStorageBytes = storageBytesBefore;
  let storageBudget = assertStorageBudget({ currentBytes: storageBytesBefore, softLimitBytes, hardLimitBytes });
  const selectedIds = new Set(selected.map((shard) => shard.id));
  const reports = requested.filter((shard) => !selectedIds.has(shard.id)).map((shard) => {
    const previous = state.shards[shard.id];
    return {
      shardId: shard.id,
      shardKey: shard.id,
      sourceId: shard.source.id,
      countryCode: shard.countryCode,
      status: isCountryDue(previous, shard.intervalDays, checkedAt) ? 'deferred' : 'not-due',
      intervalDays: shard.intervalDays,
      lastChecked: previous?.lastChecked || null,
      sourceVersion: previous?.sourceVersion || null
    };
  });
  let changed = false;
  const changedCountries = new Set();
  const plannedRawArtifacts = new Set();
  const disabledCountries = new Set();
  const successfulCountries = new Set();
  const syncErrors = [];
  const failureReport = (task, error) => {
    const errorCode = error?.code || (estimate ? 'SOURCE_ESTIMATE_FAILED' : 'SYNC_FAILED');
    const qualityFailure = errorCode === 'SOURCE_QUALITY_FAILED' || errorCode === 'SNAPSHOT_QUALITY_FAILED';
    return {
      ...task.previous,
      shardId: task.shard.id,
      shardKey: task.shard.id,
      sourceId: task.shard.source.id,
      countryCode: task.shard.countryCode,
      intervalDays: task.shard.intervalDays,
      lastChecked: checkedAt.toISOString(),
      sourceVersion: task.discovery?.version || task.previous?.sourceVersion || null,
      sourceBytes: task.discovery?.sourceBytes ?? task.previous?.sourceBytes ?? null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      errorCode,
      failureSignature: qualityFailure
        ? error?.failureSignature || task.discovery?.failureSignature || null
        : null,
      rejectionReasons: qualityFailure
        ? error?.rejectionReasons || error?.metrics?.rejectionReasons || task.previous?.rejectionReasons || {}
        : null,
      metrics: qualityFailure ? error?.metrics || task.previous?.metrics || null : null,
      errorUrl: error?.url || null,
      errorStatus: error?.status ?? null
    };
  };
  const recordFailure = async (task, error) => {
    console.error(`[address-sync] ${task.shard.countryCode} failed`, error);
    const report = failureReport(task, error);
    reports.push(report);
    if (!dryRun && !estimate) {
      state.shards[task.shard.id] = report;
      await stateStore.save({ ...state, updatedAt: checkedAt.toISOString() });
    }
    if (syncMode === 'initial' || syncMode === 'manual') {
      syncErrors.push({ countryCode: task.shard.countryCode, error });
    }
    else if (!estimate) throw error;
  };
  try {
    const work = [];
    for (const shard of selected) {
      const previous = state.shards[shard.id];
      if (syncMode === 'daily' && !estimate && !isCountryDue(previous, shard.intervalDays, checkedAt)) {
        reports.push({ shardId: shard.id, shardKey: shard.id, sourceId: shard.source.id, countryCode: shard.countryCode, status: 'not-due', intervalDays: shard.intervalDays, lastChecked: previous.lastChecked, sourceVersion: previous.sourceVersion });
        continue;
      }
      const defaults = providedImporter || providedCatalog ? null : ADDRESS_POLICY_DEFAULTS[shard.countryCode];
      const policy = database && activeRun && !providedImporter
        ? await loadImportPolicy(database, shard.countryCode, maxRecords, perLocality)
        : { enabled: true, targetCount: defaults?.target || maxRecords,
          levelLimits: defaults?.limits || [maxRecords, perLocality, perLocality, perLocality],
          overrides: new Map(), nodeFloors: new Map(), level1Min: defaults?.level1Min || 0,
          level2Min: defaults?.level2Min || 0, minPerNode: defaults?.minPerNode || 0 };
      if (policy.enabled === false) {
        disabledCountries.add(shard.countryCode);
        reports.push({ shardId: shard.id, shardKey: shard.id, sourceId: shard.source.id, countryCode: shard.countryCode,
          status: 'disabled', intervalDays: shard.intervalDays, lastChecked: previous?.lastChecked || null,
          sourceVersion: previous?.sourceVersion || null });
        continue;
      }
      work.push({ shard, previous, policy });
    }

    const discovered = await mapConcurrent(work, runtimePolicy.prepareConcurrency, async (task) => {
      try {
        console.log(`[address-sync] ${task.shard.countryCode} discover`);
        const discoveredSource = await adapters.discover(task.shard, { includeAssetSizes: estimate, syncMode, cacheDir });
        const discovery = {
          ...discoveredSource,
          failureSignature: sourceQualityFailureSignature(task.shard, discoveredSource, task.policy)
        };
        return { ...task, discovery };
      } catch (error) { return { ...task, error }; }
    });
    const planned = [];
    for (const task of discovered) {
      if (task.error) { await recordFailure(task, task.error); continue; }
      if (task.previous?.errorCode === 'SOURCE_QUALITY_FAILED'
        && task.previous.failureSignature === task.discovery.failureSignature) {
        reports.push({
          ...task.previous,
          shardId: task.shard.id,
          shardKey: task.shard.id,
          sourceId: task.shard.source.id,
          countryCode: task.shard.countryCode,
          sourceVersion: task.discovery.version,
          status: 'source-quality-failed',
          skipped: true
        });
        continue;
      }
      const sourceTarget = integer(task.shard.maxRecords, maxRecords);
      const estimatedOutputBytes = sourceTarget * 2048;
      const estimatedDatabaseBytes = sourceTarget * 2048;
      const rawKey = `${task.discovery.dataUrl || ''}\u001f${task.discovery.version || ''}`;
      const temporarySourceBytes = task.discovery.adapter === 'geofabrik' && !plannedRawArtifacts.has(rawKey)
        ? task.discovery.sourceBytes || 0 : 0;
      if (task.discovery.adapter === 'geofabrik') plannedRawArtifacts.add(rawKey);
      const projectedCacheBytes = plannedCacheBytes + estimatedOutputBytes + temporarySourceBytes;
      try {
        storageBudget = assertStorageBudget({
          currentBytes: plannedStorageBytes,
          additionalBytes: estimatedOutputBytes + estimatedDatabaseBytes + temporarySourceBytes,
          softLimitBytes,
          hardLimitBytes
        });
      } catch (error) { await recordFailure(task, error); continue; }
      const report = {
        shardId: task.shard.id, shardKey: task.shard.id, sourceId: task.shard.source.id,
        countryCode: task.shard.countryCode, adapter: task.discovery.adapter, intervalDays: task.shard.intervalDays,
        lastChecked: checkedAt.toISOString(), sourceVersion: task.discovery.version, sourceBytes: task.discovery.sourceBytes,
        estimatedPeakBytes: projectedCacheBytes, estimatedStoragePeakBytes: storageBudget.projectedBytes,
        estimatedDatabaseBytes, allowShadowExpansion: storageBudget.allowShadowExpansion,
        estimateMethod: task.discovery.estimateMethod, targetCount: sourceTarget,
        status: dryRun || estimate ? 'planned' : 'discovered'
      };
      plannedCacheBytes += estimatedOutputBytes;
      plannedStorageBytes += estimatedOutputBytes + estimatedDatabaseBytes;
      if (dryRun || estimate) reports.push(report);
      else planned.push({ ...task, report, estimatedOutputBytes, estimatedDatabaseBytes, storageBudget });
    }

    const importPreparedTask = async (task) => {
      if (task.error) { await recordFailure(task, task.error); return; }
      try {
        const materializedStorageBytes = await measureStorage([dataRoot]);
        storageBudget = assertStorageBudget({ currentBytes: materializedStorageBytes, additionalBytes: task.estimatedDatabaseBytes, softLimitBytes, hardLimitBytes });
        console.log(`[address-sync] ${task.shard.countryCode} import`);
        const imported = await importer.importShard({
          shard: task.shard, discovery: task.discovery, materialized: task.materialized,
          maxRecords: task.policy.targetCount, sourceMaxRecords: task.report.targetCount, perLocality, policy: task.policy,
          storagePolicy: { allowShadowExpansion: storageBudget.allowShadowExpansion, softLimitBytes, hardLimitBytes }
        });
        const storageBytesAfterImport = await measureStorage([dataRoot]);
        storageBudget = assertStorageBudget({ currentBytes: storageBytesAfterImport, softLimitBytes, hardLimitBytes });
        Object.assign(task.report, {
          status: imported.skipped ? 'unchanged' : 'imported', checksumSha256: task.materialized.checksum,
          sourceChecksumSha256: task.materialized.sourceChecksum || task.previous?.sourceChecksumSha256 || null,
          cacheBytes: task.materialized.cacheBytes, cacheHit: task.materialized.cacheHit, datasetId: imported.datasetId,
          acceptedCount: imported.acceptedCount, rejectedCount: imported.rejectedCount,
          rejectionReasons: imported.rejectionReasons || {}, metrics: imported.metrics || null,
          localityCount: imported.localityCount || null, residentialCount: imported.residentialCount || 0,
          deficit: Math.max(0, task.report.targetCount - imported.acceptedCount), storageBytesAfterImport,
          allowShadowExpansion: storageBudget.allowShadowExpansion, lastSuccessfulAt: checkedAt.toISOString()
        });
        state.shards[task.shard.id] = task.report;
        await stateStore.save({ ...state, updatedAt: checkedAt.toISOString() });
        await pruneShardCache(cacheDir, task.shard, task.materialized.file);
        plannedCacheBytes = await directorySize(cacheDir);
        plannedStorageBytes = await measureStorage([dataRoot]);
        changed ||= !imported.skipped;
        successfulCountries.add(task.shard.countryCode);
        if (!imported.skipped) changedCountries.add(task.shard.countryCode);
        reports.push(task.report);
        console.log(`[address-sync] ${task.shard.countryCode} ready addresses=${imported.acceptedCount} target=${task.report.targetCount} deficit=${task.report.deficit}`);
      } catch (error) { await recordFailure(task, error); }
    };

    for (let offset = 0; offset < planned.length; offset += runtimePolicy.prepareConcurrency) {
      const wave = planned.slice(offset, offset + runtimePolicy.prepareConcurrency);
      const waveRaw = new Map();
      for (const task of wave) {
        if (task.discovery.adapter === 'geofabrik') {
          waveRaw.set(`${task.discovery.dataUrl}\u001f${task.discovery.version}`, Number(task.discovery.sourceBytes || 0));
        }
      }
      const currentStorage = await measureStorage([dataRoot]);
      try {
        assertStorageBudget({
          currentBytes: currentStorage,
          additionalBytes: [...waveRaw.values()].reduce((total, value) => total + value, 0)
            + wave.reduce((total, task) => total + task.estimatedOutputBytes + task.estimatedDatabaseBytes, 0),
          softLimitBytes,
          hardLimitBytes
        });
      } catch (error) {
        for (const task of wave) await recordFailure(task, error);
        continue;
      }
      const preparedWave = await mapConcurrent(wave, runtimePolicy.prepareConcurrency, async (task) => {
        try {
          console.log(`[address-sync] ${task.shard.countryCode} materialize`);
          const shardTarget = task.report.targetCount;
          const candidateLimit = Math.min(300_000, Math.max(shardTarget + 1_000, shardTarget * 3));
          const candidatePerLocality = Math.max(perLocality, ...task.policy.levelLimits);
          const materialized = await adapters.materialize(task.shard, task.discovery, {
            cacheDir, maxBytes: Math.max(1, hardLimitBytes - currentStorage),
            maxRecords: candidateLimit, perLocality: candidatePerLocality, retainRaw, sharedRaw: wave.length > 1
          });
          return { ...task, materialized };
        } catch (error) { return { ...task, error }; }
      });
      await adapters.cleanupSharedRaw?.().catch(() => {});
      for (const task of preparedWave) await importPreparedTask(task);
    }
    if (database && activeRun && !providedImporter) {
      for (const countryCode of changedCountries) {
        const coverage = await refreshResidentialCoverage(database, countryCode, checkedAt.toISOString());
        console.log(`[address-sync] ${countryCode} coverage mapped=${coverage.matchedAddresses} unmatched=${coverage.unmatchedAddresses}`);
      }
    }
    const blockingSyncErrors = syncErrors.filter(({ countryCode, error }) =>
      error?.code !== 'SOURCE_QUALITY_FAILED' || !successfulCountries.has(countryCode));
    for (const { countryCode, error } of syncErrors) {
      if (error?.code === 'SOURCE_QUALITY_FAILED' && successfulCountries.has(countryCode)) {
        console.warn(`[address-sync] ${countryCode} source-quality failure retained; another source succeeded`);
      }
    }
    if (blockingSyncErrors.length) {
      throw new AggregateError(
        blockingSyncErrors.map(({ error }) => error),
        `Address sync failed for ${blockingSyncErrors.length} country shard(s)`
      );
    }
    if (syncMode === 'initial' && requireResidential) {
      const missingResidential = requested.filter((shard) => !disabledCountries.has(shard.countryCode)
        && Number(state.shards[shard.id]?.residentialCount || 0) < 1);
      if (missingResidential.length) {
        throw new Error(`Initial residential sync incomplete for: ${missingResidential.map(({ countryCode }) => countryCode).join(', ')}`);
      }
    }
  } finally {
    await adapters.cleanupSharedRaw?.().catch(() => {});
    if (!providedImporter) await importer?.close();
  }
  return {
    changed,
    dryRun: dryRun || estimate,
    syncMode,
    softLimitBytes,
    hardLimitBytes,
    cacheBytesBefore,
    storageBytesBefore,
    storageBudget,
    requiredCountries: [...new Set(catalog.shards.map((shard) => shard.countryCode))].sort(),
    selectedShards: selected.map((shard) => shard.id),
    releaseTargets: reports.filter((report) => report.status === 'imported').map((report) => ({
      shardKey: report.shardKey,
      sourceId: report.sourceId,
      countryCode: report.countryCode,
      datasetId: report.datasetId
    })),
    reports
  };
};

const parseArguments = (arguments_) => {
  const options = { requestedShards: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--estimate') options.estimate = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--initial') options.syncMode = 'initial';
    else if (argument === '--daily') options.syncMode = 'daily';
    else if (argument === '--manual') options.syncMode = 'manual';
    else if (argument === '--all') options.requestedShards.push('all');
    else if (argument === '--shard') options.requestedShards.push(arguments_[index += 1]);
    else if (argument === '--cache-dir') options.cacheDir = resolve(arguments_[index += 1]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.requestedShards.length) options.requestedShards.push('all');
  return options;
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await runAddressEtl(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
