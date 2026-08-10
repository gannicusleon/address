import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncApi } from './api.mjs';
import { createSyncArtifactCleanup } from './artifact-cleanup.mjs';
import { createPostgresPool, initializePostgres, PostgresDatabase } from '../database/postgres.mjs';
import { SyncCoordinator } from './coordinator.mjs';
import { createSyncQueue } from './queue.mjs';
import { runAddressSync, syncPostgresStatementTimeout } from './run-address-sync.mjs';
import { startDailyScheduler, startInitialScheduler, triggerStartupSync } from './scheduler.mjs';
import { loadSourceCatalog } from './source-adapters.mjs';

const integer = (value, fallback, minimum, maximum) => {
  const number = value === undefined || value === '' ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return number;
};
const enabled = (value) => /^(1|true|yes)$/iu.test(String(value || ''));
const japanJobTimeoutMs = 10 * 60 * 60_000;

export const syncJobTimeout = (environment, shards) => {
  const configured = integer(environment.SYNC_JOB_TIMEOUT_MS, 90 * 60_000, 60_000, 24 * 60 * 60_000);
  const includesJapan = shards.some((value) => {
    const normalized = String(value).toLowerCase();
    return normalized === 'all' || normalized === 'jp' || normalized.startsWith('japan-abr');
  });
  return includesJapan ? Math.max(configured, japanJobTimeoutMs) : configured;
};

const stripPrefix = (request) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/sync-control')) return request;
  url.pathname = url.pathname.slice('/sync-control'.length) || '/';
  return new Request(url, request);
};

export const createSyncRuntime = async ({
  environment = process.env,
  runSync = runAddressSync,
  database: providedDatabase,
  stateDir = resolve(environment.SYNC_STATE_DIR || '.data-cache/sync-control'),
  utcHour = integer(environment.SYNC_UTC_HOUR, 3, 0, 23),
  now = () => new Date()
} = {}) => {
  let testDatabase;
  if (!providedDatabase && environment.NODE_ENV === 'test' && environment.ADDRESS_TEST_DATABASE === 'memory') {
    const { initializeTestDatabase, openTestDatabase } = await import('../../tests/helpers/postgres-test-database.mjs');
    testDatabase = openTestDatabase(':memory:');
    await initializeTestDatabase(testDatabase, new URL('../control/schema.sql', import.meta.url));
    providedDatabase = testDatabase;
  }
  const postgresPool = providedDatabase ? undefined : createPostgresPool({
    environment,
    statement_timeout: syncPostgresStatementTimeout(environment),
    application_name: 'address-sync'
  });
  if (postgresPool) await initializePostgres(postgresPool);
  const database = providedDatabase || new PostgresDatabase(postgresPool);
  const queueDatabase = providedDatabase || new PostgresDatabase(postgresPool);
  const scheduleStateFile = resolve(stateDir, 'daily-schedule.json');
  const initialStateFile = resolve(stateDir, 'initial-schedule.json');
  const coordinator = new SyncCoordinator({
    stateDir,
    now,
    jobTimeoutMs: ({ shards }) => syncJobTimeout(environment, shards),
    runSync: ({ id, trigger, shards, signal }) => runSync({
      releaseId: id,
      signal,
      database,
      environment: {
        ...environment,
        ADDRESS_SYNC_JOB_ID: id,
        ADDRESS_SYNC_TRIGGER: trigger,
        ADDRESS_SYNC_SHARDS: shards.join(',')
      }
    })
  });
  await coordinator.initialize();
  const artifactCleanup = environment.ADDRESS_SYNC_CACHE_DIR ? createSyncArtifactCleanup({
    cacheDir: environment.ADDRESS_SYNC_CACHE_DIR,
    isBusy: () => Boolean(coordinator.currentJob),
    staleMs: integer(environment.ADDRESS_SYNC_ARTIFACT_STALE_MS, 6 * 60 * 60_000, 60_000, 30 * 24 * 60 * 60_000),
    intervalMs: integer(environment.ADDRESS_SYNC_CLEANUP_INTERVAL_MS, 15 * 60_000, 60_000, 24 * 60 * 60_000),
    retainRaw: enabled(environment.ADDRESS_SYNC_RETAIN_RAW)
  }) : null;
  artifactCleanup?.start();
  const queue = createSyncQueue({
    environment,
    coordinator,
    stateDir,
    now,
    addressDatabase: queueDatabase,
    controlDatabase: queueDatabase,
    loadCatalog: () => loadSourceCatalog(undefined, environment)
  });
  const handler = createSyncApi({
    coordinator,
    queue,
    token: environment.SYNC_ADMIN_TOKEN,
    allowedOrigin: environment.SYNC_ADMIN_ORIGIN || ''
  });
  const api = (request) => handler(stripPrefix(request));
  let stopScheduler;
  let stopInitialScheduler;
  let stopQueue;
  return {
    api,
    database,
    coordinator,
    queue,
    startScheduler: ({ startup = true } = {}) => {
      if (!enabled(environment.SYNC_SCHEDULER_ENABLED)) return () => {};
      if (stopScheduler) return stopScheduler;
      stopQueue = queue.start();
      stopScheduler = startDailyScheduler({ coordinator, stateFile: scheduleStateFile, utcHour, now });
      if (startup) {
        stopInitialScheduler = startInitialScheduler({
          coordinator,
          stateFile: initialStateFile,
          now,
          retryBaseMs: integer(environment.SYNC_INITIAL_RETRY_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
          onComplete: () => void triggerStartupSync(coordinator, {
            stateFile: scheduleStateFile,
            utcHour,
            now,
            maxAttempts: integer(environment.SYNC_DAILY_MAX_ATTEMPTS, 3, 1, 10),
            retryBaseMs: integer(environment.SYNC_DAILY_RETRY_MS, 60_000, 1_000, 60 * 60_000)
          }).catch((error) => {
            console.error('Address synchronization startup check failed', error);
          })
        });
      }
      return () => {
        stopInitialScheduler?.();
        stopInitialScheduler = undefined;
        stopScheduler?.();
        stopScheduler = undefined;
        stopQueue?.();
        stopQueue = undefined;
      };
    },
    close: async () => {
      stopScheduler?.();
      stopScheduler = undefined;
      stopInitialScheduler?.();
      stopInitialScheduler = undefined;
      stopQueue = undefined;
      await artifactCleanup?.stop();
      await queue.stop();
      await coordinator.waitForIdle();
      testDatabase?.close();
      await postgresPool?.end();
    }
  };
};

const toWebRequest = async (request) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return new Request(new URL(request.url || '/', 'http://sync.internal'), {
    method: request.method,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
  });
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const host = process.env.SYNC_HOST || '127.0.0.1';
  const port = integer(process.env.SYNC_PORT, 8791, 1, 65_535);
  const runtime = await createSyncRuntime();
  runtime.startScheduler();
  const server = createServer(async (request, response) => {
    try {
      const webResponse = await runtime.api(await toWebRequest(request));
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
    }
  });
  server.listen(port, host, () => console.log(`Address sync control listening on http://${host}:${port}`));
  let stopBackfill = () => {};
  if (/^(1|true|yes)$/iu.test(String(process.env.TRANSLATION_BACKFILL_ENABLED || ''))) {
    const { startTranslationBackfill } = await import('./translation-backfill.mjs');
    stopBackfill = startTranslationBackfill({
      database: runtime.database,
      isBusy: () => Boolean(runtime.coordinator.currentJob)
    });
    console.log('Translation backfill worker enabled');
  }
  const shutdown = async () => {
    stopBackfill();
    await new Promise((done) => server.close(done));
    await runtime.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
