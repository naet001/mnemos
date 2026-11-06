import type pg from "pg";
import { getPool } from "./index.js";
import { logger } from "../logger/index.js";
import {
  AppError,
  ConflictError,
  PersistenceError,
  ValidationError,
} from "../core/index.js";

export type DbExecutor = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  pool?: pg.Pool,
): Promise<T> {
  const p = pool ?? getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw mapPersistenceError(err);
  } finally {
    client.release();
  }
}

const CONFLICT_CODES = new Set(["23505", "23P01"]);
const VALIDATION_CODES = new Set([
  "23503",
  "23502",
  "23514",
  "22001",
  "22P02",
]);

// Converts raw pg errors into typed application errors. The original message
// is only logged, never forwarded: pg messages can embed SQL, table names, or
// constraint details that must not reach clients (SPEC §15).
export function mapPersistenceError(err: unknown): never {
  if (err instanceof AppError) throw err;

  const candidate = err instanceof Error ? (err as unknown as { code?: unknown }) : undefined;
  const sqlState =
    candidate && typeof candidate.code === "string" && candidate.code.length === 5
      ? candidate.code
      : undefined;

  logger.error("Persistence failure", {
    sqlState,
    message: err instanceof Error ? err.message : String(err),
  });

  if (sqlState) {
    if (CONFLICT_CODES.has(sqlState)) {
      throw new ConflictError("Resource conflicts with existing data", { sqlState });
    }
    if (VALIDATION_CODES.has(sqlState)) {
      throw new ValidationError("Invalid or referenced data", { sqlState });
    }
  }
  throw new PersistenceError("A persistence error occurred", {
    ...(sqlState ? { sqlState } : {}),
  });
}
