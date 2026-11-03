import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../config/index.js";
import { logger } from "../logger/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Migration {
  version: number;
  name: string;
  filename: string;
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial_schema", filename: "001_initial.sql" },
];

async function getAppliedVersions(pool: pg.Pool): Promise<Set<number>> {
  try {
    const result = await pool.query(
      "SELECT version FROM _migrations ORDER BY version"
    );
    return new Set(result.rows.map((r) => r.version));
  } catch {
    // _migrations table doesn't exist yet — no migrations applied
    return new Set();
  }
}

async function runMigration(
  pool: pg.Pool,
  migration: Migration
): Promise<void> {
  const filePath = resolve(__dirname, "migrations", migration.filename);
  const sql = readFileSync(filePath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Split by semicolons and execute each statement
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));

    for (const statement of statements) {
      await client.query(statement);
    }

    await client.query("COMMIT");
    logger.info(`Migration ${migration.version} applied`, {
      name: migration.name,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info("Starting migrations", { database: "mnemos" });

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    // Verify connection
    await pool.query("SELECT 1");
    logger.info("Database connected");

    // Ensure _migrations table exists (bootstrap)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version    INTEGER     NOT NULL PRIMARY KEY,
        name       TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum   TEXT        NOT NULL
      )
    `);

    const applied = await getAppliedVersions(pool);

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        logger.debug(`Migration ${migration.version} already applied, skipping`);
        continue;
      }

      try {
        await runMigration(pool, migration);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Migration ${migration.version} failed`, { error: message });
        process.exit(1);
      }
    }

    logger.info("All migrations applied successfully");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Migration runner failed", { error: message });
  process.exit(1);
});