import { applyHierarchicalQuota } from './address-policy.mjs';
import { validateAddressQuality } from '../../src/domain/address-quality.mjs';
import { validateAdministrativeHierarchy } from '../../src/domain/administrative-integrity.mjs';

const cleanKey = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('und');
const postcodeKey = (value) => cleanKey(value).replace(/\s/gu, '');
const randomKey = (hash) => Number.parseInt(hash.slice(0, 8), 16) & 0x7fffffff;
const expiry = (date) => new Date(date.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
const DEFAULT_MINIMUM_RATIO = 0.95;
const postalHierarchyCountries = new Set(['US', 'CA', 'AU', 'DE', 'MX', 'IN', 'MY', 'PH']);
const germanPostalMigrationShards = new Set([
  'geofabrik-osm-de-by', 'geofabrik-osm-de-rp', 'geofabrik-osm-de-sh', 'geofabrik-osm-de-sn'
]);

// Minimum administrative completeness per country. A record must carry at least
// one region-level field and (where listed) a city-level field, else it is dropped.
const requiredAdminFields = {
  CN: { region: true, city: true, district: true }, IN: { region: true, city: true }, VN: { region: true, city: true },
  TH: { region: true, city: true }, US: { region: true, city: true }, CA: { region: true, city: true },
  JP: { region: true, city: true }, MX: { region: true, city: true }, BR: { region: true, city: true },
  AU: { region: true, city: true }, KR: { region: true, city: true }, MY: { region: true, city: true },
  PH: { region: true, city: true }, TR: { region: true, city: true }, RU: { region: true, city: true },
  DE: { region: false, city: true }, FR: { region: false, city: true }, IT: { region: false, city: true },
  ES: { region: false, city: true }, NL: { region: false, city: true }, GB: { region: false, city: true },
  SA: { region: false, city: true }, NG: { region: true, city: true }, ZA: { region: false, city: true },
  TW: { region: true, city: true }, HK: { region: false, city: true }, SG: { region: false, city: false }
};

const hasRegion = (components) => Boolean((components.admin1 || '').trim() || (components.admin1Code || '').trim());
const hasCity = (components) => Boolean(
  (components.locality || '').trim() || (components.postalLocality || '').trim() || (components.district || '').trim()
);

// Countries whose admin hierarchy is rebuilt from coordinates, overriding
// untrustworthy source text (OSM stores district names in the city field, mixes
// scripts, etc.). Only CN has both severe misplacement and a dense enough catalog.
const geoAnchorCountries = new Set(['CN']);

// Countries whose source admin1 must resolve to a catalog_regions entry. A
// non-matching value (e.g. NL Overture address_levels carrying the city name)
// is re-derived from coordinates; a record that cannot be anchored to any
// region is dropped — no invented admin. US is excluded because
// administrative-integrity.mjs already validates against the full official
// subdivision list (incl. territories such as PR that the catalog omits).
// TW/HK are excluded because their catalog region names are Latin-script while
// source admin1 is Han, so name validation cannot apply there.
const catalogAnchoredAdmin1Countries = new Set(['NL', 'CA', 'DE', 'FR', 'IT', 'ES', 'AU', 'JP', 'MX']);
const foldAdmin1 = (value) => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/gu, '')
  .toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]+/gu, '');
// The catalog stores some JP prefectures with the 都/道/府/県 suffix and some
// without; compare both spellings on both sides.
const admin1Variants = (value) => {
  const folded = foldAdmin1(value);
  if (!folded) return [];
  const stripped = folded.replace(/[都道府県]$/u, '');
  return stripped && stripped !== folded ? [folded, stripped] : [folded];
};
const matchesCatalogRegion = (geocoder, value) => {
  const needles = admin1Variants(value);
  if (!needles.length) return false;
  for (const region of geocoder.regionsById.values()) {
    for (const candidate of [region.code, region.name, region.native_name, region.zh_name]) {
      if (admin1Variants(candidate).some((key) => needles.includes(key))) return true;
    }
  }
  return false;
};

// Rule-based soft fixes for countries with locality-level misplacement but a
// catalog too sparse (TW) or a defect rate too low (RU) for full re-anchoring.
// `demote` matches a locality that is NOT a city; `replaceWith: 'admin1'` uses the
// admin1 name as the city (TW 縣市), `'anchor'` uses the coordinate-nearest
// catalog city (RU район records).
const softLocalityFixes = {
  TW: { demote: /[里村]$/u, replaceWith: 'admin1' },
  RU: { demote: /район|поселение|сельсовет|городской округ/iu, replaceWith: 'anchor' }
};

