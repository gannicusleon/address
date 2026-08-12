import { evaluateCountryGoals } from './country-goals.mjs';

const nextSyncAt = (lastSuccessfulAt, intervalDays) => {
  if (!lastSuccessfulAt) return null;
  const date = new Date(lastSuccessfulAt);
  date.setUTCDate(date.getUTCDate() + intervalDays);
  return date.toISOString();
};

export class PostgresCountryStateStore {
  constructor({ database, shards, now = () => new Date() }) {
    this.database = database;
    this.shards = shards;
    this.now = now;
    this.byId = new Map(shards.map((shard) => [shard.id, shard]));
    this.initialized = false;
  }

  async ensureSchema() {
    if (this.initialized) return;
    const now = this.now().toISOString();
    const statements = [];
    for (const shard of this.shards) {
      statements.push(this.database.prepare(`
      INSERT INTO sync_country_state(country_code, status, failure_count, updated_at)
      VALUES (?, 'pending', 0, ?) ON CONFLICT (country_code) DO NOTHING
      `).bind(shard.countryCode, now));
      statements.push(this.database.prepare(`INSERT INTO sync_shard_state(
          shard_id,country_code,status,last_success_at,next_sync_at,active_dataset_id,address_count,
          residential_count,failure_count,last_error,source_version,failure_code,failure_signature,updated_at
        ) SELECT ?,country_code,status,last_success_at,next_sync_at,active_dataset_id,address_count,
          residential_count,failure_count,last_error,source_version,failure_code,failure_signature,updated_at
        FROM sync_country_state WHERE country_code=?
          AND NOT EXISTS (SELECT 1 FROM sync_shard_state WHERE country_code=?)
        ON CONFLICT (shard_id) DO NOTHING`
        ).bind(shard.id, shard.countryCode, shard.countryCode));
      statements.push(this.database.prepare(`INSERT INTO sync_shard_state(
          shard_id,country_code,status,failure_count,updated_at
        ) VALUES (?,?,'pending',0,?) ON CONFLICT (shard_id) DO NOTHING`).bind(shard.id, shard.countryCode, now));
    }
    if (statements.length) await this.database.batch(statements);
    this.initialized = true;
  }

  async load() {
    await this.ensureSchema();
    const deficits = await this.countryDeficits();
    const result = await this.database.prepare(`
      SELECT shard_id,country_code,status,last_success_at,next_sync_at,active_dataset_id,
        address_count, residential_count, failure_count, last_error, source_version,
        failure_code, failure_signature, updated_at
      FROM sync_shard_state
    `).all();
    const shards = {};
    for (const row of result.results) {
      const shard = this.byId.get(row.shard_id);
      if (!shard) continue;
      shards[shard.id] = {
        shardId: shard.id,
        countryCode: row.country_code,
        status: row.status === 'ready' ? 'imported' : row.status,
        lastSuccessfulAt: row.last_success_at,
        nextSyncAt: row.next_sync_at,
        datasetId: row.active_dataset_id,
        acceptedCount: Number(row.address_count || 0),
        residentialCount: Number(row.residential_count || 0),
        failureCount: Number(row.failure_count || 0),
        error: row.last_error,
        sourceVersion: row.source_version,
        errorCode: row.failure_code,
        failureSignature: row.failure_signature,
        lastChecked: row.updated_at,
        countryBelowTarget: deficits.belowTarget.has(row.country_code),
        countryBelowFloor: deficits.belowFloor.has(row.country_code)
      };
    }
    return { schemaVersion: 1, shards };
  }

  // Countries below their count target or with admin nodes under a configured floor
  // are eligible for daily retries instead of the monthly cadence.
  async countryDeficits() {
    const belowTarget = new Set();
    const belowFloor = new Set();
    try {
      const goals = await evaluateCountryGoals(this.database);
      for (const goal of goals.values()) {
        if (goal.countryCode === 'CN' || !goal.enabled) continue;
        if (!goal.countMet) belowTarget.add(goal.countryCode);
        if (!goal.coverageMet || !goal.overrideMet) belowFloor.add(goal.countryCode);
      }
    } catch {
      return { belowTarget, belowFloor };
    }
    return { belowTarget, belowFloor };
  }

