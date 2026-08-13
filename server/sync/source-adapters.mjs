import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';
import { postcodePatterns } from '../../src/domain/postcode-patterns.mjs';

const syncRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const catalogFile = resolve(syncRoot, 'source-shards.json');
const overtureExporter = resolve(syncRoot, 'overture-export.py');
const geofabrikExporter = resolve(syncRoot, 'geofabrik-export.py');
const japanAbrExporter = resolve(syncRoot, 'japan-abr-export.py');
const japanPlateauExtractor = resolve(syncRoot, 'extract-tar-zstd.py');
const singaporeHdbExporter = resolve(syncRoot, 'singapore-hdb-export.py');
const koreaKaptExporter = resolve(syncRoot, 'korea-kapt-export.py');
const openAddressesExporter = resolve(syncRoot, 'openaddresses-export.py');
const inegiResidentialExporter = resolve(syncRoot, 'inegi-residential-export.py');
const ethekwiniResidentialExporter = resolve(syncRoot, 'south-africa-ethekwini-export.py');
const capeTownResidentialExporter = resolve(syncRoot, 'south-africa-cape-town-export.py');
const taiwanResidentialExporter = resolve(syncRoot, 'taiwan-residential-export.py');
const hongKongResidentialExporter = resolve(syncRoot, 'hong-kong-residential-export.py');
const licensedResidentialExporter = resolve(syncRoot, 'licensed-residential-export.py');
const overtureResidentialRevision = 'residential-buildings-v9';
const geofabrikExportRevision = 'g71';
const vietnamGeofabrikExportRevision = 'vn-two-tier-v5';
const japanAbrExportRevision = 'abr-rsdt-plateau-osm-chiban-v10';
const singaporeHdbExportRevision = 'hdb-property-building-onemap-v2';
const koreaKaptExportRevision = 'kapt-official-apartments-v2';
const openAddressesExportRevision = 'archive-residential-v2';
const inegiResidentialExportRevision = 'official-dwelling-v1';
const ethekwiniResidentialExportRevision = 'official-address-zoning-postcode-v1';
const capeTownResidentialExportRevision = 'official-parcel-zoning-postcode-v1';
const taiwanResidentialExportRevision = 'molit-lvr-oa-post-v2';
const hongKongResidentialExportRevision = 'bd-building-information-v1';
const mapplsResidentialRevision = 'licensed-nearby-details-v2';
const licensedResidentialRevision = 'licensed-feed-v2';
const pdokBagRevision = 'strict-active-residential-coverage-round-robin-v2';
const japanMaterializeTimeoutMs = 20 * 60 * 60_000;
export const sourceAdapterRevisions = Object.freeze({
  overture: overtureResidentialRevision,
  geofabrik: geofabrikExportRevision,
  'japan-abr': japanAbrExportRevision,
  'singapore-hdb': singaporeHdbExportRevision,
  'korea-kapt': koreaKaptExportRevision,
  'openaddresses-archive': openAddressesExportRevision,
  'inegi-residential': inegiResidentialExportRevision,
  'ethekwini-residential': ethekwiniResidentialExportRevision,
  'cape-town-residential': capeTownResidentialExportRevision,
  'taiwan-residential': taiwanResidentialExportRevision,
  'hong-kong-residential': hongKongResidentialExportRevision,
  'mappls-residential': mapplsResidentialRevision,
  'licensed-residential-feed': licensedResidentialRevision,
  'pdok-bag': pdokBagRevision
});
// geoBoundaries gbOpen has no entries for these territories; use the exact OSM admin relations instead.
const osmBoundaryRelations = { HKG: 913110, MAC: 1867188 };

export const countryBounds = {
  US: [-180, 17, -64, 72], CA: [-141, 41, -52, 84], MX: [-119, 14, -86, 33],
  GB: [-9, 49, 2, 61], DE: [5, 47, 16, 56], FR: [-6, 41, 10, 52], IT: [6, 35, 19, 48],
  ES: [-19, 27, 5, 44], NL: [3, 50, 8, 54], JP: [122, 20, 154, 46],
  HK: [113, 22, 115, 23], SG: [103, 1, 105, 2], TW: [119, 21, 123, 26],
  RU: [19, 41, 180, 82], CN: [73, 18, 135, 54], KR: [124, 33, 132, 39],
  MY: [99, 0, 120, 8], TH: [97, 5, 106, 21], PH: [116, 4, 127, 22],
  VN: [102, 8, 110, 24], TR: [25, 35, 45, 43], SA: [34, 16, 56, 33],
  IN: [68, 6, 98, 36], AU: [112, -44, 154, -10], BR: [-74, -34, -34, 6],
  NG: [2, 4, 15, 14], ZA: [16, -35, 33, -22]
};

export class SourceMetadataError extends Error {
  constructor(message, { url, status = null, code = 'SOURCE_METADATA_ERROR', cause } = {}) {
    super(`${message}: ${url}`, { cause });
    this.name = 'SourceMetadataError';
    this.code = code;
    this.url = url;
    this.status = status;
  }
}

const retryableStatus = (status) => status === 408 || status === 429 || status >= 500;
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const execFileAsync = promisify(execFile);

const curlMetadataFetch = async (input, init = {}) => {
  const url = String(input);
  const parseHeaders = (stdout) => {
    const blocks = stdout.split(/\r?\n\r?\n/u).map((value) => value.trim()).filter((value) => /^HTTP\//u.test(value));
    const lines = (blocks.at(-1) || '').split(/\r?\n/u);
    const status = Number(lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/u)?.[1] || 200);
    const headers = new Headers();
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator > 0) headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    return new Response(null, { status, headers });
  };
  if ((init.method || 'GET') === 'HEAD') {
    const { stdout } = await execFileAsync('curl', ['-4', '-sSLI', '--connect-timeout', '15', '--max-time', '60', url], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true
    });
    return parseHeaders(stdout);
  }
  if (new Headers(init.headers).has('range')) {
    const sink = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const { stdout } = await execFileAsync('curl', ['-4', '-fsSL', '-r', '0-0', '-D', '-', '-o', sink,
      '--connect-timeout', '15', '--max-time', '60', url], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true
    });
    return parseHeaders(stdout);
  }
  const { stdout } = await execFileAsync('curl', ['-4', '-fsSL', '--connect-timeout', '15', '--max-time', '60', url], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true
  });
  return new Response(stdout, { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const jsonRequest = async (url, fetchImpl, { attempts = 3 } = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) {
        throw new SourceMetadataError(`Source metadata request returned HTTP ${response.status}`, {
          url, status: response.status, code: 'SOURCE_METADATA_HTTP'
        });
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/\b(application\/([^;]+\+)?json|application\/geo\+json)\b/iu.test(contentType)) {
        throw new SourceMetadataError(`Source metadata returned unexpected Content-Type ${contentType || '(missing)'}`, {
          url, status: response.status, code: 'SOURCE_METADATA_CONTENT_TYPE'
        });
      }
      try {
        return await response.json();
      } catch (error) {
        throw new SourceMetadataError('Source metadata returned invalid JSON', {
          url, status: response.status, code: 'SOURCE_METADATA_JSON', cause: error
        });
      }
    } catch (error) {
      lastError = error instanceof SourceMetadataError ? error : new SourceMetadataError('Source metadata request failed', {
        url, code: error?.name === 'TimeoutError' ? 'SOURCE_METADATA_TIMEOUT' : 'SOURCE_METADATA_NETWORK', cause: error
      });
      const retryable = !(lastError instanceof SourceMetadataError) || lastError.status === null || retryableStatus(lastError.status)
        || lastError.code === 'SOURCE_METADATA_CONTENT_TYPE' || lastError.code === 'SOURCE_METADATA_JSON';
      if (!retryable || attempt === attempts) throw lastError;
      await wait(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
};

const headRequest = async (url, fetchImpl, { attempts = 3 } = {}) => {
  let lastError;
  let lastResponse;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: 'HEAD' });
      if (response.ok || !retryableStatus(response.status)) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await wait(250 * 2 ** (attempt - 1));
  }
  if (lastResponse) return lastResponse;
  throw lastError;
};

const safeVersion = (value) => String(value).replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 96);
export const normalizedCachePolicyIdentity = (maxRecords, perLocality) =>
  `m${Number(maxRecords)}-p${Number(perLocality)}`;
const intersects = (left, right) => left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
const headerNumber = (headers, name) => {
  const value = Number(headers.get(name));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

export const sourceSizeMatches = (actual, expected) => expected === null
  || (actual >= Math.floor(expected * 0.75) && actual <= Math.ceil(expected * 1.25));

const pdokText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();

export const normalizePdokBagFeature = (feature, sourceName = 'Kadaster BAG') => {
  const properties = feature?.properties;
  const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
  if (!properties || !Array.isArray(coordinates) || properties.gebruiksdoel !== 'woonfunctie'
    || properties.status !== 'Verblijfsobject in gebruik' || properties.geconstateerd !== 'N'
    || properties.hoofdadres_status !== 'Naamgeving uitgegeven'
    || properties.openbare_ruimte_status !== 'Naamgeving uitgegeven'
    || properties.woonplaats_status !== 'Woonplaats aangewezen') return null;
  const sourceRecordId = pdokText(properties.identificatie);
  const houseNumber = Number(properties.huisnummer);
  const houseLetter = pdokText(properties.huisletter);
  const addition = pdokText(properties.toevoeging);
  const street = pdokText(properties.openbare_ruimte_naam);
  const locality = pdokText(properties.woonplaats_naam);
  const admin1 = pdokText(properties.provincie_naam);
  const postcode = pdokText(properties.postcode).toUpperCase().replace(/\s+/gu, '');
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  const safeSuffix = (value) => !value || /^[\p{L}\p{N} .'/+-]{1,16}$/u.test(value);
  if (!/^\d{16}$/u.test(sourceRecordId) || !Number.isSafeInteger(houseNumber) || houseNumber < 1
    || !safeSuffix(houseLetter) || !safeSuffix(addition) || !street || !locality || !admin1
    || !/^\d{4}[A-Z]{2}$/u.test(postcode) || !Number.isFinite(longitude) || !Number.isFinite(latitude)
    || longitude < 3 || longitude > 8 || latitude < 50 || latitude > 54) return null;
  const number = `${houseNumber}${houseLetter}${addition ? `-${addition}` : ''}`;
  return {
    id: sourceRecordId,
    source_record_id: sourceRecordId,
    source_dataset: sourceName,
    number,
    street,
    locality,
    postal_city: locality,
    admin1,
    postcode,
    longitude,
    latitude,
    property_type: 'residential',
    residential_building_id: sourceRecordId,
    residential_building_class: 'bag:woonfunctie'
  };
};

export const selectDispersedSeeds = (values, maximum = 400) => {
  const cells = new Map();
  for (const value of values || []) {
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || longitude < 3 || longitude > 8 || latitude < 50 || latitude > 54) continue;
    const key = `${Math.round(latitude / 0.08)}:${Math.round(longitude / 0.12)}`;
    if (!cells.has(key)) cells.set(key, { latitude, longitude });
  }
  const candidates = [...cells.values()];
  if (candidates.length <= maximum) return candidates;
  const selected = [candidates.splice(Math.floor(candidates.length / 2), 1)[0]];
  const minimumDistances = candidates.map((candidate) =>
    (candidate.latitude - selected[0].latitude) ** 2 + (candidate.longitude - selected[0].longitude) ** 2);
  while (selected.length < maximum && candidates.length) {
    let bestIndex = 0;
    for (let index = 1; index < candidates.length; index += 1) {
      if (minimumDistances[index] > minimumDistances[bestIndex]) bestIndex = index;
    }
    const [latest] = candidates.splice(bestIndex, 1);
    minimumDistances.splice(bestIndex, 1);
    selected.push(latest);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const distance = (candidate.latitude - latest.latitude) ** 2 + (candidate.longitude - latest.longitude) ** 2;
      minimumDistances[index] = Math.min(minimumDistances[index], distance);
    }
  }
  return selected;
};

const recentBootstrapRaw = async ({ cacheDir, shard, dataUrl, currentDate, currentBytes }) => {
  if (!cacheDir || !/^\d{4}-\d{2}-\d{2}$/u.test(currentDate)) return null;
  const directory = resolve(cacheDir, 'raw');
  let names;
  try { names = await readdir(directory); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const prefix = `${shard.id}-`;
  const suffix = `-${basename(new URL(dataUrl).pathname)}`;
  const currentTime = new Date(`${currentDate}T00:00:00.000Z`).getTime();
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const version = name.slice(prefix.length, -suffix.length);
    const match = version.match(/^(\d{4}-\d{2}-\d{2})-([a-zA-Z0-9._-]+)$/u);
    if (!match) continue;
    const publishedTime = new Date(`${match[1]}T00:00:00.000Z`).getTime();
    const age = currentTime - publishedTime;
    if (!Number.isFinite(publishedTime) || age < 0 || age > 24 * 60 * 60 * 1000) continue;
    const file = resolve(directory, name);
    const size = (await stat(file)).size;
    if (size < 1) continue;
    if (currentBytes !== null && (size < currentBytes * 0.75 || size > currentBytes * 1.25)) continue;
    candidates.push({ version, publishedAt: `${match[1]}T00:00:00.000Z`, etag: match[2], file, size, publishedTime });
  }
  return candidates.sort((left, right) => right.publishedTime - left.publishedTime || right.version.localeCompare(left.version))[0] || null;
};