// Fills empty admin fields via catalog reverse-geocoding, then enforces the
// country's minimum administrative completeness. Returns false to drop the record.
const enrichAndValidate = (record, geocoder, countryCode, rebuildFormattedAddress) => {
  const components = record.components;
  if (geoAnchorCountries.has(countryCode) && geocoder?.hierarchyReady) {
    // Cross-border source label guard: china.pbf carries Taiwan/HK/Macau points.
    const sourceRegion = `${components.admin1 || ''} ${record.admin1 || ''}`;
    if (countryCode === 'CN') {
      if (/香港|澳門|澳门|台湾|臺灣|hong\s?kong|macau|macao|taiwan/iu.test(sourceRegion)) return false;
      // Russian/Mongolian border streets leak Cyrillic; a CN street is never Cyrillic.
      if (/[Ѐ-ӿ]/u.test(`${components.street || ''} ${components.buildingName || ''}`)) return false;
    }
    const anchored = geocoder.resolveHierarchy(Number(record.latitude), Number(record.longitude), {
      sourceAdmin1: components.admin1 || record.admin1 || ''
    });
    // No city-tier anchor within range => point is off-grid or cross-border; drop.
    if (!anchored) return false;
    components.admin1 = anchored.admin1;
    components.admin1Code = anchored.admin1Code || components.admin1Code || '';
    components.locality = anchored.city;
    components.postalLocality = anchored.city;
    if (anchored.district) {
      components.district = anchored.district;
      components.dependentLocality = anchored.district;
      record.district = anchored.district;
    } else {
      components.district = '';
      components.dependentLocality = '';
      record.district = '';
    }
    record.englishComponentHints = {
      ...(record.englishComponentHints || {}),
      admin1: anchored.admin1En, locality: anchored.cityEn,
      ...(anchored.districtEn ? { district: anchored.districtEn } : {})
    };
    record.chineseComponentHints = {
      ...(record.chineseComponentHints || {}),
      admin1: anchored.admin1Zh || anchored.admin1, locality: anchored.cityZh || anchored.city,
      ...(anchored.districtZh || anchored.district ? { district: anchored.districtZh || anchored.district } : {})
    };
    record.admin1 = components.admin1;
    record.admin1Code = components.admin1Code;
    record.locality = components.locality;
    record.postalLocality = components.postalLocality;
    // OSM name tags sometimes hold "中文 English" in one value; keep the Han part
    // as native and route the Latin part to the English hint (Han-script countries only).
    if (countryCode === 'CN' || countryCode === 'TW') {
      for (const field of ['street', 'buildingName']) {
        const value = String(components[field] || '').trim();
        const mixed = value.match(/^([^A-Za-z]*\p{Script=Han}[^A-Za-z]*)\s+([A-Za-z][A-Za-z' .’-]+)$/u);
        if (mixed) {
          components[field] = mixed[1].trim();
          record.englishComponentHints[field] = record.englishComponentHints[field] || mixed[2].trim();
          if (field === 'street') record.street = components.street;
          if (field === 'buildingName') record.buildingName = components.buildingName;
        }
      }
    }
    if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    const policy = requiredAdminFields[countryCode] || { region: false, city: false };
    if (policy.region && !hasRegion(components)) return false;
    if (policy.city && !hasCity(components)) return false;
    if (policy.district && !(components.district || '').trim()) return false;
    return true;
  }
  const softFix = softLocalityFixes[countryCode];
  if (softFix) {
    const locality = String(components.locality || '').trim();
    if (locality && softFix.demote.test(locality)) {
      // Preserve the fine-grained name for sampling-bucket diversity before replacing.
      record.samplingLocality = locality;
      let replacement = '';
      if (softFix.replaceWith === 'admin1') {
        replacement = String(components.admin1 || record.admin1 || '').trim();
      } else if (softFix.replaceWith === 'anchor' && geocoder?.hierarchyReady) {
        const anchored = geocoder.resolveHierarchy(Number(record.latitude), Number(record.longitude), {
          sourceAdmin1: components.admin1 || record.admin1 || ''
        });
        const city = String(anchored?.city || '').trim();
        replacement = city && !softFix.demote.test(city) ? city : '';
      }
      if (!replacement) return false;
      components.locality = replacement;
      if (components.postalLocality && softFix.demote.test(components.postalLocality)) {
        components.postalLocality = replacement;
      }
      record.locality = replacement;
      if (record.postalLocality && softFix.demote.test(record.postalLocality)) record.postalLocality = replacement;
      if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    }
  }
  if (catalogAnchoredAdmin1Countries.has(countryCode) && geocoder?.regions?.length) {
    const sourceAdmin1 = String(components.admin1 || '').trim();
    if (sourceAdmin1 && !matchesCatalogRegion(geocoder, sourceAdmin1)) {
      const region = geocoder.nearestRegion(Number(record.latitude), Number(record.longitude), 10);
      if (!region) return false;
      components.admin1 = region.native_name || region.name || '';
      components.admin1Code = region.code || '';
      record.admin1 = components.admin1;
      record.admin1Code = components.admin1Code;
      record.englishComponentHints = { ...(record.englishComponentHints || {}), admin1: region.name || components.admin1 };
      if (region.zh_name) {
        record.chineseComponentHints = { ...(record.chineseComponentHints || {}), admin1: region.zh_name };
      }
      if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    }
  }
  if (geocoder?.available) {
    const filled = geocoder.lookup(record);
    let enriched = false;
    if (filled.admin1 && (!components.admin1 || filled.replaceRegion)) {
      components.admin1 = filled.admin1;
      if (filled.admin1Code) components.admin1Code = filled.admin1Code;
      record.englishComponentHints = record.englishComponentHints || {};
      if (filled.admin1En) record.englishComponentHints.admin1 = filled.admin1En;
      if (filled.admin1Zh) record.chineseComponentHints = { ...(record.chineseComponentHints || {}), admin1: filled.admin1Zh };
      enriched = true;
    }
    if (filled.locality && (!components.locality || filled.replaceCity)) {
      components.locality = filled.locality;
      if (filled.replaceCity && components.postalLocality) components.postalLocality = filled.locality;
      record.englishComponentHints = record.englishComponentHints || {};
      if (filled.localityEn) record.englishComponentHints.locality = filled.localityEn;
      if (filled.localityZh) record.chineseComponentHints = { ...(record.chineseComponentHints || {}), locality: filled.localityZh };
      enriched = true;
    }
    if (enriched) {
      record.admin1 = components.admin1 || '';
      record.admin1Code = components.admin1Code || record.admin1Code || '';
      record.locality = components.locality || '';
      if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
    }
  }
  const policy = requiredAdminFields[countryCode] || { region: false, city: false };
  if (policy.region && !hasRegion(components)) return false;
  if (policy.city && !hasCity(components)) return false;
  if (policy.district && !(components.district || '').trim()) return false;
  // Cross-border leakage guard: a mainland-China record must never carry an HK/Macau region.
  if (countryCode === 'CN') {
    const region = `${components.admin1 || ''} ${record.admin1 || ''}`;
    if (/香港|澳門|澳门|hong\s?kong|macau|macao/iu.test(region)) return false;
  }
  return true;
};
const applyQualityGate = (record, countryCode, rebuildFormattedAddress) => {
  const hierarchy = validateAdministrativeHierarchy({
    countryCode, admin1: record.components.admin1, admin1Code: record.components.admin1Code
  });
  if (!hierarchy.valid) return { valid: false, reasons: [hierarchy.reason], components: record.components };
  const quality = validateAddressQuality({
    countryCode, components: record.components, latitude: record.latitude, longitude: record.longitude
  });
  if (!quality.valid) return quality;
  record.components = quality.components;
  for (const field of ['admin1', 'admin1Code', 'locality', 'postalLocality', 'district', 'postcode', 'street', 'houseNumber', 'buildingName', 'unit']) {
    record[field] = quality.components[field] || '';
  }
  if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(record.components, countryCode);
  return quality;
};
const reconcilePostalHierarchy = (record, geocoder, countryCode, rebuildFormattedAddress) => {
  if (!postalHierarchyCountries.has(countryCode) || !geocoder?.postalAvailable) {
    return { valid: true, corrected: false };
  }
  const resolution = geocoder.resolvePostalRegion(record);
  if (resolution.status !== 'resolved') return { valid: false, reason: resolution.status };
  const region = resolution.region;
  const components = record.components;
  const compatiblePhilippineProvince = countryCode === 'PH'
    ? geocoder.moreSpecificCompatibleSourceRegion(region, components.admin1, components.admin1Code)
    : null;
  const effectiveRegion = compatiblePhilippineProvince || region;
  // US catalog native_name has contained truncated/corrupt labels (for example
  // "Down" for Alaska). USPS state names/codes are English, so name is the
  // authoritative label for US reconciliation.
  const admin1 = countryCode === 'US'
    ? (effectiveRegion.name || effectiveRegion.native_name || '')
    : (effectiveRegion.native_name || effectiveRegion.name || '');
  const admin1Code = effectiveRegion.code || '';
  const postalLocality = countryCode === 'MY' ? String(resolution.postalLocality || '').trim() : '';
  const corrected = foldAdmin1(components.admin1) !== foldAdmin1(admin1)
    || foldAdmin1(components.admin1Code) !== foldAdmin1(admin1Code)
    || (postalLocality && foldAdmin1(components.postalLocality) !== foldAdmin1(postalLocality));
  components.admin1 = admin1;
  components.admin1Code = admin1Code;
  if (postalLocality) components.postalLocality = postalLocality;
  record.admin1 = admin1;
  record.admin1Code = admin1Code;
  if (postalLocality) record.postalLocality = postalLocality;
  record.englishComponentHints = {
    ...(record.englishComponentHints || {}),
    admin1: effectiveRegion.name || admin1,
    ...(postalLocality ? { postalLocality: resolution.postalLocalityEn || postalLocality } : {})
  };
  if (effectiveRegion.zh_name) {
    record.chineseComponentHints = { ...(record.chineseComponentHints || {}), admin1: effectiveRegion.zh_name };
  }
  if (postalLocality && resolution.postalLocalityZh) {
    record.chineseComponentHints = {
      ...(record.chineseComponentHints || {}), postalLocality: resolution.postalLocalityZh
    };
  }
  if (rebuildFormattedAddress) record.formattedAddress = rebuildFormattedAddress(components, countryCode);
  return { valid: true, corrected };
};
const refreshRecordIdentity = (record, hash) => {
  const canonicalHash = hash([
    record.countryCode, record.admin1, record.locality, record.postcode, record.street, record.houseNumber,
    record.unit, Number(record.longitude).toFixed(6), Number(record.latitude).toFixed(6)
  ].map((part) => String(part ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('und')).join('\u001f'));
  record.canonicalHash = canonicalHash;
  record.id = `addr-${canonicalHash.slice(0, 40)}`;
};
export const ADDRESS_IMPORT_REVISION = 'strict-residential-v27';

export class SourceQualityError extends Error {
  constructor(shardId, retrySignature, rejectionReasons, metrics = {}) {
    super(`Shard ${shardId} produced no valid addresses`);
    this.name = 'SourceQualityError';
    this.code = 'SOURCE_QUALITY_FAILED';
    this.failureSignature = retrySignature;
    this.rejectionReasons = rejectionReasons;
    this.metrics = { ...metrics, rejectionReasons };
  }
}

export class SnapshotQualityError extends Error {
  constructor(shardId, failures, metrics, failureSignature = '') {
    super(`Shard ${shardId} failed snapshot quality gates: ${failures.join('; ')}`);
    this.name = 'SnapshotQualityError';
    this.code = 'SNAPSHOT_QUALITY_FAILED';
    this.failureSignature = failureSignature;
    this.rejectionReasons = metrics.rejectionReasons || {};
    this.metrics = metrics;
  }
}

const coverageKey = (record) => [
  'sync', record.countryCode, cleanKey(record.admin1Code || record.admin1) || '*',
  cleanKey(record.postalLocality || record.locality) || '*', record.propertyType
].join(':');

const variants = (record) => ({
  components: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, record.localizations[language].components])),
  addresses: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, record.localizations[language].formattedAddress]))
});

