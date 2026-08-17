import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';
import {
  applyHierarchicalQuota, deleteNodeTarget, loadImportPolicy, upsertNodePolicy, upsertNodeTarget
} from '../server/sync/address-policy.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const hex = (value) => Buffer.from(value, 'utf8').toString('hex').toUpperCase();
const a1Key = (name) => `US:a1:${hex(name)}`;
const record = (hash, admin1, locality, district = '') => ({
  canonicalHash: hash, countryCode: 'US', qualityScore: 0.9,
  components: { admin1, locality, district }
});
const many = (prefix, count, admin1, locality) =>
  Array.from({ length: count }, (_, index) => record(`${prefix}-${index}`, admin1, locality));
const countBy = (records, admin1) => records.filter((value) => value.components.admin1 === admin1).length;

describe('floor-aware hierarchical allocation', () => {
  it('fills a below-floor admin node before generic round-robin extras', () => {
    const records = [
      ...many('alpha1', 10, 'Alpha', 'Alpha One'),
      ...many('alpha2', 10, 'Alpha', 'Alpha Two'),
      ...many('beta', 10, 'Beta', 'Beta One')
    ];
    const policy = { targetCount: 21, levelLimits: [100, 100, 100, 0], overrides: new Map() };
    const withoutFloors = applyHierarchicalQuota(records, policy);
    expect(countBy(withoutFloors, 'Beta')).toBe(7);
    const withFloor = applyHierarchicalQuota(records, { ...policy, nodeFloors: new Map([[a1Key('Beta'), 10]]) });
    expect(withFloor).toHaveLength(21);
    expect(countBy(withFloor, 'Beta')).toBe(10);
    expect(withFloor.slice(15, 20).map((value) => value.canonicalHash))
      .toEqual(['beta-5', 'beta-6', 'beta-7', 'beta-8', 'beta-9']);
  });

  it('orders floor fills by deficit descending and exceeds the country minimum when needed', () => {
    const records = [
      ...many('a', 10, 'Alpha', 'A'), ...many('b', 10, 'Beta', 'B'), ...many('c', 10, 'Gamma', 'C')
    ];
    const selected = applyHierarchicalQuota(records, {
      targetCount: 18, levelLimits: [100, 100, 100, 0], overrides: new Map(),
      nodeFloors: new Map([[a1Key('Beta'), 9], [a1Key('Gamma'), 7]])
    });
    expect(selected).toHaveLength(21);
    expect(countBy(selected, 'Beta')).toBe(9);
    expect(countBy(selected, 'Gamma')).toBe(7);
  });

  it('allows all lowest-node floors to push far beyond the country minimum', () => {
    const records = [
      ...many('a', 10, 'Alpha', 'A'), ...many('b', 10, 'Beta', 'B'), ...many('c', 10, 'Gamma', 'C')
    ];
    const selected = applyHierarchicalQuota(records, {
      targetCount: 6, maxRecords: 30, levelLimits: [100, 100, 100, 0], overrides: new Map(),
      minPerNode: 5
    });
    expect(selected).toHaveLength(15);
    expect(['Alpha', 'Beta', 'Gamma'].map((admin1) => countBy(selected, admin1))).toEqual([5, 5, 5]);
  });

  it('keeps the source shard capacity as a technical hard limit', () => {
    const records = [...many('a', 10, 'Alpha', 'A'), ...many('b', 10, 'Beta', 'B')];
    const selected = applyHierarchicalQuota(records, {
      targetCount: 6, maxRecords: 8, levelLimits: [100, 100, 100, 0], overrides: new Map(), minPerNode: 5
    });
    expect(selected).toHaveLength(8);
  });

  it('keeps level caps binding above node floors', () => {
    const records = [...many('a', 10, 'Alpha', 'A'), ...many('b', 10, 'Beta', 'B')];
    const selected = applyHierarchicalQuota(records, {
      targetCount: 12, levelLimits: [6, 100, 100, 0], overrides: new Map(),
      nodeFloors: new Map([[a1Key('Beta'), 9]])
    });
    expect(selected).toHaveLength(12);
    expect(countBy(selected, 'Beta')).toBe(6);
    expect(countBy(selected, 'Alpha')).toBe(6);
  });

  it('allocates only existing candidates when a floor exceeds source capacity', () => {
    const records = [...many('a', 20, 'Alpha', 'A'), ...many('b', 3, 'Beta', 'B')];
    const selected = applyHierarchicalQuota(records, {
      targetCount: 20, levelLimits: [100, 100, 100, 0], overrides: new Map(),
      nodeFloors: new Map([[a1Key('Beta'), 10]])
    });
    expect(selected).toHaveLength(20);
    expect(countBy(selected, 'Beta')).toBe(3);
    expect(countBy(selected, 'Alpha')).toBe(17);
  });

  it('applies country level floors and tops up lowest nodes above a raised minPerNode', () => {
    const records = [
      ...many('l1', 20, 'Alpha', 'One'), ...many('l2', 20, 'Alpha', 'Two'), ...many('l3', 8, 'Alpha', 'Three')
    ];
    const selected = applyHierarchicalQuota(records, {
      targetCount: 30, levelLimits: [100, 100, 100, 0], overrides: new Map(),
      nodeFloors: new Map(), level1Min: 0, level2Min: 0, minPerNode: 8
    });
    const localities = (values) => ['One', 'Two', 'Three']
      .map((locality) => values.filter((value) => value.components.locality === locality).length);
    expect(localities(selected.slice(0, 24))).toEqual([8, 8, 8]);
    expect(localities(selected)).toEqual([11, 11, 8]);
    const withLevelMin = applyHierarchicalQuota(records, {
      targetCount: 30, levelLimits: [100, 100, 100, 0], overrides: new Map(), level2Min: 8
    });
    expect(localities(withLevelMin.slice(0, 24))).toEqual([8, 8, 8]);
  });

  it('selects identically to the legacy policy shape when no floors are configured', () => {
    const records = [
      ...Array.from({ length: 15 }, (_, index) => record(`manhattan-${index}`, 'New York', 'New York', 'Manhattan')),
      ...Array.from({ length: 12 }, (_, index) => record(`brooklyn-${index}`, 'New York', 'New York', 'Brooklyn')),
      ...many('buffalo', 4, 'New York', 'Buffalo')
    ];
    const legacy = { targetCount: 23, levelLimits: [100, 100, 6, 0], overrides: new Map() };
    const explicit = { ...legacy, nodeFloors: new Map(), level1Min: 0, level2Min: 0, minPerNode: 5 };
    expect(applyHierarchicalQuota(records, explicit).map((value) => value.canonicalHash))
      .toEqual(applyHierarchicalQuota(records, legacy).map((value) => value.canonicalHash));
  });

  it('loads floors and node minimums through the import policy layer', async () => {
    const database = openTestDatabase(':memory:');
    const us = await loadImportPolicy(database, 'US', 50_000, 64);
    expect(us).toMatchObject({ enabled: true, targetCount: 50_000, level1Min: 1_000, level2Min: 0, minPerNode: 5 });
    expect(us.levelLimits).toEqual([2_000, 300, 80, 0]);
    expect(us.overrides.size).toBe(0);
    expect(us.nodeFloors.get(a1Key('District of Columbia'))).toBe(2_000);
    const kr = await loadImportPolicy(database, 'KR', 20_000, 64);
    expect(kr.nodeFloors.get(`KR:a1:${hex('서울특별시')}`)).toBe(2_000);
    expect(kr.nodeFloors.get(`KR:a1:${hex('부산광역시')}`)).toBe(2_000);
    const de = await loadImportPolicy(database, 'DE', 40_000, 64);
    expect(de.nodeFloors.get(`DE:a1:${hex('Berlin')}`)).toBe(2_000);
    expect(de.nodeFloors.get(`DE:a1:${hex('Hamburg')}`)).toBe(2_000);
    const unknown = await loadImportPolicy(database, 'XX', 111, 7);
    expect(unknown).toMatchObject({ enabled: true, targetCount: 111, level1Min: 0, level2Min: 0, minPerNode: 0 });
    expect(unknown.nodeFloors.size).toBe(0);

    await database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,total_count,updated_at)
      VALUES ('US:loc:AA:BB','US:a1:AA','US',2,'City B',3,'2026-08-01T00:00:00Z')`).run();
    await upsertNodeTarget(database, 'US:loc:AA:BB', 44);
    await upsertNodePolicy(database, 'US:loc:AA:BB', 9);
    let policy = await loadImportPolicy(database, 'US', 50_000, 64);
    expect(policy.nodeFloors.get('US:loc:AA:BB')).toBe(44);
    expect(policy.overrides.get('US:loc:AA:BB')).toBe(9);
    await deleteNodeTarget(database, 'US:loc:AA:BB');
    policy = await loadImportPolicy(database, 'US', 50_000, 64);
    expect(policy.nodeFloors.has('US:loc:AA:BB')).toBe(false);
    expect(policy.overrides.get('US:loc:AA:BB')).toBe(9);
    database.close();
  });

  it('re-imports under the v26 revision when node floors change', async () => {
    const directory = resolve('.data-cache', 'floor-allocation-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture.jsonl');
    await writeFile(file, `${Array.from({ length: 2 }, (_, index) => JSON.stringify({
      id: `overture-${index}`, admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
      postcode: '19103', street: 'Market Street', number: String(1700 + index),
      longitude: -75.169 + index / 100, latitude: 39.953, property_type: 'residential',
      residential_building_id: `building-${index}`, residential_building_class: 'house'
    })).join('\n')}\n`, 'utf8');
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
    const source = {
      id: 'fixture', adapter: 'overture', name: 'Fixture', homepageUrl: 'https://example.test',
      dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
      licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
      attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms',
      shareAlike: false, redistributionAllowed: true
    };
    const importWith = (policy) => importer.importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source },
      discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'f'.repeat(64) },
      maxRecords: 10, perLocality: 10, policy
    });
    const policy = { targetCount: 10, levelLimits: [10, 10, 10, 0], overrides: new Map() };
    const first = await importWith(policy);
    expect(first).toMatchObject({ acceptedCount: 2, skipped: false });
    expect(first.datasetId).toContain('strict-residential-v26');
    await expect(importWith(policy)).resolves.toMatchObject({ skipped: true });
    const refreshed = await importWith({ ...policy, nodeFloors: new Map([[a1Key('Pennsylvania'), 2]]) });
    expect(refreshed).toMatchObject({ acceptedCount: 2, skipped: false });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM address_pool WHERE active=1 AND country_code='US'")
      .first('count')).toBe(2);
    database.close();
  });
});
