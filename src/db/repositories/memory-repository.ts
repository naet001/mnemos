import type { DbExecutor } from "../tx.js";
import type {
  Memory,
  MemoryStatus,
  MemoryType,
  MemoryVersion,
  Scope,
} from "../../core/index.js";
import { ConflictError } from "../../core/index.js";
import { TagRepository } from "./tag-repository.js";
import { scopeVisibilitySql } from "./visibility-sql.js";

export interface MemoryRow {
  id: string;
  content: string;
  type: MemoryType;
  scope: Scope;
  project_id: string | null;
  status: MemoryStatus;
  importance: number;
  confidence: string | number;
  source_id: string;
  created_by_agent: string;
  current_version: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface VersionRow {
  id: string;
  memory_id: string;
  version: number;
  content: string;
  type: MemoryType;
  scope: Scope;
  project_id: string | null;
  status: MemoryStatus;
  importance: number;
  confidence: string | number;
  source_id: string;
  created_at: Date;
}

function asConfidence(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

export function mapMemory(row: MemoryRow, tags: string[]): Memory {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    scope: row.scope,
    projectId: row.project_id,
    status: row.status,
    importance: row.importance,
    confidence: asConfidence(row.confidence),
    sourceId: row.source_id,
    createdByAgent: row.created_by_agent,
    currentVersion: row.current_version,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapVersion(row: VersionRow): MemoryVersion {
  return {
    id: row.id,
    memoryId: row.memory_id,
    version: row.version,
    content: row.content,
    type: row.type,
    scope: row.scope,
    projectId: row.project_id,
    status: row.status,
    importance: row.importance,
    confidence: asConfidence(row.confidence),
    sourceId: row.source_id,
    createdAt: row.created_at,
  };
}

export interface CreateMemoryRowInput {
  content: string;
  type: MemoryType;
  scope: Scope;
  projectId: string | null;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  sourceId: string;
  createdByAgent: string;
  currentVersion: number;
  archivedAt: Date | null;
}

export interface MemoryMutationInput {
  content: string;
  type: MemoryType;
  scope: Scope;
  projectId: string | null;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  sourceId: string;
  archivedAt: Date | null;
}

export interface MemoryListFilter {
  actorAgentId: string;
  accessibleProjectIds: string[];
  statuses: MemoryStatus[];
  scope?: Scope;
  projectId?: string;
  types?: MemoryType[];
  tagNames?: string[];
  limit: number;
  offset: number;
}

export class MemoryRepository {
  constructor(private readonly tagsRepo = new TagRepository()) {}

  async create(db: DbExecutor, input: CreateMemoryRowInput): Promise<Memory> {
    const result = await db.query<MemoryRow>(
      `INSERT INTO memories (
         content, type, scope, project_id, status, importance, confidence,
         source_id, created_by_agent, current_version, archived_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.content,
        input.type,
        input.scope,
        input.projectId,
        input.status,
        input.importance,
        input.confidence,
        input.sourceId,
        input.createdByAgent,
        input.currentVersion,
        input.archivedAt,
      ],
    );
    return mapMemory(result.rows[0], []);
  }

  async insertVersion(
    db: DbExecutor,
    memoryId: string,
    version: number,
    input: MemoryMutationInput,
  ): Promise<MemoryVersion> {
    const result = await db.query<VersionRow>(
      `INSERT INTO memory_versions (
         memory_id, version, content, type, scope, project_id, status,
         importance, confidence, source_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        memoryId,
        version,
        input.content,
        input.type,
        input.scope,
        input.projectId,
        input.status,
        input.importance,
        input.confidence,
        input.sourceId,
      ],
    );
    return mapVersion(result.rows[0]);
  }

  async getById(db: DbExecutor, id: string): Promise<Memory | null> {
    const result = await db.query<MemoryRow>(`SELECT * FROM memories WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const tags = await this.tagsRepo.getTagsForMemories(db, [id]);
    return mapMemory(row, tags.get(id) ?? []);
  }

  async list(
    db: DbExecutor,
    filter: MemoryListFilter,
  ): Promise<{ rows: Memory[]; total: number }> {
    const params: unknown[] = [filter.actorAgentId, filter.accessibleProjectIds];
    const where: string[] = [
      // Soft-deleted rows are never listable, regardless of status filter.
      "m.status <> 'deleted'",
      "m.status = ANY($3::text[])",
      scopeVisibilitySql("m.scope", "m.project_id", "m.created_by_agent", "$1", "$2"),
    ];
    params.push(filter.statuses);

    let idx = 4;
    if (filter.projectId) {
      where.push(`m.project_id = $${idx++}`);
      params.push(filter.projectId);
    }
    if (filter.scope) {
      where.push(`m.scope = $${idx++}`);
      params.push(filter.scope);
    }
    if (filter.types?.length) {
      where.push(`m.type = ANY($${idx++}::text[])`);
      params.push(filter.types);
    }
    if (filter.tagNames?.length) {
      // tags.name keeps display casing; matching is case-insensitive.
      where.push(`EXISTS (
        SELECT 1 FROM memory_tags mt
        JOIN tags t ON t.id = mt.tag_id
        WHERE mt.memory_id = m.id AND LOWER(t.name) = ANY($${idx++}::text[])
      )`);
      params.push(filter.tagNames.map((t) => t.toLowerCase()));
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memories m ${whereSql}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? "0");
    const result = await db.query<MemoryRow>(
      `SELECT m.* FROM memories m ${whereSql}
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, filter.limit, filter.offset],
    );
    const ids = result.rows.map((r) => r.id);
    const tags = await this.tagsRepo.getTagsForMemories(db, ids);
    return {
      rows: result.rows.map((r) => mapMemory(r, tags.get(r.id) ?? [])),
      total,
    };
  }

  async applyMutation(
    db: DbExecutor,
    id: string,
    expectedVersion: number,
    newVersion: number,
    input: MemoryMutationInput,
  ): Promise<Memory> {
    const result = await db.query<MemoryRow>(
      `UPDATE memories
       SET content = $1, type = $2, scope = $3, project_id = $4, status = $5,
           importance = $6, confidence = $7, source_id = $8, current_version = $9,
           archived_at = $10, updated_at = NOW()
       WHERE id = $11 AND current_version = $12
       RETURNING *`,
      [
        input.content,
        input.type,
        input.scope,
        input.projectId,
        input.status,
        input.importance,
        input.confidence,
        input.sourceId,
        newVersion,
        input.archivedAt,
        id,
        expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      const exists = await db.query<{ current_version: number }>(
        `SELECT current_version FROM memories WHERE id = $1`,
        [id],
      );
      if (!exists.rows[0]) {
        throw new ConflictError("Memory not found for update");
      }
      throw new ConflictError("Version conflict", {
        expectedVersion,
        currentVersion: exists.rows[0].current_version,
      });
    }
    return mapMemory(row, []);
  }

  async listVersions(db: DbExecutor, memoryId: string): Promise<MemoryVersion[]> {
    const result = await db.query<VersionRow>(
      `SELECT * FROM memory_versions WHERE memory_id = $1 ORDER BY version ASC`,
      [memoryId],
    );
    return result.rows.map(mapVersion);
  }
}
