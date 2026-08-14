import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem } from 'node:os';
import { createPostgresPool, initializePostgres, PostgresDatabase } from '../database/postgres.mjs';
import { runAddressEtl } from './address-etl.mjs';
import { PostgresCountryStateStore } from './postgres-country-state.mjs';
import { createProviderCredentialPool } from './provider-credential-pool.mjs';
import { loadSourceCatalog } from './source-adapters.mjs';

const validReleaseId = (value) => {
  const id = String(value || `sync-${Date.now()}`).trim();
  if (!/^[a-zA-Z0-9._:-]{1,120}$/u.test(id)) throw new Error('Invalid address sync job id');
  return id;
};

const enabled = (value) => /^(1|true|yes)$/iu.test(String(value || ''));
const deterministicFailureCodes = new Set(['SOURCE_QUALITY_FAILED', 'SNAPSHOT_QUALITY_FAILED']);
const nonRetryableFailureCodes = new Set([
  ...deterministicFailureCodes,
  'SYNC_JOB_TIMEOUT', 'SYNC_PROCESS_TIMEOUT', 'SYNC_PROCESS_ABORTED',
  'ADDRESS_SYNC_MEMORY_LOW', 'ADDRESS_SYNC_ALREADY_RUNNING'
]);
const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
export const syncPostgresStatementTimeout = (environment = {}) => integer(
  environment.ADDRESS_SYNC_POSTGRES_STATEMENT_TIMEOUT_MS, 3 * 60 * 60_000, 30_000, 3 * 60 * 60_000
);
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const processIsAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

export const acquireSyncLease = async (file, { now = () => Date.now(), isAlive = processIsAlive } = {}) => {
  await mkdir(dirname(file), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date(now()).toISOString() }));
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(file, 'utf8'));
          if (current.token === token) await rm(file, { force: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(file, 'utf8')); } catch {}
      const age = await stat(file).then((entry) => now() - entry.mtimeMs).catch(() => 0);
      if (isAlive(Number(owner?.pid)) || age < 60_000) {
        throw Object.assign(new Error('Another address synchronization process is already running'), {
          code: 'ADDRESS_SYNC_ALREADY_RUNNING'
        });
      }
      await rm(file, { force: true });
    }
  }
  throw Object.assign(new Error('Address synchronization lease could not be acquired'), {
    code: 'ADDRESS_SYNC_ALREADY_RUNNING'
  });
};
const shouldRetry = (error) => {
  const errors = error instanceof AggregateError ? error.errors : [error];
  return errors.some((entry) => !nonRetryableFailureCodes.has(entry?.code));
};

export const assertSyncMemory = (availableBytes, minimumBytes) => {
  if (availableBytes >= minimumBytes) return;
  throw Object.assign(new Error(`Address synchronization requires ${minimumBytes} free bytes; ${availableBytes} available`), {
    code: 'ADDRESS_SYNC_MEMORY_LOW', availableBytes, minimumBytes
  });
};

export const runAddressSync = async ({
  releaseId = process.env.ADDRESS_SYNC_JOB_ID,
  database: providedDatabase,
  environment = process.env,
  runEtl = runAddressEtl,
  catalog: providedCatalog,
  signal,
  wait = delay,
  availableMemory = freemem
} = {}) => {
  const id = validReleaseId(releaseId);
  const syncMode = environment.ADDRESS_SYNC_MODE
    || (environment.ADDRESS_SYNC_TRIGGER === 'initial' ? 'initial'
      : ['manual', 'force'].includes(environment.ADDRESS_SYNC_TRIGGER) ? 'manual' : 'daily');
  const usesBuiltInEtl = runEtl === runAddressEtl;
  if (usesBuiltInEtl && !enabled(environment.ADDRESS_SYNC_DRY_RUN) && !enabled(environment.ADDRESS_SYNC_ESTIMATE)) {
    assertSyncMemory(availableMemory(), integer(
      environment.ADDRESS_SYNC_MIN_FREE_MEMORY_BYTES, 2 * 1024 ** 3, 256 * 1024 ** 2, Number.MAX_SAFE_INTEGER
    ));
  }
  const lockFile = resolve(environment.ADDRESS_SYNC_LOCK_FILE
    || resolve(environment.SYNC_STATE_DIR || '.data-cache/sync-control', 'address-sync.lock'));
  const releaseLease = usesBuiltInEtl && !providedDatabase ? await acquireSyncLease(lockFile) : async () => {};
  let database;
  let postgresPool;
  try {
    if (providedDatabase) database = providedDatabase;
    else if (usesBuiltInEtl) {
      postgresPool = createPostgresPool({
        environment,
        statement_timeout: syncPostgresStatementTimeout(environment),
        application_name: 'address-sync'
      });
      await initializePostgres(postgresPool);
      database = new PostgresDatabase(postgresPool);
    }
    const catalog = providedCatalog || (usesBuiltInEtl ? await loadSourceCatalog(undefined, environment) : undefined);
    const stateStore = database && catalog ? new PostgresCountryStateStore({ database, shards: catalog.shards }) : undefined;
    const credentialPool = usesBuiltInEtl ? createProviderCredentialPool(database, environment) : null;
    const options = {
      database,
      environment,
      catalog,
      stateStore,
      credentialPool,
      requestedShards: environment.ADDRESS_SYNC_SHARDS
        ? environment.ADDRESS_SYNC_SHARDS.split(',').map((value) => value.trim()).filter(Boolean)
        : ['all'],
      dryRun: enabled(environment.ADDRESS_SYNC_DRY_RUN),
      estimate: enabled(environment.ADDRESS_SYNC_ESTIMATE),
      force: enabled(environment.ADDRESS_SYNC_FORCE) || ['manual', 'force'].includes(environment.ADDRESS_SYNC_TRIGGER),
      syncMode,
      signal,
      requireResidential: enabled(environment.ADDRESS_SYNC_REQUIRE_RESIDENTIAL),
      maxShardsPerRun: syncMode === 'manual' || syncMode === 'initial' ? Number.MAX_SAFE_INTEGER : 1
    };
    const defaultAttempts = syncMode === 'daily' ? 1 : 3;
    const attempts = integer(environment.ADDRESS_SYNC_RETRY_ATTEMPTS, defaultAttempts, 1, 10);
    const baseDelayMs = integer(environment.ADDRESS_SYNC_RETRY_BASE_MS, 1_000, 1, 60_000);
    let etl;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (signal?.aborted) throw Object.assign(new Error('Address synchronization aborted'), { code: 'SYNC_JOB_TIMEOUT' });
        etl = await runEtl(options);
        break;
      } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error('Address synchronization aborted'), {
          code: 'SYNC_JOB_TIMEOUT', cause: error
        });
        if (attempt === attempts || !shouldRetry(error)) throw error;
        const waitMs = Math.min(60_000, baseDelayMs * 2 ** (attempt - 1));
        console.warn(`Address synchronization attempt ${attempt}/${attempts} failed; retrying in ${waitMs}ms`, error);
        if (signal?.aborted) throw Object.assign(new Error('Address synchronization aborted'), { code: 'SYNC_JOB_TIMEOUT' });
        await wait(waitMs);
      }
    }
    return { releaseId: id, changed: Boolean(etl.changed), etl };
  } finally {
    try {
      await postgresPool?.end();
    } finally {
      await releaseLease();
    }
  }
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await runAddressSync();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