const sourceStatement = (database, shard, observedAt) => database.prepare(`
  INSERT INTO address_sources(
    id,name,homepage_url,data_url,license_code,license_name,license_url,attribution_text,
    attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,metadata_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,data_url=excluded.data_url,license_code=excluded.license_code,
    license_name=excluded.license_name,license_url=excluded.license_url,
    attribution_text=excluded.attribution_text,attribution_url=excluded.attribution_url,
    terms_url=excluded.terms_url,share_alike=excluded.share_alike,
    notice_required=excluded.notice_required,redistribution_allowed=excluded.redistribution_allowed,
    metadata_json=excluded.metadata_json,updated_at=excluded.updated_at
`).bind(
  shard.source.id, shard.source.name, shard.source.homepageUrl, shard.source.dataUrl,
  shard.source.licenseCode, shard.source.licenseName, shard.source.licenseUrl,
  shard.source.attributionText, shard.source.attributionUrl, shard.source.termsUrl,
  Number(Boolean(shard.source.shareAlike)), Number(Boolean(shard.source.noticeRequired)),
  Number(shard.source.redistributionAllowed !== false), JSON.stringify({ adapter: shard.source.adapter }),
  observedAt, observedAt
);

const datasetStatement = (database, { datasetId, datasetVersion, shard, discovery, materialized, observedAt }) => database.prepare(`
  INSERT INTO address_datasets(
    id,source_id,country_code,version,published_at,retrieved_at,imported_at,input_checksum,format,
    license_code,license_name,license_url,attribution_text,attribution_url,terms_url,
    share_alike,notice_required,redistribution_allowed,accepted_count,rejected_count,active_count,status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')
  ON CONFLICT(id) DO UPDATE SET version=excluded.version,published_at=excluded.published_at,
    retrieved_at=excluded.retrieved_at,imported_at=excluded.imported_at,input_checksum=excluded.input_checksum,
    format=excluded.format,status='pending'
`).bind(
  datasetId, shard.source.id, shard.countryCode, datasetVersion, discovery.publishedAt || null,
  observedAt, observedAt, materialized.checksum, materialized.format,
  shard.source.licenseCode, shard.source.licenseName, shard.source.licenseUrl,
  shard.source.attributionText, shard.source.attributionUrl, shard.source.termsUrl,
  Number(Boolean(shard.source.shareAlike)), Number(Boolean(shard.source.noticeRequired)),
  Number(shard.source.redistributionAllowed !== false), 0, 0, 0
);