const digestFile = async (file, algorithm) => {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
};

export const sha256File = (file) => digestFile(file, 'sha256');

// Postcode locator pages often contain a changing nonce, timestamp, or
// analytics markup even when the actual postal rows are unchanged. Hash only
// visible semantic text so a dynamic wrapper cannot create a new source
// version on every queue pass.
export const canonicalizeHtmlText = (html) => {
  let value = String(html || '').replace(/<!--[\s\S]*?-->/gu, ' ');
  value = value.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ');
  value = value.replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('und');
  return value;
};

export const stableHtmlFingerprint = async (file) => {
  const hash = createHash('sha256');
  let buffered = '';
  let skippedTag = null;
  const canonicalLine = (line) => {
    let value = line;
    while (value) {
      if (skippedTag) {
        const closing = value.search(new RegExp(`</${skippedTag}\\s*>`, 'iu'));
        if (closing < 0) return '';
        value = value.slice(closing).replace(new RegExp(`^</${skippedTag}\\s*>`, 'iu'), ' ');
        skippedTag = null;
      }
      const opening = value.match(/<(script|style|noscript)\b[^>]*>/iu);
      if (!opening) break;
      const before = value.slice(0, opening.index);
      const closing = value.slice((opening.index || 0) + opening[0].length)
        .search(new RegExp(`</${opening[1]}\\s*>`, 'iu'));
      if (closing < 0) {
        skippedTag = opening[1];
        value = before;
        break;
      }
      value = `${before} ${value.slice((opening.index || 0) + opening[0].length + closing)}`
        .replace(new RegExp(`^\\s*</${opening[1]}\\s*>`, 'iu'), ' ');
    }
    return canonicalizeHtmlText(value);
  };
  for await (const chunk of createReadStream(file)) {
    buffered += chunk.toString('utf8');
    const parts = buffered.split(/\r?\n/u);
    buffered = parts.pop() || '';
    for (const part of parts) {
      const canonical = canonicalLine(part);
      if (canonical) hash.update(canonical).update('\n');
    }
  }
  const canonical = canonicalLine(buffered);
  if (canonical) hash.update(canonical).update('\n');
  return hash.digest('hex').slice(0, 16);
};
const hasMinimumLines = async (file, minimum) => {
  if (minimum <= 1) return (await stat(file)).size > 0;
  let lines = 0;
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    for (const character of chunk) {
      if (character === '\n' && ++lines >= minimum) return true;
    }
  }
  return false;
};
export const parseGeofabrikMd5 = (value) => String(value || '').match(/\b[a-f\d]{32}\b/iu)?.[0].toLowerCase() || null;

const environmentEnabled = (value) => /^(1|true|yes)$/iu.test(String(value || ''));

