import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  { version: 2, name: "embedding_unique", filename: "002_embedding_unique.sql" },
  { version: 3, name: "proposal_provenance", filename: "003_proposal_provenance.sql" },
];

async function getAppliedChecksums(pool: pg.Pool): Promise<Map<number, string>> {
  try {
    const result = await pool.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM _migrations ORDER BY version"
    );
    return new Map(result.rows.map((r) => [r.version, r.checksum]));
  } catch (err) {
    // Only tolerate a missing bookkeeping table; rethrow anything else so a
    // dead/unauthorized database can never be mistaken for "no migrations".
    if (err instanceof Error && "code" in err && err.code === "42P01") {
      return new Map();
    }
    throw err;
  }
}

async function runMigration(
  pool: pg.Pool,
  migration: Migration
): Promise<void> {
  const filePath = resolve(__dirname, "migrations", migration.filename);
  const sql = readFileSync(filePath, "utf-8");
  const checksum = createHash("sha256").update(sql, "utf8").digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Execute the whole file as one simple query: pg supports multi-statement
    // strings, and naive splitting on ";" would drop DDL that follows comments.
    await client.query(sql);

    await client.query(
      `INSERT INTO _migrations (version, name, checksum)
       VALUES ($1, $2, $3)
       ON CONFLICT (version) DO NOTHING`,
      [migration.version, migration.name, checksum]
    );

    await client.query("COMMIT");
    logger.info(`Migration ${migration.version} applied`, {
      name: migration.name,
      sqlBytes: Buffer.byteLength(sql, "utf8"),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  // Bootstrap bookkeeping table (must exist before the runner records versions).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER     NOT NULL PRIMARY KEY,
      name       TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum   TEXT        NOT NULL
    )
  `);

  const applied = await getAppliedChecksums(pool);

  for (const migration of MIGRATIONS) {
    const existing = applied.get(migration.version);
    if (existing !== undefined) {
      const filePath = resolve(__dirname, "migrations", migration.filename);
      const current = createHash("sha256")
        .update(readFileSync(filePath, "utf-8"), "utf8")
        .digest("hex");
      if (existing !== current) {
        logger.warn(`Migration ${migration.version} checksum differs from applied file`, {
          name: migration.name,
          filename: migration.filename,
          applied: existing.slice(0, 12),
          current: current.slice(0, 12),
        });
      } else {
        logger.debug(`Migration ${migration.version} already applied, skipping`);
      }
      continue;
    }

    await runMigration(pool, migration);
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

    await runMigrations(pool);

    logger.info("All migrations applied successfully");
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Migration runner failed", { error: message });
    process.exit(1);
  });
}