const addressStatements = (database, records, context) => {
  const addressBindings = [];
  const addressRows = records.map((record) => {
    const localized = variants(record);
    const coverage = coverageKey(record);
    addressBindings.push(
      record.id, record.countryCode, record.admin1, record.admin1Code, record.locality, record.postalLocality,
      record.district, record.postcode, record.street, record.houseNumber, record.buildingName,
      record.latitude, record.longitude, record.nativeLanguage, JSON.stringify(localized.components),
      JSON.stringify(localized.addresses), cleanKey(record.admin1), cleanKey(record.admin1Code),
      cleanKey(record.locality), cleanKey(record.postalLocality), cleanKey(record.district), postcodeKey(record.postcode),
      record.propertyType, record.qualityScore, context.datasetId, coverage, randomKey(record.canonicalHash),
      context.observedAt, context.observedAt, context.expiresAt
    );
    return '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,NULL)';
  });
  const address = database.prepare(`
    INSERT INTO address_pool(
      id,country_code,admin1,admin1_code,locality,postal_locality,district,postcode,street,house_number,
      building_name,latitude,longitude,native_language,component_variants_json,address_variants_json,
      admin1_key,admin1_code_key,locality_key,postal_locality_key,district_key,postcode_key,property_type,
      quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,expires_at,retired_at
    ) VALUES ${addressRows.join(',')}
    ON CONFLICT(id) DO UPDATE SET
      admin1=excluded.admin1,admin1_code=excluded.admin1_code,locality=excluded.locality,
      postal_locality=excluded.postal_locality,district=excluded.district,postcode=excluded.postcode,
      street=excluded.street,house_number=excluded.house_number,building_name=excluded.building_name,
      latitude=excluded.latitude,longitude=excluded.longitude,native_language=excluded.native_language,
      component_variants_json=excluded.component_variants_json,address_variants_json=excluded.address_variants_json,
      admin1_key=excluded.admin1_key,admin1_code_key=excluded.admin1_code_key,
      locality_key=excluded.locality_key,postal_locality_key=excluded.postal_locality_key,
      district_key=excluded.district_key,postcode_key=excluded.postcode_key,
      property_type=excluded.property_type,quality_score=GREATEST(address_pool.quality_score,excluded.quality_score),
      generation=excluded.generation,coverage=excluded.coverage,active=1,last_seen_at=excluded.last_seen_at,
      expires_at=excluded.expires_at,retired_at=NULL
  `).bind(...addressBindings);
  const evidenceBindings = [];
  const evidenceRows = records.flatMap((record) => {
    const evidence = [{ type: 'address_existence', sourceRecordId: record.sourceRecordId }];
    if ((record.propertyType === 'residential' || record.propertyType === 'apartment') && record.residentialSourceRecordId) {
      evidence.push({ type: 'residential_use', sourceRecordId: record.residentialSourceRecordId || record.sourceRecordId });
    }
    return evidence.map(({ type, sourceRecordId }) => {
        evidenceBindings.push(
          context.hash(`${context.datasetId}\u001f${record.id}\u001f${sourceRecordId}\u001f${type}`),
          record.id, context.datasetId, sourceRecordId, context.discovery.dataUrl || '', context.observedAt,
          type, context.observedAt
        );
        return '(?,?,?,?,?,?,?,0,1,?)';
      });
  });
  const evidence = database.prepare(`
      INSERT INTO address_pool_evidence(
        id,address_id,dataset_id,source_record_id,record_url,observed_at,evidence_type,is_primary,is_current,created_at
      ) VALUES ${evidenceRows.join(',')}
      ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,is_current=1
    `).bind(...evidenceBindings);
  return [address, evidence];
};