export const loadSourceCatalog = async (file = catalogFile, environment = process.env) => {
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.sources)) throw new Error('Unsupported source shard catalog');
  const shards = [];
  for (const configuredSource of catalog.sources) {
    if (configuredSource.enabledEnvironment && !environmentEnabled(environment[configuredSource.enabledEnvironment])) continue;
    const source = { ...configuredSource };
    if (source.redistributionConfirmationEnvironment) {
      source.redistributionAllowed = environmentEnabled(environment[source.redistributionConfirmationEnvironment]);
    }
    if (source.dataUrlEnvironment) {
      const configuredUrl = String(environment[source.dataUrlEnvironment] || '').trim();
      if (!configuredUrl) throw new Error(`${source.dataUrlEnvironment} is required when ${source.id} is enabled`);
      source.dataUrl = configuredUrl;
    }
    const intervalDays = source.intervalDays || catalog.defaultIntervalDays;
    if (source.adapter === 'overture') {
      for (const countryCode of source.countries || []) shards.push({
        id: `${source.id}-${countryCode.toLowerCase()}`, countryCode, intervalDays, source
      });
    } else if (source.adapter === 'geofabrik') {
      for (const extract of source.extracts || []) shards.push({
        id: `${source.id}-${extract.shardId || extract.countryCode.toLowerCase()}`,
        countryCode: extract.countryCode,
        extractId: extract.extractId,
        boundaryIso3: extract.boundaryIso3,
        excludeBoundaryIso3: extract.excludeBoundaryIso3,
        postcodeDataUrl: extract.postcodeDataUrl,
        postcodeDataFormat: extract.postcodeDataFormat,
        maxRecords: extract.maxRecords ?? source.extractDefaults?.maxRecords,
        qualityGate: extract.qualityGate ?? source.extractDefaults?.qualityGate,
        intervalDays,
        source: extract.shardId ? {
          ...source,
          id: `${source.id}-${extract.shardId}`,
          name: `${source.name} (${extract.name || extract.extractId})`
        } : source
      });
    } else if (source.adapter === 'japan-abr') {
      shards.push({
        id: source.id,
        countryCode: 'JP',
        extractId: source.extractId || 'japan',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'singapore-hdb') {
      shards.push({
        id: source.id,
        countryCode: 'SG',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'korea-kapt') {
      shards.push({
        id: source.id,
        countryCode: 'KR',
        extractId: source.extractId || 'korea',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'openaddresses-archive') {
      shards.push({
        id: source.id,
        countryCode: source.countryCode,
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'inegi-residential') {
      shards.push({
        id: source.id,
        countryCode: 'MX',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'ethekwini-residential') {
      shards.push({
        id: source.id,
        countryCode: 'ZA',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'cape-town-residential') {
      shards.push({
        id: source.id,
        countryCode: 'ZA',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'taiwan-residential') {
      shards.push({
        id: source.id,
        countryCode: 'TW',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'hong-kong-residential') {
      shards.push({
        id: source.id,
        countryCode: 'HK',
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        intervalDays,
        source
      });
    } else if (source.adapter === 'mappls-residential' || source.adapter === 'licensed-residential-feed'
      || source.adapter === 'pdok-bag') {
      shards.push({
        id: source.id,
        countryCode: source.countryCode,
        maxRecords: source.maxRecords,
        qualityGate: source.qualityGate,
        quotaProvider: source.quotaProvider,
        intervalDays,
        source
      });
    } else {
      throw new Error(`Unsupported source adapter: ${source.adapter}`);
    }
  }
  const duplicate = shards.find((shard, index) => shards.findIndex((entry) => entry.id === shard.id) !== index);
  if (duplicate) throw new Error(`Duplicate source shard: ${duplicate.id}`);
  return { ...catalog, shards };
};

export const createSourceAdapters = ({
  fetchImpl = fetch,
  execute = runProcess,
  processConcurrency = 3,
  processTimeoutMs = Number(process.env.ADDRESS_SYNC_PROCESS_TIMEOUT_MS || 30 * 60_000),
  signal,
  pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  enableOvertureResidential = process.env.ADDRESS_SYNC_OVERTURE_BUILDINGS === 'true',
  environment = process.env,
  credentialPool = null,
  loadSeedLocations = async () => []
} = {}) => {
  const apiFetchImpl = fetchImpl;
  const useCurlTransport = fetchImpl === fetch;
  if (useCurlTransport) fetchImpl = curlMetadataFetch;
  let overtureCatalogPromise;
  let overtureBuildingCatalogPromise;
  let geofabrikIndexPromise;
  const processWaiters = [];
  let activeProcesses = 0;
  const runExecute = async (options) => {
    if (activeProcesses >= processConcurrency) await new Promise((resolve) => processWaiters.push(resolve));
    activeProcesses += 1;
    try {
      return await execute({
        ...options,
        signal: options.signal || signal,
        timeoutMs: options.timeoutMs || processTimeoutMs
      });
    }
    finally {
      activeProcesses -= 1;
      processWaiters.shift()?.();
    }
  };
  const downloads = new Map();
  const verifiedDownloads = new Map();
  const sharedRawFiles = new Set();

  const environmentKeys = (baseName) => [baseName, ...Object.keys(environment)
    .filter((name) => name.startsWith(`${baseName}_`) && /^\d+$/u.test(name.slice(baseName.length + 1)))
    .sort((left, right) => Number(left.slice(baseName.length + 1)) - Number(right.slice(baseName.length + 1)))]
    .map((name) => String(environment[name] || '').trim())
    .filter(Boolean)
    .map((secret, index) => ({ id: `environment-${index}`, secret, disabled: false, cooldownUntil: 0 }));
  const mapplsEnvironmentCredentials = environmentKeys('MAPPLS_API_KEY');
  let mapplsEnvironmentCursor = 0;
  const mapplsCredentialPool = credentialPool || {
    acquire: async () => {
      const now = Date.now();
      for (let offset = 0; offset < mapplsEnvironmentCredentials.length; offset += 1) {
        const index = (mapplsEnvironmentCursor + offset) % mapplsEnvironmentCredentials.length;
        const credential = mapplsEnvironmentCredentials[index];
        if (!credential.disabled && credential.cooldownUntil <= now) {
          mapplsEnvironmentCursor = (index + 1) % mapplsEnvironmentCredentials.length;
          return credential;
        }
      }
      return null;
    },
    report: async (id, outcome, observation = {}) => {
      const credential = mapplsEnvironmentCredentials.find((entry) => entry.id === id);
      if (!credential || outcome === 'success') return;
      if (outcome === 'auth' || outcome === 'invalid') credential.disabled = true;
      else credential.cooldownUntil = Number.isFinite(Date.parse(observation.retryAt))
        ? Date.parse(observation.retryAt) : Date.now() + (outcome === 'quota' ? 60_000 : 5_000);
    }
  };

  const retryAtFrom = (response) => {
    const value = response.headers.get('retry-after');
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1000).toISOString();
    return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  };

  const requestMappls = async (target) => {
    const attempted = new Set();
    for (let pacingAttempt = 0; pacingAttempt < 20; pacingAttempt += 1) {
      const credential = await mapplsCredentialPool.acquire('mappls', { excludeIds: attempted });
      if (!credential) {
        if (!attempted.size && pacingAttempt < 19) {
          await wait(100);
          continue;
        }
        throw Object.assign(new Error('No Mappls credential is currently available'), {
          code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
        });
      }
      attempted.add(credential.id);
      const url = new URL(target);
      url.searchParams.set('access_token', credential.secret);
      let response;
      try {
        response = await apiFetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
        });
      } catch (error) {
        if (signal?.aborted) throw Object.assign(error, { code: 'SYNC_PROCESS_ABORTED' });
        await mapplsCredentialPool.report(credential.id, 'network');
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await mapplsCredentialPool.report(credential.id, 'auth');
        continue;
      }
      if (response.status === 429) {
        await mapplsCredentialPool.report(credential.id, 'quota', { retryAt: retryAtFrom(response) });
        continue;
      }
      if (!response.ok) {
        await mapplsCredentialPool.report(credential.id, response.status >= 500 ? 'network' : 'invalid', {
          retryAt: retryAtFrom(response)
        });
        if (response.status >= 500) continue;
        throw Object.assign(new Error(`Mappls request returned HTTP ${response.status}`), {
          code: 'SOURCE_METADATA_HTTP', status: response.status
        });
      }
      let body;
      try { body = await response.json(); }
      catch (error) {
        await mapplsCredentialPool.report(credential.id, 'invalid');
        throw Object.assign(new Error('Mappls returned invalid JSON'), { code: 'SOURCE_METADATA_JSON', cause: error });
      }
      await mapplsCredentialPool.report(credential.id, 'success');
      return body;
    }
    throw Object.assign(new Error('Every Mappls credential is unavailable'), {
      code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
    });
  };

  const loadStacItems = async (collectionUrl, collection) => {
    const links = collection.links.filter((link) => link.rel === 'item');
    const items = [];
    for (let offset = 0; offset < links.length; offset += 32) {
      items.push(...await Promise.all(links.slice(offset, offset + 32).map((link) =>
        jsonRequest(new URL(link.href, collectionUrl).href, fetchImpl))));
    }
    return items;
  };

  const overtureCatalog = async () => {
    if (!overtureCatalogPromise) overtureCatalogPromise = (async () => {
      const rootUrl = 'https://stac.overturemaps.org/catalog.json';
      const root = await jsonRequest(rootUrl, fetchImpl);
      if (!/^20\d{2}-\d{2}-\d{2}\.\d+$/u.test(root.latest || '')) throw new Error('Overture STAC did not return a valid latest release');
      const collectionUrl = `https://stac.overturemaps.org/${root.latest}/addresses/address/collection.json`;
      const collection = await jsonRequest(collectionUrl, fetchImpl);
      const items = await loadStacItems(collectionUrl, collection);
      return { version: root.latest, collectionUrl, items };
    })();
    return overtureCatalogPromise;
  };

  const overtureBuildingCatalog = async () => {
    if (!overtureBuildingCatalogPromise) overtureBuildingCatalogPromise = (async () => {
      const addressCatalog = await overtureCatalog();
      const collectionUrl = `https://stac.overturemaps.org/${addressCatalog.version}/buildings/building/collection.json`;
      const collection = await jsonRequest(collectionUrl, fetchImpl);
      return { collectionUrl, items: await loadStacItems(collectionUrl, collection) };
    })();
    return overtureBuildingCatalogPromise;
  };

  const geofabrikIndex = async () => {
    if (!geofabrikIndexPromise) {
      geofabrikIndexPromise = jsonRequest('https://download.geofabrik.de/index-v1-nogeom.json', fetchImpl)
        .catch((error) => {
          geofabrikIndexPromise = undefined;
          throw error;
        });
    }
    return geofabrikIndexPromise;
  };

  const discoverOverture = async (shard, { includeAssetSizes = false } = {}) => {
    const catalog = await overtureCatalog();
    const bounds = shard.bounds || countryBounds[shard.countryCode];
    if (!bounds) throw new Error(`Missing Overture bounds for ${shard.countryCode}`);
    const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    const assets = catalog.items
      .filter((item) => Array.isArray(item.bbox) && intersects(bounds, item.bbox))
      .sort((left, right) => {
        const distance = (item) => Math.abs((item.bbox[0] + item.bbox[2]) / 2 - center[0])
          + Math.abs((item.bbox[1] + item.bbox[3]) / 2 - center[1]);
        return distance(left) - distance(right);
      })
      .map((item) => item.assets?.aws?.href)
      .filter((url) => typeof url === 'string' && url.startsWith('https://'));
    if (!assets.length) throw new Error(`Overture STAC has no intersecting address assets for ${shard.countryCode}`);
    let buildingAssets = [];
    let buildingAssetEntries = [];
    if (enableOvertureResidential) {
      try {
        const buildingCatalog = await overtureBuildingCatalog();
        buildingAssetEntries = buildingCatalog.items
          .filter((item) => Array.isArray(item.bbox) && intersects(bounds, item.bbox))
          .map((item) => ({ url: item.assets?.aws?.href, bbox: item.bbox }))
          .filter((entry) => typeof entry.url === 'string' && entry.url.startsWith('https://'));
        buildingAssets = buildingAssetEntries.map(({ url }) => url);
      } catch (error) {
        console.warn(`Overture Buildings discovery failed for ${shard.countryCode}: ${error.message}`);
      }
    }
    let sourceBytes = null;
    if (includeAssetSizes) {
      const sizes = await Promise.all(assets.map(async (url) => {
        const response = await fetchImpl(url, { method: 'HEAD' });
        return response.ok ? headerNumber(response.headers, 'content-length') : null;
      }));
      sourceBytes = sizes.every(Number.isSafeInteger) ? sizes.reduce((sum, value) => sum + value, 0) : null;
    }
    return {
      adapter: 'overture',
      version: catalog.version,
      publishedAt: `${catalog.version.slice(0, 10)}T00:00:00.000Z`,
      dataUrl: catalog.collectionUrl,
      assets,
      buildingAssets,
      buildingAssetEntries,
      sourceBytes,
      estimateMethod: sourceBytes === null ? 'record-limit' : 'intersecting-assets-upper-bound'
    };
  };

  const discoverGeofabrik = async (shard, { syncMode, cacheDir } = {}) => {
    const index = await geofabrikIndex();
    const feature = index.features?.find((entry) => entry.properties?.id === shard.extractId);
    const dataUrl = feature?.properties?.urls?.pbf;
    if (!dataUrl) throw new Error(`Geofabrik extract is missing: ${shard.extractId}`);
    const response = await headRequest(dataUrl, fetchImpl);
    if (!response.ok) throw new Error(`Geofabrik metadata request failed (${response.status}): ${dataUrl}`);
    const modified = response.headers.get('last-modified');
    const etag = response.headers.get('etag')?.replaceAll('"', '') || '';
    const dateVersion = modified ? new Date(modified).toISOString().slice(0, 10) : 'latest';
    let version = etag ? `${dateVersion}-${safeVersion(etag).slice(0, 24)}` : dateVersion;
    let publishedAt = modified ? new Date(modified).toISOString() : null;
    let sourceBytes = headerNumber(response.headers, 'content-length');
    let discoveryEtag = etag;
    let estimateMethod = 'http-content-length';
    let bootstrapRawFile = null;
    if (syncMode === 'initial') {
      const recent = await recentBootstrapRaw({ cacheDir, shard, dataUrl, currentDate: dateVersion, currentBytes: sourceBytes });
      if (recent) {
        version = recent.version;
        publishedAt = recent.publishedAt;
        sourceBytes = recent.size;
        discoveryEtag = recent.etag;
        estimateMethod = 'recent-bootstrap-raw';
        bootstrapRawFile = recent.file;
      }
    }
    let boundaryUrl = null;
    const boundaryDownloadUrl = async (iso3) => {
      const relation = osmBoundaryRelations[iso3];
      if (relation) return `https://polygons.openstreetmap.fr/get_geojson.py?id=${relation}&params=0`;
      const boundary = await jsonRequest(`https://www.geoboundaries.org/api/current/gbOpen/${iso3}/ADM0/`, fetchImpl);
      if (!String(boundary.gjDownloadURL || '').startsWith('https://')) throw new Error(`Country boundary is missing: ${iso3}`);
      return boundary.gjDownloadURL;
    };
    if (shard.boundaryIso3) boundaryUrl = await boundaryDownloadUrl(shard.boundaryIso3);
    const excludeBoundaryUrls = [];
    for (const iso3 of shard.excludeBoundaryIso3 || []) {
      excludeBoundaryUrls.push(await boundaryDownloadUrl(iso3));
    }
    let postcodeDataUrl = null;
    let postcodeDataFormat = null;
    let postcodeVersion = null;
    let postcodeBytes = null;
    let postcodeFile = null;
    if (shard.postcodeDataUrl) {
      postcodeDataFormat = shard.postcodeDataFormat || 'html';
      if (!['html', 'pdf', 'geojson'].includes(postcodeDataFormat)) {
        throw new Error(`Unsupported postcode data format: ${postcodeDataFormat}`);
      }
      postcodeDataUrl = shard.postcodeDataUrl;
      if (cacheDir) {
        const rawDir = resolve(cacheDir, 'raw');
        await mkdir(rawDir, { recursive: true });
        const identity = createHash('sha256').update(`${postcodeDataUrl}\u001f${postcodeDataFormat}`).digest('hex').slice(0, 16);
        postcodeFile = resolve(rawDir, `${shard.id}-postcodes-${identity}.${postcodeDataFormat}`);
        postcodeBytes = await download(postcodeDataUrl, postcodeFile, {
          expectedBytes: null,
          maxBytes: Math.max(10 * 1024 * 1024, Number(shard.source?.postcodeMaxBytes || 512 * 1024 * 1024)),
          forceRefresh: postcodeDataFormat === 'html'
        });
        if (postcodeBytes < 100_000) throw new Error(`Official postcode source is unexpectedly small: ${postcodeBytes}`);
        postcodeVersion = postcodeDataFormat === 'html'
          ? await stableHtmlFingerprint(postcodeFile)
          : await sha256File(postcodeFile).then((value) => value.slice(0, 16));
      } else {
        const postcodeResponse = await fetchImpl(shard.postcodeDataUrl, {
          headers: { Accept: postcodeDataFormat === 'pdf' ? 'application/pdf' : 'text/html' },
          signal: AbortSignal.timeout(60_000)
        });
        if (!postcodeResponse.ok) {
          throw new Error(`Official postcode source request failed (${postcodeResponse.status}): ${shard.postcodeDataUrl}`);
        }
        const postcodeContent = Buffer.from(await postcodeResponse.arrayBuffer());
        postcodeBytes = postcodeContent.byteLength;
        if (postcodeBytes < 100_000) throw new Error(`Official postcode source is unexpectedly small: ${postcodeBytes}`);
        postcodeVersion = postcodeDataFormat === 'html'
          ? createHash('sha256').update(canonicalizeHtmlText(postcodeContent.toString('utf8'))).digest('hex').slice(0, 16)
          : createHash('sha256').update(postcodeContent).digest('hex').slice(0, 16);
      }
      version = `${version}-p${postcodeVersion}`;
    }
    return {
      adapter: 'geofabrik', version, publishedAt,
      dataUrl, sourceBytes, etag: discoveryEtag,
      lastModified: modified, boundaryUrl, excludeBoundaryUrls, estimateMethod, bootstrapRawFile,
      postcodeDataUrl, postcodeDataFormat, postcodeVersion, postcodeBytes, postcodeFile
    };
  };

  const discoverJapanAbr = async (shard) => {
    const abr = await jsonRequest(shard.source.dataUrl, fetchImpl);
    const postalUrl = shard.source.postalDataUrl;
    if (!String(postalUrl || '').startsWith('https://')) throw new Error('Japan Post data URL is missing');
    const postalResponse = await headRequest(postalUrl, fetchImpl);
    if (!postalResponse.ok) throw new Error(`Japan Post metadata request failed (${postalResponse.status}): ${postalUrl}`);
    const abrUpdated = Number(abr.meta?.updated);
    if (!Number.isSafeInteger(abrUpdated) || abrUpdated <= 0 || !Array.isArray(abr.data)) {
      throw new Error('Geolonia ABR metadata is invalid');
    }
    const postalModified = postalResponse.headers.get('last-modified');
    const postalVersion = postalModified ? new Date(postalModified).toISOString().slice(0, 10) : 'latest';
    const plateauBundles = (shard.source.plateauBundles || []).map((bundle) => {
      if (!/^https:\/\//u.test(bundle.url || '') || !/^[a-f\d]{64}$/u.test(bundle.sha256 || '')
        || !Number.isSafeInteger(bundle.bytes) || bundle.bytes < 1 || !/^\d{5}$/u.test(bundle.cityCode || '')) {
        throw new Error(`Japan PLATEAU bundle metadata is invalid: ${bundle.cityCode || '(missing)'}`);
      }
      return bundle;
    });
    let osmUrl = null;
    let osmResponse = null;
    let osmMd5 = null;
    if (!plateauBundles.length || shard.source.useOsmSupplement === true) {
      try {
        const index = await geofabrikIndex();
        const feature = index.features?.find((entry) => entry.properties?.id === shard.extractId);
        const candidateUrl = feature?.properties?.urls?.pbf;
        if (candidateUrl) {
          const candidateResponse = await headRequest(candidateUrl, fetchImpl);
          if (candidateResponse.ok) {
            osmUrl = candidateUrl;
            osmResponse = candidateResponse;
          } else {
            const checksumResponse = await fetchImpl(`${candidateUrl}.md5`);
            if (checksumResponse.ok) {
              osmMd5 = parseGeofabrikMd5(await checksumResponse.text());
              if (osmMd5) osmUrl = candidateUrl;
            }
          }
        }
      } catch {}
    }
    if (!plateauBundles.length && !osmUrl) {
      throw new Error('Japan residential building source is unavailable');
    }
    const osmModified = osmResponse?.headers.get('last-modified');
    const osmVersion = osmUrl
      ? (osmModified ? new Date(osmModified).toISOString().slice(0, 10) : osmMd5 || 'latest')
      : 'plateau-only';
    const version = `${abrUpdated}-${osmVersion}-${postalVersion}-${japanAbrExportRevision}`;
    const osmBytes = osmResponse ? headerNumber(osmResponse.headers, 'content-length') : null;
    const postalBytes = headerNumber(postalResponse.headers, 'content-length');
    const plateauBytes = plateauBundles.reduce((total, bundle) => total + bundle.bytes, 0);
    return {
      adapter: 'japan-abr',
      version,
      publishedAt: new Date(abrUpdated * 1000).toISOString(),
      dataUrl: shard.source.dataUrl,
      osmUrl,
      postalUrl,
      osmVersion,
      osmMd5,
      postalVersion,
      osmBytes,
      postalBytes,
      plateauBundles,
      plateauBytes,
      sourceBytes: postalBytes !== null && (!osmUrl || osmBytes !== null)
        ? (osmBytes || 0) + postalBytes + plateauBytes : null,
      estimateMethod: osmUrl ? 'geofabrik-plateau-and-japan-post-content-length' : 'plateau-and-japan-post-content-length'
    };
  };

  const dataGovDownload = async (datasetId) => {
    const baseUrl = `https://api-open.data.gov.sg/v1/public/api/datasets/${datasetId}`;
    let payload = await jsonRequest(`${baseUrl}/initiate-download`, fetchImpl);
    let dataUrl = payload.data?.url;
    for (let attempt = 0; !dataUrl && attempt < 10; attempt += 1) {
      await wait(1_000);
      payload = await jsonRequest(`${baseUrl}/poll-download`, fetchImpl);
      dataUrl = payload.data?.url;
    }
    if (!String(dataUrl || '').startsWith('https://')) throw new Error(`data.gov.sg download is unavailable: ${datasetId}`);
    let sourceBytes = null;
    let lastModified = null;
    try {
      const response = await headRequest(dataUrl, fetchImpl);
      if (response.ok) {
        sourceBytes = headerNumber(response.headers, 'content-length');
        lastModified = response.headers.get('last-modified');
      }
    } catch {}
    return { dataUrl, sourceBytes, lastModified };
  };

  const discoverSingaporeHdb = async (shard) => {
    const [property, building] = await Promise.all([
      dataGovDownload(shard.source.propertyDatasetId),
      dataGovDownload(shard.source.buildingDatasetId)
    ]);
    const publishedAt = [property.lastModified, building.lastModified]
      .filter(Boolean).map((value) => new Date(value)).sort((left, right) => right - left)[0];
    const dateVersion = publishedAt && Number.isFinite(publishedAt.getTime())
      ? publishedAt.toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    return {
      adapter: 'singapore-hdb',
      version: `${dateVersion}-${singaporeHdbExportRevision}`,
      publishedAt: publishedAt?.toISOString() || null,
      dataUrl: shard.source.dataUrl,
      propertyUrl: property.dataUrl,
      buildingUrl: building.dataUrl,
      propertyBytes: property.sourceBytes,
      buildingBytes: building.sourceBytes,
      sourceBytes: property.sourceBytes !== null && building.sourceBytes !== null
        ? property.sourceBytes + building.sourceBytes : null,
      residentialBuildingAvailable: true,
      estimateMethod: 'official-dataset-download'
    };
  };

  const discoverKoreaKapt = async (shard) => {
    const response = await fetchImpl(shard.source.dataUrl, { headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error(`K-apt metadata request failed (${response.status}): ${shard.source.dataUrl}`);
    const page = await response.text();
    if (!page.includes('K-apt')) throw new Error('K-apt metadata page is invalid');
    const modified = response.headers.get('last-modified');
    const sourceVersion = modified && Number.isFinite(new Date(modified).getTime())
      ? new Date(modified).toISOString().slice(0, 10)
      : 'latest';
    const runDate = new Date().toISOString().slice(0, 10);
    return {
      adapter: 'korea-kapt',
      version: `${sourceVersion}-${runDate}-${koreaKaptExportRevision}`,
      publishedAt: modified ? new Date(modified).toISOString() : null,
      dataUrl: shard.source.dataUrl,
      sourceBytes: null,
      estimateMethod: 'official-k-apt-dynamic-catalog'
    };
  };

  const discoverOpenAddresses = async (shard) => {
    let response = await headRequest(shard.source.dataUrl, fetchImpl);
    if ([403, 405].includes(response.status)) {
      response = await fetchImpl(shard.source.dataUrl, { headers: { Range: 'bytes=0-0' } });
    }
    if (!response.ok) throw new Error(`OpenAddresses metadata request failed (${response.status}): ${shard.source.dataUrl}`);
    const modified = response.headers.get('last-modified');
    const etag = response.headers.get('etag')?.replaceAll('"', '') || '';
    const version = safeVersion([modified ? new Date(modified).toISOString().slice(0, 10) : 'latest', etag].filter(Boolean).join('-'));
    const bounds = shard.bounds || countryBounds[shard.countryCode];
    const buildingCatalog = await overtureBuildingCatalog();
    const buildingAssetEntries = buildingCatalog.items
      .filter((item) => Array.isArray(item.bbox) && intersects(bounds, item.bbox))
      .map((item) => ({ url: item.assets?.aws?.href, bbox: item.bbox }))
      .filter((entry) => typeof entry.url === 'string' && entry.url.startsWith('https://'));
    if (!buildingAssetEntries.length) throw new Error(`Overture STAC has no residential building assets for ${shard.countryCode}`);
    return {
      adapter: 'openaddresses-archive',
      version,
      publishedAt: modified ? new Date(modified).toISOString() : null,
      dataUrl: shard.source.dataUrl,
      sourceBytes: Number(response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1])
        || headerNumber(response.headers, 'content-length'),
      buildingAssets: buildingAssetEntries.map(({ url }) => url),
      buildingAssetEntries,
      estimateMethod: 'http-content-length'
    };
  };

  const discoverInegiResidential = async (shard) => {
    const inspect = async (url) => {
      let response = await headRequest(url, fetchImpl);
      if ([403, 405].includes(response.status)) {
        response = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
      }
      if (!response.ok) throw new Error(`INEGI source metadata request failed (${response.status}): ${url}`);
      return {
        bytes: Number(response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1])
          || headerNumber(response.headers, 'content-length'),
        modified: response.headers.get('last-modified')
      };
    };
    const [source, normalized] = await Promise.all([
      inspect(shard.source.dataUrl), inspect(shard.source.normalizedDataUrl)
    ]);
    const publishedAt = [source.modified, normalized.modified]
      .filter(Boolean).map((value) => new Date(value)).sort((left, right) => right - left)[0];
    return {
      adapter: 'inegi-residential',
      version: `${shard.source.sourceVersion}-${inegiResidentialExportRevision}`,
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt.toISOString() : null,
      dataUrl: shard.source.dataUrl,
      normalizedDataUrl: shard.source.normalizedDataUrl,
      sourceBytes: source.bytes,
      normalizedSourceBytes: normalized.bytes,
      estimateMethod: 'http-content-length'
    };
  };

  const discoverEthekwiniResidential = async (shard) => {
    const [address, zoning, postalResponse] = await Promise.all([
      jsonRequest(`${shard.source.addressUrl}?f=json`, fetchImpl),
      jsonRequest(`${shard.source.zoningUrl}?f=json`, fetchImpl),
      headRequest(shard.source.postalDataUrl, fetchImpl)
    ]);
    if (!postalResponse.ok) {
      throw new Error(`South African Post Office metadata request failed (${postalResponse.status})`);
    }
    const modifiedValues = [
      Number(address.editingInfo?.lastEditDate),
      Number(zoning.editingInfo?.lastEditDate)
    ].filter((value) => Number.isFinite(value) && value > 0);
    const publishedAt = modifiedValues.length ? new Date(Math.max(...modifiedValues)).toISOString() : null;
    const postalModified = postalResponse.headers.get('last-modified');
    const postalVersion = postalModified ? new Date(postalModified).toISOString().slice(0, 10) : 'latest';
    return {
      adapter: 'ethekwini-residential',
      version: `${publishedAt?.slice(0, 10) || 'latest'}-${postalVersion}-${ethekwiniResidentialExportRevision}`,
      publishedAt,
      dataUrl: shard.source.addressUrl,
      addressUrl: shard.source.addressUrl,
      zoningUrl: shard.source.zoningUrl,
      postalUrl: shard.source.postalDataUrl,
      postalBytes: headerNumber(postalResponse.headers, 'content-length'),
      sourceBytes: headerNumber(postalResponse.headers, 'content-length'),
      residentialBuildingAvailable: true,
      estimateMethod: 'arcgis-feature-count-and-postal-content-length'
    };
  };

  const discoverCapeTownResidential = async (shard) => {
    const [parcel, postalResponse] = await Promise.all([
      jsonRequest(`${shard.source.parcelUrl}?f=json`, fetchImpl),
      headRequest(shard.source.postalDataUrl, fetchImpl)
    ]);
    if (!postalResponse.ok) {
      throw new Error(`South African Post Office metadata request failed (${postalResponse.status})`);
    }
    const modified = Number(parcel.editingInfo?.lastEditDate);
    const publishedAt = Number.isFinite(modified) && modified > 0 ? new Date(modified).toISOString() : null;
    const postalModified = postalResponse.headers.get('last-modified');
    const postalVersion = postalModified ? new Date(postalModified).toISOString().slice(0, 10) : 'latest';
    return {
      adapter: 'cape-town-residential',
      version: `${publishedAt?.slice(0, 10) || 'latest'}-${postalVersion}-${capeTownResidentialExportRevision}`,
      publishedAt,
      dataUrl: shard.source.parcelUrl,
      parcelUrl: shard.source.parcelUrl,
      postalUrl: shard.source.postalDataUrl,
      postalBytes: headerNumber(postalResponse.headers, 'content-length'),
      sourceBytes: headerNumber(postalResponse.headers, 'content-length'),
      residentialBuildingAvailable: true,
      estimateMethod: 'arcgis-feature-count-and-postal-content-length'
    };
  };

  const discoverTaiwanResidential = async (shard) => {
    const inspect = async (url) => {
      let response = await headRequest(url, fetchImpl);
      if ([403, 405].includes(response.status)) {
        response = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
      }
      if (!response.ok) throw new Error(`Taiwan source metadata request failed (${response.status}): ${url}`);
      return {
        bytes: Number(response.headers.get('content-range')?.match(/\/(\d+)$/u)?.[1])
          || headerNumber(response.headers, 'content-length'),
        modified: response.headers.get('last-modified')
      };
    };
    const archiveSources = shard.source.archives?.length ? shard.source.archives : [{
      sourceVersion: shard.source.sourceVersion,
      dataUrl: shard.source.dataUrl,
      archiveCacheName: shard.source.archiveCacheName,
      sha256: shard.source.sha256
    }];
    const [molitArchives, openAddresses] = await Promise.all([
      Promise.all(archiveSources.map(async (archive) => ({ ...archive, ...await inspect(archive.dataUrl) }))),
      inspect(shard.source.openAddressesDataUrl)
    ]);
    const publishedAt = [...molitArchives.map(({ modified }) => modified), openAddresses.modified]
      .filter(Boolean).map((value) => new Date(value)).sort((left, right) => right - left)[0];
    const molitBytes = molitArchives.every(({ bytes }) => bytes !== null)
      ? molitArchives.reduce((total, { bytes }) => total + bytes, 0)
      : null;
    const sourceVersion = molitArchives.map(({ sourceVersion }) => sourceVersion).filter(Boolean).join('+');
    return {
      adapter: 'taiwan-residential',
      version: `${sourceVersion}-${taiwanResidentialExportRevision}`,
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt.toISOString() : null,
      dataUrl: molitArchives[0].dataUrl,
      molitArchives,
      openAddressesDataUrl: shard.source.openAddressesDataUrl,
      sourceBytes: molitBytes !== null && openAddresses.bytes !== null ? molitBytes + openAddresses.bytes : null,
      molitBytes,
      openAddressesBytes: openAddresses.bytes,
      residentialBuildingAvailable: true,
      estimateMethod: 'official-archives-content-length'
    };
  };

  const discoverHongKongResidential = async (shard) => {
    const metadataResponse = await fetchImpl(shard.source.metadataUrl);
    if (!metadataResponse.ok) {
      throw new Error(`Hong Kong source metadata request failed (${metadataResponse.status})`);
    }
    const metadata = await metadataResponse.text();
    const dataUrl = metadata.match(/https:\/\/static\.csdi\.gov\.hk\/csdi-webpage\/download\/[a-f\d]+\/csv/iu)?.[0];
    const date = metadata.match(/Last updated on[\s\S]{0,500}?(\d{2})\/(\d{2})\/(\d{4})/iu);
    if (!dataUrl || !date) throw new Error('Hong Kong source metadata is missing the download URL or update date');
    const response = await headRequest(dataUrl, fetchImpl);
    if (!response.ok) throw new Error(`Hong Kong source request failed (${response.status})`);
    const publishedAt = `${date[3]}-${date[2]}-${date[1]}T00:00:00.000Z`;
    return {
      adapter: 'hong-kong-residential',
      version: `${publishedAt.slice(0, 10)}-${hongKongResidentialExportRevision}`,
      publishedAt,
      dataUrl,
      sourceBytes: headerNumber(response.headers, 'content-length'),
      residentialBuildingAvailable: true,
      estimateMethod: 'official-archive-content-length'
    };
  };

  const requireLicensedSource = (source) => {
    for (const name of [source.licenseConfirmationEnvironment, source.redistributionConfirmationEnvironment].filter(Boolean)) {
      if (!environmentEnabled(environment[name])) {
        throw Object.assign(new Error(`${name} must be true before ${source.id} can run`), {
          code: 'SOURCE_LICENSE_NOT_CONFIRMED'
        });
      }
    }
  };

  const mapplsCategoryCodes = (source) => {
    const name = source.categoryCodesEnvironment || 'MAPPLS_RESIDENTIAL_CATEGORY_CODES';
    const values = String(environment[name] || '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
    if (!values.length || values.some((value) => !/^[A-Z\d_-]{2,32}$/u.test(value))) {
      throw Object.assign(new Error(`${name} must contain authorized residential category codes`), {
        code: 'SOURCE_CONFIGURATION_INVALID'
      });
    }
    return [...new Set(values)];
  };

  const discoverMapplsResidential = async (shard) => {
    requireLicensedSource(shard.source);
    const categories = mapplsCategoryCodes(shard.source);
    const month = new Date().toISOString().slice(0, 7);
    const categoryFingerprint = createHash('sha256').update(categories.sort().join('\u001f')).digest('hex').slice(0, 12);
    return {
      adapter: 'mappls-residential',
      version: `${month}-${categoryFingerprint}-${mapplsResidentialRevision}`,
      publishedAt: null,
      dataUrl: shard.source.dataUrl,
      sourceBytes: null,
      categoryCodes: categories,
      residentialBuildingAvailable: true,
      estimateMethod: 'licensed-paginated-api'
    };
  };

  const licensedLocalFile = async (value) => {
    const root = await realpath(resolve(environment.ADDRESS_DATA_ROOT || 'data'));
    const file = await realpath(resolve(value));
    const relativeFile = relative(root, file);
    if (!relativeFile || isAbsolute(relativeFile) || relativeFile === '..' || relativeFile.startsWith(`..${sep}`) || relativeFile.startsWith(sep)) {
      throw Object.assign(new Error('Licensed feed files must be inside ADDRESS_DATA_ROOT'), {
        code: 'SOURCE_CONFIGURATION_INVALID'
      });
    }
    return file;
  };

  const discoverLicensedResidential = async (shard) => {
    requireLicensedSource(shard.source);
    const configuredVersion = String(environment[shard.source.versionEnvironment] || '').trim();
    if (/^https:\/\//iu.test(shard.source.dataUrl)) {
      const response = await headRequest(shard.source.dataUrl, fetchImpl);
      if (!response.ok) throw new Error(`Licensed feed metadata request failed (${response.status})`);
      const modified = response.headers.get('last-modified');
      const etag = response.headers.get('etag')?.replaceAll('"', '') || '';
      const version = configuredVersion || [modified ? new Date(modified).toISOString().slice(0, 10) : '', etag]
        .filter(Boolean).join('-');
      if (!version) throw Object.assign(new Error(`${shard.source.versionEnvironment} is required when the feed has no validator`), {
        code: 'SOURCE_CONFIGURATION_INVALID'
      });
      return {
        adapter: 'licensed-residential-feed',
        version: `${safeVersion(version)}-${licensedResidentialRevision}`,
        publishedAt: modified && Number.isFinite(Date.parse(modified)) ? new Date(modified).toISOString() : null,
        dataUrl: shard.source.dataUrl,
        sourceBytes: headerNumber(response.headers, 'content-length'),
        estimateMethod: 'licensed-feed-content-length'
      };
    }
    const file = await licensedLocalFile(shard.source.dataUrl);
    const metadata = await stat(file);
    const checksum = await sha256File(file);
    return {
      adapter: 'licensed-residential-feed',
      version: `${safeVersion(configuredVersion || checksum.slice(0, 24))}-${licensedResidentialRevision}`,
      publishedAt: metadata.mtime.toISOString(),
      dataUrl: file,
      sourceBytes: metadata.size,
      sourceChecksum: checksum,
      estimateMethod: 'licensed-local-feed'
    };
  };

  const discoverPdokBag = async (shard) => {
    const metadata = await jsonRequest(shard.source.dataUrl, fetchImpl);
    const itemLink = metadata?.links?.find((link) => link.rel === 'items'
      && /(?:application\/geo\+json|application\/json)/iu.test(String(link.type || '')));
    const updated = metadata?.links?.find((link) => link.rel === 'self')?.updated;
    if (!itemLink?.href || !updated || !Number.isFinite(Date.parse(updated))) {
      throw new SourceMetadataError('PDOK BAG collection metadata is incomplete', {
        url: shard.source.dataUrl, code: 'SOURCE_METADATA_INVALID'
      });
    }
    return {
      adapter: 'pdok-bag',
      version: `${new Date(updated).toISOString().slice(0, 10)}-${pdokBagRevision}`,
      publishedAt: new Date(updated).toISOString(),
      dataUrl: itemLink.href,
      sourceBytes: null,
      estimateMethod: 'pdok-bag-ogc-features'
    };
  };

  const discover = (shard, options) => {
    if (shard.source.adapter === 'overture') return discoverOverture(shard, options);
    if (shard.source.adapter === 'geofabrik') return discoverGeofabrik(shard, options);
    if (shard.source.adapter === 'japan-abr') return discoverJapanAbr(shard, options);
    if (shard.source.adapter === 'singapore-hdb') return discoverSingaporeHdb(shard, options);
    if (shard.source.adapter === 'korea-kapt') return discoverKoreaKapt(shard, options);
    if (shard.source.adapter === 'openaddresses-archive') return discoverOpenAddresses(shard, options);
    if (shard.source.adapter === 'inegi-residential') return discoverInegiResidential(shard, options);
    if (shard.source.adapter === 'ethekwini-residential') return discoverEthekwiniResidential(shard, options);
    if (shard.source.adapter === 'cape-town-residential') return discoverCapeTownResidential(shard, options);
    if (shard.source.adapter === 'taiwan-residential') return discoverTaiwanResidential(shard, options);
    if (shard.source.adapter === 'hong-kong-residential') return discoverHongKongResidential(shard, options);
    if (shard.source.adapter === 'mappls-residential') return discoverMapplsResidential(shard, options);
    if (shard.source.adapter === 'licensed-residential-feed') return discoverLicensedResidential(shard, options);
    if (shard.source.adapter === 'pdok-bag') return discoverPdokBag(shard, options);
    throw new Error(`Unsupported source adapter: ${shard.source.adapter}`);
  };

  const download = async (url, destination, { expectedBytes, maxBytes, forceRefresh = false }) => {
    await mkdir(resolve(destination, '..'), { recursive: true });
    if (!forceRefresh) {
      try {
        const existing = (await stat(destination)).size;
        if (existing > 0 && sourceSizeMatches(existing, expectedBytes)) return existing;
      } catch {}
    } else {
      await rm(destination, { force: true });
      await rm(`${destination}.part`, { force: true });
    }
    const partial = `${destination}.part`;
    let completed = false;
    try {
      if (useCurlTransport) {
        try {
          await runProcess({
            file: 'curl',
            args: ['-4', '-fL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '15', '-C', '-', '-o', partial, url],
            signal
          });
        } catch {
          await rm(partial, { force: true });
          await runProcess({
            file: 'curl',
            args: ['-4', '-fL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '15', '-o', partial, url],
            signal
          });
        }
        const downloaded = (await stat(partial)).size;
        if (downloaded > maxBytes || !sourceSizeMatches(downloaded, expectedBytes)) {
          throw new Error(`Source download size mismatch: ${downloaded} (expected ${expectedBytes ?? 'unknown'})`);
        }
        await rename(partial, destination);
        completed = true;
        return downloaded;
      }
      let offset = 0;
      try { offset = (await stat(partial)).size; } catch {}
      if (expectedBytes !== null && expectedBytes > maxBytes) throw new Error(`Source file exceeds cache budget: ${expectedBytes} > ${maxBytes}`);
      const response = await fetchImpl(url, {
        headers: offset ? { Range: `bytes=${offset}-` } : {},
        signal
      });
      if (!response.ok) throw new Error(`Source download failed (${response.status}): ${url}`);
      const append = offset > 0 && response.status === 206;
      if (!append) offset = 0;
      const remaining = headerNumber(response.headers, 'content-length');
      if (remaining !== null && offset + remaining > maxBytes) throw new Error(`Source file exceeds cache budget: ${offset + remaining} > ${maxBytes}`);
      if (!response.body) throw new Error(`Source download returned an empty body: ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: append ? 'a' : 'w' }));
      await rename(partial, destination);
      completed = true;
      return (await stat(destination)).size;
    } finally {
      if (!completed) await rm(partial, { force: true });
    }
  };

  const sharedDownload = (url, destination, options) => {
    if (!downloads.has(destination)) {
      downloads.set(destination, download(url, destination, options).finally(() => downloads.delete(destination)));
    }
    return downloads.get(destination);
  };

  const verifiedGeofabrikDownload = (url, destination, options) => {
    if (!verifiedDownloads.has(destination)) {
      verifiedDownloads.set(destination, (async () => {
        const expectedMd5 = useCurlTransport
          ? await execFileAsync('curl', ['-4', '-fsSL', '--connect-timeout', '15', '--max-time', '60', `${url}.md5`], {
            encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true
          }).then(({ stdout }) => parseGeofabrikMd5(stdout)).catch(() => null)
          : null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          await sharedDownload(url, destination, options);
          if (!expectedMd5 || await digestFile(destination, 'md5') === expectedMd5) return;
          await rm(destination, { force: true });
          await rm(`${destination}.part`, { force: true });
        }
        throw new Error(`Geofabrik checksum mismatch after full retry: ${url}`);
      })().finally(() => verifiedDownloads.delete(destination)));
    }
    return verifiedDownloads.get(destination);
  };

  const materializeOverture = async (shard, discovery, options) => {
    const residentialRevision = discovery.buildingAssets?.length ? `-${overtureResidentialRevision}` : '';
    const policyIdentity = normalizedCachePolicyIdentity(options.maxRecords, options.perLocality);
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${safeVersion(discovery.version)}${residentialRevision}-${policyIdentity}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output),
        cacheHit: true, methodRevision: overtureResidentialRevision };
    } catch {}
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    const assetsFile = `${temporary}.assets.json`;
    const buildingAssetsFile = `${temporary}.building-assets.json`;
    await writeFile(assetsFile, JSON.stringify(discovery.assets), 'utf8');
    await writeFile(buildingAssetsFile, JSON.stringify(discovery.buildingAssetEntries || discovery.buildingAssets || []), 'utf8');
    try {
      const postcodePattern = postcodePatterns[shard.countryCode]?.source;
      const candidateRecords = Math.min(240_000, Math.ceil(options.maxRecords * 1.6));
      await runExecute({
        file: pythonBin,
        args: [overtureExporter, '--country', shard.countryCode, '--release', discovery.version,
          '--output', temporary, '--max-records', String(options.maxRecords),
          '--candidate-records', String(candidateRecords),
          '--per-locality', String(options.perLocality), '--assets-file', assetsFile,
          '--building-assets-file', buildingAssetsFile,
          ...(postcodePattern ? ['--postcode-pattern', postcodePattern] : []),
          '--bounds', ...((shard.bounds || countryBounds[shard.countryCode]).map(String))],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
    } finally {
      await rm(assetsFile, { force: true });
      await rm(buildingAssetsFile, { force: true });
      await rm(temporary, { force: true });
    }
    const size = (await stat(output)).size;
    return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output),
      cacheHit: false, methodRevision: overtureResidentialRevision };
  };

  const materializeGeofabrik = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const methodRevision = shard.countryCode === 'VN' ? vietnamGeofabrikExportRevision : undefined;
    const boundarySignature = [
      geofabrikExportRevision,
      shard.countryCode === 'VN' ? vietnamGeofabrikExportRevision : '',
      shard.boundaryIso3 ? `b${shard.boundaryIso3}` : '',
      (shard.excludeBoundaryIso3 || []).length ? `x${shard.excludeBoundaryIso3.join('-')}` : ''
    ].filter(Boolean).join('-');
    const outputVersion = `${version}-${boundarySignature}-${normalizedCachePolicyIdentity(options.maxRecords, options.perLocality)}`;
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${outputVersion}.geojsonseq`);
    try {
      const size = (await stat(output)).size;
      if (discovery.postcodeFile && !options.retainRaw) await rm(discovery.postcodeFile, { force: true });
      return {
        file: output, format: 'geofabrik-geojsonseq', cacheBytes: size, checksum: await sha256File(output),
        cacheHit: true, methodRevision
      };
    } catch {}
    const rawIdentity = createHash('sha256').update(`${discovery.dataUrl}\u001f${version}`).digest('hex').slice(0, 16);
    const raw = resolve(options.cacheDir, 'raw', `${rawIdentity}-${basename(new URL(discovery.dataUrl).pathname)}`);
    const boundary = `${raw}.${shard.id}.boundary.geojson`;
    const excludeBoundaries = (discovery.excludeBoundaryUrls || []).map((_, index) => `${raw}.${shard.id}.exclude-${index}.geojson`);
    const postcodeFile = discovery.postcodeDataUrl
      ? (discovery.postcodeFile || `${raw}.${shard.id}.postcodes.${discovery.postcodeDataFormat || 'html'}`) : null;
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await verifiedGeofabrikDownload(discovery.dataUrl, raw, { expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes });
    if (options.sharedRaw && !options.retainRaw) sharedRawFiles.add(raw);
    const sourceChecksum = await sha256File(raw);
    let completed = false;
    try {
      if (discovery.boundaryUrl) {
        await download(discovery.boundaryUrl, boundary, { expectedBytes: null, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024) });
      }
      for (let index = 0; index < (discovery.excludeBoundaryUrls || []).length; index += 1) {
        await download(discovery.excludeBoundaryUrls[index], excludeBoundaries[index], { expectedBytes: null, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024) });
      }
      if (postcodeFile) {
        try {
          await stat(postcodeFile);
        } catch {
          await download(discovery.postcodeDataUrl, postcodeFile, {
            expectedBytes: discovery.postcodeDataFormat === 'pdf' ? null : discovery.postcodeBytes,
            maxBytes: Math.max(10 * 1024 * 1024, options.maxBytes)
          });
        }
      }
      const boundaryBytes = (discovery.boundaryUrl ? (await stat(boundary)).size : 0)
        + (await Promise.all(excludeBoundaries.map(async (file) => (await stat(file)).size))).reduce((sum, size) => sum + size, 0)
        + (postcodeFile ? (await stat(postcodeFile)).size : 0);
      const stagingBytes = (await stat(raw)).size + boundaryBytes;
      if (stagingBytes > options.maxBytes) throw new Error(`Geofabrik staging files exceed cache budget: ${stagingBytes} > ${options.maxBytes}`);
      await runExecute({
        file: pythonBin,
        args: [geofabrikExporter, '--input', raw, '--output', temporary,
          '--max-records', String(options.maxRecords), '--per-locality', String(options.perLocality),
          '--country', shard.countryCode,
          ...(postcodeFile && discovery.postcodeDataFormat === 'pdf' ? ['--postcode-pdf', postcodeFile] : []),
          ...(postcodeFile && discovery.postcodeDataFormat === 'html' ? ['--postcode-html', postcodeFile] : []),
          ...(postcodeFile && discovery.postcodeDataFormat === 'geojson' ? ['--postcode-geojson', postcodeFile] : []),
          ...(discovery.boundaryUrl ? ['--boundary', boundary] : []),
          ...excludeBoundaries.flatMap((file) => ['--exclude-boundary', file])],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(boundary, { force: true });
      if (postcodeFile && !options.retainRaw) await rm(postcodeFile, { force: true });
      await Promise.all(excludeBoundaries.map((file) => rm(file, { force: true })));
      await rm(temporary, { force: true });
      if (!options.retainRaw && !options.sharedRaw && completed) await rm(raw, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output, format: 'geofabrik-geojsonseq', cacheBytes: size, checksum: await sha256File(output),
      sourceChecksum, cacheHit: false, methodRevision
    };
  };

  const materializeJapanAbr = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const policyIdentity = normalizedCachePolicyIdentity(sourceMaximum, options.perLocality);
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${japanAbrExportRevision}-${policyIdentity}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
    } catch {}
    const postalIdentity = createHash('sha256')
      .update(`${discovery.postalUrl}\u001f${discovery.postalVersion || version}`).digest('hex').slice(0, 16);
    const osmIdentity = discovery.osmUrl
      ? createHash('sha256').update(`${discovery.osmUrl}\u001f${discovery.osmVersion || version}`).digest('hex').slice(0, 16) : null;
    const osmFile = discovery.osmUrl
      ? resolve(options.cacheDir, 'raw', `${osmIdentity}-${basename(new URL(discovery.osmUrl).pathname)}`) : null;
    const postalFile = resolve(options.cacheDir, 'raw', `${postalIdentity}-${basename(new URL(discovery.postalUrl).pathname)}`);
    const plateauArtifacts = (discovery.plateauBundles || []).map((bundle) => {
      const directory = resolve(options.cacheDir, 'raw', `plateau-${bundle.cityCode}-${bundle.year}`);
      return {
        ...bundle,
        directory,
        bundleFile: resolve(options.cacheDir, 'raw', basename(new URL(bundle.url).pathname)),
        parquetFile: resolve(directory, 'buildings.parquet')
      };
    });
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await Promise.all([
      ...(osmFile ? [verifiedGeofabrikDownload(discovery.osmUrl, osmFile, {
        expectedBytes: discovery.osmBytes, maxBytes: options.maxBytes
      })] : []),
      sharedDownload(discovery.postalUrl, postalFile, {
        expectedBytes: discovery.postalBytes, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024)
      }),
      ...plateauArtifacts.map(async (bundle) => {
        await sharedDownload(bundle.url, bundle.bundleFile, {
          expectedBytes: bundle.bytes, maxBytes: Math.min(options.maxBytes, bundle.bytes + 1024 * 1024)
        });
        const checksum = await sha256File(bundle.bundleFile);
        if (checksum !== bundle.sha256) {
          await rm(bundle.bundleFile, { force: true });
          throw new Error(`Japan PLATEAU checksum mismatch: ${bundle.cityCode}`);
        }
        await rm(bundle.directory, { recursive: true, force: true });
        await mkdir(bundle.directory, { recursive: true });
        await runExecute({
          file: pythonBin,
          args: [japanPlateauExtractor, '--archive', bundle.bundleFile,
            '--output', bundle.parquetFile, '--member', 'buildings.parquet'],
          phase: `extract:${shard.id}:${bundle.cityCode}`
        });
      })
    ]);
    if (osmFile && options.sharedRaw && !options.retainRaw) sharedRawFiles.add(osmFile);
    const [osmChecksum, postalChecksum] = await Promise.all([
      osmFile ? sha256File(osmFile) : null,
      sha256File(postalFile)
    ]);
    try {
      await runExecute({
        file: pythonBin,
        args: [japanAbrExporter,
          '--abr-url', shard.source.dataUrl,
          '--postal-zip', postalFile,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality),
          ...(osmFile ? ['--osm-pbf', osmFile] : []),
          ...(shard.source.landLot === true ? ['--land-lot'] : []),
          ...plateauArtifacts.flatMap((bundle) => ['--plateau-city-code', bundle.cityCode]),
          ...plateauArtifacts.flatMap((bundle) => ['--plateau-parquet', bundle.parquetFile])],
        phase: `materialize:${shard.id}`,
        timeoutMs: Math.max(processTimeoutMs, japanMaterializeTimeoutMs)
      });
      await rename(temporary, output);
    } finally {
      await rm(temporary, { force: true });
      if (osmFile && !options.retainRaw && !options.sharedRaw) await rm(osmFile, { force: true });
      if (!options.retainRaw) await rm(postalFile, { force: true });
      if (!options.retainRaw) {
        await Promise.all(plateauArtifacts.flatMap((bundle) => [
          rm(bundle.bundleFile, { force: true }), rm(bundle.directory, { recursive: true, force: true })
        ]));
      }
    }
    const size = (await stat(output)).size;
    const sourceChecksum = createHash('sha256')
      .update([osmChecksum, postalChecksum, ...plateauArtifacts.map((bundle) => bundle.sha256)].filter(Boolean).join('\u001f'))
      .digest('hex');
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false
    };
  };

  const materializeSingaporeHdb = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${version}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
    } catch {}
    const rawRoot = resolve(options.cacheDir, 'raw');
    const propertyFile = resolve(rawRoot, `${shard.id}-${version}-property.csv`);
    const buildingFile = resolve(rawRoot, `${shard.id}-${version}-buildings.geojson`);
    const onemapCacheFile = resolve(rawRoot, `${shard.id}-onemap-cache.jsonl`);
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await Promise.all([
      sharedDownload(discovery.propertyUrl, propertyFile, {
        expectedBytes: discovery.propertyBytes, maxBytes: Math.min(options.maxBytes, 100 * 1024 * 1024)
      }),
      sharedDownload(discovery.buildingUrl, buildingFile, {
        expectedBytes: discovery.buildingBytes, maxBytes: Math.min(options.maxBytes, 250 * 1024 * 1024)
      })
    ]);
    const [propertyChecksum, buildingChecksum] = await Promise.all([
      sha256File(propertyFile), sha256File(buildingFile)
    ]);
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [singaporeHdbExporter,
          '--property-csv', propertyFile,
          '--building-geojson', buildingFile,
          '--onemap-cache', onemapCacheFile,
          '--output', temporary,
          '--max-records', String(options.maxRecords),
          '--per-locality', String(options.perLocality)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) {
        await Promise.all([rm(propertyFile, { force: true }), rm(buildingFile, { force: true })]);
      }
    }
    const size = (await stat(output)).size;
    const sourceChecksum = createHash('sha256')
      .update(`${propertyChecksum}\u001f${buildingChecksum}`).digest('hex');
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false
    };
  };

  const materializeKoreaKapt = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
    } catch {}
    const cacheFile = resolve(options.cacheDir, 'raw', `${shard.id}-postcode-cache.jsonl`);
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await mkdir(resolve(options.cacheDir, 'raw'), { recursive: true });
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [koreaKaptExporter,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality),
          '--postcode-cache', cacheFile,
          '--daily-geocode-limit', String(shard.source.dailyGeocodeLimit || 2800),
          '--geocode-concurrency', String(shard.source.geocodeConcurrency || 3)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256').update(`${discovery.version}\u001f${size}`).digest('hex'),
      cacheHit: false,
      completed
    };
  };

  const materializeOpenAddresses = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${openAddressesExportRevision}-${overtureResidentialRevision}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true,
        methodRevision: `${openAddressesExportRevision}-${overtureResidentialRevision}` };
    } catch {}
    const rawIdentity = createHash('sha256').update(`${discovery.dataUrl}\u001f${version}`).digest('hex').slice(0, 16);
    const raw = resolve(options.cacheDir, 'raw', shard.source.archiveCacheName
      ? basename(shard.source.archiveCacheName)
      : `${rawIdentity}-${basename(new URL(discovery.dataUrl).pathname)}`);
    const temporary = `${output}.${process.pid}.tmp`;
    const candidateFile = `${temporary}.candidates.jsonl`;
    const mappingFile = `${temporary}.mapping.json`;
    const assetsFile = `${temporary}.assets.json`;
    const buildingAssetsFile = `${temporary}.building-assets.json`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await verifiedGeofabrikDownload(discovery.dataUrl, raw, { expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes });
    await writeFile(mappingFile, JSON.stringify(shard.source.mapping), 'utf8');
    await writeFile(assetsFile, '[]', 'utf8');
    await writeFile(buildingAssetsFile, JSON.stringify(discovery.buildingAssetEntries), 'utf8');
    let completed = false;
    const sourceChecksum = await sha256File(raw);
    const archiveMembers = Array.isArray(shard.source.archiveMembers)
      ? shard.source.archiveMembers
      : [shard.source.archiveMember];
    if (!archiveMembers.length || archiveMembers.some((member) => typeof member !== 'string' || !member)) {
      throw new Error(`OpenAddresses archive members are missing for ${shard.id}`);
    }
    try {
      await runExecute({
        file: pythonBin,
        args: [openAddressesExporter, '--input', raw,
          ...archiveMembers.flatMap((member) => ['--member', member]),
          '--mapping-file', mappingFile, '--country', shard.countryCode, '--output', candidateFile,
          '--max-records', String(sourceMaximum), '--per-locality', String(options.perLocality)],
        phase: `candidates:${shard.id}`
      });
      await runExecute({
        file: pythonBin,
        args: [overtureExporter, '--country', shard.countryCode, '--release', discovery.version,
          '--output', temporary, '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality), '--assets-file', assetsFile,
          '--building-assets-file', buildingAssetsFile, '--candidate-jsonl', candidateFile,
          '--bounds', ...((shard.bounds || countryBounds[shard.countryCode]).map(String))],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await Promise.all([mappingFile, assetsFile, buildingAssetsFile, candidateFile, temporary]
        .map((file) => rm(file, { force: true })));
      if (!options.retainRaw && completed) await rm(raw, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false,
      methodRevision: `${openAddressesExportRevision}-${overtureResidentialRevision}`
    };
  };

  const materializeInegiResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const output = resolve(options.cacheDir, 'normalized', `${shard.id}-${version}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
    } catch {}
    const rawRoot = resolve(options.cacheDir, 'raw');
    const sourceFile = resolve(rawRoot, basename(shard.source.archiveCacheName));
    const normalizedFile = resolve(rawRoot, basename(shard.source.normalizedArchiveCacheName));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await Promise.all([
      sharedDownload(discovery.dataUrl, sourceFile, {
        expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes
      }),
      sharedDownload(discovery.normalizedDataUrl, normalizedFile, {
        expectedBytes: discovery.normalizedSourceBytes, maxBytes: options.maxBytes
      })
    ]);
    const [sourceChecksum, normalizedChecksum] = await Promise.all([
      sha256File(sourceFile), sha256File(normalizedFile)
    ]);
    if (sourceChecksum !== shard.source.sha256 || normalizedChecksum !== shard.source.normalizedSha256) {
      throw new Error('INEGI source checksum mismatch');
    }
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [inegiResidentialExporter,
          '--input', sourceFile,
          '--normalized-input', normalizedFile,
          '--normalized-member', shard.source.normalizedArchiveMember,
          '--output', temporary,
          '--max-records', String(options.maxRecords),
          '--per-locality', String(options.perLocality)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) {
        await Promise.all([rm(sourceFile, { force: true }), rm(normalizedFile, { force: true })]);
      }
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256').update(`${sourceChecksum}\u001f${normalizedChecksum}`).digest('hex'),
      cacheHit: false
    };
  };

  const materializeEthekwiniResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
    } catch {}
    const postalFile = resolve(options.cacheDir, 'raw', basename(
      shard.source.postalCacheName || `${shard.id}-${version}-postalcodes.txt`
    ));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await sharedDownload(discovery.postalUrl, postalFile, {
      expectedBytes: discovery.postalBytes,
      maxBytes: Math.min(options.maxBytes, 10 * 1024 * 1024)
    });
    const postalChecksum = await sha256File(postalFile);
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [ethekwiniResidentialExporter,
          '--address-url', discovery.addressUrl,
          '--zoning-url', discovery.zoningUrl,
          '--postal-file', postalFile,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality),
          '--concurrency', String(shard.source.queryConcurrency || 16)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) await rm(postalFile, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256').update(`${postalChecksum}\u001f${discovery.version}`).digest('hex'),
      cacheHit: false
    };
  };

  const materializeCapeTownResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
    } catch {}
    const postalFile = resolve(options.cacheDir, 'raw', basename(
      shard.source.postalCacheName || `${shard.id}-${version}-postalcodes.txt`
    ));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await sharedDownload(discovery.postalUrl, postalFile, {
      expectedBytes: discovery.postalBytes,
      maxBytes: Math.min(options.maxBytes, 10 * 1024 * 1024)
    });
    const postalChecksum = await sha256File(postalFile);
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [capeTownResidentialExporter,
          '--parcel-url', discovery.parcelUrl,
          '--postal-file', postalFile,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) await rm(postalFile, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256').update(`${postalChecksum}\u001f${discovery.version}`).digest('hex'),
      cacheHit: false
    };
  };

  const materializeTaiwanResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      const minimum = Number(shard.qualityGate?.minimumRecords || 1);
      if (await hasMinimumLines(output, minimum)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch {}
    const rawRoot = resolve(options.cacheDir, 'raw');
    const archiveSources = discovery.molitArchives?.length ? discovery.molitArchives : [{
      dataUrl: discovery.dataUrl,
      archiveCacheName: shard.source.archiveCacheName,
      sha256: shard.source.sha256,
      bytes: discovery.molitBytes
    }];
    const molitFiles = archiveSources.map((archive) => resolve(rawRoot, basename(archive.archiveCacheName)));
    const openAddressesFile = resolve(rawRoot, basename(shard.source.openAddressesArchiveCacheName));
    const postcodeCache = resolve(rawRoot, basename(shard.source.postcodeCacheName));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await mkdir(rawRoot, { recursive: true });
    await Promise.all([
      ...archiveSources.map((archive, index) => sharedDownload(archive.dataUrl, molitFiles[index], {
        expectedBytes: archive.bytes, maxBytes: options.maxBytes
      })),
      sharedDownload(discovery.openAddressesDataUrl, openAddressesFile, {
        expectedBytes: discovery.openAddressesBytes, maxBytes: options.maxBytes
      })
    ]);
    const [molitChecksums, openAddressesChecksum] = await Promise.all([
      Promise.all(molitFiles.map((file) => sha256File(file))), sha256File(openAddressesFile)
    ]);
    for (const [index, archive] of archiveSources.entries()) {
      if (archive.sha256 && molitChecksums[index] !== archive.sha256) {
        throw new Error(`Taiwan MOLIT source checksum mismatch: ${archive.sourceVersion || index + 1}`);
      }
    }
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [taiwanResidentialExporter,
          ...molitFiles.flatMap((file) => ['--molit-archive', file]),
          '--openaddresses-archive', openAddressesFile,
          '--postcode-cache', postcodeCache,
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-locality', String(options.perLocality),
          '--request-interval', String(shard.source.postcodeRequestInterval ?? 0.2),
          '--postcode-concurrency', String(shard.source.postcodeConcurrency || 6)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) {
        await Promise.all([...molitFiles, openAddressesFile].map((file) => rm(file, { force: true })));
      }
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: createHash('sha256')
        .update(`${molitChecksums.join('\u001f')}\u001f${openAddressesChecksum}\u001f${discovery.version}`).digest('hex'),
      cacheHit: false
    };
  };

  const materializeHongKongResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      const minimum = Number(shard.qualityGate?.minimumRecords || 1);
      if (await hasMinimumLines(output, minimum)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch {}
    const rawRoot = resolve(options.cacheDir, 'raw');
    const sourceFile = resolve(rawRoot, basename(shard.source.archiveCacheName));
    const temporary = `${output}.${process.pid}.tmp`;
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    await mkdir(rawRoot, { recursive: true });
    await sharedDownload(discovery.dataUrl, sourceFile, {
      expectedBytes: discovery.sourceBytes, maxBytes: options.maxBytes
    });
    const sourceChecksum = await sha256File(sourceFile);
    let completed = false;
    try {
      await runExecute({
        file: pythonBin,
        args: [hongKongResidentialExporter,
          '--building-information', sourceFile,
          '--offline',
          '--output', temporary,
          '--max-records', String(sourceMaximum),
          '--per-district', String(options.perLocality)],
        phase: `materialize:${shard.id}`
      });
      await rename(temporary, output);
      completed = true;
    } finally {
      await rm(temporary, { force: true });
      if (!options.retainRaw && completed) await rm(sourceFile, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false
    };
  };

  const replaceFile = async (temporary, destination) => {
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await rm(destination, { force: true });
      await rename(temporary, destination);
    }
  };

  const writeJsonAtomic = async (file, value) => {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
    await replaceFile(temporary, file);
  };

  const mapplsAddressRecord = (detailsPayload, nearby, categoryCode, sourceName) => {
    const details = Array.isArray(detailsPayload) ? detailsPayload[0]
      : detailsPayload?.results?.[0] || detailsPayload?.result || detailsPayload?.copResults?.[0]
        || detailsPayload?.copResults || detailsPayload;
    if (!details || typeof details !== 'object') return null;
    const address = details.addressTokens && typeof details.addressTokens === 'object' ? details.addressTokens : details;
    const admin = details.adminTokens && typeof details.adminTokens === 'object' ? details.adminTokens : details;
    const sourceRecordId = String(details.eloc || details.eLoc || nearby.eLoc || nearby.eloc || '').trim();
    const formattedAddress = String(details.address || details.formattedAddress || nearby.placeAddress || '').trim();
    const addressParts = formattedAddress.split(',').map((value) => value.trim()).filter(Boolean);
    const parsedNumber = addressParts[0]?.match(/^(\d+[A-Za-z]?(?:[-/]\d+)?)(?:\s|$)/u)?.[1] || '';
    const number = String(address.houseNumber || details.houseNumber || parsedNumber).trim();
    const parsedStreet = parsedNumber
      ? (addressParts[0].slice(parsedNumber.length).trim() || addressParts[1] || '')
      : '';
    const street = String(address.street || details.street || parsedStreet).trim();
    const admin1 = String(admin.state || address.state || details.state || '').trim();
    const locality = String(admin.city || address.city || details.city || address.village || details.village || address.locality || details.locality || '').trim();
    const district = String(admin.district || admin.subDistrict || address.district || details.district || address.subDistrict || details.subDistrict || '').trim();
    const postcode = String(admin.pincode || address.pincode || details.pincode || '').trim();
    const coordinates = details.coordinates || details.location || {};
    const longitude = Number(details.longitude ?? details.lon ?? coordinates.longitude ?? coordinates.lng ?? nearby.longitude ?? nearby.lon);
    const latitude = Number(details.latitude ?? details.lat ?? coordinates.latitude ?? coordinates.lat ?? nearby.latitude ?? nearby.lat);
    if (!sourceRecordId || !number || !street || !admin1 || !locality || !district || !/^\d{6}$/u.test(postcode)
      || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    return {
      id: sourceRecordId,
      source_record_id: sourceRecordId,
      source_dataset: sourceName,
      number,
      street,
      building_name: String(address.houseName || details.houseName || details.name || nearby.placeName || '').trim(),
      district,
      locality,
      admin1,
      postcode,
      longitude,
      latitude,
      property_type: 'residential',
      residential_building_id: sourceRecordId,
      residential_building_class: `mappls-category:${categoryCode}`
    };
  };

  const materializeMapplsResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const identity = normalizedCachePolicyIdentity(sourceMaximum, options.perLocality);
    const normalizedRoot = resolve(options.cacheDir, 'normalized');
    const rawRoot = resolve(options.cacheDir, 'raw');
    const output = resolve(normalizedRoot, `${shard.id}-${version}-${identity}.jsonl`);
    const candidates = resolve(rawRoot, `${shard.id}-${version}-${identity}-candidates.jsonl`);
    const checkpointFile = resolve(rawRoot, `${shard.id}-${version}-${identity}-checkpoint.json`);
    await Promise.all([mkdir(normalizedRoot, { recursive: true }), mkdir(rawRoot, { recursive: true })]);
    let checkpoint = { version, seedIndex: 0, categoryIndex: 0, page: 1, processed: [], complete: false };
    try {
      const loaded = JSON.parse(await readFile(checkpointFile, 'utf8'));
      if (loaded.version === version) checkpoint = { ...checkpoint, ...loaded };
    } catch {}
    if (checkpoint.complete) {
      try {
        const size = (await stat(output)).size;
        if (await hasMinimumLines(output, Number(shard.qualityGate?.minimumRecords || 1))) {
          return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
        }
        await rm(output, { force: true });
        checkpoint = { version, seedIndex: 0, categoryIndex: 0, page: 1, processed: [], complete: false };
      } catch {
        try {
          if (!await hasMinimumLines(candidates, Number(shard.qualityGate?.minimumRecords || 1))) throw new Error('empty Mappls candidate cache');
          const temporary = `${output}.${process.pid}.tmp`;
          await copyFile(candidates, temporary);
          await replaceFile(temporary, output);
          const size = (await stat(output)).size;
          return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
        } catch {
          checkpoint = { version, seedIndex: 0, categoryIndex: 0, page: 1, processed: [], complete: false };
        }
      }
    }
    const seeds = (await loadSeedLocations(shard.countryCode))
      .map((value) => ({ latitude: Number(value.latitude), longitude: Number(value.longitude) }))
      .filter(({ latitude, longitude }) => Number.isFinite(latitude) && Number.isFinite(longitude));
    if (!seeds.length) throw Object.assign(new Error('Mappls residential discovery requires postcode or city coordinates'), {
      code: 'SOURCE_CONFIGURATION_INVALID'
    });
    const processed = new Set(checkpoint.processed || []);
    let acceptedCount = 0;
    let candidatesPresent = false;
    try {
      for (const line of (await readFile(candidates, 'utf8')).split(/\r?\n/u)) {
        if (!line) continue;
        candidatesPresent = true;
        const value = JSON.parse(line);
        processed.add(String(value.source_record_id || value.id));
        acceptedCount += 1;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!candidatesPresent && checkpoint.processed?.length) {
      checkpoint.processed = [];
      processed.clear();
    }
    const persistCheckpoint = async () => {
      checkpoint.processed = [...processed];
      checkpoint.acceptedCount = acceptedCount;
      checkpoint.updatedAt = new Date().toISOString();
      await writeJsonAtomic(checkpointFile, checkpoint);
    };
    const requestBudget = Math.max(10, Math.min(100_000,
      Number.parseInt(environment.MAPPLS_MAX_REQUESTS_PER_RUN || '2000', 10) || 2000));
    const maximumPages = Math.max(1, Math.min(100,
      Number.parseInt(environment.MAPPLS_MAX_PAGES_PER_SEED || '10', 10) || 10));
    let requests = 0;
    let pageCompleted = true;
    try {
      while (!checkpoint.complete && acceptedCount < sourceMaximum && requests < requestBudget) {
        if (checkpoint.seedIndex >= seeds.length) {
          checkpoint.complete = true;
          break;
        }
        const seed = seeds[checkpoint.seedIndex];
        const categoryCode = discovery.categoryCodes[checkpoint.categoryIndex];
        const nearbyUrl = new URL('https://search.mappls.com/search/places/nearby/json');
        Object.entries({
          keywords: categoryCode,
          refLocation: `${seed.latitude},${seed.longitude}`,
          region: 'IND',
          radius: '10000',
          page: String(checkpoint.page),
          filter: `categoryCode:${categoryCode}`
        }).forEach(([name, value]) => nearbyUrl.searchParams.set(name, value));
        const nearbyPayload = await requestMappls(nearbyUrl);
        requests += 1;
        const locations = Array.isArray(nearbyPayload?.suggestedLocations) ? nearbyPayload.suggestedLocations : [];
        pageCompleted = true;
        for (const nearby of locations) {
          const eLoc = String(nearby.eLoc || nearby.eloc || '').trim();
          if (!eLoc || processed.has(eLoc)) continue;
          if (requests >= requestBudget) { pageCompleted = false; break; }
          const detailsUrl = new URL(`https://explore.mappls.com/apis/O2O/entity/${encodeURIComponent(eLoc)}`);
          const details = await requestMappls(detailsUrl);
          requests += 1;
          processed.add(eLoc);
          const record = mapplsAddressRecord(details, nearby, categoryCode, shard.source.name);
          if (!record) continue;
          await appendFile(candidates, `${JSON.stringify(record)}\n`, 'utf8');
          acceptedCount += 1;
          if (acceptedCount >= sourceMaximum) break;
        }
        if (!pageCompleted || acceptedCount >= sourceMaximum) break;
        const totalPages = Math.min(maximumPages, Math.max(1, Number(nearbyPayload?.pageInfo?.totalPages || 1)));
        if (locations.length && checkpoint.page < totalPages) checkpoint.page += 1;
        else {
          checkpoint.page = 1;
          checkpoint.categoryIndex += 1;
          if (checkpoint.categoryIndex >= discovery.categoryCodes.length) {
            checkpoint.categoryIndex = 0;
            checkpoint.seedIndex += 1;
          }
        }
        await persistCheckpoint();
      }
      if (acceptedCount >= sourceMaximum || checkpoint.seedIndex >= seeds.length) checkpoint.complete = true;
    } finally {
      await persistCheckpoint();
    }
    if (!acceptedCount) throw Object.assign(new Error('Mappls discovery checkpoint advanced without a publishable record'), {
      code: checkpoint.complete ? 'SOURCE_QUALITY_FAILED' : 'SOURCE_PARTIAL'
    });
    const temporary = `${output}.${process.pid}.tmp`;
    await copyFile(candidates, temporary);
    await replaceFile(temporary, output);
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum: await sha256File(candidates),
      cacheHit: false
    };
  };

  const materializePdokBag = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = options.maxRecords;
    const identity = normalizedCachePolicyIdentity(sourceMaximum, options.perLocality);
    const normalizedRoot = resolve(options.cacheDir, 'normalized');
    const rawRoot = resolve(options.cacheDir, 'raw');
    const output = resolve(normalizedRoot, `${shard.id}-${version}-${identity}.jsonl`);
    const candidates = resolve(rawRoot, `${shard.id}-${version}-${identity}-candidates.jsonl`);
    const checkpointFile = resolve(rawRoot, `${shard.id}-${version}-${identity}-checkpoint.json`);
    const minimumRecords = Number(shard.qualityGate?.minimumRecords || 1);
    await Promise.all([mkdir(normalizedRoot, { recursive: true }), mkdir(rawRoot, { recursive: true })]);
    try {
      const size = (await stat(output)).size;
      if (await hasMinimumLines(output, minimumRecords)) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch {}

    const seeds = selectDispersedSeeds(await loadSeedLocations(shard.countryCode), 400);
    if (!seeds.length) throw Object.assign(new Error('PDOK BAG discovery requires Netherlands postcode or city coordinates'), {
      code: 'SOURCE_CONFIGURATION_INVALID'
    });
    let checkpoint = { version, round: 0, seedIndex: 0, nextBySeed: {}, complete: false };
    try {
      const loaded = JSON.parse(await readFile(checkpointFile, 'utf8'));
      if (loaded.version === version) {
        checkpoint = { ...checkpoint, ...loaded };
        if (!checkpoint.nextBySeed || typeof checkpoint.nextBySeed !== 'object') checkpoint.nextBySeed = {};
        if (loaded.nextUrl && !checkpoint.nextBySeed[String(loaded.seedIndex || 0)]) {
          checkpoint.nextBySeed[String(loaded.seedIndex || 0)] = loaded.nextUrl;
        }
        if (loaded.pageInSeed != null && loaded.round == null) checkpoint.round = Number(loaded.pageInSeed || 0);
      }
    } catch {}
    const processed = new Set();
    let acceptedCount = 0;
    try {
      const lines = createInterface({ input: createReadStream(candidates, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line);
        const id = String(record.source_record_id || record.id || '');
        if (id) processed.add(id);
        acceptedCount += 1;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!acceptedCount && Number(checkpoint.acceptedCount || 0) > 0) {
      checkpoint = { version, seedIndex: 0, pageInSeed: 0, nextUrl: null, complete: false };
    }
    const persistCheckpoint = () => writeJsonAtomic(checkpointFile, {
      ...checkpoint, acceptedCount, updatedAt: new Date().toISOString()
    });
    const requestBudget = Math.max(1, Math.min(2_000,
      Number.parseInt(environment.PDOK_BAG_MAX_REQUESTS_PER_RUN || '1000', 10) || 1000));
    const maximumPages = Math.max(1, Math.min(10,
      Number.parseInt(environment.PDOK_BAG_MAX_PAGES_PER_SEED || '2', 10) || 2));
    const pageLimit = Math.max(1, Math.min(250,
      Math.floor(sourceMaximum / Math.max(1, seeds.length * maximumPages)) || 1));
    const apiOrigin = new URL(discovery.dataUrl).origin;
    const apiPath = new URL(discovery.dataUrl).pathname;
    const checkedItemsUrl = (value) => {
      const url = new URL(value);
      if (url.origin !== apiOrigin || url.pathname !== apiPath) {
        throw Object.assign(new Error(`PDOK BAG returned an invalid pagination URL: ${url}`), {
          code: 'SOURCE_METADATA_INVALID'
        });
      }
      return url.toString();
    };
    let requests = 0;
    try {
      while (!checkpoint.complete && acceptedCount < sourceMaximum && requests < requestBudget) {
        if (checkpoint.seedIndex >= seeds.length) {
          checkpoint.complete = true;
          break;
        }
        const seedIndex = checkpoint.seedIndex;
        const seed = seeds[seedIndex];
        if (checkpoint.round > 0 && !checkpoint.nextBySeed[String(seedIndex)]) {
          checkpoint.seedIndex += 1;
          if (checkpoint.seedIndex >= seeds.length) {
            checkpoint.round += 1;
            checkpoint.seedIndex = 0;
            if (checkpoint.round >= maximumPages) checkpoint.complete = true;
          }
          await persistCheckpoint();
          continue;
        }
        const firstPage = new URL(discovery.dataUrl);
        firstPage.searchParams.set('f', 'json');
        firstPage.searchParams.set('limit', String(pageLimit));
        firstPage.searchParams.set('bbox', [
          seed.longitude - 0.06, seed.latitude - 0.04,
          seed.longitude + 0.06, seed.latitude + 0.04
        ].map((value) => value.toFixed(6)).join(','));
        const requestUrl = checkedItemsUrl(checkpoint.round > 0
          ? checkpoint.nextBySeed[String(seedIndex)] : firstPage);
        const payload = await jsonRequest(requestUrl, fetchImpl);
        requests += 1;
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
          throw Object.assign(new Error('PDOK BAG returned an invalid FeatureCollection'), {
            code: 'SOURCE_METADATA_INVALID'
          });
        }
        const records = [];
        for (const feature of payload.features) {
          const record = normalizePdokBagFeature(feature, shard.source.name);
          if (!record || processed.has(record.source_record_id)) continue;
          processed.add(record.source_record_id);
          records.push(record);
          acceptedCount += 1;
          if (acceptedCount >= sourceMaximum) break;
        }
        if (records.length) await appendFile(candidates, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
        const next = payload.links?.find((link) => link.rel === 'next')?.href;
        if (checkpoint.round === 0 && next && acceptedCount < sourceMaximum) {
          checkpoint.nextBySeed[String(seedIndex)] = checkedItemsUrl(next);
        } else if (checkpoint.round > 0) {
          delete checkpoint.nextBySeed[String(seedIndex)];
        }
        checkpoint.seedIndex += 1;
        if (checkpoint.seedIndex >= seeds.length) {
          checkpoint.seedIndex = 0;
          checkpoint.round += 1;
          if (checkpoint.round >= maximumPages || !Object.keys(checkpoint.nextBySeed).length) checkpoint.complete = true;
        }
        if (acceptedCount >= sourceMaximum) checkpoint.complete = true;
        await persistCheckpoint();
      }
    } finally {
      await persistCheckpoint();
    }
    if (!checkpoint.complete) throw Object.assign(new Error('PDOK BAG initialization paused at its request budget'), {
      code: 'SOURCE_PARTIAL'
    });
    if (acceptedCount < minimumRecords) throw Object.assign(
      new Error(`PDOK BAG produced ${acceptedCount} qualifying records; ${minimumRecords} required`), {
        code: 'SOURCE_QUALITY_FAILED', metrics: { acceptedCount, minimumRecords }
      });
    const temporary = `${output}.${process.pid}.tmp`;
    let sourceChecksum;
    try {
      await copyFile(candidates, temporary);
      await replaceFile(temporary, output);
      sourceChecksum = await sha256File(candidates);
    } finally {
      await rm(temporary, { force: true });
    }
    await Promise.all([rm(candidates, { force: true }), rm(checkpointFile, { force: true })]);
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false
    };
  };

  const materializeLicensedResidential = async (shard, discovery, options) => {
    const version = safeVersion(discovery.version);
    const sourceMaximum = Math.min(options.maxRecords, Number(shard.maxRecords || options.maxRecords));
    const output = resolve(options.cacheDir, 'normalized',
      `${shard.id}-${version}-${normalizedCachePolicyIdentity(sourceMaximum, options.perLocality)}.jsonl`);
    try {
      const size = (await stat(output)).size;
      if (await hasMinimumLines(output, Number(shard.qualityGate?.minimumRecords || 1))) {
        return { file: output, format: 'overture-jsonl', cacheBytes: size, checksum: await sha256File(output), cacheHit: true };
      }
      await rm(output, { force: true });
    } catch {}
    const mappingName = shard.source.mappingEnvironment;
    let mapping;
    try { mapping = JSON.parse(String(environment[mappingName] || '')); }
    catch { throw Object.assign(new Error(`${mappingName} must be a JSON field map`), { code: 'SOURCE_CONFIGURATION_INVALID' }); }
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw Object.assign(new Error(`${mappingName} must be a JSON field map`), { code: 'SOURCE_CONFIGURATION_INVALID' });
    }
    const residentialValues = String(environment[shard.source.residentialValuesEnvironment] || '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    const datasetResidential = environmentEnabled(environment[shard.source.datasetResidentialEnvironment]);
    if ((!mapping.residentialClass || !residentialValues.length) && !datasetResidential) {
      throw Object.assign(new Error('Licensed feeds require explicit residential evidence'), {
        code: 'SOURCE_CONFIGURATION_INVALID'
      });
    }
    await mkdir(resolve(options.cacheDir, 'normalized'), { recursive: true });
    const remote = /^https:\/\//iu.test(discovery.dataUrl);
    const sourceFile = remote
      ? resolve(options.cacheDir, 'raw', `${shard.id}-${version}${shard.source.fileExtension || '.feed'}`)
      : await licensedLocalFile(discovery.dataUrl);
    if (remote) await download(discovery.dataUrl, sourceFile, {
      expectedBytes: discovery.sourceBytes,
      maxBytes: options.maxBytes
    });
    const sourceChecksum = discovery.sourceChecksum || await sha256File(sourceFile);
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      await runExecute({
        file: pythonBin,
        args: [licensedResidentialExporter,
          '--input', sourceFile,
          '--output', temporary,
          '--country', shard.countryCode,
          '--source-name', shard.source.name,
          '--mapping-json', JSON.stringify(mapping),
          '--format', String(environment[shard.source.formatEnvironment] || 'auto'),
          '--residential-values', residentialValues.join(','),
          ...(datasetResidential ? ['--dataset-residential'] : []),
          '--max-records', String(sourceMaximum)],
        phase: `materialize:${shard.id}`
      });
      await replaceFile(temporary, output);
    } finally {
      await rm(temporary, { force: true });
      if (remote && !options.retainRaw) await rm(sourceFile, { force: true });
    }
    const size = (await stat(output)).size;
    return {
      file: output,
      format: 'overture-jsonl',
      cacheBytes: size,
      checksum: await sha256File(output),
      sourceChecksum,
      cacheHit: false
    };
  };

  const materialize = (shard, discovery, options) => {
    if (discovery.adapter === 'overture') return materializeOverture(shard, discovery, options);
    if (discovery.adapter === 'geofabrik') return materializeGeofabrik(shard, discovery, options);
    if (discovery.adapter === 'japan-abr') return materializeJapanAbr(shard, discovery, options);
    if (discovery.adapter === 'singapore-hdb') return materializeSingaporeHdb(shard, discovery, options);
    if (discovery.adapter === 'korea-kapt') return materializeKoreaKapt(shard, discovery, options);
    if (discovery.adapter === 'openaddresses-archive') return materializeOpenAddresses(shard, discovery, options);
    if (discovery.adapter === 'inegi-residential') return materializeInegiResidential(shard, discovery, options);
    if (discovery.adapter === 'ethekwini-residential') return materializeEthekwiniResidential(shard, discovery, options);
    if (discovery.adapter === 'cape-town-residential') return materializeCapeTownResidential(shard, discovery, options);
    if (discovery.adapter === 'taiwan-residential') return materializeTaiwanResidential(shard, discovery, options);
    if (discovery.adapter === 'hong-kong-residential') return materializeHongKongResidential(shard, discovery, options);
    if (discovery.adapter === 'mappls-residential') return materializeMapplsResidential(shard, discovery, options);
    if (discovery.adapter === 'licensed-residential-feed') return materializeLicensedResidential(shard, discovery, options);
    if (discovery.adapter === 'pdok-bag') return materializePdokBag(shard, discovery, options);
    throw new Error(`Unsupported source adapter: ${discovery.adapter}`);
  };

  const cleanupSharedRaw = async () => {
    await Promise.all([...sharedRawFiles].map((file) => rm(file, { force: true })));
    sharedRawFiles.clear();
  };

  return { discover, materialize, cleanupSharedRaw };
};
