import type { DbExecutor } from "../tx.js";

export interface EmbeddingRecord {
  memoryId: string;
  memoryVersion: number;
  embedding: number[];
  model: string;
  dimensions: number;
  status: "active" | "pending" | "failed";
}

export interface UpsertEmbeddingInput {
  memoryId: string;
  memoryVersion: number;
  embedding: number[];
  model: string;
  dimensions: number;
}

export function toPgVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

// pgvector values come back as text ("[0.1,0.2,...]"); be defensive in case
// a driver or future codec returns an array already.
export function parsePgVector(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/^\[|\]$/g, "");
    if (trimmed === "") return [];
    return trimmed.split(",").map(Number);
  }
  return [];
}

interface EmbeddingRow {
  memory_id: string;
  memory_version: number;
  embedding: unknown;
  model: string;
  dimensions: number;
  status: EmbeddingRecord["status"];
}

function mapEmbedding(row: EmbeddingRow): EmbeddingRecord {
  return {
    memoryId: row.memory_id,
    memoryVersion: row.memory_version,
    embedding: parsePgVector(row.embedding),
    model: row.model,
    dimensions: row.dimensions,
    status: row.status,
  };
}

export class EmbeddingRepository {
  async upsert(db: DbExecutor, input: UpsertEmbeddingInput): Promise<void> {
    await db.query(
      `INSERT INTO memory_embeddings (memory_id, memory_version, embedding, model, dimensions, status)
       VALUES ($1, $2, $3::vector, $4, $5, 'active')
       ON CONFLICT (memory_id, memory_version) DO UPDATE
       SET embedding = EXCLUDED.embedding,
           model = EXCLUDED.model,
           dimensions = EXCLUDED.dimensions,
           status = 'active'`,
      [
        input.memoryId,
        input.memoryVersion,
        toPgVector(input.embedding),
        input.model,
        input.dimensions,
      ],
    );
  }

  async getForVersion(
    db: DbExecutor,
    memoryId: string,
    memoryVersion: number,
  ): Promise<EmbeddingRecord | null> {
    const result = await db.query<EmbeddingRow>(
      `SELECT memory_id, memory_version, embedding, model, dimensions, status
       FROM memory_embeddings
       WHERE memory_id = $1 AND memory_version = $2`,
      [memoryId, memoryVersion],
    );
    const row = result.rows[0];
    return row ? mapEmbedding(row) : null;
  }

  // Rows without any embedding are "pending" (SPEC §8: embedding failure must
  // not lose the memory). Future retry jobs / manual re-embed start here.
  async findMemoriesMissingEmbedding(
    db: DbExecutor,
  ): Promise<Array<{ memoryId: string; currentVersion: number }>> {
    const result = await db.query<{ id: string; current_version: number }>(
      `SELECT m.id, m.current_version
       FROM memories m
       WHERE m.status <> 'deleted'
         AND NOT EXISTS (
           SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id
         )
       ORDER BY m.created_at ASC`,
    );
    return result.rows.map((r) => ({ memoryId: r.id, currentVersion: r.current_version }));
  }
}
