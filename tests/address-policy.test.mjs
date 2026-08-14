import { describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import {
  ADDRESS_POLICY_DEFAULTS, CHINA_NODE_TARGET_SEEDS, applyHierarchicalQuota, deleteNodeTarget, ensureAddressPolicies,
  getRuntimePolicy, listCountryNodeTargets, listCountryPolicies, listNodePolicies, policyNodeKeys, updateCountryPolicy,
  updateRuntimePolicy, upsertNodePolicy, upsertNodeTarget
} from '../server/sync/address-policy.mjs';
import { mapConcurrent } from '../server/sync/address-etl.mjs';

const nodeKeyFor = (name) => `CN:a1:${Buffer.from(name, 'utf8').toString('hex').toUpperCase()}`;

const record = (hash, admin1, locality, district = '') => ({
  canonicalHash: hash, countryCode: 'US', qualityScore: 0.9,
  components: { admin1, locality, district }
});

describe('hierarchical address policies', () => {
  it('seeds all supported countries and validates runtime concurrency', async () => {
    const database = openTestDatabase(':memory:');
    await ensureAddressPolicies(database, '2026-07-28T00:00:00.000Z');
    expect((await listCountryPolicies(database))).toHaveLength(Object.keys(ADDRESS_POLICY_DEFAULTS).length);
    expect(ADDRESS_POLICY_DEFAULTS).toMatchObject({
      HK: { target: 20_000, limits: [10_000, 2_000, 300, 0] },
      JP: { target: 20_000 }, KR: { target: 20_000, limits: [3_000, 500, 100, 0] },
      TW: { target: 10_000 }, ZA: { target: 8_000 }
    });
    await expect(updateRuntimePolicy(database, { prepareConcurrency: 11, cpuConcurrency: 2 }))
      .rejects.toThrow('INVALID_PREPARE_CONCURRENCY');
    expect(await updateRuntimePolicy(database, { prepareConcurrency: 10, cpuConcurrency: 4 }))
      .toMatchObject({ prepareConcurrency: 10, cpuConcurrency: 4 });
    expect(await getRuntimePolicy(database)).toMatchObject({ prepareConcurrency: 10, cpuConcurrency: 4 });
    database.close();
  });

  it('migrates legacy defaults while preserving custom country targets', async () => {
    const database = openTestDatabase(':memory:');
    await database.batch([
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('CA',1,35000,2500,350,80,0,'2026-07-01T00:00:00Z')`),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('MX',1,12345,2000,300,70,0,'2026-07-01T00:00:00Z')`),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('SG',1,8000,8000,500,80,0,'2026-07-01T00:00:00Z')`),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('HK',1,10000,2000,300,80,0,'2026-07-01T00:00:00Z')`),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('JP',1,15000,7000,1000,200,0,'2026-07-01T00:00:00Z')`),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,level1_min,level2_min,updated_at
      ) VALUES ('NL',1,25000,3000,400,80,0,500,0,'2026-07-01T00:00:00Z')`),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('KR',1,10000,1500,250,60,0,'2026-07-01T00:00:00Z')`),
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('MY',1,10000,1500,250,60,0,'2026-07-01T00:00:00Z')`),
      database.prepare(`INSERT INTO sync_runtime_settings(id,prepare_concurrency,cpu_concurrency,updated_at)
        VALUES (1,10,3,'2026-07-01T00:00:00Z')`)
    ]);
    await ensureAddressPolicies(database, '2026-07-29T00:00:00Z');
    expect(await database.prepare('SELECT target_count FROM sync_country_policies WHERE country_code=?')
      .bind('CA').first('target_count')).toBe(15_000);
    expect(await database.prepare('SELECT target_count FROM sync_country_policies WHERE country_code=?')
      .bind('MX').first('target_count')).toBe(12_345);
    expect(await database.prepare('SELECT target_count FROM sync_country_policies WHERE country_code=?')
      .bind('SG').first('target_count')).toBe(12_000);
    expect(await database.prepare(`SELECT target_count,level1_limit,level2_limit,level3_limit
      FROM sync_country_policies WHERE country_code=?`).bind('HK').first())
      .toMatchObject({ target_count: 20_000, level1_limit: 10_000, level2_limit: 2_000, level3_limit: 300 });
    expect(await database.prepare('SELECT target_count FROM sync_country_policies WHERE country_code=?')
      .bind('JP').first('target_count')).toBe(20_000);
    expect(await database.prepare(`SELECT target_count,level1_limit,level2_limit,level3_limit,level1_min
      FROM sync_country_policies WHERE country_code=?`).bind('NL').first())
      .toMatchObject({ target_count: 50_000, level1_limit: 5_000, level2_limit: 700, level3_limit: 120, level1_min: 1_000 });
    expect(await database.prepare(`SELECT target_count,level1_limit,level2_limit,level3_limit
      FROM sync_country_policies WHERE country_code=?`).bind('KR').first())
      .toMatchObject({ target_count: 20_000, level1_limit: 3_000, level2_limit: 500, level3_limit: 100 });
    expect(await database.prepare(`SELECT target_count,level1_limit,level2_limit,level3_limit
      FROM sync_country_policies WHERE country_code=?`).bind('MY').first())
      .toMatchObject({ target_count: 10_000, level1_limit: 1_800, level2_limit: 300, level3_limit: 70 });
    expect(await database.prepare(`SELECT level1_limit,level2_limit,level3_limit,level4_limit
      FROM sync_country_policies WHERE country_code=?`).bind('SG').first())
      .toMatchObject({ level1_limit: 12_000, level2_limit: 1_000, level3_limit: 100, level4_limit: 0 });
    expect(await getRuntimePolicy(database)).toMatchObject({ prepareConcurrency: 10, cpuConcurrency: 1 });
    database.close();
  });

  it('enforces country, hierarchy and node override limits without synthesizing shortages', () => {
    const records = [
      record('a', 'New York', 'New York', 'Manhattan'),
      record('b', 'New York', 'New York', 'Manhattan'),
      record('c', 'New York', 'Buffalo'),
      record('d', 'California', 'Los Angeles')
    ];
    const policy = { targetCount: 4, levelLimits: [3, 2, 1, 0], overrides: new Map() };
    expect(applyHierarchicalQuota(records, policy).map((value) => value.canonicalHash)).toEqual(['a', 'c', 'd']);
    const nodeKey = 'US:a1:4E657720596F726B';
    expect(applyHierarchicalQuota(records, { ...policy, overrides: new Map([[nodeKey, 1]]) })
      .map((value) => value.canonicalHash)).toEqual(['a', 'd']);
  });

  it('fills five records per lowest administrative node before assigning extras', () => {
    const manhattan = Array.from({ length: 15 }, (_, index) => record(`manhattan-${index}`, 'New York', 'New York', 'Manhattan'));
    const brooklyn = Array.from({ length: 12 }, (_, index) => record(`brooklyn-${index}`, 'New York', 'New York', 'Brooklyn'));
    const selected = applyHierarchicalQuota([...manhattan, ...brooklyn], {
      targetCount: 23,
      levelLimits: [100, 100, 100, 0],
      overrides: new Map()
    });
    const firstTen = selected.slice(0, 10);
    expect(firstTen.filter((value) => value.components.district === 'Manhattan')).toHaveLength(5);
    expect(firstTen.filter((value) => value.components.district === 'Brooklyn')).toHaveLength(5);
    expect(selected.filter((value) => value.components.district === 'Manhattan')).toHaveLength(12);
    expect(selected.filter((value) => value.components.district === 'Brooklyn')).toHaveLength(11);
  });

  it('keeps popularity order for extras while respecting node overrides and the country cap', () => {
    const popular = Array.from({ length: 15 }, (_, index) => record(`popular-${index}`, 'New York', 'New York', 'Manhattan'));
    const regular = Array.from({ length: 15 }, (_, index) => record(`regular-${index}`, 'New York', 'New York', 'Brooklyn'));
    const popularNode = policyNodeKeys(popular[0])[2];
    const selected = applyHierarchicalQuota([...popular, ...regular], {
      targetCount: 23,
      levelLimits: [100, 100, 100, 0],
      overrides: new Map([[popularNode, 12]])
    });
    expect(selected).toHaveLength(23);
    expect(selected.filter((value) => value.components.district === 'Manhattan')).toHaveLength(12);
    expect(selected.filter((value) => value.components.district === 'Brooklyn')).toHaveLength(11);
  });

  it('stores country settings and inherited node overrides separately from coverage counts', async () => {
    const database = openTestDatabase(':memory:');
    await ensureAddressPolicies(database);
    await database.prepare(`INSERT INTO admin_coverage_stats(
      node_key,parent_key,country_code,level,region_name,total_count,updated_at
    ) VALUES ('US:a1:AA','US','US',1,'Fixture State',12,'2026-07-28T00:00:00Z')`).run();
    await updateCountryPolicy(database, 'US', { targetCount: 100, level1Limit: 20, level2Limit: 5, level3Limit: 2, level4Limit: 0 });
    expect((await listNodePolicies(database, 'US'))[0]).toMatchObject({ inheritedTarget: 20, targetCount: 20, currentCount: 12 });
    await upsertNodePolicy(database, 'US:a1:AA', 7);
    expect((await listNodePolicies(database, 'US'))[0]).toMatchObject({ overrideTarget: 7, targetCount: 7, excess: 5 });
    database.close();
  });

  it('bounds concurrent preparation while preserving result order', async () => {
    let active = 0;
    let maximum = 0;
    const output = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      return value * 2;
    });
    expect(output).toEqual([2, 4, 6, 8, 10]);
    expect(maximum).toBe(2);
  });

  it('validates dual completion fields and seeds per-country coverage defaults', async () => {
    const database = openTestDatabase(':memory:');
    expect(ADDRESS_POLICY_DEFAULTS).toMatchObject({
      US: { minPerNode: 5, coverageRatio: 1, level1Min: 1_000, level2Min: 0 },
      CN: { coverageRatio: 1, level1Min: 800, level2Min: 60 },
      HK: { level1Min: 0 }, SG: { level1Min: 0 }, ZA: { level1Min: 150 },
      IN: { coverageRatio: 0.6, level1Min: 0 }, PH: { coverageRatio: 0.6 }, VN: { coverageRatio: 0.6 },
      NG: { coverageRatio: 0.6 }, TH: { coverageRatio: 0.6 }, TR: { coverageRatio: 0.6 },
      SA: { coverageRatio: 0.6 }, MY: { coverageRatio: 0.6 }
    });
    const policies = await listCountryPolicies(database);
    expect(policies.find((value) => value.countryCode === 'IN'))
      .toMatchObject({ minPerNode: 5, coverageRatio: 0.6, level1Min: 0, level2Min: 0 });
    expect(policies.find((value) => value.countryCode === 'US'))
      .toMatchObject({ minPerNode: 5, coverageRatio: 1, level1Min: 1_000 });
    await expect(updateCountryPolicy(database, 'US', { minPerNode: 0 })).rejects.toThrow('INVALID_POLICY_MIN_PER_NODE');
    await expect(updateCountryPolicy(database, 'US', { minPerNode: 101 })).rejects.toThrow('INVALID_POLICY_MIN_PER_NODE');
    await expect(updateCountryPolicy(database, 'US', { coverageRatio: 1.5 })).rejects.toThrow('INVALID_POLICY_COVERAGE_RATIO');
    await expect(updateCountryPolicy(database, 'US', { coverageRatio: -0.1 })).rejects.toThrow('INVALID_POLICY_COVERAGE_RATIO');
    await expect(updateCountryPolicy(database, 'US', { level1Min: 50_001 })).rejects.toThrow('INVALID_POLICY_LEVEL1_MIN');
    await expect(updateCountryPolicy(database, 'US', { level1Min: 500, level1Limit: 400 })).rejects.toThrow('INVALID_POLICY_LEVEL1_MIN');
    await expect(updateCountryPolicy(database, 'US', { level2Min: 400, level2Limit: 300 })).rejects.toThrow('INVALID_POLICY_LEVEL2_MIN');
    expect(await updateCountryPolicy(database, 'US', { minPerNode: 8, coverageRatio: 0.75, level1Min: 900, level2Min: 10 }))
      .toMatchObject({ minPerNode: 8, coverageRatio: 0.75, level1Min: 900, level2Min: 10 });
    database.close();
  });

  it('manages per-node targets with level defaults, tombstones and idempotent municipal seeds', async () => {
    const database = openTestDatabase(':memory:');
    await ensureAddressPolicies(database);
    await database.batch([
      database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,total_count,updated_at)
        VALUES ('US:a1:AA','US','US',1,'State A',1200,'2026-08-01T00:00:00Z')`),
      database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,total_count,updated_at)
        VALUES ('US:loc:AA:BB','US:a1:AA','US',2,'City B',300,'2026-08-01T00:00:00Z')`),
      database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,total_count,updated_at)
        VALUES ('US:dist:AA:BB:CC','US:loc:AA:BB','US',3,'District C',3,'2026-08-01T00:00:00Z')`)
    ]);
    const byKey = (nodes, key) => nodes.find((node) => node.key === key);
    let nodes = await listCountryNodeTargets(database, 'US');
    expect(byKey(nodes, 'US:a1:AA')).toMatchObject({
      level: 1, defaultTarget: 1_000, overrideTarget: null, targetCount: 1_000, currentCount: 1_200,
      satisfied: true, deficit: 0, excess: 0
    });
    expect(byKey(nodes, 'US:loc:AA:BB')).toMatchObject({ defaultTarget: 0, targetCount: 0, satisfied: true, deficit: 0 });
    expect(byKey(nodes, 'US:dist:AA:BB:CC')).toMatchObject({ defaultTarget: 5, targetCount: 5, satisfied: false, deficit: 2 });
    await expect(upsertNodeTarget(database, 'US:dist:AA:BB:CC', 50_001)).rejects.toThrow('INVALID_POLICY_NODE_TARGET');
    await expect(upsertNodeTarget(database, 'US:dist:AA:BB:CC', -1)).rejects.toThrow('INVALID_POLICY_NODE_TARGET');
    await expect(upsertNodeTarget(database, 'US:missing', 10)).rejects.toThrow('POLICY_NODE_NOT_FOUND');
    await upsertNodeTarget(database, 'US:dist:AA:BB:CC', 2);
    await upsertNodeTarget(database, 'US:a1:AA', 100);
    nodes = await listCountryNodeTargets(database, 'US');
    expect(byKey(nodes, 'US:dist:AA:BB:CC')).toMatchObject({ overrideTarget: 2, targetCount: 2, satisfied: true, deficit: 0 });
    expect(byKey(nodes, 'US:a1:AA')).toMatchObject({ overrideTarget: 100, targetCount: 100, excess: 1_100 });
    await deleteNodeTarget(database, 'US:a1:AA');
    nodes = await listCountryNodeTargets(database, 'US');
    expect(byKey(nodes, 'US:a1:AA')).toMatchObject({ overrideTarget: null, targetCount: 1_000 });

    const beijingKey = nodeKeyFor('北京市');
    expect(await database.prepare('SELECT min_count FROM sync_node_overrides WHERE node_key=?')
      .bind(beijingKey).first('min_count')).toBe(2_000);
    await database.prepare('UPDATE sync_node_overrides SET min_count=3000 WHERE node_key=?').bind(beijingKey).run();
    await ensureAddressPolicies(database);
    expect(await database.prepare('SELECT min_count FROM sync_node_overrides WHERE node_key=?')
      .bind(beijingKey).first('min_count')).toBe(3_000);
    await deleteNodeTarget(database, beijingKey);
    await ensureAddressPolicies(database);
    expect(await database.prepare('SELECT min_count FROM sync_node_overrides WHERE node_key=?')
      .bind(beijingKey).first('min_count')).toBe(null);
    database.close();
  });
});
