import pg from "pg";
import { logger } from "../logger/index.js";

let pool: pg.Pool | null = null;

export interface DbHealth {
  connected: boolean;
  pgvectorAvailable: boolean;
  schemaVersion: number | null;
  latencyMs: number;
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("Database pool not initialized. Call connect() first.");
  }
  return pool;
}

export async function connect(databaseUrl: string): Promise<pg.Pool> {
  if (pool) {
    logger.warn("Database pool already initialized, closing existing one");
    await disconnect();
  }

  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    logger.error("Unexpected database pool error", { error: err.message });
  });

  // Verify connection
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT 1 AS ok");
    logger.info("Database connected", { result: result.rows[0].ok });
  } finally {
    client.release();
  }

  return pool;
}

export async function disconnect(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
  logger.info("Database disconnected");
}

export async function checkHealth(): Promise<DbHealth> {
  const start = Date.now();
  const health: DbHealth = {
    connected: false,
    pgvectorAvailable: false,
    schemaVersion: null,
    latencyMs: 0,
  };

  try {
    const p = getPool();
    const client = await p.connect();
    try {
      // Basic connectivity
      await client.query("SELECT 1");

      // Check pgvector extension
      const vectorResult = await client.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
      );
      health.pgvectorAvailable = vectorResult.rowCount !== null && vectorResult.rowCount > 0;

      // Check schema version from migrations tracking
      const schemaResult = await client.query(
        "SELECT version FROM _migrations ORDER BY applied_at DESC LIMIT 1"
      );
      if (schemaResult.rowCount !== null && schemaResult.rowCount > 0) {
        health.schemaVersion = schemaResult.rows[0].version;
      }

      health.connected = true;
    } finally {
      client.release();
    }
  } catch (err) {
    // Health check failure is not fatal — just report it
    health.connected = false;
  }

  health.latencyMs = Date.now() - start;
  return health;
}