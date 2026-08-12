import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAddressEtl } from '../server/sync/address-etl.mjs';
import { runAddressSync } from '../server/sync/run-address-sync.mjs';
import { countryPlanStatus, planCountryShards } from '../server/sync/country-plan.mjs';
import { PostgresCountryStateStore } from '../server/sync/postgres-country-state.mjs';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import {
  assertStorageBudget,
  evaluateStorageBudget,
  measureStorageBytes,
  StorageBudgetExceededError
} from '../server/sync/storage-budget.mjs';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const shards = ['US', 'CA', 'JP'].map((countryCode) => ({
  id: `fixture-${countryCode.toLowerCase()}`,
  countryCode,
  intervalDays: 30
}));

describe('country sync planning', () => {
  it('initializes every country without reprocessing successful countries', () => {
    const state = { shards: { 'fixture-us': { status: 'imported', lastSuccessfulAt: '2026-07-01T00:00:00Z' } } };
    expect(planCountryShards({ shards, state, mode: 'initial' }).map(({ countryCode }) => countryCode)).toEqual(['CA', 'JP']);
    expect(countryPlanStatus({ shards, state, now: new Date('2026-07-16T00:00:00Z') })).toMatchObject({ total: 3, initialized: 1, pending: 2 });
  });

  it('selects one failed or oldest due country and waits 30 days after success', () => {
    const state = { shards: {
      'fixture-us': { status: 'imported', lastSuccessfulAt: '2026-07-01T00:00:00Z' },
      'fixture-ca': { status: 'failed', lastSuccessfulAt: '2026-06-30T00:00:00Z' },
      'fixture-jp': { status: 'imported', lastSuccessfulAt: '2026-06-01T00:00:00Z' }
    } };
    const planned = planCountryShards({ shards, state, mode: 'daily', now: new Date('2026-07-16T00:00:00Z') });
    expect(planned.map(({ countryCode }) => countryCode)).toEqual(['CA']);
  });

  it('resumes a 27-country-style initialization from the persisted country manifest', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(resolve(cacheDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      shards: { 'fixture-us': { status: 'imported', lastSuccessfulAt: '2026-07-01T00:00:00Z' } }
    }));
    const result = await runAddressEtl({
      cacheDir,
      dataRoot: cacheDir,
      catalog: { schemaVersion: 1, shards: shards.map((shard) => ({ ...shard, source: { id: 'fixture' } })) },
      syncMode: 'initial',
      dryRun: true,
      adapters: { discover: async () => ({ adapter: 'overture', version: 'fixture', sourceBytes: 0 }) }
    });
    expect(result.selectedShards).toEqual(['fixture-ca', 'fixture-jp']);
  });

  it('prioritizes reusable normalized files during initialization', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    await mkdir(resolve(cacheDir, 'normalized'), { recursive: true });
    await writeFile(resolve(cacheDir, 'normalized', 'fixture-jp-fixture.jsonl'), '{}\n');
    const result = await runAddressEtl({
      cacheDir,
      dataRoot: cacheDir,
      catalog: { schemaVersion: 1, shards: shards.map((shard) => ({ ...shard, source: { id: 'fixture' } })) },
      syncMode: 'initial',
      dryRun: true,
      adapters: { discover: async () => ({ adapter: 'overture', version: 'fixture', sourceBytes: 0 }) }
    });
    expect(result.selectedShards).toEqual(['fixture-jp', 'fixture-us', 'fixture-ca']);
  });

  it('passes initial mode to ETL without the daily one-country cap', async () => {
    let options;
    await runAddressSync({
      releaseId: 'fixture-initial',
      environment: { ADDRESS_SYNC_TRIGGER: 'initial' },
      runEtl: async (value) => {
        options = value;
        return { changed: false, dryRun: true };
      }
    });
    expect(options).toMatchObject({ syncMode: 'initial', maxShardsPerRun: Number.MAX_SAFE_INTEGER });
  });

  it('attempts later countries after an initial country fails and persists resumable state', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    const attempted = [];
    await expect(runAddressEtl({
      cacheDir,
      dataRoot: cacheDir,
      catalog: { schemaVersion: 1, shards: shards.slice(0, 2).map((shard) => ({ ...shard, source: { id: 'fixture' } })) },
      syncMode: 'initial',
      maxRecords: 1,
      measureStorage: async () => 0,
      adapters: {
        discover: async (shard) => {
          attempted.push(shard.countryCode);
          if (shard.countryCode === 'US') throw new Error('fixture failure');
          return { adapter: 'overture', version: 'fixture', sourceBytes: 0 };
        },
        materialize: async () => ({ file: resolve(cacheDir, 'fixture.jsonl'), format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 0 })
      },
      importer: { importShard: async () => ({ datasetId: 'fixture-ca', acceptedCount: 1, rejectedCount: 0, skipped: false }) }
    })).rejects.toThrow('Address sync failed for 1 country shard');
    const manifest = JSON.parse(await readFile(resolve(cacheDir, 'manifest.json'), 'utf8'));
    expect(attempted).toEqual(['US', 'CA']);
    expect(manifest.shards['fixture-us'].status).toBe('failed');
    expect(manifest.shards['fixture-ca']).toMatchObject({ status: 'imported', lastSuccessfulAt: expect.any(String) });
  });

  it('skips repeated source-quality failures until the source or adapter revision changes', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    let persisted = { schemaVersion: 1, shards: {} };
    let materializations = 0;
    let buildingAssets = [];
    const stateStore = {
      load: async () => structuredClone(persisted),
      save: async (value) => { persisted = structuredClone(value); }
    };
    const catalog = { schemaVersion: 1, shards: [{ ...shards[0], source: { id: 'fixture' } }] };
    const adapters = {
      discover: async () => ({ adapter: 'overture', version: 'fixture-v1', sourceBytes: 0, buildingAssets }),
      materialize: async () => {
        materializations += 1;
        return { file: resolve(cacheDir, 'fixture.jsonl'), format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 0 };
      }
    };
    const importer = {
      importShard: async ({ shard, discovery }) => {
        throw Object.assign(new Error(`Shard ${shard.id} produced no valid addresses`), {
          code: 'SOURCE_QUALITY_FAILED', failureSignature: discovery.failureSignature,
          rejectionReasons: { missing_residential_evidence: 4 },
          metrics: { candidateCount: 0, rejectedCount: 4, rejectionReasons: { missing_residential_evidence: 4 } }
        });
      }
    };

    await expect(runAddressEtl({ cacheDir, dataRoot: cacheDir, catalog, adapters, importer, stateStore,
      syncMode: 'manual', measureStorage: async () => 0 })).rejects.toThrow('Address sync failed for 1 country shard');
    expect(persisted.shards['fixture-us']).toMatchObject({
      errorCode: 'SOURCE_QUALITY_FAILED',
      failureSignature: expect.stringMatching(/fixture-v1:residential-buildings=0:building-assets=0:import=strict-residential-v22:policy=/u),
      rejectionReasons: { missing_residential_evidence: 4 },
      metrics: { candidateCount: 0, rejectedCount: 4 }
    });

    const repeated = await runAddressEtl({ cacheDir, dataRoot: cacheDir, catalog, adapters, importer, stateStore,
      syncMode: 'manual', measureStorage: async () => 0 });
    expect(materializations).toBe(1);
    expect(repeated.reports).toContainEqual(expect.objectContaining({ status: 'source-quality-failed', skipped: true }));

    const unavailableSignature = persisted.shards['fixture-us'].failureSignature;
    buildingAssets = ['https://example.test/buildings.parquet'];
    await expect(runAddressEtl({ cacheDir, dataRoot: cacheDir, catalog, adapters, importer, stateStore,
      syncMode: 'manual', measureStorage: async () => 0 })).rejects.toThrow('Address sync failed for 1 country shard');
    expect(materializations).toBe(2);
    expect(persisted.shards['fixture-us'].failureSignature).not.toBe(unavailableSignature);
    expect(persisted.shards['fixture-us'].failureSignature).toContain('residential-buildings=1:building-assets=1');
  });

  it('retains snapshot rejection diagnostics in failed reports', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    let persisted = { schemaVersion: 1, shards: {} };
    const stateStore = {
      load: async () => structuredClone(persisted),
      save: async (value) => { persisted = structuredClone(value); }
    };
    const catalog = { schemaVersion: 1, shards: [{ ...shards[0], source: { id: 'fixture' } }] };
    const metrics = { candidateCount: 1, previousCount: 10, rejectionReasons: { invalid_postcode: 3 } };
    await expect(runAddressEtl({
      cacheDir, dataRoot: cacheDir, catalog, stateStore, syncMode: 'manual', measureStorage: async () => 0,
      adapters: {
        discover: async () => ({ adapter: 'overture', version: 'fixture-v1', sourceBytes: 0, buildingAssets: ['building'] }),
        materialize: async () => ({ file: resolve(cacheDir, 'fixture.jsonl'), format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 0 })
      },
      importer: { importShard: async ({ discovery }) => {
        throw Object.assign(new Error('degraded snapshot'), {
          code: 'SNAPSHOT_QUALITY_FAILED', failureSignature: discovery.failureSignature,
          rejectionReasons: metrics.rejectionReasons, metrics
        });
      } }
    })).rejects.toThrow('Address sync failed for 1 country shard');
    expect(persisted.shards['fixture-us']).toMatchObject({
      errorCode: 'SNAPSHOT_QUALITY_FAILED', rejectionReasons: { invalid_postcode: 3 }, metrics
    });
  });

  it('retains an unavailable source diagnostic without failing a country whose other source succeeds', async () => {
    const cacheDir = resolve('.data-cache', 'country-plan-tests', randomUUID());
    directories.push(cacheDir);
    const countryShards = ['overture', 'geofabrik'].map((sourceId) => ({
      id: `${sourceId}-it`, countryCode: 'IT', intervalDays: 30, source: { id: sourceId }
    }));
    const result = await runAddressEtl({
      cacheDir, dataRoot: cacheDir, syncMode: 'manual', maxRecords: 1, measureStorage: async () => 0,
      catalog: { schemaVersion: 1, shards: countryShards },
      adapters: {
        discover: async (shard) => ({ adapter: shard.source.id, version: 'fixture-v1', sourceBytes: 0 }),
        materialize: async () => ({
          file: resolve(cacheDir, 'fixture.jsonl'), format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 0
        })
      },
      importer: { importShard: async ({ shard, discovery }) => {
        if (shard.source.id === 'overture') {
          throw Object.assign(new Error('Overture produced no valid addresses'), {
            code: 'SOURCE_QUALITY_FAILED', failureSignature: discovery.failureSignature
          });
        }
        return { datasetId: 'geofabrik-it-v1', acceptedCount: 1, rejectedCount: 0, residentialCount: 1, skipped: false };
      } }
    });
    expect(result.reports).toEqual(expect.arrayContaining([
      expect.objectContaining({ shardId: 'overture-it', status: 'failed', errorCode: 'SOURCE_QUALITY_FAILED' }),
      expect.objectContaining({ shardId: 'geofabrik-it', status: 'imported', acceptedCount: 1 })
    ]));
  });

  it('persists 30-day country state in PostgreSQL without double-counting repeated failures', async () => {
    const database = openTestDatabase(':memory:');
    const store = new PostgresCountryStateStore({ database, shards });
    const failed = {
      schemaVersion: 1,
      shards: {
        'fixture-us': {
          shardId: 'fixture-us', countryCode: 'US', intervalDays: 30, status: 'failed',
          lastSuccessfulAt: '2026-07-01T00:00:00.000Z', lastChecked: '2026-07-16T00:00:00.000Z',
          sourceVersion: 'fixture-v1', errorCode: 'SOURCE_QUALITY_FAILED', failureSignature: 'fixture-signature', error: 'fixture'
        }
      }
    };
    await store.save(failed);
    await store.save(failed);
    const row = await database.prepare('SELECT * FROM sync_country_state WHERE country_code=?').bind('US').first();
    expect(row).toMatchObject({ status: 'failed', failure_count: 1, next_sync_at: '2026-07-31T00:00:00.000Z' });
    expect((await store.load()).shards['fixture-us']).toMatchObject({
      status: 'failed', lastSuccessfulAt: '2026-07-01T00:00:00.000Z', sourceVersion: 'fixture-v1',
      errorCode: 'SOURCE_QUALITY_FAILED', failureSignature: 'fixture-signature'
    });
    database.close();
  });

  it('tracks multiple source shards for one country independently', async () => {
    const database = openTestDatabase(':memory:');
    const countryShards = [
      { id: 'source-a-us', countryCode: 'US', intervalDays: 30 },
      { id: 'source-b-us', countryCode: 'US', intervalDays: 30 }
    ];
    const store = new PostgresCountryStateStore({ database, shards: countryShards });
    await store.save({ schemaVersion: 1, shards: {
      'source-a-us': {
        shardId: 'source-a-us', countryCode: 'US', intervalDays: 30, status: 'imported',
        lastSuccessfulAt: '2026-07-01T00:00:00.000Z', lastChecked: '2026-07-01T00:00:00.000Z'
      },
      'source-b-us': {
        shardId: 'source-b-us', countryCode: 'US', intervalDays: 30, status: 'failed',
        lastChecked: '2026-07-02T00:00:00.000Z', error: 'fixture'
      }
    } });
    expect((await store.load()).shards).toMatchObject({
      'source-a-us': { status: 'imported' },
      'source-b-us': { status: 'failed' }
    });
    expect(await database.prepare('SELECT status FROM sync_country_state WHERE country_code=?').bind('US').first('status'))
      .toBe('failed');

    await store.save({ schemaVersion: 1, shards: {
      'source-b-us': {
        shardId: 'source-b-us', countryCode: 'US', intervalDays: 30, status: 'imported',
        lastSuccessfulAt: '2026-07-03T00:00:00.000Z', lastChecked: '2026-07-03T00:00:00.000Z'
      }
    } });
    expect(await database.prepare('SELECT status FROM sync_country_state WHERE country_code=?').bind('US').first('status'))
      .toBe('ready');
    database.close();
  });

  it('keeps a country ready when one source is unavailable but another source is ready', async () => {
    const database = openTestDatabase(':memory:');
    const countryShards = [
      { id: 'overture-it', countryCode: 'IT', intervalDays: 30 },
      { id: 'geofabrik-it', countryCode: 'IT', intervalDays: 30 }
    ];
    const store = new PostgresCountryStateStore({ database, shards: countryShards });
    await store.save({ schemaVersion: 1, shards: {
      'overture-it': {
        shardId: 'overture-it', countryCode: 'IT', intervalDays: 30, status: 'failed',
        lastChecked: '2026-08-12T00:00:00.000Z', error: 'no compatible records',
        errorCode: 'SOURCE_QUALITY_FAILED', failureSignature: 'fixture-signature'
      },
      'geofabrik-it': {
        shardId: 'geofabrik-it', countryCode: 'IT', intervalDays: 30, status: 'imported',
        lastSuccessfulAt: '2026-08-12T00:01:00.000Z', lastChecked: '2026-08-12T00:01:00.000Z',
        acceptedCount: 100, residentialCount: 100
      }
    } });
    expect(await database.prepare(`SELECT status,last_error,failure_code FROM sync_country_state
      WHERE country_code=?`).bind('IT').first()).toEqual({ status: 'ready', last_error: null, failure_code: null });
    expect(await database.prepare(`SELECT status,failure_code FROM sync_shard_state
      WHERE shard_id=?`).bind('overture-it').first()).toEqual({ status: 'failed', failure_code: 'SOURCE_QUALITY_FAILED' });
    database.close();
  });

});

