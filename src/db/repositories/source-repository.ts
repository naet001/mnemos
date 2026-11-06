import type { DbExecutor } from "../tx.js";
import type { Source, SourceKind } from "../../core/index.js";

interface SourceRow {
  id: string;
  agent_id: string;
  source_kind: SourceKind;
  external_ref: string | null;
  created_at: Date;
}

function map(row: SourceRow): Source {
  return {
    id: row.id,
    agentId: row.agent_id,
    sourceKind: row.source_kind,
    externalRef: row.external_ref,
    createdAt: row.created_at,
  };
}

export class SourceRepository {
  async create(
    db: DbExecutor,
    input: { agentId: string; sourceKind: SourceKind; externalRef?: string | null },
  ): Promise<Source> {
    const result = await db.query<SourceRow>(
      `INSERT INTO sources (agent_id, source_kind, external_ref)
       VALUES ($1, $2, $3)
       RETURNING id, agent_id, source_kind, external_ref, created_at`,
      [input.agentId, input.sourceKind, input.externalRef ?? null],
    );
    return map(result.rows[0]);
  }

  async getById(db: DbExecutor, id: string): Promise<Source | null> {
    const result = await db.query<SourceRow>(
      `SELECT id, agent_id, source_kind, external_ref, created_at FROM sources WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
}
