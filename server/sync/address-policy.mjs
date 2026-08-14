const DEFAULT_PREPARE_CONCURRENCY = 1;
const DEFAULT_CPU_CONCURRENCY = 1;
export const LOWEST_NODE_BASE_TARGET = 5;

const DEFAULT_MIN_PER_NODE = 5;
const DEFAULT_COVERAGE_RATIO = 1;

const policy = (target, limits, labels, coverageRatio = DEFAULT_COVERAGE_RATIO, level1Min = 0, level2Min = 0) =>
  ({ target, limits, labels, minPerNode: DEFAULT_MIN_PER_NODE, coverageRatio, level1Min, level2Min });

export const ADDRESS_POLICY_DEFAULTS = {
  US: policy(50_000, [2_000, 300, 80, 0], ['State', 'County / city', 'Local area', ''], 1, 1_000),
  CA: policy(15_000, [2_500, 350, 80, 0], ['Province / territory', 'City', 'Regional area', ''], 1, 300),
  MX: policy(20_000, [2_000, 300, 70, 0], ['State', 'Municipality', 'Locality', ''], 1, 400),
  GB: policy(35_000, [3_000, 350, 80, 0], ['Country / region', 'Post town', 'District', ''], 1, 700),
  DE: policy(40_000, [2_500, 350, 80, 0], ['State', 'Municipality', 'District', ''], 1, 800),
  FR: policy(40_000, [3_500, 350, 80, 0], ['Region', 'Commune', 'District', ''], 1, 800),
  IT: policy(35_000, [2_500, 350, 80, 0], ['Region', 'Municipality', 'District', ''], 1, 700),
  ES: policy(25_000, [2_500, 350, 80, 0], ['Autonomous community', 'Municipality', 'District', ''], 1, 500),
  NL: policy(50_000, [5_000, 700, 120, 0], ['Province', 'Municipality', 'District', ''], 1, 1_000),
  JP: policy(20_000, [7_000, 1_000, 200, 0], ['Prefecture', 'Municipality', 'Town / ward', ''], 1, 400),
  CN: policy(40_000, [2_500, 400, 30, 10], ['Province', 'Prefecture city', 'District / county', 'Township'], 1, 800, 60),
  HK: policy(20_000, [10_000, 2_000, 300, 0], ['Region', 'District', 'Locality', '']),
  TW: policy(10_000, [2_000, 300, 70, 0], ['County / city', 'District / township', 'Village', ''], 1, 200),
  KR: policy(20_000, [3_000, 500, 100, 0], ['Province / city', 'City / district', 'Neighborhood', ''], 1, 400),
  SG: policy(12_000, [12_000, 1_000, 100, 0], ['Planning region', 'Planning area', 'Locality', '']),
  MY: policy(10_000, [1_800, 300, 70, 0], ['State / territory', 'District / city', 'Locality', ''], 0.6),
  TH: policy(10_000, [1_200, 250, 60, 0], ['Province', 'District', 'Subdistrict', ''], 0.6),
  PH: policy(10_000, [2_500, 500, 150, 40], ['Region', 'Province', 'City / municipality', 'Barangay'], 0.6),
  VN: policy(10_000, [1_200, 250, 60, 0], ['Province / municipality', 'District', 'Ward / commune', ''], 0.6),
  TR: policy(10_000, [1_200, 250, 60, 0], ['Province', 'District', 'Neighborhood', ''], 0.6),
  SA: policy(5_000, [1_000, 200, 50, 0], ['Region', 'City', 'District', ''], 0.6),
  IN: policy(20_000, [1_800, 300, 70, 0], ['State / territory', 'District / city', 'Locality', ''], 0.6),
  AU: policy(20_000, [4_000, 350, 80, 0], ['State / territory', 'Locality', 'District', ''], 1, 400),
  BR: policy(20_000, [1_500, 250, 60, 0], ['State', 'Municipality', 'District', ''], 1, 400),
  NG: policy(8_000, [1_000, 200, 50, 0], ['State', 'Local government area', 'Locality', ''], 0.6),
  ZA: policy(8_000, [4_000, 3_800, 60, 0], ['Province', 'Municipality', 'Locality', ''], 1, 150),
  RU: policy(20_000, [2_000, 300, 70, 0], ['Federal subject', 'City / district', 'Locality', ''], 1, 400)
};