export class PostgresAddressImporter {
  constructor({ database, normalizeRecord, localizeRecords, hash, reverseGeocoder, rebuildFormattedAddress }) {
    this.database = database;
    this.normalizeRecord = normalizeRecord;
    this.localizeRecords = localizeRecords;
    this.hash = hash;
    this.reverseGeocoder = reverseGeocoder;
    this.rebuildFormattedAddress = rebuildFormattedAddress;
  }

  async importShard({ shard, discovery, materialized, maxRecords, sourceMaxRecords = maxRecords, perLocality, policy, batchSize = 800 }) {
    const activePolicy = policy || {
      targetCount: maxRecords,
      levelLimits: [maxRecords, perLocality, perLocality, perLocality],
      overrides: new Map()
    };
    const policyIdentity = {
      targetCount: activePolicy.targetCount,
      levelLimits: activePolicy.levelLimits,
      sourceMaxRecords,
      overrides: [...activePolicy.overrides].sort(([left], [right]) => left.localeCompare(right)),
      floors: {
        level1Min: Number(activePolicy.level1Min) || 0,
        level2Min: Number(activePolicy.level2Min) || 0,
        minPerNode: Number(activePolicy.minPerNode) || 0,
        nodes: [...(activePolicy.nodeFloors || new Map())].sort(([left], [right]) => left.localeCompare(right))
      }
    };
    if (materialized.methodRevision) policyIdentity.methodRevision = materialized.methodRevision;
    const policyHash = this.hash(JSON.stringify(policyIdentity)).slice(0, 8);
    const generatedDatasetId = `${shard.id}-${String(discovery.version).replace(/[^a-zA-Z0-9._-]/gu, '_')}-${materialized.checksum.slice(0, 12)}-${ADDRESS_IMPORT_REVISION}-${policyHash}`;
    const datasetVersion = `${String(discovery.version)}-${ADDRESS_IMPORT_REVISION}-${policyHash}`;
    const existingIdentity = await this.database.prepare(`SELECT id,status,active_count,rejected_count
      FROM address_datasets WHERE source_id=? AND country_code=? AND version LIKE ? AND input_checksum=?
      ORDER BY imported_at DESC LIMIT 1`).bind(
      shard.source.id, shard.countryCode, `${String(discovery.version)}-%`, materialized.checksum
    ).first();
    const datasetId = existingIdentity?.id ? String(existingIdentity.id) : generatedDatasetId;
    const existing = await this.database.prepare("SELECT status,active_count,rejected_count FROM address_datasets WHERE id=?").bind(datasetId).first();
    if (existing?.status === 'active' && datasetId === generatedDatasetId) {
      return {
        datasetId,
        acceptedCount: Number(existing.active_count),
        residentialCount: Number(existing.active_count),
        rejectedCount: Number(existing.rejected_count),
        rejectionReasons: {},
        metrics: null,
        skipped: true
      };
    }

    const seen = new Set();
    const candidates = [];
    let rejectedCount = 0;
    let postalCorrections = 0;
    const rejectionReasons = new Map();
    const reject = (reasons) => {
      rejectedCount += 1;
      for (const reason of reasons) rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1);
    };
    const geocoder = this.reverseGeocoder ? await this.reverseGeocoder(shard.countryCode) : null;
    for await (const value of readJsonLines(materialized.file)) {
      const record = this.normalizeRecord(value, shard, materialized.format);
      if (!record) {
        reject(['invalid_source_record']);
        continue;
      }
      if (!enrichAndValidate(record, geocoder, shard.countryCode, this.rebuildFormattedAddress)) {
        reject(['invalid_administrative_hierarchy']);
        continue;
      }
      const postalHierarchy = reconcilePostalHierarchy(
        record, geocoder, shard.countryCode, this.rebuildFormattedAddress
      );
      if (!postalHierarchy.valid) {
        reject([postalHierarchy.reason]);
        continue;
      }
      if (postalHierarchy.corrected) postalCorrections += 1;
      refreshRecordIdentity(record, this.hash);
      if (seen.has(record.canonicalHash)) {
        reject(['duplicate']);
        continue;
      }
      const quality = applyQualityGate(record, shard.countryCode, this.rebuildFormattedAddress);
      if (!quality.valid) {
        reject(quality.reasons);
        continue;
      }
      if (!['residential', 'apartment'].includes(record.propertyType) || !record.residentialSourceRecordId) {
        reject(['missing_residential_evidence']);
        continue;
      }
      seen.add(record.canonicalHash);
      candidates.push(record);
    }
    candidates.sort((left, right) =>
      Number(Boolean(right.residentialSourceRecordId)) - Number(Boolean(left.residentialSourceRecordId))
      || Number(right.qualityScore || 0) - Number(left.qualityScore || 0)
      || left.canonicalHash.localeCompare(right.canonicalHash));
    const records = applyHierarchicalQuota(candidates, {
      ...activePolicy,
      targetCount: Math.min(activePolicy.targetCount, sourceMaxRecords),
      maxRecords: sourceMaxRecords
    });
    if (!records.length) {
      throw new SourceQualityError(
        shard.id,
        discovery.failureSignature || '',
        Object.fromEntries(rejectionReasons),
        { candidateCount: 0, rejectedCount }
      );
    }

