import type pg from "pg";
import { getPool } from "./index.js";
import { PersistenceError } from "../core/index.js";

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
    throw err;
  } finally {
    client.release();
  }
}

export function mapPersistenceError(err: unknown): never {
  if (err instanceof Error && err.name && err.name.endsWith("Error") && "code" in err) {
    throw err;
  }
  throw new PersistenceError("A persistence error occurred");
}