const LEGACY_DEFAULT_TARGETS = {
  CA: [35_000], MX: [30_000], ES: [35_000], NL: [30_000, 25_000], JP: [40_000, 15_000],
  HK: [12_000, 10_000], TW: [25_000], KR: [10_000], SG: [8_000], MY: [15_000], TH: [15_000],
  PH: [15_000], VN: [15_000], TR: [15_000], SA: [8_000], IN: [30_000],
  AU: [35_000], BR: [30_000], NG: [10_000], ZA: [15_000], RU: [30_000]
};

const LEGACY_DEFAULT_LIMITS = {
  NL: [[3_000, 400, 80, 0]],
  HK: [[2_000, 300, 80, 0]],
  KR: [[1_500, 250, 60, 0]],
  SG: [[8_000, 500, 80, 0]],
  MY: [[1_500, 250, 60, 0]],
  ZA: [[1_500, 250, 60, 0]]
};

const LEGACY_DEFAULT_FLOORS = {
  NL: [[500, 0]]
};

const integer = (value, minimum, maximum, code) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
};

const decimal = (value, minimum, maximum, code) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
};

export const validateCountryPolicy = (countryCode, input) => {
  const code = String(countryCode || '').trim().toUpperCase();
  const defaults = ADDRESS_POLICY_DEFAULTS[code];
  if (!defaults) throw new Error('INVALID_POLICY_COUNTRY');
  const limits = [1, 2, 3, 4].map((level, index) => integer(
    input[`level${level}Limit`] ?? input.limits?.[index] ?? defaults.limits[index], 0, 1_000_000, 'INVALID_POLICY_LIMIT'
  ));
  const floors = [1, 2].map((level, index) => {
    const code = `INVALID_POLICY_LEVEL${level}_MIN`;
    const provided = input[`level${level}Min`];
    const floor = integer(provided ?? defaults[`level${level}Min`], 0, 50_000, code);
    if (floor > 0 && limits[index] > 0 && floor > limits[index]) {
      if (provided !== undefined) throw new Error(code);
      return limits[index];
    }
    return floor;
  });
  return {
    countryCode: code,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    targetCount: integer(input.targetCount ?? defaults.target, 1, 2_000_000, 'INVALID_POLICY_TARGET'),
    limits,
    minPerNode: integer(input.minPerNode ?? defaults.minPerNode, 1, 100, 'INVALID_POLICY_MIN_PER_NODE'),
    coverageRatio: decimal(input.coverageRatio ?? defaults.coverageRatio, 0, 1, 'INVALID_POLICY_COVERAGE_RATIO'),
    level1Min: floors[0],
    level2Min: floors[1]
  };
};

export const validateRuntimePolicy = (input) => ({
  prepareConcurrency: integer(input.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY, 1, 10, 'INVALID_PREPARE_CONCURRENCY'),
  cpuConcurrency: integer(input.cpuConcurrency ?? DEFAULT_CPU_CONCURRENCY, 1, 4, 'INVALID_CPU_CONCURRENCY')
});

const migratedDatabases = new WeakSet();

const hexName = (value) => Buffer.from(String(value), 'utf8').toString('hex').toUpperCase();

export const CHINA_NODE_TARGET_SEEDS = { 北京市: 2_000, 上海市: 2_000, 重庆市: 2_000, 天津市: 2_000 };

export const INTERNATIONAL_NODE_TARGET_SEEDS = {
  DE: { Berlin: 2_000, Hamburg: 2_000 },
  US: { 'District of Columbia': 2_000 },
  KR: { 서울특별시: 2_000, 부산광역시: 2_000 }
};

const NODE_OVERRIDES_DDL = `CREATE TABLE sync_node_overrides (
  node_key TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES sync_country_policies(country_code) ON UPDATE CASCADE ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
  target_count INTEGER CHECK (target_count IS NULL OR target_count >= 0),
  min_count INTEGER CHECK (min_count IS NULL OR min_count BETWEEN 0 AND 50000),
  updated_at TEXT NOT NULL
)`;

const ensurePolicySchema = async (database, now) => {
  if (migratedDatabases.has(database)) return;
  migratedDatabases.add(database);
};