  async save(state) {
    await this.ensureSchema();
    const statements = [];
    const affectedCountries = new Set();
    for (const [shardId, entry] of Object.entries(state.shards || {})) {
      const shard = this.byId.get(shardId);
      if (!shard || !['failed', 'imported', 'unchanged'].includes(entry.status)) continue;
      affectedCountries.add(shard.countryCode);
      const success = entry.status !== 'failed';
      const lastSuccessfulAt = entry.lastSuccessfulAt || null;
      const updatedAt = entry.lastChecked || lastSuccessfulAt || state.updatedAt || this.now().toISOString();
      statements.push(this.database.prepare(`
        INSERT INTO sync_shard_state(
          shard_id,country_code,status,last_success_at,next_sync_at,active_dataset_id,
          address_count, residential_count, failure_count, last_error, source_version,
          failure_code, failure_signature, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shard_id) DO UPDATE SET
          status=excluded.status,
          last_success_at=coalesce(excluded.last_success_at, sync_shard_state.last_success_at),
          next_sync_at=coalesce(excluded.next_sync_at, sync_shard_state.next_sync_at),
          active_dataset_id=coalesce(excluded.active_dataset_id, sync_shard_state.active_dataset_id),
          address_count=CASE WHEN excluded.status='ready' THEN excluded.address_count ELSE sync_shard_state.address_count END,
          residential_count=CASE WHEN excluded.status='ready' THEN excluded.residential_count ELSE sync_shard_state.residential_count END,
          failure_count=CASE
            WHEN excluded.status='ready' THEN 0
            WHEN excluded.updated_at<>sync_shard_state.updated_at THEN sync_shard_state.failure_count+1
            ELSE sync_shard_state.failure_count
          END,
          last_error=excluded.last_error,
          source_version=coalesce(excluded.source_version, sync_shard_state.source_version),
          failure_code=excluded.failure_code,
          failure_signature=excluded.failure_signature,
          updated_at=excluded.updated_at
      `).bind(
        shard.id,
        shard.countryCode,
        success ? 'ready' : 'failed',
        lastSuccessfulAt,
        nextSyncAt(lastSuccessfulAt, entry.intervalDays || shard.intervalDays),
        entry.datasetId || null,
        Number(entry.acceptedCount || 0),
        Number(entry.residentialCount || 0),
        success ? 0 : 1,
        success ? null : String(entry.error || 'Address sync failed').slice(0, 1000),
        entry.sourceVersion || null,
        success ? null : entry.errorCode || null,
        success ? null : entry.failureSignature || null,
        updatedAt
      ));
    }
    if (statements.length) await this.database.batch(statements);
    for (const countryCode of affectedCountries) {
      const updatedAt = this.now().toISOString();
      await this.database.prepare(`INSERT INTO sync_country_state(country_code,status,failure_count,updated_at)
        VALUES (?,'pending',0,?) ON CONFLICT (country_code) DO NOTHING`).bind(countryCode, updatedAt).run();
      const shardRows = (await this.database.prepare(`SELECT status,last_success_at,next_sync_at,failure_count,
        last_error,source_version,failure_code,failure_signature,updated_at FROM sync_shard_state
        WHERE country_code=? ORDER BY updated_at DESC`).bind(countryCode).all()).results;
      const hasReady = shardRows.some((row) => row.status === 'ready');
      const blockingFailure = shardRows.find((row) => row.status === 'failed'
        && !(row.failure_code === 'SOURCE_QUALITY_FAILED' && hasReady));
      const latestVersion = shardRows.find((row) => row.source_version);
      const datasetId = await this.database.prepare(`SELECT id FROM address_datasets
        WHERE country_code=? AND status='active' ORDER BY imported_at DESC LIMIT 1`).bind(countryCode).first('id');
      const counts = await this.database.prepare(`SELECT COUNT(*) AS address_count,
        SUM(CASE WHEN property_type IN ('residential','apartment') THEN 1 ELSE 0 END) AS residential_count
        FROM address_pool WHERE country_code=? AND active=1`).bind(countryCode).first();
      const minimum = (column) => shardRows.map((row) => row[column]).filter(Boolean).sort()[0] || null;
      const allSourcesResolved = shardRows.every((row) => row.status === 'ready'
        || (row.status === 'failed' && row.failure_code === 'SOURCE_QUALITY_FAILED' && hasReady));
      const status = blockingFailure ? 'failed' : allSourcesResolved && hasReady ? 'ready' : 'pending';
      await this.database.prepare(`UPDATE sync_country_state SET status=?,last_success_at=?,next_sync_at=?,
        active_dataset_id=?,address_count=?,residential_count=?,failure_count=?,last_error=?,source_version=?,
        failure_code=?,failure_signature=?,updated_at=? WHERE country_code=?`).bind(
        status, minimum('last_success_at'), minimum('next_sync_at'), datasetId || null,
        Number(counts?.address_count || 0), Number(counts?.residential_count || 0),
        shardRows.reduce((total, row) => total + Number(row.failure_count || 0), 0), blockingFailure?.last_error || null,
        latestVersion?.source_version || null, blockingFailure?.failure_code || null, blockingFailure?.failure_signature || null,
        shardRows[0]?.updated_at || updatedAt, countryCode
      ).run();
    }
  }
}