    const localityCounts = new Map();
    for (const record of records) {
      const locality = cleanKey(record.samplingLocality || record.components.locality
        || record.components.postalLocality || record.postcode || '*');
      localityCounts.set(locality, (localityCounts.get(locality) || 0) + 1);
    }

    const localized = [];
    for (let offset = 0; offset < records.length; offset += batchSize) {
      localized.push(...await this.localizeRecords(records.slice(offset, offset + batchSize)));
    }
    const candidateAdmin1Count = new Set(localized
      .map((record) => cleanKey(record.admin1Code || record.admin1 || record.district))
      .filter(Boolean)).size;
    const previous = await this.database.prepare(`SELECT dataset.id,dataset.version,dataset.active_count,
      COUNT(DISTINCT coalesce(nullif(trim(pool.admin1_key),''),nullif(trim(pool.district_key),''))) AS admin1_count
      FROM address_datasets dataset
      LEFT JOIN address_pool_evidence evidence ON evidence.dataset_id=dataset.id
        AND evidence.evidence_type='address_existence' AND evidence.is_current=1
      LEFT JOIN address_pool pool ON pool.id=evidence.address_id AND pool.active=1
      WHERE dataset.source_id=? AND dataset.country_code=? AND dataset.status='active'
      GROUP BY dataset.id,dataset.version,dataset.active_count,dataset.imported_at
      ORDER BY dataset.imported_at DESC LIMIT 1`
    ).bind(shard.source.id, shard.countryCode).first();
    const configuredGate = shard.qualityGate || {};
    const effectiveMaxRecords = Math.min(activePolicy.targetCount, sourceMaxRecords);
    const compactMinimum = shard.countryCode === 'SG' ? 50 : shard.countryCode === 'HK' ? 500 : 1_000;
    const defaultMinimumRecords = effectiveMaxRecords >= 1_000
      ? Math.max(10, Math.min(compactMinimum, Math.ceil(effectiveMaxRecords * 0.01))) : 1;
    const defaultMinimumAdmin1 = shard.countryCode === 'SG'
      ? 0 : effectiveMaxRecords >= 1_000 && shard.countryCode !== 'HK' ? 2 : 1;
    const minimumRecords = configuredGate.minimumRecords
      ?? (previous ? Math.min(defaultMinimumRecords, Number(previous.active_count || 0) || 1) : 1);
    const minimumAdmin1 = configuredGate.minimumAdmin1
      ?? (previous ? Math.min(defaultMinimumAdmin1, Number(previous.admin1_count || 0)) : Math.min(defaultMinimumAdmin1, 1));
    const previousUsesCurrentRevision = Boolean(previous?.id
      && (String(previous.version || '').endsWith(`-${ADDRESS_IMPORT_REVISION}`)
        || String(previous.version || '').includes(`-${ADDRESS_IMPORT_REVISION}-`)));
    // Postal reconciliation intentionally removes or rekeys invalid legacy rows.
    // Permit only the measured migration shards to replace their older pools;
    // subsequent v27 refreshes retain the normal 95% protection.
    const germanPostalMigration = shard.countryCode === 'DE'
      && germanPostalMigrationShards.has(shard.id) && previous?.id && !previousUsesCurrentRevision;
    const migrationMinimumRatio = shard.countryCode === 'IN' && previous?.id && !previousUsesCurrentRevision
      ? 0.85 : germanPostalMigration ? 0.80 : DEFAULT_MINIMUM_RATIO;
    const minimumCountRatio = Math.max(configuredGate.minimumCountRatio ?? migrationMinimumRatio, migrationMinimumRatio);
    const minimumAdmin1Ratio = configuredGate.minimumAdmin1Ratio ?? DEFAULT_MINIMUM_RATIO;
    const metrics = {
      candidateCount: localized.length,
      candidateAdmin1Count,
      previousCount: Number(previous?.active_count || 0),
      previousAdmin1Count: Number(previous?.admin1_count || 0),
      minimumRecords,
      minimumAdmin1,
      minimumCountRatio,
      minimumAdmin1Ratio,
      importRevision: ADDRESS_IMPORT_REVISION,
      methodRevision: materialized.methodRevision || null,
      policyHash,
      postalCorrections,
      rejectionReasons: Object.fromEntries([...rejectionReasons].sort(([left], [right]) => left.localeCompare(right)))
    };
    const failures = [];
    if (metrics.candidateCount < minimumRecords) failures.push(`count ${metrics.candidateCount} < ${minimumRecords}`);
    if (metrics.candidateAdmin1Count < minimumAdmin1) failures.push(`admin1 coverage ${metrics.candidateAdmin1Count} < ${minimumAdmin1}`);
    const previousCountFloor = Math.ceil(Math.min(
      metrics.previousCount * minimumCountRatio,
      effectiveMaxRecords * minimumCountRatio
    ));
    if (metrics.previousCount && metrics.candidateCount < previousCountFloor) {
      failures.push(`count ${metrics.candidateCount} < protected previous floor ${previousCountFloor}`);
    }
    // Administrative coverage remains method-relative because revisions can intentionally
    // normalize many aliases into a smaller canonical region set.
    const sameRevision = Boolean(
      previous?.id
      && previousUsesCurrentRevision
      && String(previous.id).endsWith(`-${ADDRESS_IMPORT_REVISION}-${policyHash}`)
    );
    if (sameRevision) {
      if (metrics.previousAdmin1Count && metrics.candidateAdmin1Count < Math.ceil(metrics.previousAdmin1Count * minimumAdmin1Ratio)) {
        failures.push(`admin1 ratio ${(metrics.candidateAdmin1Count / metrics.previousAdmin1Count).toFixed(3)} < ${minimumAdmin1Ratio}`);
      }
    }
    if (failures.length) throw new SnapshotQualityError(shard.id, failures, metrics, discovery.failureSignature || '');
    const observedAt = new Date().toISOString();
    const context = { datasetId, discovery, observedAt, expiresAt: expiry(new Date(observedAt)), hash: this.hash };
    await this.database.exec('BEGIN');
    try {
      await this.database.batch([
        sourceStatement(this.database, shard, observedAt),
        datasetStatement(this.database, { datasetId, datasetVersion, shard, discovery, materialized, observedAt })
      ]);
      for (let offset = 0; offset < localized.length; offset += batchSize) {
        await this.database.batch(addressStatements(this.database, localized.slice(offset, offset + batchSize), context));
        await new Promise((resolve) => setImmediate(resolve));
      }
      await this.database.batch([
        this.database.prepare(`UPDATE address_pool_evidence SET is_primary=0
          WHERE is_primary=1 AND address_id IN (
            SELECT address_id FROM address_pool_evidence WHERE dataset_id=? AND evidence_type='address_existence'
          )`).bind(datasetId),
        this.database.prepare("UPDATE address_pool_evidence SET is_primary=1,is_current=1 WHERE dataset_id=? AND evidence_type='address_existence'").bind(datasetId),
        this.database.prepare(`UPDATE address_pool_evidence SET is_primary=0,is_current=0
          WHERE dataset_id IN (
            SELECT id FROM address_datasets WHERE source_id=? AND country_code=? AND id<>? AND status IN ('pending','active')
          )`).bind(shard.source.id, shard.countryCode, datasetId),
        this.database.prepare("UPDATE address_datasets SET status='retired',active_count=0 WHERE source_id=? AND country_code=? AND id<>? AND status IN ('pending','active')")
          .bind(shard.source.id, shard.countryCode, datasetId),
        this.database.prepare("UPDATE address_datasets SET status='active',accepted_count=?,rejected_count=? WHERE id=?")
          .bind(localized.length, rejectedCount, datasetId),
        this.database.prepare(`UPDATE address_pool SET active=0,retired_at=?
          WHERE country_code=? AND active=1 AND id NOT IN (
            SELECT evidence.address_id FROM address_pool_evidence evidence
            JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
            WHERE dataset.country_code=? AND evidence.is_current=1
              AND dataset.status IN ('pending','active')
          )`).bind(observedAt, shard.countryCode, shard.countryCode),
        this.database.prepare(`UPDATE address_pool SET active=1,retired_at=NULL
          WHERE country_code=? AND id IN (
            SELECT evidence.address_id FROM address_pool scoped
            JOIN address_pool_evidence evidence ON evidence.address_id=scoped.id
            JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
            WHERE scoped.country_code=? AND evidence.is_current=1
              AND dataset.status IN ('pending','active')
          )`).bind(shard.countryCode, shard.countryCode),
        this.database.prepare(`UPDATE address_pool_evidence SET is_primary=0
          WHERE evidence_type='address_existence' AND address_id IN (
            SELECT id FROM address_pool WHERE country_code=?
          )`).bind(shard.countryCode),
        this.database.prepare(`UPDATE address_pool SET active=0,retired_at=?
          WHERE country_code=? AND id IN (
            SELECT evidence.address_id FROM address_pool scoped
            JOIN address_pool_evidence evidence ON evidence.address_id=scoped.id
            JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
            WHERE scoped.country_code=? AND evidence.is_current=1
              AND dataset.status='active'
          )`).bind(observedAt, shard.countryCode, shard.countryCode)
      ]);
      const primaryEvidenceRows = (await this.database.prepare(`SELECT candidate.id,candidate.address_id
        FROM address_pool_evidence candidate
        JOIN address_datasets dataset ON dataset.id=candidate.dataset_id
        JOIN address_pool address ON address.id=candidate.address_id
        WHERE address.country_code=? AND candidate.is_current=1
          AND candidate.evidence_type='address_existence' AND dataset.status='active'
        ORDER BY candidate.address_id,dataset.imported_at DESC,candidate.id`).bind(shard.countryCode).all()).results;
      const primaryEvidenceIds = [];
      const primaryAddresses = new Set();
      for (const row of primaryEvidenceRows) {
        if (primaryAddresses.has(row.address_id)) continue;
        primaryAddresses.add(row.address_id);
        primaryEvidenceIds.push(row.id);
      }
      for (let offset = 0; offset < primaryEvidenceIds.length; offset += batchSize) {
        const ids = primaryEvidenceIds.slice(offset, offset + batchSize);
        await this.database.prepare(`UPDATE address_pool_evidence SET is_primary=1
          WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
      }
      const countryCandidates = (await this.database.prepare(`SELECT id,country_code,admin1,locality,postal_locality,district,
          quality_score,random_key FROM address_pool address
        WHERE country_code=? AND address.id IN (
          SELECT evidence.address_id FROM address_pool_evidence evidence
          JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
          WHERE evidence.is_current=1 AND dataset.status='active'
        ) ORDER BY quality_score DESC,random_key,id`).bind(shard.countryCode).all()).results;
      const published = applyHierarchicalQuota(countryCandidates.map((row) => ({
        id: String(row.id),
        countryCode: String(row.country_code),
        components: {
          admin1: String(row.admin1 || ''),
          locality: String(row.locality || ''),
          postalLocality: String(row.postal_locality || ''),
          district: String(row.district || '')
        }
      })), activePolicy);
      for (let offset = 0; offset < published.length; offset += batchSize) {
        const ids = published.slice(offset, offset + batchSize).map(({ id }) => id);
        await this.database.prepare(`UPDATE address_pool SET active=1,retired_at=NULL
          WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
      }
      const activeDatasets = (await this.database.prepare(`SELECT id FROM address_datasets
        WHERE country_code=? AND status='active'`).bind(shard.countryCode).all()).results;
      for (const dataset of activeDatasets) {
        const activeCount = await this.database.prepare(`SELECT COUNT(DISTINCT evidence.address_id) AS total
          FROM address_pool_evidence evidence JOIN address_pool address ON address.id=evidence.address_id
          WHERE evidence.dataset_id=? AND evidence.is_current=1 AND address.active=1`).bind(dataset.id).first('total');
        await this.database.prepare('UPDATE address_datasets SET active_count=? WHERE id=?')
          .bind(Number(activeCount || 0), dataset.id).run();
      }
      const coverageTarget = activePolicy.levelLimits[1] || perLocality;
      await this.database.prepare('DELETE FROM pool_coverage WHERE country_code=?').bind(shard.countryCode).run();
      await this.database.prepare(`INSERT INTO pool_coverage(
          coverage_key,country_code,admin1_key,locality_key,postcode_key,property_type,target_count,
          active_count,shadow_count,residential_count,refresh_status,generation,last_refreshed_at,expires_at
        ) SELECT coverage,country_code,
          coalesce(nullif(admin1_code_key,''),admin1_key),
          coalesce(nullif(postal_locality_key,''),locality_key),min(postcode_key),property_type,CAST(? AS INTEGER),
          count(*),0,sum(CASE WHEN property_type IN ('residential','apartment') THEN 1 ELSE 0 END),
          CASE WHEN count(*)>=CAST(? AS INTEGER) THEN 'ready' ELSE 'low' END,?,?,?
        FROM address_pool WHERE country_code=? AND active=1
        GROUP BY coverage,country_code,coalesce(nullif(admin1_code_key,''),admin1_key),
          coalesce(nullif(postal_locality_key,''),locality_key),property_type`
      ).bind(coverageTarget, coverageTarget, datasetId, observedAt, context.expiresAt, shard.countryCode).run();
      await this.database.batch([
        this.database.prepare(`DELETE FROM address_pool_evidence WHERE dataset_id IN (
          SELECT id FROM address_datasets WHERE source_id=? AND country_code=? AND status='retired'
        )`).bind(shard.source.id, shard.countryCode),
        this.database.prepare("DELETE FROM address_datasets WHERE source_id=? AND country_code=? AND status='retired'")
          .bind(shard.source.id, shard.countryCode),
        this.database.prepare(`DELETE FROM address_pool WHERE country_code=? AND active=0
          AND id NOT IN (
            SELECT evidence.address_id FROM address_pool_evidence evidence
            JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
            WHERE dataset.country_code=?
          )`).bind(shard.countryCode, shard.countryCode)
      ]);
      await this.database.exec('COMMIT');
    } catch (error) {
      await this.database.exec('ROLLBACK').catch(() => {});
      throw error;
    }
    const residentialCount = localized.filter((record) => record.propertyType === 'residential' || record.propertyType === 'apartment').length;
    return {
      datasetId, acceptedCount: localized.length, rejectedCount, localityCount: localityCounts.size,
      admin1Count: candidateAdmin1Count, residentialCount,
      metrics,
      rejectionReasons: Object.fromEntries([...rejectionReasons].sort(([left], [right]) => left.localeCompare(right))),
      skipped: false
    };
  }

  async close() {}
}

async function* readJsonLines(file) {
  const { createReadStream } = await import('node:fs');
  let pending = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const text = line.replace(/^\u001e/u, '').trim();
      if (text) yield JSON.parse(text);
    }
  }
  if (pending) {
    const line = pending;
    const text = line.replace(/^\u001e/u, '').trim();
    if (text) yield JSON.parse(text);
  }
}