export const ensureAddressPolicies = async (database, now = new Date().toISOString()) => {
  await ensurePolicySchema(database, now);
  const statements = Object.entries(ADDRESS_POLICY_DEFAULTS).map(([countryCode, value]) => database.prepare(`
    INSERT INTO sync_country_policies(
      country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,
      min_per_node,coverage_ratio,level1_min,level2_min,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (country_code) DO NOTHING
  `).bind(countryCode, 1, value.target, ...value.limits, value.minPerNode, value.coverageRatio,
    value.level1Min, value.level2Min, now));
  for (const [countryCode, legacyTargets] of Object.entries(LEGACY_DEFAULT_TARGETS)) {
    for (const legacyTarget of legacyTargets) {
      statements.push(database.prepare(`UPDATE sync_country_policies SET target_count=?,updated_at=?
        WHERE country_code=? AND target_count=?`).bind(
        ADDRESS_POLICY_DEFAULTS[countryCode].target, now, countryCode, legacyTarget
      ));
    }
  }
  for (const [countryCode, legacyLimitSets] of Object.entries(LEGACY_DEFAULT_LIMITS)) {
    for (const legacyLimits of legacyLimitSets) {
      statements.push(database.prepare(`UPDATE sync_country_policies
        SET level1_limit=?,level2_limit=?,level3_limit=?,level4_limit=?,updated_at=?
        WHERE country_code=? AND level1_limit=? AND level2_limit=? AND level3_limit=? AND level4_limit=?`).bind(
        ...ADDRESS_POLICY_DEFAULTS[countryCode].limits, now, countryCode, ...legacyLimits
      ));
    }
  }
  for (const [countryCode, legacyFloorSets] of Object.entries(LEGACY_DEFAULT_FLOORS)) {
    for (const legacyFloors of legacyFloorSets) {
      statements.push(database.prepare(`UPDATE sync_country_policies SET level1_min=?,level2_min=?,updated_at=?
        WHERE country_code=? AND level1_min=? AND level2_min=?`).bind(
        ADDRESS_POLICY_DEFAULTS[countryCode].level1Min, ADDRESS_POLICY_DEFAULTS[countryCode].level2Min,
        now, countryCode, ...legacyFloors
      ));
    }
  }
  for (const [regionName, minCount] of Object.entries(CHINA_NODE_TARGET_SEEDS)) {
    statements.push(database.prepare(`INSERT INTO sync_node_overrides(node_key,country_code,level,min_count,updated_at)
      VALUES (?,?,1,?,?) ON CONFLICT (node_key) DO NOTHING`).bind(`CN:a1:${hexName(regionName)}`, 'CN', minCount, now));
  }
  for (const [countryCode, nodes] of Object.entries(INTERNATIONAL_NODE_TARGET_SEEDS)) {
    for (const [regionName, minCount] of Object.entries(nodes)) {
      statements.push(database.prepare(`INSERT INTO sync_node_overrides(node_key,country_code,level,min_count,updated_at)
        VALUES (?,?,1,?,?) ON CONFLICT (node_key) DO NOTHING`).bind(`${countryCode}:a1:${hexName(regionName)}`, countryCode, minCount, now));
    }
  }
  statements.push(database.prepare(`INSERT INTO sync_runtime_settings(
    id,prepare_concurrency,cpu_concurrency,updated_at
  ) VALUES (1,?,?,?) ON CONFLICT (id) DO NOTHING`).bind(DEFAULT_PREPARE_CONCURRENCY, DEFAULT_CPU_CONCURRENCY, now));
  statements.push(database.prepare(`UPDATE sync_runtime_settings SET cpu_concurrency=?,updated_at=?
    WHERE id=1 AND cpu_concurrency=3`).bind(DEFAULT_CPU_CONCURRENCY, now));
  await database.batch(statements);
};

const rowPolicy = (row) => ({
  countryCode: String(row.country_code), enabled: Boolean(row.enabled), targetCount: Number(row.target_count),
  level1Limit: Number(row.level1_limit), level2Limit: Number(row.level2_limit),
  level3Limit: Number(row.level3_limit), level4Limit: Number(row.level4_limit),
  minPerNode: Number(row.min_per_node), coverageRatio: Number(row.coverage_ratio),
  level1Min: Number(row.level1_min), level2Min: Number(row.level2_min), updatedAt: String(row.updated_at)
});