describe('address storage budget', () => {
  it('measures nested roots once and switches off shadow expansion at the soft limit', async () => {
    const directory = resolve('.data-cache', 'storage-budget-tests', randomUUID());
    directories.push(directory);
    await mkdir(resolve(directory, 'nested'), { recursive: true });
    await writeFile(resolve(directory, 'data.bin'), Buffer.alloc(16));
    await writeFile(resolve(directory, 'nested', 'more.bin'), Buffer.alloc(8));
    expect(await measureStorageBytes([directory, resolve(directory, 'nested')])).toBe(24);
    expect(evaluateStorageBudget({ currentBytes: 39, additionalBytes: 1, softLimitBytes: 40, hardLimitBytes: 45 })).toMatchObject({
      level: 'soft', allowWrite: true, allowShadowExpansion: false
    });
  });

  it('hard-stops projected writes at 45GB-equivalent capacity', () => {
    expect(() => assertStorageBudget({ currentBytes: 44, additionalBytes: 1, softLimitBytes: 40, hardLimitBytes: 45 }))
      .toThrow(StorageBudgetExceededError);
  });

  it('passes the soft-limit shadow policy into the importer contract', async () => {
    const cacheDir = resolve('.data-cache', 'storage-budget-tests', randomUUID());
    directories.push(cacheDir);
    let receivedPolicy;
    let persistedState;
    await runAddressEtl({
      cacheDir,
      dataRoot: cacheDir,
      catalog: { schemaVersion: 1, shards: [{ ...shards[0], source: { id: 'fixture' } }] },
      syncMode: 'manual',
      softLimitBytes: 40,
      hardLimitBytes: 5000,
      maxRecords: 1,
      measureStorage: async () => 40,
      stateStore: {
        load: async () => ({ schemaVersion: 1, shards: {} }),
        save: async (value) => { persistedState = value; }
      },
      adapters: {
        discover: async () => ({ adapter: 'overture', version: 'fixture', sourceBytes: 0 }),
        materialize: async () => ({ file: resolve(cacheDir, 'fixture.jsonl'), format: 'overture-jsonl', checksum: 'a'.repeat(64), cacheBytes: 0 })
      },
      importer: {
        importShard: async ({ storagePolicy }) => {
          receivedPolicy = storagePolicy;
          return { datasetId: 'fixture', acceptedCount: 1, rejectedCount: 0, skipped: false };
        }
      }
    });
    expect(receivedPolicy).toMatchObject({ allowShadowExpansion: false, softLimitBytes: 40, hardLimitBytes: 5000 });
    expect(persistedState.shards['fixture-us']).toMatchObject({ status: 'imported', lastSuccessfulAt: expect.any(String) });
  });
});
