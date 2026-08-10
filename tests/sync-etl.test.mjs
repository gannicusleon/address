import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localizeAddressRecords, normalizeSourceRecord, runAddressEtl } from '../server/sync/address-etl.mjs';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';
import {
  canonicalizeHtmlText, createSourceAdapters, loadSourceCatalog, normalizedCachePolicyIdentity,
  parseGeofabrikMd5, sourceSizeMatches, stableHtmlFingerprint
} from '../server/sync/source-adapters.mjs';
import { runAddressSync } from '../server/sync/run-address-sync.mjs';

const execFileAsync = promisify(execFile);
const directories = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const source = {
  id: 'fixture', adapter: 'overture', name: 'Fixture', homepageUrl: 'https://example.test',
  dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
  licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms',
  shareAlike: false, redistributionAllowed: true, updateCadence: 'monthly'
};

describe('address source shard catalog', () => {
  it('expands independently supported country shards with explicit refresh intervals', async () => {
    const catalog = await loadSourceCatalog();
    expect(catalog.shards).toHaveLength(138);
    expect(catalog.shards.filter((shard) => shard.id !== 'korea-kapt-residential')
      .every((shard) => shard.intervalDays === 30)).toBe(true);
    expect(catalog.shards.some((shard) => shard.countryCode === 'CN')).toBe(false);
    expect(catalog.shards.some((shard) => shard.countryCode === 'NG')).toBe(false);
    for (const countryCode of ['AU', 'CA', 'ES', 'IT']) {
      expect(catalog.shards.filter((shard) => shard.countryCode === countryCode)).toHaveLength(2);
    }
    expect(catalog.shards.filter((shard) => shard.countryCode === 'NL')).toHaveLength(2);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'HK')).toHaveLength(3);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'TW')).toHaveLength(3);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'MX')).toHaveLength(3);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'SA')).toHaveLength(2);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'JP')).toHaveLength(1);
    expect(catalog.shards.find((shard) => shard.id === 'japan-abr-residential')).toMatchObject({
      countryCode: 'JP', extractId: 'japan', maxRecords: 20000,
      source: {
        adapter: 'japan-abr', postalDataUrl: expect.stringContaining('utf_ken_all.zip'),
        useOsmSupplement: true,
        plateauBundles: expect.arrayContaining([expect.objectContaining({ cityCode: '13113', bytes: 42731104 })])
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'japan-abr-residential').source.plateauBundles).toHaveLength(29);
    expect(catalog.shards.find((shard) => shard.id === 'singapore-hdb-residential')).toMatchObject({
      countryCode: 'SG', maxRecords: 12000,
      source: {
        adapter: 'singapore-hdb',
        propertyDatasetId: 'd_17f5382f26140b1fdae0ba2ef6239d2f',
        buildingDatasetId: 'd_16b157c52ed637edd6ba1232e026258d'
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'korea-kapt-residential')).toMatchObject({
      countryCode: 'KR', maxRecords: 20000, intervalDays: 1,
      source: { adapter: 'korea-kapt', dailyGeocodeLimit: 2800 }
    });
    expect(catalog.shards.find((shard) => shard.id === 'ethekwini-za-residential')).toMatchObject({
      countryCode: 'ZA', maxRecords: 4500,
      source: {
        adapter: 'ethekwini-residential',
        postalDataUrl: 'https://www.postoffice.co.za/Questions/postalcodes.txt'
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'cape-town-za-residential')).toMatchObject({
      countryCode: 'ZA', maxRecords: 4500,
      source: {
        adapter: 'cape-town-residential',
        parcelUrl: expect.stringContaining('Property/FeatureServer/0'),
        postalDataUrl: 'https://www.postoffice.co.za/Questions/postalcodes.txt'
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'taiwan-official-residential')).toMatchObject({
      countryCode: 'TW', maxRecords: 10000,
      source: {
        adapter: 'taiwan-residential', archives: [
          { sourceVersion: '115S2', archiveCacheName: 'tw-molit-lvr-115S2.zip' },
          { sourceVersion: '115S1', archiveCacheName: 'tw-molit-lvr-115S1.zip' }
        ],
        openAddressesDataUrl: expect.stringContaining('openaddr-collected-asia.zip'),
        postcodeCacheName: 'taiwan-postcode-cache.jsonl', postcodeConcurrency: 6
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'inegi-mx-residential')).toMatchObject({
      countryCode: 'MX', maxRecords: 20000,
      source: {
        adapter: 'inegi-residential', normalizedArchiveMember: 'produto_final.csv',
        sha256: 'd0b51cdba97f9c04eb7e8e4c17695770d66730b895308543781729851e0bd67e'
      }
    });
    expect(catalog.shards.find((shard) => shard.id === 'openaddresses-sa-national')).toMatchObject({
      countryCode: 'SA', maxRecords: 5000,
      source: { adapter: 'openaddresses-archive', archiveMember: 'ksa_FeatureToPoint_RESTACKED.csv' }
    });
    expect(catalog.shards.find((shard) => shard.id === 'openaddresses-kr-juso')).toMatchObject({
      countryCode: 'KR', maxRecords: 10000,
      source: { adapter: 'openaddresses-archive', archiveMembers: expect.arrayContaining([
        'kr/11/provincewide.csv', 'kr/50/provincewide.csv'
      ]) }
    });
    expect(catalog.shards.find((shard) => shard.id === 'openaddresses-kr-juso').source.archiveMembers)
      .toHaveLength(17);
    expect(catalog.shards.find((shard) => shard.id === 'hong-kong-official-residential'))
      .toMatchObject({ countryCode: 'HK', maxRecords: 20000 });
    expect(catalog.shards.find((shard) => shard.id === 'taiwan-official-residential'))
      .toMatchObject({
        countryCode: 'TW', maxRecords: 10000,
        source: { dataUrl: 'https://plvr.land.moi.gov.tw/DownloadSeason?season=115S2&type=zip&fileName=lvr_landcsv.zip' }
      });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-au')).toMatchObject({
      countryCode: 'AU', extractId: 'australia'
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-ca')).toMatchObject({
      countryCode: 'CA', extractId: 'canada'
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-es')).toMatchObject({
      countryCode: 'ES', extractId: 'spain'
    });
    expect(catalog.shards.filter((shard) => shard.countryCode === 'US')).toHaveLength(54);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'DE')).toHaveLength(17);
    expect(catalog.shards.filter((shard) => shard.countryCode === 'FR')).toHaveLength(28);
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-us-ca')).toMatchObject({
      extractId: 'us/california', maxRecords: 3000,
      source: { id: 'geofabrik-osm-us-ca' }
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-de-hb')).toMatchObject({
      extractId: 'bremen', maxRecords: 3000, source: { id: 'geofabrik-osm-de-hb' }
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-fr-corse')).toMatchObject({
      extractId: 'corse', maxRecords: 2000,
      qualityGate: expect.objectContaining({ minimumRecords: 10, minimumAdmin1: 0 })
    });
    expect(catalog.shards.find((shard) => shard.countryCode === 'MY')).toMatchObject({ extractId: 'malaysia-singapore-brunei', boundaryIso3: 'MYS' });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-sa')).toMatchObject({ extractId: 'gcc-states', boundaryIso3: 'SAU' });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-ph')).toMatchObject({
      countryCode: 'PH', extractId: 'philippines',
      postcodeDataUrl: 'https://phlpost.gov.ph/zip-code-locator/'
    });
    expect(catalog.shards.find((shard) => shard.id === 'geofabrik-osm-vn')).toMatchObject({
      countryCode: 'VN', extractId: 'vietnam', postcodeDataFormat: 'pdf',
      postcodeDataUrl: expect.stringContaining('danh-muc-ma-buu-chinh-quoc-gia')
    });
  });

  it('keeps licensed sources disabled until their explicit activation flags are set', async () => {
    const base = await loadSourceCatalog(undefined, {});
    expect(base.shards.some((shard) => shard.id === 'mappls-in-residential')).toBe(false);
    expect(base.shards.some((shard) => shard.id === 'vpostcode-vn-licensed')).toBe(false);
    expect(base.shards.some((shard) => shard.id === 'ng-licensed-residential')).toBe(false);
    const enabled = await loadSourceCatalog(undefined, {
      ADDRESS_SYNC_MAPPLS_ENABLED: 'true',
      ADDRESS_SYNC_VPOSTCODE_ENABLED: 'true',
      ADDRESS_SYNC_VPOSTCODE_FEED_URL: 'https://licensed.example/vn.jsonl',
      ADDRESS_SYNC_NG_FEED_ENABLED: 'true',
      ADDRESS_SYNC_NG_FEED_URL: 'https://licensed.example/ng.csv'
    });
    expect(enabled.shards.find((shard) => shard.id === 'mappls-in-residential'))
      .toMatchObject({ countryCode: 'IN', quotaProvider: 'mappls' });
    expect(enabled.shards.find((shard) => shard.id === 'vpostcode-vn-licensed'))
      .toMatchObject({ countryCode: 'VN', source: { dataUrl: 'https://licensed.example/vn.jsonl' } });
    expect(enabled.shards.find((shard) => shard.id === 'ng-licensed-residential'))
      .toMatchObject({ countryCode: 'NG', source: { dataUrl: 'https://licensed.example/ng.csv' } });
    expect(enabled.shards.filter((shard) => ['mappls-in-residential', 'vpostcode-vn-licensed', 'ng-licensed-residential']
      .includes(shard.id)).every((shard) => shard.source.redistributionAllowed === false)).toBe(true);
    const licensed = await loadSourceCatalog(undefined, {
      ADDRESS_SYNC_MAPPLS_ENABLED: 'true', ADDRESS_SYNC_MAPPLS_REDISTRIBUTION_ALLOWED: 'true',
      ADDRESS_SYNC_VPOSTCODE_ENABLED: 'true', ADDRESS_SYNC_VPOSTCODE_FEED_URL: 'https://licensed.example/vn.jsonl',
      ADDRESS_SYNC_VPOSTCODE_REDISTRIBUTION_ALLOWED: 'true',
      ADDRESS_SYNC_NG_FEED_ENABLED: 'true', ADDRESS_SYNC_NG_FEED_URL: 'https://licensed.example/ng.csv',
      ADDRESS_SYNC_NG_REDISTRIBUTION_ALLOWED: 'true'
    });
    expect(licensed.shards.filter((shard) => ['mappls-in-residential', 'vpostcode-vn-licensed', 'ng-licensed-residential']
      .includes(shard.id)).every((shard) => shard.source.redistributionAllowed === true)).toBe(true);
  });

  it('rotates Mappls credentials and resumes from a durable normalized checkpoint', async () => {
    const cacheDir = resolve('.data-cache', `mappls-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const environment = {
      ADDRESS_SYNC_MAPPLS_LICENSE_CONFIRMED: 'true',
      ADDRESS_SYNC_MAPPLS_REDISTRIBUTION_ALLOWED: 'true',
      MAPPLS_RESIDENTIAL_CATEGORY_CODES: 'RES001',
      MAPPLS_API_KEY: 'quota-key',
      MAPPLS_API_KEY_2: 'working-key',
      MAPPLS_MAX_REQUESTS_PER_RUN: '10'
    };
    const tokens = [];
    const requestedUrls = [];
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url);
      const token = url.searchParams.get('access_token');
      tokens.push(token);
      if (token === 'quota-key') return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
      if (url.hostname === 'search.mappls.com') return Response.json({
        suggestedLocations: [{ eLoc: 'ABC123' }],
        pageInfo: { totalPages: 1 }
      });
      return Response.json({
        eloc: 'ABC123', address: '18, MG Road, Central Delhi, New Delhi, Delhi, 110001', district: 'Central Delhi',
        city: 'New Delhi', state: 'Delhi', pincode: '110001',
        latitude: 28.632, longitude: 77.219
      });
    });
    const adapters = createSourceAdapters({
      fetchImpl,
      environment,
      loadSeedLocations: async () => [{ latitude: 28.63146, longitude: 77.217423 }]
    });
    const shard = {
      id: 'mappls-in-residential', countryCode: 'IN', maxRecords: 1,
      source: {
        id: 'mappls-in-residential', adapter: 'mappls-residential', name: 'Mappls fixture',
        dataUrl: 'https://search.mappls.com/search/places/nearby/json',
        licenseConfirmationEnvironment: 'ADDRESS_SYNC_MAPPLS_LICENSE_CONFIRMED',
        redistributionConfirmationEnvironment: 'ADDRESS_SYNC_MAPPLS_REDISTRIBUTION_ALLOWED',
        categoryCodesEnvironment: 'MAPPLS_RESIDENTIAL_CATEGORY_CODES'
      }
    };
    const discovery = await adapters.discover(shard);
    const first = await adapters.materialize(shard, discovery, {
      cacheDir, maxBytes: 10_000_000, maxRecords: 1, perLocality: 10, retainRaw: false
    });
    expect(tokens).toEqual(['quota-key', 'working-key', 'working-key']);
    expect(requestedUrls.at(-1).toString()).toContain('https://explore.mappls.com/apis/O2O/entity/ABC123');
    expect(JSON.parse((await readFile(first.file, 'utf8')).trim())).toMatchObject({
      source_record_id: 'ABC123', number: '18', street: 'MG Road', property_type: 'residential'
    });
    expect(await readFile(first.file, 'utf8')).not.toContain('working-key');
    const calls = fetchImpl.mock.calls.length;
    await (await import('node:fs/promises')).rm(first.file);
    const second = await adapters.materialize(shard, discovery, {
      cacheDir, maxBytes: 10_000_000, maxRecords: 1, perLocality: 10, retainRaw: false
    });
    expect(second.cacheHit).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('imports only explicitly residential rows from a licensed feed mapping', async () => {
    const dataRoot = resolve('.data-cache', `licensed-feed-${process.pid}-${Date.now()}`);
    directories.push(dataRoot);
    await mkdir(dataRoot, { recursive: true });
    const input = resolve(dataRoot, 'vpostcode.csv');
    await writeFile(input, [
      'record_id,house,road,ward,province,postcode,lon,lat,use',
      'vn-1,12,Le Loi,Ward 1,Ho Chi Minh City,70000,106.70,10.77,residential',
      'vn-2,14,Le Loi,Ward 1,Ho Chi Minh City,70000,106.71,10.78,commercial'
    ].join('\n'));
    const environment = {
      ADDRESS_DATA_ROOT: dataRoot,
      ADDRESS_SYNC_VPOSTCODE_LICENSE_CONFIRMED: 'true',
      ADDRESS_SYNC_VPOSTCODE_REDISTRIBUTION_ALLOWED: 'true',
      ADDRESS_SYNC_VPOSTCODE_FIELD_MAP: JSON.stringify({
        id: 'record_id', number: 'house', street: 'road', locality: 'ward', admin1: 'province',
        postcode: 'postcode', longitude: 'lon', latitude: 'lat', residentialClass: 'use'
      }),
      ADDRESS_SYNC_VPOSTCODE_RESIDENTIAL_VALUES: 'residential',
      ADDRESS_SYNC_VPOSTCODE_FEED_FORMAT: 'csv'
    };
    const adapters = createSourceAdapters({ environment });
    const shard = {
      id: 'vpostcode-vn-licensed', countryCode: 'VN', maxRecords: 100,
      source: {
        id: 'vpostcode-vn-licensed', adapter: 'licensed-residential-feed', name: 'Vpostcode fixture',
        dataUrl: input,
        licenseConfirmationEnvironment: 'ADDRESS_SYNC_VPOSTCODE_LICENSE_CONFIRMED',
        redistributionConfirmationEnvironment: 'ADDRESS_SYNC_VPOSTCODE_REDISTRIBUTION_ALLOWED',
        versionEnvironment: 'ADDRESS_SYNC_VPOSTCODE_FEED_VERSION',
        mappingEnvironment: 'ADDRESS_SYNC_VPOSTCODE_FIELD_MAP',
        formatEnvironment: 'ADDRESS_SYNC_VPOSTCODE_FEED_FORMAT',
        residentialValuesEnvironment: 'ADDRESS_SYNC_VPOSTCODE_RESIDENTIAL_VALUES',
        datasetResidentialEnvironment: 'ADDRESS_SYNC_VPOSTCODE_DATASET_RESIDENTIAL'
      }
    };
    const discovery = await adapters.discover(shard);
    const result = await adapters.materialize(shard, discovery, {
      cacheDir: resolve(dataRoot, 'cache'), maxBytes: 10_000_000, maxRecords: 100, perLocality: 10, retainRaw: false
    });
    const rows = (await readFile(result.file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_record_id: 'vn-1', number: '12', street: 'Le Loi', property_type: 'residential'
    });
  });

  it('persists a Mappls checkpoint when a page request fails', async () => {
    const cacheDir = resolve('.data-cache', `mappls-failure-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const environment = {
      ADDRESS_SYNC_MAPPLS_LICENSE_CONFIRMED: 'true',
      ADDRESS_SYNC_MAPPLS_REDISTRIBUTION_ALLOWED: 'true',
      MAPPLS_RESIDENTIAL_CATEGORY_CODES: 'RES001',
      MAPPLS_MAX_REQUESTS_PER_RUN: '10'
    };
    let available = true;
    const adapters = createSourceAdapters({
      environment,
      credentialPool: {
        acquire: async () => {
          if (!available) return null;
          available = false;
          return { id: 'fixture-key', secret: 'fixture-secret' };
        },
        report: async () => {}
      },
      fetchImpl: async () => { throw new Error('fixture network failure'); },
      loadSeedLocations: async () => [{ latitude: 28.63146, longitude: 77.217423 }]
    });
    const shard = {
      id: 'mappls-in-residential', countryCode: 'IN', maxRecords: 1,
      source: {
        id: 'mappls-in-residential', adapter: 'mappls-residential', name: 'Mappls fixture',
        dataUrl: 'https://search.mappls.com/search/places/nearby/json',
        licenseConfirmationEnvironment: 'ADDRESS_SYNC_MAPPLS_LICENSE_CONFIRMED',
        redistributionConfirmationEnvironment: 'ADDRESS_SYNC_MAPPLS_REDISTRIBUTION_ALLOWED',
        categoryCodesEnvironment: 'MAPPLS_RESIDENTIAL_CATEGORY_CODES'
      }
    };
    const discovery = await adapters.discover(shard);
    await expect(adapters.materialize(shard, discovery, {
      cacheDir, maxBytes: 10_000_000, maxRecords: 1, perLocality: 10, retainRaw: false
    })).rejects.toMatchObject({ code: 'SOURCE_CREDENTIAL_UNAVAILABLE' });
    const identity = normalizedCachePolicyIdentity(1, 10);
    const checkpoint = JSON.parse(await readFile(resolve(
      cacheDir, 'raw', `mappls-in-residential-${discovery.version}-${identity}-checkpoint.json`
    ), 'utf8'));
    expect(checkpoint).toMatchObject({ version: discovery.version, complete: false, seedIndex: 0, categoryIndex: 0, page: 1 });
  });

  it('removes a remote licensed feed after exporter failure', async () => {
    const cacheDir = resolve('.data-cache', `licensed-cleanup-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const environment = {
      ADDRESS_SYNC_VPOSTCODE_LICENSE_CONFIRMED: 'true',
      ADDRESS_SYNC_VPOSTCODE_REDISTRIBUTION_ALLOWED: 'true',
      ADDRESS_SYNC_VPOSTCODE_FIELD_MAP: JSON.stringify({
        id: 'id', number: 'number', street: 'street', locality: 'locality', admin1: 'admin1',
        postcode: 'postcode', longitude: 'longitude', latitude: 'latitude', residentialClass: 'class'
      }),
      ADDRESS_SYNC_VPOSTCODE_RESIDENTIAL_VALUES: 'residential',
      ADDRESS_SYNC_VPOSTCODE_FEED_FORMAT: 'jsonl'
    };
    const fetchImpl = vi.fn(async (_input, init = {}) => {
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { etag: 'fixture-v1' } });
      return new Response('{"id":"vn-1"}\n', { status: 200 });
    });
    const adapters = createSourceAdapters({
      environment,
      fetchImpl,
      execute: async () => { throw new Error('fixture exporter failure'); }
    });
    const shard = {
      id: 'vpostcode-vn-licensed', countryCode: 'VN', maxRecords: 1,
      source: {
        id: 'vpostcode-vn-licensed', adapter: 'licensed-residential-feed', name: 'Vpostcode fixture',
        dataUrl: 'https://licensed.example/vn.jsonl', fileExtension: '.jsonl',
        licenseConfirmationEnvironment: 'ADDRESS_SYNC_VPOSTCODE_LICENSE_CONFIRMED',
        redistributionConfirmationEnvironment: 'ADDRESS_SYNC_VPOSTCODE_REDISTRIBUTION_ALLOWED',
        versionEnvironment: 'ADDRESS_SYNC_VPOSTCODE_FEED_VERSION',
        mappingEnvironment: 'ADDRESS_SYNC_VPOSTCODE_FIELD_MAP',
        formatEnvironment: 'ADDRESS_SYNC_VPOSTCODE_FEED_FORMAT',
        residentialValuesEnvironment: 'ADDRESS_SYNC_VPOSTCODE_RESIDENTIAL_VALUES',
        datasetResidentialEnvironment: 'ADDRESS_SYNC_VPOSTCODE_DATASET_RESIDENTIAL'
      }
    };
    const discovery = await adapters.discover(shard);
    await expect(adapters.materialize(shard, discovery, {
      cacheDir, maxBytes: 10_000_000, maxRecords: 1, perLocality: 10, retainRaw: false
    })).rejects.toThrow('fixture exporter failure');
    const rawFiles = await (await import('node:fs/promises')).readdir(resolve(cacheDir, 'raw')).catch(() => []);
    expect(rawFiles).toEqual([]);
  });

  it('includes output limits in normalized cache identities', () => {
    expect(normalizedCachePolicyIdentity(20_000, 2_000)).toBe('m20000-p2000');
    expect(normalizedCachePolicyIdentity(10_000, 2_000))
      .not.toBe(normalizedCachePolicyIdentity(20_000, 2_000));
    expect(normalizedCachePolicyIdentity(20_000, 300))
      .not.toBe(normalizedCachePolicyIdentity(20_000, 2_000));
  });

  it('discovers the official Vietnam postcode PDF as binary content', async () => {
    const pdf = Buffer.alloc(120_000, 7);
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('index-v1-nogeom.json')) return Response.json({ features: [{
        properties: { id: 'vietnam', urls: { pbf: 'https://download.geofabrik.de/asia/vietnam-latest.osm.pbf' } }
      }] });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Thu, 31 Jul 2026 00:00:00 GMT', etag: 'vn', 'content-length': '100'
      } });
      if (url.endsWith('.pdf')) return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
      throw new Error(`Unexpected request: ${url}`);
    };
    const discovery = await createSourceAdapters({ fetchImpl }).discover({
      id: 'geofabrik-osm-vn', countryCode: 'VN', extractId: 'vietnam',
      postcodeDataUrl: 'https://example.test/vietnam-postcodes.pdf', postcodeDataFormat: 'pdf',
      source: { adapter: 'geofabrik' }
    });
    expect(discovery).toMatchObject({
      postcodeDataFormat: 'pdf', postcodeBytes: pdf.byteLength,
      postcodeDataUrl: 'https://example.test/vietnam-postcodes.pdf'
    });
    expect(discovery.version).toContain('-p');
  });

  it('fingerprints postcode HTML by stable visible content and reuses the discovered artifact', async () => {
    const cacheDir = resolve('.data-cache', `postcode-html-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const first = `<html><head><script nonce="one">window.requestId='one'</script></head>
      <body><table><tr><td>Metro Manila</td><td>1000</td></tr></table></body></html>`;
    const second = `<html data-request="two"><head><script nonce="two">window.requestId='two'</script></head>
      <body><table class="changed"><tr><td>Metro Manila</td><td>1000</td></tr></table></body></html>`;
    const firstFile = resolve(cacheDir, 'first.html');
    const secondFile = resolve(cacheDir, 'second.html');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(firstFile, first.repeat(1000));
    await writeFile(secondFile, second.repeat(1000));
    expect(canonicalizeHtmlText(first)).toBe(canonicalizeHtmlText(second));
    expect(await stableHtmlFingerprint(firstFile)).toBe(await stableHtmlFingerprint(secondFile));
  });

  it('stores localized variants, evidence and coordinates in the PostgreSQL hot pool schema', async () => {
    const schema = await readFile('server/database/schema.sql', 'utf8');
    expect(schema).toContain('component_variants_json TEXT NOT NULL');
    expect(schema).toContain('address_variants_json TEXT NOT NULL');
    expect(schema).toContain('idx_address_pool_coordinates');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS address_pool_evidence');
    expect(schema).toContain('dataset_id, address_id, source_record_id, evidence_type');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS pool_coverage');
    expect(schema).toContain('idx_address_pool_coverage ON address_pool(coverage, active, property_type)');
  });

  it('rejects HTML metadata with a structured URL-aware error after bounded retries', async () => {
    let requests = 0;
    const adapters = createSourceAdapters({
      fetchImpl: async () => {
        requests += 1;
        return new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
    });
    await expect(adapters.discover({ countryCode: 'US', source: { adapter: 'overture' } })).rejects.toMatchObject({
      code: 'SOURCE_METADATA_CONTENT_TYPE',
      url: 'https://stac.overturemaps.org/catalog.json',
      status: 200
    });
    expect(requests).toBe(3);
  });

  it('adds the Overture Buildings source only when residential classification is enabled', async () => {
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.endsWith('/catalog.json')) return Response.json({ latest: '2026-06-17.0' });
      if (url.endsWith('/collection.json')) return Response.json({ links: [{ rel: 'item', href: './00000.json' }] });
      return Response.json({
        bbox: [-180, -90, 180, 90],
        assets: { aws: { href: 'https://example.test/address.parquet' } }
      });
    };
    const shard = { countryCode: 'US', source: { adapter: 'overture' } };
    const enabled = await createSourceAdapters({ fetchImpl, enableOvertureResidential: true }).discover(shard);
    const disabled = await createSourceAdapters({ fetchImpl, enableOvertureResidential: false }).discover(shard);
    expect(enabled.buildingAssets).toEqual(['https://example.test/address.parquet']);
    expect(enabled.buildingAssetEntries).toEqual([{
      url: 'https://example.test/address.parquet', bbox: [-180, -90, 180, 90]
    }]);
    expect(disabled.buildingAssets).toEqual([]);
  });

  it('reads one or many OpenAddresses archive members with cross-member deduplication', async () => {
    const cacheDir = resolve('.data-cache', `openaddresses-members-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    await mkdir(cacheDir, { recursive: true });
    const header = 'LON,LAT,NUMBER,STREET,DISTRICT,CITY,REGION,POSTCODE,ID\n';
    const first = `${header}126.9704,37.5844,94,자하문로,청운동,종로구,서울특별시,03047,a1\n`
      + '127.0000,37.5000,10,테헤란로,역삼동,강남구,서울특별시,06236,a2\n'
      + '127.1000,37.6000,11,테헤란로,역삼동,강남구,서울특별시,,invalid\n';
    const second = `${header}126.9704,37.5844,94,자하문로,청운동,종로구,서울특별시,03047,duplicate\n`
      + '129.0756,35.1796,20,중앙대로,중앙동,중구,부산광역시,48924,b1\n';
    const archive = resolve(cacheDir, 'fixture.zip');
    const mapping = resolve(cacheDir, 'mapping.json');
    const oneMemberOutput = resolve(cacheDir, 'one.jsonl');
    const manyMemberOutput = resolve(cacheDir, 'many.jsonl');
    await writeFile(archive, zipSync({
      'kr/11/provincewide.csv': strToU8(first),
      'kr/26/provincewide.csv': strToU8(second)
    }));
    await writeFile(mapping, JSON.stringify({
      id: 'ID', number: 'NUMBER', street: 'STREET', district: 'DISTRICT', locality: 'CITY',
      admin1: 'REGION', postcode: 'POSTCODE', longitude: 'LON', latitude: 'LAT'
    }));
    const common = ['server/sync/openaddresses-export.py', '--input', archive,
      '--mapping-file', mapping, '--country', 'KR', '--max-records', '10', '--per-locality', '5'];
    const python = process.platform === 'win32' ? 'python' : 'python3';
    await execFileAsync(python, [...common, '--member', 'kr/11/provincewide.csv', '--output', oneMemberOutput]);
    await execFileAsync(python, [...common, '--member', 'kr/11/provincewide.csv',
      '--member', 'kr/26/provincewide.csv', '--output', manyMemberOutput]);
    const oneMember = (await readFile(oneMemberOutput, 'utf8')).trim().split('\n').map(JSON.parse);
    const manyMembers = (await readFile(manyMemberOutput, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(oneMember).toHaveLength(2);
    expect(manyMembers).toHaveLength(3);
    expect(new Set(manyMembers.map((record) => record.id)).size).toBe(3);
    expect(manyMembers.every((record) => record.postcode && record.district && record.locality)).toBe(true);
  });

  it('discovers OpenAddresses archives with Overture residential building assets', async () => {
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'openaddresses-sa-national');
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.dataUrl) {
        return new Response(null, { status: 206, headers: {
          'content-range': 'bytes 0-0/181901121', 'last-modified': 'Mon, 23 Jun 2025 13:13:06 GMT'
        } });
      }
      if (url.endsWith('/catalog.json')) return Response.json({ latest: '2026-07-22.0' });
      if (url.endsWith('/collection.json')) return Response.json({ links: [{ rel: 'item', href: './00000.json' }] });
      return Response.json({
        bbox: [-180, -90, 180, 90],
        assets: { aws: { href: 'https://example.test/building.parquet' } }
      });
    };
    const discovered = await createSourceAdapters({ fetchImpl }).discover(shard);
    expect(discovered).toMatchObject({
      adapter: 'openaddresses-archive', version: '2025-06-23', sourceBytes: 181901121,
      buildingAssets: ['https://example.test/building.parquet']
    });
  });

  it('discovers both preserved INEGI dwelling artifacts without a residential inference source', async () => {
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'inegi-mx-residential');
    const fetchImpl = async (input) => new Response(null, {
      status: 200,
      headers: {
        'content-length': String(String(input) === shard.source.dataUrl ? 639926884 : 683565189),
        'last-modified': 'Thu, 11 Apr 2024 00:00:00 GMT'
      }
    });
    const discovered = await createSourceAdapters({ fetchImpl }).discover(shard);
    expect(discovered).toMatchObject({
      adapter: 'inegi-residential',
      version: 'inegi-address-frame-preserved-2024-04-11-official-dwelling-v1',
      sourceBytes: 639926884,
      normalizedSourceBytes: 683565189
    });
    expect(discovered).not.toHaveProperty('buildingAssets');
  });

  it('accepts a complete rolling-source download within the discovery size window', () => {
    expect(sourceSizeMatches(21_091_815, 21_092_996)).toBe(true);
    expect(sourceSizeMatches(5_000_000, 21_092_996)).toBe(false);
    expect(sourceSizeMatches(21_091_815, null)).toBe(true);
  });

  it('parses only a valid Geofabrik MD5 checksum', () => {
    expect(parseGeofabrikMd5('0123456789abcdef0123456789ABCDEF  japan-latest.osm.pbf'))
      .toBe('0123456789abcdef0123456789abcdef');
    expect(parseGeofabrikMd5('missing')).toBeNull();
  });

  it('uses strict Japan PLATEAU evidence when the optional OSM source is unavailable', async () => {
    const cacheDir = resolve('.data-cache', `japan-abr-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const catalogShard = catalog.shards.find((entry) => entry.id === 'japan-abr-residential');
    const plateauPayload = 'plateau';
    const shard = {
      ...catalogShard,
      source: {
        ...catalogShard.source,
        plateauBundles: [{
          cityCode: '13113', year: 2023, url: 'https://example.test/plateau.tar.zst',
          sha256: createHash('sha256').update(plateauPayload).digest('hex'), bytes: plateauPayload.length
        }]
      }
    };
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.dataUrl) return Response.json({ meta: { updated: 1_735_102_668 }, data: [] });
      if (url.endsWith('index-v1-nogeom.json')) return Response.json({ features: [{
        properties: { id: 'japan', urls: { pbf: 'https://example.test/japan.osm.pbf' } }
      }] });
      if (init.method === 'HEAD' && url.endsWith('.pbf')) return new Response(null, { status: 503 });
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Tue, 30 Jun 2026 00:00:00 GMT',
        'content-length': url.endsWith('.zip') ? '7' : '8'
      } });
      if (url.endsWith('.zip')) return new Response('postal!');
      if (url.endsWith('.pbf')) return new Response('osm-data');
      if (url.endsWith('.tar.zst')) return new Response(plateauPayload);
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase, timeoutMs }) => {
      calls.push({ file, args, phase, timeoutMs });
      if (phase.startsWith('extract:')) {
        const output = args[args.indexOf('--output') + 1];
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, plateauPayload, 'utf8');
      } else {
        await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-jp' })}\n`, 'utf8');
      }
    };
    const adapters = createSourceAdapters({
      fetchImpl, execute, pythonBin: 'python-fixture', processTimeoutMs: 1_234
    });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'japan-abr',
        version: '1735102668-plateau-only-2026-06-30-abr-rsdt-plateau-osm-chiban-v10',
      sourceBytes: 14, osmUrl: null, osmVersion: 'plateau-only', osmBytes: null,
      postalVersion: '2026-06-30', postalBytes: 7, plateauBytes: 7
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 60000, perLocality: 200, maxBytes: 1024, retainRaw: false, sharedRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m20000-p200.jsonl');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      file: 'python-fixture', phase: 'extract:japan-abr-residential:13113', timeoutMs: 1_234
    });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('extract-tar-zstd.py'), '--archive', expect.stringContaining('.tar.zst'),
      '--output', expect.stringContaining('buildings.parquet'), '--member', 'buildings.parquet'
    ]));
    const materializeCall = calls.find(({ phase }) => phase === 'materialize:japan-abr-residential');
    expect(materializeCall).toMatchObject({ file: 'python-fixture', timeoutMs: 28_800_000 });
    expect(materializeCall.args).toEqual(expect.arrayContaining([
      expect.stringContaining('japan-abr-export.py'), '--abr-url', shard.source.dataUrl,
      '--max-records', '20000', '--per-locality', '200', '--plateau-parquet',
      expect.stringContaining('buildings.parquet')
    ]));
    expect(materializeCall.args).toEqual(expect.arrayContaining(['--plateau-city-code', '13113']));
    expect(materializeCall.args).toContain('--land-lot');
    expect(materializeCall.args).not.toContain('--osm-pbf');
  });

  it('uses a verified Geofabrik checksum when Japan PBF metadata HEAD is unavailable', async () => {
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'japan-abr-residential');
    const checksum = '0123456789abcdef0123456789abcdef';
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.dataUrl) return Response.json({ meta: { updated: 1_735_102_668 }, data: [] });
      if (url.endsWith('index-v1-nogeom.json')) return Response.json({ features: [{
        properties: { id: 'japan', urls: { pbf: 'https://example.test/japan.osm.pbf' } }
      }] });
      if (url.endsWith('.pbf.md5')) return new Response(`${checksum}  japan.osm.pbf`);
      if (init.method === 'HEAD' && url.endsWith('.pbf')) return new Response(null, { status: 502 });
      if (init.method === 'HEAD' && url.endsWith('.zip')) return new Response(null, { status: 200, headers: {
        'last-modified': 'Tue, 30 Jun 2026 00:00:00 GMT', 'content-length': '7'
      } });
      throw new Error(`Unexpected request: ${url}`);
    };
    const discovery = await createSourceAdapters({ fetchImpl }).discover(shard);
    expect(discovery).toMatchObject({
      osmUrl: 'https://example.test/japan.osm.pbf', osmMd5: checksum,
      osmVersion: checksum, osmBytes: null,
      version: `1735102668-${checksum}-2026-06-30-abr-rsdt-plateau-osm-chiban-v10`
    });
  });

  it('discovers and materializes the official Singapore HDB residential source', async () => {
    const cacheDir = resolve('.data-cache', `singapore-hdb-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'singapore-hdb-residential');
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('initiate-download')) {
        const property = url.includes(shard.source.propertyDatasetId);
        return Response.json({ data: { url: property
          ? 'https://example.test/property.csv' : 'https://example.test/buildings.geojson' } });
      }
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'last-modified': 'Wed, 29 Jul 2026 00:00:00 GMT',
        'content-length': url.endsWith('.csv') ? '8' : '9'
      } });
      if (url.endsWith('.csv')) return new Response('property');
      if (url.endsWith('.geojson')) return new Response('buildings');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-sg' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'singapore-hdb', version: '2026-07-29-hdb-property-building-onemap-v2',
      sourceBytes: 17, propertyBytes: 8, buildingBytes: 9, residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 12000, perLocality: 1000, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:singapore-hdb-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('singapore-hdb-export.py'), '--onemap-cache',
      expect.stringContaining('singapore-hdb-residential-onemap-cache.jsonl'),
      '--max-records', '12000', '--per-locality', '1000'
    ]));
  });

  it('discovers and materializes the official K-apt apartment source', async () => {
    const cacheDir = resolve('.data-cache', `korea-kapt-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'korea-kapt-residential');
    const calls = [];
    const fetchImpl = async () => new Response('<title>K-apt</title>', { status: 200,
      headers: { 'last-modified': 'Thu, 30 Jul 2026 00:00:00 GMT' } });
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({
        id: 'kapt-fixture', country: 'KR', postcode: '03000', street: '종로', number: '1',
        property_type: 'apartment', residential_building_id: 'A1'
      })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    const today = new Date().toISOString().slice(0, 10);
    expect(discovery).toMatchObject({
      adapter: 'korea-kapt', version: `2026-07-30-${today}-kapt-official-apartments-v2`
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 60000, perLocality: 500, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m20000-p500.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('korea-kapt-export.py'), '--postcode-cache',
      expect.stringContaining('korea-kapt-residential-postcode-cache.jsonl'),
      '--daily-geocode-limit', '2800', '--max-records', '20000', '--per-locality', '500'
    ]));
  });

  it('discovers and materializes the official eThekwini residential source', async () => {
    const cacheDir = resolve('.data-cache', `ethekwini-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'ethekwini-za-residential');
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === `${shard.source.addressUrl}?f=json`) return Response.json({ editingInfo: { lastEditDate: 1784806455000 } });
      if (url === `${shard.source.zoningUrl}?f=json`) return Response.json({ editingInfo: { lastEditDate: 1782986069000 } });
      if (url === shard.source.postalDataUrl && init.method === 'HEAD') return new Response(null, {
        status: 200, headers: { 'content-length': '6', 'last-modified': 'Fri, 31 Jul 2026 00:00:00 GMT' }
      });
      if (url === shard.source.postalDataUrl) return new Response('postal');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-za' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'ethekwini-residential',
      version: '2026-07-23-2026-07-31-official-address-zoning-postcode-v1',
      postalBytes: 6,
      residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 8000, perLocality: 1500, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m4500-p1500.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:ethekwini-za-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('south-africa-ethekwini-export.py'), '--postal-file',
      expect.stringContaining('ethekwini-za-residential-postalcodes.txt'),
      '--max-records', '4500', '--per-locality', '1500', '--concurrency', '16'
    ]));
  });

  it('discovers and materializes the official Cape Town residential source', async () => {
    const cacheDir = resolve('.data-cache', `cape-town-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'cape-town-za-residential');
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === `${shard.source.parcelUrl}?f=json`) return Response.json({ editingInfo: { lastEditDate: 1785138876806 } });
      if (url === shard.source.postalDataUrl && init.method === 'HEAD') return new Response(null, {
        status: 200, headers: { 'content-length': '6', 'last-modified': 'Fri, 31 Jul 2026 00:00:00 GMT' }
      });
      if (url === shard.source.postalDataUrl) return new Response('postal');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-cape-town' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'cape-town-residential',
      version: '2026-07-27-2026-07-31-official-parcel-zoning-postcode-v1',
      postalBytes: 6,
      residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 8000, perLocality: 1500, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m4500-p1500.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:cape-town-za-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('south-africa-cape-town-export.py'), '--parcel-url',
      expect.stringContaining('Property/FeatureServer/0'), '--postal-file',
      expect.stringContaining('cape-town-za-residential-postalcodes.txt'),
      '--max-records', '4500', '--per-locality', '1500'
    ]));
  });

  it('discovers and materializes the verified Taiwan residential source', async () => {
    const cacheDir = resolve('.data-cache', `taiwan-residential-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'taiwan-official-residential');
    const calls = [];
    const molitUrls = new Set(shard.source.archives.map(({ dataUrl }) => dataUrl));
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (init.method === 'HEAD' && molitUrls.has(url)) return new Response(null, {
        status: 200, headers: { 'content-length': '5', 'last-modified': 'Fri, 31 Jul 2026 00:00:00 GMT' }
      });
      if (init.method === 'HEAD' && url === shard.source.openAddressesDataUrl) return new Response(null, {
        status: 200, headers: { 'content-length': '7', 'last-modified': 'Thu, 30 Jul 2026 00:00:00 GMT' }
      });
      if (molitUrls.has(url)) return new Response('molit');
      if (url === shard.source.openAddressesDataUrl) return new Response('oa-data');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-tw' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'taiwan-residential', version: '115S2+115S1-molit-lvr-oa-post-v2',
      molitBytes: 10, openAddressesBytes: 7, residentialBuildingAvailable: true,
      molitArchives: [
        { sourceVersion: '115S2', bytes: 5 },
        { sourceVersion: '115S1', bytes: 5 }
      ]
    });
    const checksumShard = {
      ...shard,
      source: { ...shard.source, archives: shard.source.archives.map((archive) => ({ ...archive, sha256: null })) }
    };
    const checksumDiscovery = {
      ...discovery,
      molitArchives: discovery.molitArchives.map((archive) => ({ ...archive, sha256: null }))
    };
    const materialized = await adapters.materialize(checksumShard, checksumDiscovery, {
      cacheDir, maxRecords: 30000, perLocality: 1000, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m10000-p1000.jsonl');
    const retried = await adapters.materialize(checksumShard, checksumDiscovery, {
      cacheDir, maxRecords: 30000, perLocality: 1000, maxBytes: 1024, retainRaw: false
    });
    expect(retried).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:taiwan-official-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('taiwan-residential-export.py'), '--molit-archive', '--openaddresses-archive',
      '--postcode-cache', expect.stringContaining('taiwan-postcode-cache.jsonl'),
      '--max-records', '10000', '--per-locality', '1000', '--request-interval', '0.2',
      '--postcode-concurrency', '6'
    ]));
    expect(calls[0].args.filter((value) => value === '--molit-archive')).toHaveLength(2);
  });

  it('discovers and materializes the official Hong Kong residential source', async () => {
    const cacheDir = resolve('.data-cache', `hong-kong-residential-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    const catalog = await loadSourceCatalog();
    const shard = catalog.shards.find((entry) => entry.id === 'hong-kong-official-residential');
    expect(shard.source.dataUrl).toBe(shard.source.metadataUrl);
    const dataUrl = 'https://static.csdi.gov.hk/csdi-webpage/download/0123456789abcdef/csv';
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === shard.source.metadataUrl) return new Response(`
        <a href="${dataUrl}">CSV</a>
        <div>Last updated on</div><div>14/07/2026</div>
      `);
      if (init.method === 'HEAD' && url === dataUrl) {
        return new Response(null, { status: 200, headers: { 'content-length': '9' } });
      }
      if (url === dataUrl) return new Response('hk-source');
      throw new Error(`Unexpected request: ${url}`);
    };
    const execute = async ({ file, args, phase }) => {
      calls.push({ file, args, phase });
      await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify({ id: 'fixture-hk' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture' });
    const discovery = await adapters.discover(shard);
    expect(discovery).toMatchObject({
      adapter: 'hong-kong-residential', version: '2026-07-14-bd-building-information-v1',
      publishedAt: '2026-07-14T00:00:00.000Z', dataUrl, sourceBytes: 9,
      residentialBuildingAvailable: true
    });
    const materialized = await adapters.materialize(shard, discovery, {
      cacheDir, maxRecords: 60000, perLocality: 10000, maxBytes: 1024, retainRaw: false
    });
    expect(materialized).toMatchObject({ format: 'overture-jsonl', cacheHit: false });
    expect(materialized.file).toContain('-m20000-p10000.jsonl');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: 'python-fixture', phase: 'materialize:hong-kong-official-residential' });
    expect(calls[0].args).toEqual(expect.arrayContaining([
      expect.stringContaining('hong-kong-residential-export.py'), '--building-information', '--offline',
      '--max-records', '20000', '--per-district', '10000'
    ]));
  });

  it('reloads the Geofabrik index after a failed request', async () => {
    let indexRequests = 0;
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('index-v1-nogeom.json')) {
        indexRequests += 1;
        if (indexRequests === 1) return new Response('missing', { status: 404 });
        return Response.json({ features: [{
          properties: { id: 'china', urls: { pbf: 'https://download.geofabrik.de/asia/china-latest.osm.pbf' } }
        }] });
      }
      if (init.method === 'HEAD') {
        return new Response(null, { status: 200, headers: {
          'last-modified': 'Mon, 27 Jul 2026 00:00:00 GMT', etag: 'fixture', 'content-length': '100'
        } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const adapters = createSourceAdapters({ fetchImpl });
    const shard = {
      id: 'geofabrik-osm-cn', countryCode: 'CN', extractId: 'china',
      source: { adapter: 'geofabrik' }
    };
    await expect(adapters.discover(shard)).rejects.toMatchObject({ code: 'SOURCE_METADATA_HTTP', status: 404 });
    await expect(adapters.discover(shard)).resolves.toMatchObject({ version: '2026-07-27-fixture' });
    expect(indexRequests).toBe(2);
  });

  it('retries transient Geofabrik metadata failures', async () => {
    let headRequests = 0;
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('index-v1-nogeom.json')) {
        return Response.json({ features: [{
          properties: { id: 'bremen', urls: { pbf: 'https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf' } }
        }] });
      }
      if (init.method === 'HEAD') {
        headRequests += 1;
        if (headRequests === 1) throw new Error('transient timeout');
        return new Response(null, { status: 200, headers: {
          'last-modified': 'Mon, 27 Jul 2026 00:00:00 GMT', etag: 'fixture', 'content-length': '100'
        } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const adapters = createSourceAdapters({ fetchImpl });
    await expect(adapters.discover({
      id: 'geofabrik-osm-de-hb', countryCode: 'DE', extractId: 'bremen', source: { adapter: 'geofabrik' }
    })).resolves.toMatchObject({ version: '2026-07-27-fixture', sourceBytes: 100 });
    expect(headRequests).toBe(2);
  });

  it('reuses a complete one-day-old Geofabrik PBF only during initial bootstrap', async () => {
    const cacheDir = resolve('.data-cache', `recent-bootstrap-${process.pid}-${Date.now()}`);
    const rawDir = resolve(cacheDir, 'raw');
    directories.push(cacheDir);
    await mkdir(rawDir, { recursive: true });
    const fileName = 'geofabrik-osm-cn-2026-07-15-oldetag-china-latest.osm.pbf';
    const candidate = resolve(rawDir, fileName);
    await writeFile(candidate, Buffer.alloc(96));
    await writeFile(`${candidate}.part`, Buffer.alloc(96));
    await writeFile(`${candidate}.prefetch`, Buffer.alloc(96));
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('index-v1-nogeom.json')) {
        return Response.json({ features: [{
          properties: { id: 'china', urls: { pbf: 'https://download.geofabrik.de/asia/china-latest.osm.pbf' } }
        }] });
      }
      if (init.method === 'HEAD') {
        return new Response(null, { status: 200, headers: {
          'last-modified': 'Thu, 16 Jul 2026 00:00:00 GMT', etag: 'newetag', 'content-length': '100'
        } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const adapters = createSourceAdapters({ fetchImpl });
    const shard = {
      id: 'geofabrik-osm-cn', countryCode: 'CN', extractId: 'china',
      source: { adapter: 'geofabrik' }
    };
    await expect(adapters.discover(shard, { syncMode: 'initial', cacheDir })).resolves.toMatchObject({
      version: '2026-07-15-oldetag', publishedAt: '2026-07-15T00:00:00.000Z',
      sourceBytes: 96, estimateMethod: 'recent-bootstrap-raw', bootstrapRawFile: candidate
    });
    await expect(adapters.discover(shard, { syncMode: 'daily', cacheDir })).resolves.toMatchObject({
      version: '2026-07-16-newetag', sourceBytes: 100, estimateMethod: 'http-content-length', bootstrapRawFile: null
    });
  });
});

describe('source record normalization', () => {
  it('keeps source unit semantics separate from building names', () => {
    const overture = normalizeSourceRecord({
      id: 'unit-3', admin1: 'California', locality: 'Berkeley', postal_city: 'Berkeley', postcode: '94704',
      street: 'College Avenue', number: '2704', unit: '3', longitude: -122.25, latitude: 37.86
    }, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl');
    const osm = normalizeSourceRecord({
      id: 'node/3', geometry: { type: 'Point', coordinates: [-0.12, 51.5] }, properties: {
        '@id': 'node/3', 'addr:housenumber': '21', 'addr:street': 'Baker Street', 'addr:city': 'London',
        'addr:postcode': 'NW1 6XE', 'addr:unit': '3', name: 'Baker House'
      }
    }, { id: 'fixture-gb', countryCode: 'GB', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(overture.components).toMatchObject({ unit: '3', buildingName: '' });
    expect(osm.components).toMatchObject({ unit: '3', buildingName: 'Baker House' });
  });

  it('does not treat OSM addr:place as a postal locality', () => {
    const record = normalizeSourceRecord({
      id: 'way/4', geometry: { type: 'Point', coordinates: [9.4, 42.3] }, properties: {
        '@type': 'way', '@id': 'way/4', 'addr:housenumber': '27', 'addr:street': 'Ortia',
        'addr:place': 'Poggiale', 'addr:city': 'Tarrano', 'addr:postcode': '20234', building: 'house'
      }
    }, { id: 'fixture-fr', countryCode: 'FR', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record.components).toMatchObject({ locality: 'Tarrano', postalLocality: 'Tarrano', street: 'Ortia' });
  });

  it.each([
    ['TH', {
      'addr:province': 'กรุงเทพมหานคร', 'addr:district': 'เขตวัฒนา', 'addr:subdistrict': 'แขวงคลองตันเหนือ',
      'addr:postcode': '10110'
    }, { admin1: 'กรุงเทพมหานคร', locality: 'เขตวัฒนา', district: 'แขวงคลองตันเหนือ' }],
    ['PH', {
      'addr:province': 'Metro Manila', 'addr:city': 'Quezon City', 'addr:barangay': 'Bagumbayan',
      'addr:postcode': '1110'
    }, { admin1: 'Metro Manila', locality: 'Quezon City', district: 'Bagumbayan' }],
    ['VN', {
      'addr:province': 'Thành phố Hồ Chí Minh', 'addr:city': 'Thành phố Hồ Chí Minh', 'addr:ward': 'Phường Bến Thành',
      'addr:postcode': '70000'
    }, { admin1: 'Thành phố Hồ Chí Minh', locality: 'Phường Bến Thành', district: '' }]
  ])('maps current %s OSM administrative address tags', (countryCode, addressTags, expected) => {
    const record = normalizeSourceRecord({
      id: `way/${countryCode}`, geometry: { type: 'Point', coordinates: [100.5, 13.7] },
      properties: {
        '@type': 'way', '@id': `way/${countryCode}`, 'addr:housenumber': '10',
        'addr:street': 'Source Street', building: 'house', ...addressTags
      }
    }, { id: `fixture-${countryCode}`, countryCode, source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record.components).toMatchObject(expected);
  });

  it('normalizes Overture fields without inventing translated components', () => {
    const record = normalizeSourceRecord({
      id: 'overture-1', country: 'US', admin1: 'Pennsylvania', locality: 'Philadelphia',
      postal_city: 'Philadelphia', postcode: '19103', street: 'Market Street', number: '1700',
      longitude: -75.169, latitude: 39.953, source_dataset: 'OpenAddresses fixture'
    }, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl');
    expect(record).toMatchObject({
      countryCode: 'US', admin1: 'Pennsylvania', locality: 'Philadelphia',
      street: 'Market Street', houseNumber: '1700', propertyType: 'unknown'
    });
    expect(record.formattedAddress).toContain('Philadelphia');
  });

  it('accepts only explicit Overture residential building evidence', () => {
    const base = {
      id: 'overture-residential', country: 'US', admin1: 'Pennsylvania', locality: 'Philadelphia',
      postal_city: 'Philadelphia', postcode: '19103', street: 'Market Street', number: '1700',
      longitude: -75.169, latitude: 39.953
    };
    expect(normalizeSourceRecord({
      ...base, property_type: 'residential', residential_building_id: 'building-42', residential_building_class: 'house'
    }, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl')).toMatchObject({
      propertyType: 'residential', residentialSourceRecordId: 'building-42', residentialSourceClass: 'house'
    });
    expect(normalizeSourceRecord({ ...base, id: 'overture-unknown', property_type: 'commercial' },
      { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl')).toMatchObject({ propertyType: 'unknown' });
  });

  it('uses explicit OSM building tags as residential evidence', () => {
    const record = normalizeSourceRecord({
      id: 'node/1', geometry: { type: 'Point', coordinates: [116.4, 39.9] },
      properties: { '@id': 'node/1', 'addr:housenumber': '8', 'addr:street': '文化路', 'addr:city': '北京市', building: 'apartments' }
    }, { id: 'fixture-cn', countryCode: 'CN', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record).toMatchObject({ propertyType: 'apartment', postcode: '', nativeLanguage: 'zh-CN' });
  });

  it('keeps residential evidence from addressed OSM ways and areas', () => {
    const record = normalizeSourceRecord({
      id: 'way/88', geometry: { type: 'Point', coordinates: [-75.16, 39.95] },
      properties: { '@type': 'way', '@id': 'way/88', 'addr:housenumber': '10', 'addr:street': 'Bank Street', 'addr:city': 'Philadelphia', building: 'house' }
    }, { id: 'fixture-us', countryCode: 'US', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record).toMatchObject({ sourceRecordId: 'way/88', propertyType: 'residential', houseNumber: '10' });
  });

  it('normalizes an official Singapore HDB building with complete postal evidence', () => {
    const record = normalizeSourceRecord({
      id: 'hdb-building:8003:948044', source_record_id: 'hdb-building:8003:948044',
      source_dataset: 'HDB Property Information + HDB Existing Building',
      country: 'SG', admin1: 'Singapore', locality: 'Jurong West', postal_city: 'Singapore',
      address_levels: ['Singapore', 'Jurong West'], postcode: '600277', street: 'TOH GUAN RD', number: '277',
      longitude: 103.7466, latitude: 1.3413, property_type: 'apartment',
      residential_building_id: 'hdb-property:277:TOG', residential_building_class: 'apartments'
    }, {
      id: 'singapore-hdb-residential', countryCode: 'SG',
      source: { ...source, adapter: 'singapore-hdb' }
    }, 'overture-jsonl');
    expect(record).toMatchObject({
      countryCode: 'SG', admin1: 'Singapore', locality: 'Jurong West', postalLocality: 'Singapore',
      postcode: '600277', street: 'TOH GUAN RD', houseNumber: '277', propertyType: 'apartment',
      residentialSourceRecordId: 'hdb-property:277:TOG', residentialSourceClass: 'apartments',
      evidenceClass: 'official-address-point'
    });
  });

  it.each([
    ['JP', ['東京都', '杉並区', '永福'], '東京都', '杉並区', '永福'],
    ['MX', ['México', 'Texcoco', 'San Mateo'], 'México', 'Texcoco', 'San Mateo'],
    ['TW', ['臺北市', '中正區', '幸福里'], '臺北市', '中正區', '幸福里']
  ])('maps Overture address levels into complete %s administration', (countryCode, addressLevels, admin1, locality, district) => {
    const record = normalizeSourceRecord({
      id: `overture-${countryCode}`, country: countryCode, address_levels: addressLevels,
      postcode: countryCode === 'JP' ? '1680064' : countryCode === 'MX' ? '56233' : '100',
      street: 'Source Street', number: '10', longitude: 121.5, latitude: 25
    }, { id: `fixture-${countryCode}`, countryCode, source }, 'overture-jsonl');
    expect(record.components).toMatchObject({ admin1, locality, district });
  });

  it('maps Taiwan county and district below an English source region', () => {
    const record = normalizeSourceRecord({
      id: 'overture-tw-hierarchy', country: 'TW', address_levels: ['Taipei', '臺北市', '中正區'],
      postal_city: '臺北市', postcode: '100', street: '忠孝東路', number: '10', longitude: 121.52, latitude: 25.04
    }, { id: 'fixture-tw', countryCode: 'TW', source }, 'overture-jsonl');
    expect(record.components).toMatchObject({
      admin1: '臺北市', locality: '中正區', postalLocality: '中正區', district: ''
    });
  });

  it('exports the NL single address level as both admin1 and locality for import-time re-anchoring', () => {
    // Overture NL (BAG) address_levels carry only the city; the exporter therefore
    // emits the city name into admin1. The catalog anchoring step inside
    // PostgresAddressImporter is responsible for replacing it with the province.
    const record = normalizeSourceRecord({
      id: 'overture-nl', country: 'NL', admin1: 'Domburg', locality: 'Domburg',
      postal_city: 'Domburg', address_levels: ['Domburg'], postcode: '4357 HC',
      street: 'Ooststraat', number: '11', longitude: 3.4939, latitude: 51.5564
    }, { id: 'fixture-nl', countryCode: 'NL', source }, 'overture-jsonl');
    expect(record.components).toMatchObject({ admin1: 'Domburg', locality: 'Domburg', district: '' });
  });

  it.each(['JP', 'MX', 'TW'])('does not duplicate a two-level %s hierarchy into district', (countryCode) => {
    const record = normalizeSourceRecord({
      id: `overture-two-level-${countryCode}`, country: countryCode, address_levels: ['Region', 'Municipality'],
      postcode: '12345', street: 'Source Street', number: '10', longitude: 1, latitude: 1
    }, { id: `fixture-${countryCode}`, countryCode, source }, 'overture-jsonl');
    expect(record.components).toMatchObject({ admin1: 'Region', locality: 'Municipality', district: '' });
  });

  it('keeps the verified Japanese OSM residential building name for blacklist screening', () => {
    const record = normalizeSourceRecord({
      id: 'abr-jp', source_record_id: 'abr-jp', source_dataset: 'Digital Agency Address Base Registry via Geolonia',
      address_levels: ['東京都', '新宿区', '新宿'], postal_city: '新宿区', postcode: '1600022',
      street: '新宿六丁目', number: '10番11号', building_name: '新宿レジデンス',
      longitude: 139.707, latitude: 35.694, property_type: 'apartment',
      residential_building_id: 'way/10', residential_building_class: 'apartments'
    }, { id: 'fixture-jp', countryCode: 'JP', source }, 'overture-jsonl');
    expect(record).toMatchObject({ buildingName: '新宿レジデンス', propertyType: 'apartment' });
    expect(normalizeSourceRecord({
      id: 'abr-jp-public', address_levels: ['兵庫県', '神戸市', '有馬町'], postal_city: '神戸市',
      postcode: '6511401', street: '有馬町一丁目', number: '1番1号', building_name: '市立有馬地域福祉センター',
      longitude: 135.25, latitude: 34.8, property_type: 'residential',
      residential_building_id: 'way/11', residential_building_class: 'residential'
    }, { id: 'fixture-jp', countryCode: 'JP', source }, 'overture-jsonl')).toBeNull();
  });

  it('maps the most detailed Italian address level to locality', () => {
    const record = normalizeSourceRecord({
      id: 'overture-it', country: 'IT', address_levels: ['Sardegna', 'Sud Sardegna', 'Teulada'],
      street: 'Via Sulcis', number: '95', longitude: 8.77, latitude: 38.97
    }, { id: 'fixture-it', countryCode: 'IT', source }, 'overture-jsonl');
    expect(record.components).toMatchObject({ admin1: 'Sardegna', locality: 'Teulada', district: 'Sud Sardegna' });
  });

  it('uses the containing OSM building as independent residential evidence', () => {
    const record = normalizeSourceRecord({
      id: 'node/9', geometry: { type: 'Point', coordinates: [-75.16, 39.95] },
      properties: {
        '@type': 'node', '@id': 'node/9', 'addr:housenumber': '12', 'addr:street': 'Bank Street',
        'addr:city': 'Philadelphia', name: 'Ground-floor tenant',
        residential_building_id: 'way/88', residential_building_class: 'apartments'
      }
    }, { id: 'fixture-us', countryCode: 'US', source: { ...source, adapter: 'geofabrik' } }, 'geofabrik-geojsonseq');
    expect(record).toMatchObject({
      sourceRecordId: 'node/9', propertyType: 'apartment',
      residentialSourceRecordId: 'way/88', residentialSourceClass: 'building=apartments', buildingName: ''
    });
  });

  it('splits Hong Kong bilingual source components before translation', async () => {
    const record = normalizeSourceRecord({
      id: 'hk-bilingual', admin1: '九龍 Kowloon', locality: '黃大仙 Wong Tai Sin', postal_city: '黃大仙 Wong Tai Sin',
      street: '正德街 Ching Tak Street', number: '103', unit: '龍安樓 Lung On House', longitude: 114.19278, latitude: 22.34135
    }, { id: 'fixture-hk', countryCode: 'HK', source }, 'overture-jsonl');
    const [localized] = await localizeAddressRecords([record], {
      environment: { GOOGLE_TRANSLATION_ENABLED: 'true' },
      fetchImpl: async () => { throw new Error('translation should not duplicate bilingual hints'); }
    });
    expect(localized.localizations.native.components).toMatchObject({ admin1: '九龍', street: '正德街', unit: '龍安樓' });
    expect(localized.localizations.en.components).toMatchObject({ admin1: 'Kowloon', street: 'Ching Tak Street', unit: 'Lung On House' });
    expect(localized.localizations.en.components.unit).not.toMatch(/[\p{Script=Han}]/u);
  });

  it('builds verified-ready English and Chinese address variants before database insertion', async () => {
    const record = normalizeSourceRecord({
      id: 'overture-2', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953
    }, { id: 'fixture-us', countryCode: 'US', source }, 'overture-jsonl');
    const dictionary = new Map([
      ['Pennsylvania', '宾夕法尼亚州'], ['Philadelphia', '费城'], ['Market Street', '市场街']
    ]);
    const localized = await localizeAddressRecords([record], {
      environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'true', GOOGLE_TRANSLATION_ENABLED: 'true' },
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
        const translated = url.searchParams.get('q').split(`\n${boundary}\n`).map((value) => dictionary.get(value)).join(`\n${boundary}\n`);
        return Response.json([[[translated]]]);
      }
    });
    expect(localized[0].localizations.en.formattedAddress).toContain('Philadelphia');
    expect(localized[0].localizations['zh-CN'].components).toMatchObject({ admin1: '宾夕法尼亚州', locality: '费城', street: '市场街' });
    expect(localized[0].localizations['zh-CN'].formattedAddress).toBe('美国宾夕法尼亚州费城市场街170019103');
  });

  it('keeps source components when translation providers are unavailable', async () => {
    const record = normalizeSourceRecord({
      id: 'overture-fallback', admin1: 'Victoria', locality: 'Melbourne', postal_city: 'Melbourne',
      postcode: '3000', street: 'King Street', number: '10', longitude: 144.956, latitude: -37.817
    }, { id: 'fixture-au', countryCode: 'AU', source }, 'overture-jsonl');
    const [localized] = await localizeAddressRecords([record], {
      environment: { GOOGLE_TRANSLATION_ENABLED: 'true' },
      fetchImpl: async () => { throw new Error('translator unavailable'); }
    });
    expect(localized.localizations.en.components.admin1).toBe('Victoria');
    expect(localized.localizations['zh-CN'].components.admin1).toBe('Victoria');
  });

  it('supports deferred translation during the initial bulk import', async () => {
    const record = normalizeSourceRecord({
      id: 'overture-deferred', admin1: 'Victoria', locality: 'Melbourne', postal_city: 'Melbourne',
      postcode: '3000', street: 'King Street', number: '10', longitude: 144.956, latitude: -37.817
    }, { id: 'fixture-au', countryCode: 'AU', source }, 'overture-jsonl');
    const fetchImpl = vi.fn();
    const [localized] = await localizeAddressRecords([record], {
      environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'false' }, fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(localized.localizations['zh-CN'].source).toBe('local-postal-fallback');
  });

  it('uses deterministic local CN and HK variants while bulk translation is deferred', async () => {
    const china = normalizeSourceRecord({
      id: 'cn-deferred', admin1: '河北省', locality: '唐山市', postal_city: '唐山市',
      street: '文化路', number: '30', longitude: 118.18, latitude: 39.63
    }, { id: 'fixture-cn', countryCode: 'CN', source }, 'overture-jsonl');
    const hongKong = normalizeSourceRecord({
      id: 'hk-deferred', admin1: '九龍 Kowloon', locality: '黃大仙 Wong Tai Sin', postal_city: '黃大仙 Wong Tai Sin',
      street: '正德街 Ching Tak Street', number: '103', unit: '龍安樓 Lung On House', longitude: 114.19, latitude: 22.34
    }, { id: 'fixture-hk', countryCode: 'HK', source }, 'overture-jsonl');
    const taiwan = normalizeSourceRecord({
      id: 'tw-deferred', admin1: '臺北市', locality: '中正區', postal_city: '中正區',
      street: '忠孝東路', number: '100', longitude: 121.52, latitude: 25.04
    }, { id: 'fixture-tw', countryCode: 'TW', source }, 'overture-jsonl');
    const [localizedChina, localizedHongKong, localizedTaiwan] = await localizeAddressRecords([china, hongKong, taiwan], {
      environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'false' }, fetchImpl: vi.fn()
    });
    expect(localizedChina.localizations.en.components).toMatchObject({ admin1: 'Hebei Province', locality: 'Tangshan City', street: 'Wenhua Road' });
    expect(localizedChina.localizations['zh-CN'].formattedAddress).toBe('中国河北省唐山市文化路30');
    expect(localizedHongKong.localizations.en.components).toMatchObject({ admin1: 'Kowloon', street: 'Ching Tak Street', unit: 'Lung On House' });
    expect(localizedHongKong.localizations['zh-CN'].components).toMatchObject({ admin1: '九龙', street: '正德街', unit: '龙安楼' });
    expect(localizedTaiwan.localizations.en.components).toMatchObject({ admin1: 'Taibei Municipality', locality: 'Zhongzheng District', street: 'Zhongxiaodong Road' });
  });

  it('allows online translation for selected countries during fast initialization', async () => {
    const record = normalizeSourceRecord({
      id: 'hk-english-only', admin1: 'HK', locality: 'EASTERN DISTRICT', postal_city: 'EASTERN DISTRICT',
      street: 'OI SHUN ROAD', number: '33', longitude: 114.225, latitude: 22.282
    }, { id: 'fixture-hk', countryCode: 'HK', source }, 'overture-jsonl');
    const dictionary = new Map([
      ['HK', '香港'], ['EASTERN DISTRICT', '东区'], ['OI SHUN ROAD', '爱信道']
    ]);
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      const boundary = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
      const values = url.searchParams.get('q').split(`\n${boundary}\n`);
      const translated = url.searchParams.get('tl') === 'zh-CN'
        ? values.map((value) => dictionary.get(value) || value)
        : values;
      return Response.json([[[translated.join(`\n${boundary}\n`)]]]);
    });
    const [localized] = await localizeAddressRecords([record], {
      environment: {
        ADDRESS_SYNC_TRANSLATION_ENABLED: 'false', ADDRESS_SYNC_TRANSLATION_COUNTRIES: 'HK',
        GOOGLE_TRANSLATION_ENABLED: 'true'
      },
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(localized.localizations['zh-CN'].components).toMatchObject({ admin1: '香港', locality: '东区', street: '爱信道' });
  });
});

describe('built-in ETL planning and publishing', () => {
  it('matches all Overture candidates before limiting and supports OSM multipolygon buildings', async () => {
    const overture = (await readFile('server/sync/overture-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const geofabrik = (await readFile('server/sync/geofabrik-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const japanAbr = (await readFile('server/sync/japan-abr-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const openAddresses = (await readFile('server/sync/openaddresses-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const inegiResidential = (await readFile('server/sync/inegi-residential-export.py', 'utf8')).replace(/\r\n/g, '\n');
    const adapterSource = (await readFile('server/sync/source-adapters.mjs', 'utf8')).replace(/\r\n/g, '\n');
    expect(geofabrik).not.toContain('--communities-file');
    expect(overture).toContain('candidate_limit');
    expect(overture).toContain('CREATE TEMP VIEW address_candidates AS');
    expect(overture).toContain('candidate_sources = "\\nUNION ALL\\n".join(asset_queries)');
    expect(overture).toContain('AND bbox.xmin >= {minimum_longitude}');
    expect(overture).toContain('AND bbox.ymax <= {maximum_latitude}');
    expect(overture).toContain('--building-assets-file');
    expect(overture).toContain('--candidate-jsonl');
    expect(overture).toContain("FROM read_json_auto({sql_string(str(candidate_file))}");
    expect(overture).toContain('ST_Intersects(address_candidates.geometry, residential_buildings.geometry)');
    expect(overture).not.toContain('residential_probe_limit');
    expect(overture).not.toContain('residential_grid_limit');
    expect(overture).not.toContain('residential_grid_scale');
    expect(overture).not.toContain('JOIN residential_grids ON');
    expect(overture).toContain("list_transform(address_levels");
    expect(overture).toContain("coalesce(address_levels[-1].value, '') AS district");
    expect(overture).not.toContain('AND bbox.xmax >= {minimum_longitude}');
    expect(overture).toContain('FROM address_candidates\n    JOIN classified');
    expect(overture.indexOf('JOIN classified ON classified.address_id')).toBeLessThan(
      overture.indexOf('residential_locality_rank <= {args.per_locality}')
    );
    expect(overture).toContain('LIMIT {args.max_records}');
    expect(overture).toContain('raise RuntimeError(f"Residential building classification failed: {error}") from error');
    expect(overture).not.toContain("'unknown' AS property_type");
    expect(overture).not.toContain('USING SAMPLE system(25 PERCENT)');
    expect(overture).toContain('PARTITION BY coalesce(nullif(trim(address_candidates.admin1)');
    expect(overture).toContain('residential_locality_rank');
    expect(overture).toContain('SET http_keep_alive=true');
    expect(overture).toContain('SET http_retries=10');
    expect(openAddresses).toContain('required_mapping = {"id", "number", "street", "district", "locality", "admin1", "postcode", "longitude", "latitude"}');
    expect(openAddresses).toContain('while len(selected) < candidate_limit:');
    expect(inegiResidential).toContain('normalized(row.get("TIPODOM")) != "VIVIENDA"');
    expect(inegiResidential).toContain('POSTCODE_PATTERN.fullmatch(postcode)');
    expect(inegiResidential).toContain('inverse_inegi_lambert(*point)');
    expect(inegiResidential).toContain('"residential_building_class": "dwelling_house"');
    expect(adapterSource).toContain('return distance(left) - distance(right)');
    expect(adapterSource).toContain("['-4', '-sSLI', '--connect-timeout', '15', '--max-time', '60', url]");
    expect(adapterSource).toContain("expectedBytes: discovery.postcodeDataFormat === 'pdf' ? null : discovery.postcodeBytes");
    expect(geofabrik).toContain('def way(self, way, tags=None)');
    expect(geofabrik).toContain('def area(self, area, tags)');
    expect(geofabrik).toContain('.with_areas(KeyFilter("building"))');
    expect(geofabrik).toContain('f"relation/{area.orig_id()}"');
    expect(geofabrik).toContain('osmium.FileProcessor(args.input).with_locations(location_storage)');
    expect(geofabrik).toContain('sparse_file_array,{location_index}');
    expect(geofabrik).toContain('prepare(self.geometry)');
    expect(geofabrik).toContain('contains_xy(self.geometry, longitude, latitude)');
    expect(geofabrik).toContain('intersects_xy(self.hole_boundaries, longitude, latitude)');
    expect(geofabrik).toContain('self.capture(');
    expect(geofabrik).toContain('self.residential_limit = max_records');
    expect(geofabrik).toContain('self.points_by_tile = {}');
    expect(geofabrik).not.toContain('sqlite3');
    expect(geofabrik).toContain('if not point_in_ring(longitude, latitude, ring):');
    expect(geofabrik).toContain('properties["residential_building_id"] = residential_building[0]');
    expect(geofabrik).toContain('if has_non_residential_poi(tags):');
    expect(geofabrik).toContain('properties.pop("name", None)');
    expect(geofabrik).toContain('selected_matches = matcher.selected_matches(args.max_records)');
    expect(geofabrik).toContain('max_records / 10');
    expect(geofabrik).toContain('self.group_limit = max(1, min(per_locality, max_records))');
    expect(geofabrik).toContain('"addr:subdistrict", "addr:barangay", "addr:ward", "addr:commune"');
    expect(geofabrik).toContain('VietnamPostcodes(args.postcode_pdf)');
    expect(geofabrik).toContain('is_residential = building in RESIDENTIAL_BUILDINGS');
    expect(geofabrik).toContain('class PhilippinePostcodes');
    expect(geofabrik).toContain('if len(entries) < 900:');
    expect(geofabrik).toContain('if args.postcode_html and args.country != "PH"');
    expect(geofabrik).toContain('residential_selected = sorted(');
    expect(geofabrik).toContain('residential_selected + selected');
    expect(japanAbr).toContain('def match_plateau_buildings(connection, parquet_paths):');
    expect(japanAbr).toContain('None if any(lot_city_matches(priority, code, has_ward) for priority in priority_codes)');
    expect(japanAbr).toContain("WHERE usage='residential'");
    expect(japanAbr).toContain('intersects_xy(geometry, longitude, latitude)');
    expect(japanAbr).toContain('match_residential_buildings(connection, args.osm_pbf, args.output)');
    expect(japanAbr).toContain('POSTAL_RANGE_PATTERN');
    expect(japanAbr).toContain('street = clean(lines[0])');
    expect(japanAbr).toContain('if not district or district == street or not postcode:');
    expect(japanAbr).toContain('building_class not in RESIDENTIAL_BUILDINGS');
    expect(japanAbr).toContain('any(clean(tags.get(key)) not in {"", "no", "none"}');
    expect(japanAbr).toContain('point_in_ring(longitude, latitude, ring)');
    expect(japanAbr).toContain('FROM candidates WHERE building_id IS NOT NULL');
    expect(japanAbr).toContain('"residential_building_id": building_id');
    expect(japanAbr).toContain('def match_city_lots(connection, lots, buildings, claimed_buildings):');
    expect(japanAbr).toContain('WHERE residential_matches=1 AND blocked_matches=0');
    expect(japanAbr).toContain('if building_lot_counts.get(building_uid) != 1:');
    expect(japanAbr).toContain('if building_id in claimed_buildings:');
  });

  it('atomically imports localized records, evidence and coverage into PostgreSQL', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture.jsonl');
    await writeFile(file, `${[{
      id: 'overture-1', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market\u2028Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'building-1', residential_building_class: 'house'
    }, {
      id: 'overture-address-only', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1701', longitude: -75.168, latitude: 39.953
    }].map(JSON.stringify).join('\n')}\n`, 'utf8');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components,
          formattedAddress: record.formattedAddress,
          source: language === 'native' ? 'source' : 'fixture-translator'
        }]))
      }))
    });
    const result = await importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234 },
      materialized: { file, format: 'overture-jsonl', checksum: 'b'.repeat(64), cacheBytes: 321 },
      maxRecords: 10,
      perLocality: 2
    });
    expect(result).toMatchObject({
      acceptedCount: 1, rejectedCount: 1, localityCount: 1, skipped: false,
      rejectionReasons: { missing_residential_evidence: 1 },
      metrics: expect.objectContaining({ importRevision: 'strict-residential-v22' })
    });
    expect(await database.prepare('SELECT status,active_count FROM address_datasets WHERE id=?').bind(result.datasetId).first())
      .toMatchObject({ status: 'active', active_count: 1 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(1);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_evidence WHERE is_current=1').first('count')).toBe(2);
    expect(await database.prepare("SELECT source_record_id FROM address_pool_evidence WHERE evidence_type='residential_use'").first('source_record_id'))
      .toBe('building-1');
    expect(await database.prepare('SELECT COUNT(*) AS count FROM pool_coverage').first('count')).toBe(1);
    const aliasRetry = await importer.importShard({
      shard: { id: 'legacy-fixture-us', countryCode: 'US', source },
      discovery: { version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234 },
      materialized: { file, format: 'overture-jsonl', checksum: 'b'.repeat(64), cacheBytes: 321 },
      maxRecords: 10,
      perLocality: 2
    });
    expect(aliasRetry).toMatchObject({ acceptedCount: 1, skipped: false });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_datasets').first('count')).toBe(1);
    await writeFile(file, `${[{
      id: 'replacement-overlap', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'replacement-building-1', residential_building_class: 'house'
    }, {
      id: 'overture-2', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1800', longitude: -75.17, latitude: 39.954,
      property_type: 'residential', residential_building_id: 'building-2', residential_building_class: 'house'
    }].map(JSON.stringify).join('\n')}\n`, 'utf8');
    const replacementSource = { ...source, id: 'replacement-source', name: 'Replacement source' };
    const replacement = await importer.importShard({
      shard: { id: 'replacement-us', countryCode: 'US', source: replacementSource },
      discovery: { version: '2026-07-17.0', publishedAt: '2026-07-17T00:00:00Z', dataUrl: replacementSource.dataUrl, sourceBytes: 1234 },
      materialized: { file, format: 'overture-jsonl', checksum: 'd'.repeat(64), cacheBytes: 321 },
      maxRecords: 10,
      perLocality: 2
    });
    expect(replacement).toMatchObject({ acceptedCount: 2, skipped: false });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(2);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='retired'").first('count')).toBe(0);
    expect((await database.prepare("SELECT source_id FROM address_datasets WHERE status='active' ORDER BY source_id").all()).results
      .map(({ source_id }) => source_id)).toEqual(['fixture', 'replacement-source']);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(2);
    expect(await database.prepare('SELECT active_count FROM pool_coverage').first('active_count')).toBe(2);

    await writeFile(file, `${JSON.stringify({
      id: 'overture-3', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1900', longitude: -75.171, latitude: 39.955,
      property_type: 'residential', residential_building_id: 'building-3', residential_building_class: 'house'
    })}\n`, 'utf8');
    await importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: '2026-08-17.0', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'e'.repeat(64) },
      maxRecords: 10,
      perLocality: 2
    });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(2);
    expect(await database.prepare("SELECT active_count FROM address_datasets WHERE source_id='replacement-source'").first('active_count')).toBe(2);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(2);
    expect(await database.prepare('SELECT active_count FROM pool_coverage').first('active_count')).toBe(2);
    database.close();
  });

  it('applies the country target across active sources while retaining their evidence', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'country-quota.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components,
          formattedAddress: record.formattedAddress,
          source: 'fixture'
        }]))
      }))
    });
    const makeRows = (prefix, start) => Array.from({ length: 2 }, (_, index) => ({
      id: `${prefix}-${index}`, admin1: 'Pennsylvania', locality: index ? 'Pittsburgh' : 'Philadelphia',
      postal_city: index ? 'Pittsburgh' : 'Philadelphia', postcode: `1910${(start + index) % 10}`,
      street: 'Market Street', number: String(start + index), longitude: -75.2 + index / 100,
      latitude: 40 + index / 100, property_type: 'residential',
      residential_building_id: `${prefix}-building-${index}`, residential_building_class: 'house'
    }));
    const policy = { targetCount: 2, levelLimits: [10, 10, 10, 0], overrides: new Map() };
    for (const [index, sourceId] of ['source-a', 'source-b'].entries()) {
      await writeFile(file, `${makeRows(sourceId, 100 + index * 10).map(JSON.stringify).join('\n')}\n`, 'utf8');
      await importer.importShard({
        shard: { id: `${sourceId}-us`, countryCode: 'US', source: { ...source, id: sourceId } },
        discovery: { version: `v${index + 1}`, dataUrl: source.dataUrl },
        materialized: { file, format: 'overture-jsonl', checksum: String(index + 1).repeat(64) },
        maxRecords: 2,
        perLocality: 2,
        policy
      });
    }
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(2);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool WHERE active=0 AND retired_at IS NOT NULL').first('count')).toBe(2);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(2);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_evidence WHERE is_current=1').first('count')).toBe(8);
    database.close();
  });

  it('rejects a sharply degraded candidate snapshot and preserves the active pool', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'quality.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database, normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    const rows = [
      ['1', 'Pennsylvania', 'Philadelphia'], ['2', 'Pennsylvania', 'Pittsburgh'],
      ['3', 'New York', 'New York'], ['4', 'New York', 'Buffalo']
    ].map(([id, admin1, locality]) => ({
      id, admin1, locality, postal_city: locality, postcode: `1000${id}`, street: 'Main Street', number: id,
      longitude: -75 + Number(id) / 100, latitude: 40 + Number(id) / 100,
      property_type: 'residential', residential_building_id: `building-${id}`, residential_building_class: 'house'
    }));
    await writeFile(file, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8');
    const shard = { id: 'quality-us', countryCode: 'US', source, qualityGate: {
      minimumRecords: 1, minimumAdmin1: 1, minimumCountRatio: 0.75, minimumAdmin1Ratio: 0.75
    } };
    const first = await importer.importShard({
      shard, discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '1'.repeat(64) }, maxRecords: 10, perLocality: 10
    });
    await writeFile(file, `${JSON.stringify(rows[0])}\n`, 'utf8');
    await expect(importer.importShard({
      shard, discovery: { version: 'v2', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '2'.repeat(64) }, maxRecords: 10, perLocality: 10
    })).rejects.toMatchObject({
      code: 'SNAPSHOT_QUALITY_FAILED',
      rejectionReasons: {},
      metrics: expect.objectContaining({ candidateCount: 1, rejectionReasons: {} })
    });
    expect(await database.prepare("SELECT id FROM address_datasets WHERE status='active'").first('id')).toBe(first.datasetId);
    expect(await database.prepare('SELECT COUNT(*) count FROM address_pool_runtime').first('count')).toBe(4);

    await database.prepare("UPDATE address_datasets SET version='v1-legacy-import-revision' WHERE id=?").bind(first.datasetId).run();
    const revised = await importer.importShard({
      shard, discovery: { version: 'v3', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '3'.repeat(64) }, maxRecords: 10, perLocality: 10
    });
    expect(revised).toMatchObject({ acceptedCount: 1, skipped: false });
    expect(await database.prepare("SELECT id FROM address_datasets WHERE status='active'").first('id')).toBe(revised.datasetId);
    database.close();
  });

  it('publishes a small first strict snapshot and permits a later strict increase', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'small-strict.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database, normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((record) => ({
        ...record,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    const makeRows = (count) => Array.from({ length: count }, (_, index) => ({
      id: `jp-${index}`, address_levels: ['東京都', '杉並区', '永福'], postcode: '1680064',
      street: '永福一丁目', number: String(index + 1), longitude: 139.64 + index / 10000,
      latitude: 35.67 + index / 10000, property_type: 'residential',
      residential_building_id: `building-${index}`, residential_building_class: 'house'
    }));
    const shard = { id: 'small-jp', countryCode: 'JP', source };
    const policy = { targetCount: 40_000, levelLimits: [1_500, 200, 50, 0], overrides: new Map() };
    await writeFile(file, `${makeRows(2).map(JSON.stringify).join('\n')}\n`, 'utf8');
    await expect(importer.importShard({
      shard, discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '4'.repeat(64) },
      maxRecords: 40_000, perLocality: 64, policy
    })).resolves.toMatchObject({ acceptedCount: 2 });
    await writeFile(file, `${makeRows(3).map(JSON.stringify).join('\n')}\n`, 'utf8');
    await expect(importer.importShard({
      shard, discovery: { version: 'v2', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '5'.repeat(64) },
      maxRecords: 40_000, perLocality: 64, policy
    })).resolves.toMatchObject({ acceptedCount: 3 });
    const revisedPolicy = { ...policy, targetCount: 30_000 };
    await expect(importer.importShard({
      shard, discovery: { version: 'v2', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: '5'.repeat(64) },
      maxRecords: 30_000, perLocality: 64, policy: revisedPolicy
    })).resolves.toMatchObject({ acceptedCount: 3, skipped: false });
    expect(await database.prepare("SELECT COUNT(*) count FROM address_datasets WHERE status='active'").first('count')).toBe(1);
    database.close();
  });

  it('applies the country cap across active datasets from multiple sources', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'multi-source.jsonl');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((value) => ({
        ...value,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: value.components, formattedAddress: value.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    const policy = { targetCount: 12, levelLimits: [100, 100, 100, 0], overrides: new Map() };
    const rows = (prefix, district, longitude, sharedBuilding = false) => Array.from({ length: 8 }, (_, index) => ({
      id: `${prefix}-${index}`, admin1: 'Pennsylvania', locality: 'Philadelphia', district,
      postal_city: 'Philadelphia', postcode: `191${String(index).padStart(2, '0')}`,
      street: `${district} Street`, number: String(100 + index), longitude: longitude + index / 10000,
      latitude: 39.95 + index / 10000, property_type: 'residential',
      residential_building_id: `${prefix}-building-${sharedBuilding ? 'shared' : index}`, residential_building_class: 'house'
    }));
    const importRows = async (sourceId, district, checksum, longitude, sourceMaxRecords = 12, sharedBuilding = false) => {
      await writeFile(file, `${rows(sourceId, district, longitude, sharedBuilding).map(JSON.stringify).join('\n')}\n`, 'utf8');
      return importer.importShard({
        shard: { id: `${sourceId}-us`, countryCode: 'US', source: { ...source, id: sourceId, name: sourceId } },
        discovery: { version: 'v1', dataUrl: source.dataUrl },
        materialized: { file, format: 'overture-jsonl', checksum: checksum.repeat(64) },
        maxRecords: 12, sourceMaxRecords, perLocality: 100, policy
      });
    };
    expect(await importRows('source-a', 'Alpha', 'a', -75.17)).toMatchObject({ acceptedCount: 8 });
    expect(await importRows('source-b', 'Beta', 'b', -75.27)).toMatchObject({ acceptedCount: 8 });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_pool WHERE active=1 AND country_code='US'").first('count')).toBe(12);
    expect(await database.prepare("SELECT SUM(active_count) AS count FROM address_datasets WHERE status='active'").first('count')).toBe(12);
    const districts = (await database.prepare(`SELECT district,COUNT(*) AS count FROM address_pool
      WHERE country_code='US' AND active=1 GROUP BY district ORDER BY district`).all()).results;
    expect(districts).toEqual([{ district: 'Alpha', count: 6 }, { district: 'Beta', count: 6 }]);
    expect(await importRows('source-c', 'Gamma', 'c', -75.37, 3, true)).toMatchObject({ acceptedCount: 3 });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_pool WHERE active=1 AND country_code='US'").first('count')).toBe(12);
    expect(await database.prepare(`SELECT COUNT(*) AS count FROM address_pool_evidence evidence
      JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
      WHERE dataset.source_id='source-c' AND evidence.evidence_type='residential_use' AND evidence.is_current=1`).first('count')).toBe(3);
    database.close();
  });

  it('uses the provided PostgreSQL database by default', async () => {
    const directory = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture.jsonl');
    const database = openTestDatabase();
    await writeFile(file, `${JSON.stringify({
      id: 'overture-default', admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: '1700', longitude: -75.169, latitude: 39.953,
      property_type: 'residential', residential_building_id: 'building-default', residential_building_class: 'house'
    })}\n`, 'utf8');
    const localizeRecords = async (records) => records.map((record) => ({
      ...record,
      localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
        components: record.components,
        formattedAddress: record.formattedAddress,
        source: language === 'native' ? 'source' : 'fixture-translator'
      }]))
    }));
    let materializeOptions;
    const result = await runAddressEtl({
      database,
      cacheDir: resolve(directory, 'cache'),
      dataRoot: directory,
      catalog: { schemaVersion: 1, shards: [{
        id: 'fixture-us', countryCode: 'US', intervalDays: 30, source,
        qualityGate: { minimumRecords: 1, minimumAdmin1: 1, minimumCountRatio: 0, minimumAdmin1Ratio: 0 }
      }] },
      syncMode: 'manual',
      maxRecords: 10,
      perLocality: 2,
      localizeRecords,
      adapters: {
        discover: async () => ({ adapter: 'overture', version: 'fixture', dataUrl: source.dataUrl, sourceBytes: 0 }),
        materialize: async (_shard, _discovery, options) => {
          materializeOptions = options;
          return { file, format: 'overture-jsonl', checksum: 'c'.repeat(64), cacheBytes: 1 };
        }
      }
    });
    expect(result).toMatchObject({ changed: true, selectedShards: ['fixture-us'] });
    expect(materializeOptions).toMatchObject({ maxRecords: 1_010, perLocality: 2_000 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM address_pool_runtime').first('count')).toBe(1);
    expect(await database.prepare('SELECT status FROM sync_country_state WHERE country_code=?').bind('US').first('status')).toBe('ready');
    database.close();
  });

  it('supports a single-shard dry run without opening PostgreSQL or changing cache state', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = { schemaVersion: 1, shards: [{ id: 'fixture-us', countryCode: 'US', intervalDays: 30, source }] };
    const result = await runAddressEtl({
      cacheDir,
      catalog,
      requestedShards: ['US'],
      dryRun: true,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      adapters: {
        discover: async () => ({ adapter: 'overture', version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234, estimateMethod: 'fixture' })
      }
    });
    expect(result).toMatchObject({ dryRun: true, changed: false, selectedShards: ['fixture-us'] });
    expect(result.reports[0]).toMatchObject({ intervalDays: 30, sourceVersion: '2026-06-17.0', sourceBytes: 1234, status: 'planned' });
  });

  it('selects only one due country for an automatic daily run', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = { schemaVersion: 1, shards: [
      { id: 'fixture-us', countryCode: 'US', intervalDays: 30, source },
      { id: 'fixture-ca', countryCode: 'CA', intervalDays: 30, source }
    ] };
    const result = await runAddressEtl({
      cacheDir,
      catalog,
      dryRun: true,
      maxShardsPerRun: 1,
      adapters: { discover: async () => ({ adapter: 'overture', version: '2026-06-17.0', sourceBytes: 100, estimateMethod: 'fixture' }) }
    });
    expect(result.selectedShards).toHaveLength(1);
    expect(result.reports.filter(({ status }) => status === 'planned')).toHaveLength(1);
    expect(result.reports.filter(({ status }) => status === 'deferred')).toHaveLength(1);
  });

  it('persists incremental shard metadata and skips a shard inside its interval', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = { schemaVersion: 1, shards: [{ id: 'fixture-us', countryCode: 'US', intervalDays: 30, source }] };
    let discoveries = 0;
    const adapters = {
      discover: async () => {
        discoveries += 1;
        return { adapter: 'overture', version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z', dataUrl: source.dataUrl, sourceBytes: 1234, estimateMethod: 'fixture' };
      },
      materialize: async () => ({
        file: resolve(cacheDir, 'normalized', 'fixture.jsonl'), format: 'overture-jsonl',
        cacheBytes: 321, checksum: 'a'.repeat(64), cacheHit: false
      })
    };
    const importer = { importShard: async () => ({
      datasetId: 'fixture-dataset', acceptedCount: 10, rejectedCount: 1, localityCount: 2,
      rejectionReasons: { duplicate: 1 }, metrics: { candidateCount: 10, rejectedCount: 1 }, skipped: false
    }) };
    const first = await runAddressEtl({ cacheDir, catalog, adapters, importer, now: () => new Date('2026-07-16T00:00:00Z') });
    const second = await runAddressEtl({ cacheDir, catalog, adapters, importer, now: () => new Date('2026-07-17T00:00:00Z') });
    const manifest = JSON.parse(await readFile(resolve(cacheDir, 'manifest.json'), 'utf8'));
    expect(discoveries).toBe(1);
    expect(first.reports[0]).toMatchObject({
      rejectionReasons: { duplicate: 1 }, metrics: { candidateCount: 10, rejectedCount: 1 }
    });
    expect(second.reports[0].status).toBe('not-due');
    expect(manifest.shards['fixture-us']).toMatchObject({
      intervalDays: 30,
      lastChecked: '2026-07-16T00:00:00.000Z',
      sourceVersion: '2026-06-17.0',
      sourceBytes: 1234,
      checksumSha256: 'a'.repeat(64),
      cacheBytes: 321
    });
  });

  it('keeps initial synchronization incomplete until residential evidence exists', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = { schemaVersion: 1, shards: [{ id: 'fixture-us', countryCode: 'US', intervalDays: 30, source }] };
    let imports = 0;
    const adapters = {
      discover: async () => ({
        adapter: 'overture', version: '2026-06-17.0', publishedAt: '2026-06-17T00:00:00Z',
        dataUrl: source.dataUrl, sourceBytes: 1234, estimateMethod: 'fixture'
      }),
      materialize: async () => ({
        file: resolve(cacheDir, 'normalized', 'fixture.jsonl'), format: 'overture-jsonl',
        cacheBytes: 321, checksum: 'b'.repeat(64), cacheHit: imports > 0
      })
    };
    const importer = {
      importShard: async () => {
        imports += 1;
        return {
          datasetId: `fixture-dataset-${imports}`, acceptedCount: 10, rejectedCount: 0,
          localityCount: 2, residentialCount: imports === 1 ? 0 : 3, skipped: false
        };
      }
    };

    await expect(runAddressEtl({ cacheDir, catalog, adapters, importer, syncMode: 'initial', requireResidential: true }))
      .rejects.toThrow('Initial residential sync incomplete for: US');
    await expect(runAddressEtl({ cacheDir, catalog, adapters, importer, syncMode: 'initial', requireResidential: true }))
      .resolves.toMatchObject({ selectedShards: ['fixture-us'] });
    expect(imports).toBe(2);
  });

  it('continues an estimate after one shard metadata failure', async () => {
    const cacheDir = resolve('.data-cache', 'sync-etl-tests', randomUUID());
    directories.push(cacheDir);
    const catalog = {
      schemaVersion: 1,
      shards: [
        { id: 'fixture-us', countryCode: 'US', intervalDays: 30, source },
        { id: 'fixture-ca', countryCode: 'CA', intervalDays: 30, source }
      ]
    };
    const adapters = {
      discover: async (shard) => {
        if (shard.countryCode === 'US') throw Object.assign(new Error('metadata failed'), { code: 'SOURCE_METADATA_HTTP', url: 'https://example.test/us', status: 503 });
        return { adapter: 'overture', version: '2026-06-17.0', sourceBytes: 100, estimateMethod: 'fixture' };
      }
    };
    const result = await runAddressEtl({ cacheDir, catalog, adapters, estimate: true });
    expect(result.reports).toEqual([
      expect.objectContaining({ countryCode: 'US', status: 'failed', errorCode: 'SOURCE_METADATA_HTTP', errorStatus: 503 }),
      expect.objectContaining({ countryCode: 'CA', status: 'planned', sourceVersion: '2026-06-17.0' })
    ]);
  });

  it('publishes through the PostgreSQL ETL transaction without an external release phase', async () => {
    const result = await runAddressSync({
      releaseId: 'release-built-in',
      environment: {},
      runEtl: async () => ({ changed: true, dryRun: false, requiredCountries: ['US'] })
    });
    expect(result).toMatchObject({ releaseId: 'release-built-in', changed: true });
  });

  it('returns independently imported country targets from the PostgreSQL ETL result', async () => {
    const result = await runAddressSync({
      releaseId: 'release-shards',
      environment: {},
      runEtl: async () => ({
        changed: true,
        dryRun: false,
        requiredCountries: ['CA', 'US'],
        releaseTargets: [
          { shardKey: 'fixture-us', sourceId: 'fixture', countryCode: 'US' },
          { shardKey: 'fixture-ca', sourceId: 'fixture', countryCode: 'CA' }
        ]
      })
    });
    expect(result.etl.releaseTargets).toHaveLength(2);
  });

  it('forces a manually selected country to check upstream immediately', async () => {
    let options;
    await runAddressSync({
      releaseId: 'release-manual',
      environment: { ADDRESS_SYNC_TRIGGER: 'manual' },
      runEtl: async (value) => { options = value; return { changed: false, dryRun: false, requiredCountries: ['US'] }; }
    });
    expect(options.force).toBe(true);
    expect(options.maxShardsPerRun).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reports unchanged without invoking another publication system', async () => {
    const result = await runAddressSync({
      releaseId: 'release-unchanged',
      environment: {},
      runEtl: async () => ({ changed: false, dryRun: false, requiredCountries: ['US'] })
    });
    expect(result.changed).toBe(false);
  });
});