export const getRuntimePolicy = async (database) => {
  await ensureAddressPolicies(database);
  const row = await database.prepare('SELECT prepare_concurrency,cpu_concurrency,updated_at FROM sync_runtime_settings WHERE id=1').first();
  return { prepareConcurrency: Number(row.prepare_concurrency), cpuConcurrency: Number(row.cpu_concurrency), updatedAt: String(row.updated_at) };
};

export const updateRuntimePolicy = async (database, input) => {
  const value = validateRuntimePolicy(input);
  const now = new Date().toISOString();
  await database.prepare(`UPDATE sync_runtime_settings SET prepare_concurrency=?,cpu_concurrency=?,updated_at=? WHERE id=1`)
    .bind(value.prepareConcurrency, value.cpuConcurrency, now).run();
  return { ...value, updatedAt: now };
};

export const listCountryPolicies = async (database) => {
  await ensureAddressPolicies(database);
  const rows = (await database.prepare(`SELECT policy.*,
    COALESCE(coverage.total_count,0) AS actual_count
    FROM sync_country_policies policy
    LEFT JOIN admin_coverage_stats coverage ON coverage.node_key=policy.country_code
    ORDER BY policy.country_code`).all()).results;
  const datasets = (await database.prepare(`SELECT country_code,version,imported_at FROM address_datasets
    WHERE status='active' ORDER BY country_code,imported_at DESC`).all()).results;
  const versions = new Map();
  for (const dataset of datasets) {
    if (!versions.has(dataset.country_code)) versions.set(dataset.country_code, dataset.version);
  }
  return rows.map((row) => {
    const currentCount = Number(row.actual_count || 0);
    const targetCount = Number(row.target_count);
    return {
      ...rowPolicy(row), currentCount, sourceVersion: versions.has(row.country_code) ? String(versions.get(row.country_code)) : null,
      deficit: Math.max(0, targetCount - currentCount), excess: Math.max(0, currentCount - targetCount),
      state: currentCount > targetCount ? 'excess' : currentCount < targetCount ? 'deficit' : 'ready',
      labels: ADDRESS_POLICY_DEFAULTS[String(row.country_code)]?.labels || []
    };
  });
};

export const getCountryPolicy = async (database, countryCode) => {
  await ensureAddressPolicies(database);
  const code = String(countryCode || '').trim().toUpperCase();
  const row = await database.prepare('SELECT * FROM sync_country_policies WHERE country_code=?').bind(code).first();
  if (!row) throw new Error('POLICY_NOT_FOUND');
  return { ...rowPolicy(row), labels: ADDRESS_POLICY_DEFAULTS[code].labels };
};

export const updateCountryPolicy = async (database, countryCode, input) => {
  const value = validateCountryPolicy(countryCode, input);
  const now = new Date().toISOString();
  await ensureAddressPolicies(database, now);
  await database.prepare(`UPDATE sync_country_policies SET enabled=?,target_count=?,level1_limit=?,level2_limit=?,
    level3_limit=?,level4_limit=?,min_per_node=?,coverage_ratio=?,level1_min=?,level2_min=?,updated_at=?
    WHERE country_code=?`).bind(
    Number(value.enabled), value.targetCount, ...value.limits, value.minPerNode, value.coverageRatio,
    value.level1Min, value.level2Min, now, value.countryCode
  ).run();
  return getCountryPolicy(database, value.countryCode);
};

