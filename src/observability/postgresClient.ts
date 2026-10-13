type ProcessEnvLike = Record<string, string | undefined>;

export type TriMMCPostgresConfig = {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
};

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function getRuntimeEnv(): ProcessEnvLike {
  const maybeProcess = globalThis as { process?: { env?: ProcessEnvLike } };
  return maybeProcess.process?.env || {};
}

export function resolvePostgresConfig(env: ProcessEnvLike = getRuntimeEnv()): TriMMCPostgresConfig {
  const connectionString = env.TRIMC_DATABASE_URL || env.DATABASE_URL || '';

  return {
    connectionString,
    max: toInt(env.TRIMC_PG_MAX, 20),
    idleTimeoutMillis: toInt(env.TRIMC_PG_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: toInt(env.TRIMC_PG_CONN_TIMEOUT_MS, 5_000)
  };
}

export async function createPostgresPool(config: Partial<TriMMCPostgresConfig> = {}) {
  const resolved = {
    ...resolvePostgresConfig(),
    ...config
  };

  if (!resolved.connectionString) {
    throw new Error('Postgres connection string is required (TRIMC_DATABASE_URL or DATABASE_URL)');
  }

  const pg = await import('pg');
  const { Pool } = pg;
  return new Pool(resolved);
}