export const listNodePolicies = async (database, parentKey) => {
  const parent = String(parentKey || '');
  const rows = (await database.prepare(`SELECT coverage.node_key,coverage.parent_key,coverage.country_code,coverage.level,
    coverage.region_code,coverage.region_name,coverage.total_count,coverage.child_count,coverage.updated_at,
    override.target_count AS override_target,
    CASE coverage.level WHEN 1 THEN country.level1_limit WHEN 2 THEN country.level2_limit
      WHEN 3 THEN country.level3_limit WHEN 4 THEN country.level4_limit ELSE country.target_count END AS inherited_target
    FROM admin_coverage_stats coverage JOIN sync_country_policies country ON country.country_code=coverage.country_code
    LEFT JOIN sync_node_overrides override ON override.node_key=coverage.node_key
    WHERE coverage.parent_key=? ORDER BY coverage.total_count DESC,coverage.region_name`).bind(parent).all()).results;
  return rows.map((row) => {
    const inheritedTarget = Number(row.inherited_target || 0);
    const overrideTarget = row.override_target == null ? null : Number(row.override_target);
    const targetCount = overrideTarget ?? inheritedTarget;
    const currentCount = Number(row.total_count || 0);
    const bounded = overrideTarget !== null || inheritedTarget > 0;
    return {
      key: String(row.node_key), parentKey: String(row.parent_key), countryCode: String(row.country_code),
      level: Number(row.level), regionCode: String(row.region_code || ''), regionName: String(row.region_name),
      currentCount, childCount: Number(row.child_count || 0), inheritedTarget, overrideTarget, targetCount,
      deficit: bounded ? Math.max(0, targetCount - currentCount) : 0,
      excess: bounded ? Math.max(0, currentCount - targetCount) : 0,
      updatedAt: String(row.updated_at)
    };
  });
};

export const upsertNodePolicy = async (database, nodeKey, targetCount) => {
  const key = String(nodeKey || '');
  const target = integer(targetCount, 0, 1_000_000, 'INVALID_POLICY_TARGET');
  const node = await database.prepare('SELECT country_code,level FROM admin_coverage_stats WHERE node_key=?').bind(key).first();
  if (!node || Number(node.level) < 1) throw new Error('POLICY_NODE_NOT_FOUND');
  const now = new Date().toISOString();
  await database.prepare(`INSERT INTO sync_node_overrides(node_key,country_code,level,target_count,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(node_key) DO UPDATE SET target_count=excluded.target_count,updated_at=excluded.updated_at`)
    .bind(key, String(node.country_code), Number(node.level), target, now).run();
  return { key, targetCount: target, updatedAt: now };
};

export const deleteNodePolicy = async (database, nodeKey) => {
  // Keep the row as a tombstone so seeded defaults are not resurrected and any
  // min_count target on the same node survives clearing the level limit.
  await database.prepare('UPDATE sync_node_overrides SET target_count=NULL,updated_at=? WHERE node_key=?')
    .bind(new Date().toISOString(), String(nodeKey || '')).run();
};

export const listCountryNodeTargets = async (database, countryCode) => {
  const country = await getCountryPolicy(database, countryCode);
  const rows = (await database.prepare(`SELECT coverage.node_key,coverage.parent_key,coverage.level,coverage.region_code,
      coverage.region_name,coverage.total_count,coverage.updated_at,override.min_count AS override_target
    FROM admin_coverage_stats coverage
    LEFT JOIN sync_node_overrides override ON override.node_key=coverage.node_key
    WHERE coverage.country_code=? AND coverage.level>0
    ORDER BY coverage.level,coverage.total_count DESC,coverage.region_name`).bind(country.countryCode).all()).results;
  const lowestLevel = rows.reduce((maximum, row) => Math.max(maximum, Number(row.level)), 0);
  return rows.map((row) => {
    const level = Number(row.level);
    const defaultTarget = Math.max(
      level === lowestLevel ? country.minPerNode : 0,
      level === 1 ? country.level1Min : level === 2 ? country.level2Min : 0
    );
    const overrideTarget = row.override_target == null ? null : Number(row.override_target);
    const targetCount = overrideTarget ?? defaultTarget;
    const currentCount = Number(row.total_count || 0);
    return {
      key: String(row.node_key), parentKey: String(row.parent_key || ''), countryCode: country.countryCode, level,
      regionCode: String(row.region_code || ''), regionName: String(row.region_name),
      currentCount, defaultTarget, overrideTarget, targetCount,
      satisfied: targetCount <= 0 || currentCount >= targetCount,
      deficit: Math.max(0, targetCount - currentCount),
      excess: overrideTarget == null ? 0 : Math.max(0, currentCount - overrideTarget),
      updatedAt: String(row.updated_at)
    };
  });
};

export const upsertNodeTarget = async (database, nodeKey, minCount) => {
  await ensureAddressPolicies(database);
  const key = String(nodeKey || '');
  const target = integer(minCount, 0, 50_000, 'INVALID_POLICY_NODE_TARGET');
  const node = await database.prepare('SELECT country_code,level FROM admin_coverage_stats WHERE node_key=?').bind(key).first();
  if (!node || Number(node.level) < 1) throw new Error('POLICY_NODE_NOT_FOUND');
  const now = new Date().toISOString();
  await database.prepare(`INSERT INTO sync_node_overrides(node_key,country_code,level,min_count,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(node_key) DO UPDATE SET min_count=excluded.min_count,updated_at=excluded.updated_at`)
    .bind(key, String(node.country_code), Number(node.level), target, now).run();
  return { key, minCount: target, updatedAt: now };
};

export const deleteNodeTarget = async (database, nodeKey) => {
  await ensureAddressPolicies(database);
  // Tombstone instead of DELETE so idempotent seeding cannot resurrect the override.
  await database.prepare('UPDATE sync_node_overrides SET min_count=NULL,updated_at=? WHERE node_key=?')
    .bind(new Date().toISOString(), String(nodeKey || '')).run();
};

export const loadImportPolicy = async (database, countryCode, fallbackMaxRecords, fallbackPerLocality) => {
  await ensureAddressPolicies(database);
  const country = await getCountryPolicy(database, countryCode).catch(() => null);
  if (!country) return {
    enabled: true,
    targetCount: fallbackMaxRecords,
    levelLimits: [fallbackMaxRecords, fallbackPerLocality, fallbackPerLocality, fallbackPerLocality],
    overrides: new Map(),
    nodeFloors: new Map(),
    level1Min: 0,
    level2Min: 0,
    minPerNode: 0
  };
  if (!country.enabled) return {
    enabled: false,
    targetCount: country.targetCount,
    levelLimits: [country.level1Limit, country.level2Limit, country.level3Limit, country.level4Limit],
    overrides: new Map(),
    nodeFloors: new Map(),
    level1Min: country.level1Min,
    level2Min: country.level2Min,
    minPerNode: country.minPerNode
  };
  const overrides = (await database.prepare(`SELECT node_key,target_count,min_count FROM sync_node_overrides
    WHERE country_code=? AND (target_count IS NOT NULL OR min_count IS NOT NULL)`)
    .bind(countryCode).all()).results;
  const entries = (field) => overrides.filter((row) => row[field] != null)
    .map((row) => [String(row.node_key), Number(row[field])]);
  return {
    enabled: true,
    targetCount: country.targetCount,
    levelLimits: [country.level1Limit, country.level2Limit, country.level3Limit, country.level4Limit],
    overrides: new Map(entries('target_count')),
    nodeFloors: new Map(entries('min_count')),
    level1Min: country.level1Min,
    level2Min: country.level2Min,
    minPerNode: country.minPerNode
  };
};

export const policyNodeKeys = (record) => {
  const hex = (value) => Buffer.from(String(value || ''), 'utf8').toString('hex').toUpperCase();
  const country = record.countryCode;
  const admin1 = String(record.components?.admin1 || record.admin1 || '').trim();
  const locality = String(record.components?.locality || record.components?.postalLocality || record.locality || '').trim();
  const district = String(record.components?.district || record.district || '').trim();
  const level1 = admin1 ? `${country}:a1:${hex(admin1)}` : '';
  const level2 = admin1 && locality ? `${country}:loc:${hex(admin1)}:${hex(locality)}` : '';
  const level3 = admin1 && locality && district ? `${country}:dist:${hex(admin1)}:${hex(locality)}:${hex(district)}` : '';
  return [level1, level2, level3, ''];
};

export const applyHierarchicalQuota = (records, policyValue) => {
  const counts = [new Map(), new Map(), new Map(), new Map()];
  const selected = [];
  const selectedIndexes = new Set();
  const overrides = policyValue.overrides || new Map();
  const hardLimit = Number.isFinite(policyValue.maxRecords)
    ? Math.max(0, Number(policyValue.maxRecords)) : Number.POSITIVE_INFINITY;
  const keysByIndex = records.map(policyNodeKeys);
  const canSelect = (index) => keysByIndex[index].every((key, level) => {
    if (!key) return true;
    const overridden = overrides.has(key);
    const limit = overridden ? overrides.get(key) : policyValue.levelLimits[level];
    return (!overridden && limit === 0) || (counts[level].get(key) || 0) < limit;
  });
  const select = (index, allowBeyondTarget = false) => {
    if (selected.length >= hardLimit || (!allowBeyondTarget && selected.length >= policyValue.targetCount)
      || selectedIndexes.has(index) || !canSelect(index)) return false;
    selectedIndexes.add(index);
    selected.push(records[index]);
    keysByIndex[index].forEach((key, level) => {
      if (key) counts[level].set(key, (counts[level].get(key) || 0) + 1);
    });
    return true;
  };

  // Give every deepest available administrative node the baseline before
  // distributing extras in balanced rounds.
  const groups = new Map();
  keysByIndex.forEach((keys, index) => {
    const key = [...keys].reverse().find(Boolean) || `${records[index].countryCode}:country`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });
  const cursors = new Map([...groups.keys()].map((key) => [key, 0]));
  for (let round = 0; round < LOWEST_NODE_BASE_TARGET && selected.length < policyValue.targetCount; round += 1) {
    for (const [key, indexes] of groups) {
      if (selected.length >= policyValue.targetCount) break;
      let cursor = cursors.get(key);
      while (cursor < indexes.length && selectedIndexes.has(indexes[cursor])) cursor += 1;
      if (cursor < indexes.length) select(indexes[cursor]);
      cursors.set(key, cursor + 1);
    }
  }

  // Dual-criteria floors: before generic extras, top up nodes that sit below an
  // explicit minimum (per-node min_count override, else country level1_min /
  // level2_min, else a raised lowest-node minPerNode), largest deficit first.
  // Level caps still bind through canSelect, so a floor never overrides a limit
  // and a node whose source lacks candidates simply stays below its floor.
  const nodeFloors = policyValue.nodeFloors || new Map();
  const levelMins = [Number(policyValue.level1Min) || 0, Number(policyValue.level2Min) || 0, 0, 0];
  const minPerNode = Number(policyValue.minPerNode) || 0;
  const floorNodes = new Map();
  if (nodeFloors.size || levelMins[0] || levelMins[1] || minPerNode > 0) {
    for (const [groupKey, indexes] of groups) {
      keysByIndex[indexes[0]].forEach((key, level) => {
        if (!key) return;
        const lowestMin = key === groupKey ? minPerNode : 0;
        const floor = nodeFloors.has(key) ? Number(nodeFloors.get(key)) : Math.max(levelMins[level], lowestMin);
        if (floor <= 0) return;
        const node = floorNodes.get(key) || { key, level, floor, groupKeys: [], rotation: 0, exhausted: false };
        node.groupKeys.push(groupKey);
        floorNodes.set(key, node);
      });
    }
  }
  const fillFloorGroup = (groupKey) => {
    const indexes = groups.get(groupKey);
    let cursor = cursors.get(groupKey);
    let taken = false;
    while (cursor < indexes.length && !taken) {
      const index = indexes[cursor];
      cursor += 1;
      taken = !selectedIndexes.has(index) && select(index, true);
    }
    cursors.set(groupKey, cursor);
    return taken;
  };
  while (floorNodes.size && selected.length < hardLimit) {
    let best = null;
    let bestDeficit = 0;
    for (const node of floorNodes.values()) {
      if (node.exhausted) continue;
      const deficit = node.floor - (counts[node.level].get(node.key) || 0);
      if (deficit > bestDeficit) {
        best = node;
        bestDeficit = deficit;
      }
    }
    if (!best) break;
    let taken = false;
    for (let attempt = 0; attempt < best.groupKeys.length && !taken; attempt += 1) {
      taken = fillFloorGroup(best.groupKeys[best.rotation]);
      best.rotation = (best.rotation + 1) % best.groupKeys.length;
    }
    if (!taken) best.exhausted = true;
  }

  let remaining = true;
  while (remaining && selected.length < policyValue.targetCount) {
    remaining = false;
    for (const [key, indexes] of groups) {
      if (selected.length >= policyValue.targetCount) break;
      let cursor = cursors.get(key);
      while (cursor < indexes.length && selectedIndexes.has(indexes[cursor])) cursor += 1;
      if (cursor < indexes.length) {
        remaining = true;
        select(indexes[cursor]);
      }
      cursors.set(key, cursor + 1);
    }
  }
  return selected;
};
