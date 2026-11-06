import type { DbExecutor } from "../tx.js";
import type { Memory, MemoryStatus, MemoryType } from "../../core/index.js";
import { TagRepository } from "./tag-repository.js";
import { mapMemory, type MemoryRow } from "./memory-repository.js";
import { toPgVector } from "./embedding-repository.js";
import { scopeVisibilitySql } from "./visibility-sql.js";

export interface SearchFilter {
  actorAgentId: string;
  accessibleProjectIds: string[];
  statuses: MemoryStatus[];
  projectIds?: string[];
  types?: MemoryType[];
  tagNames?: string[];
  limit: number;
}

export interface SearchHit {
  memoryId: string;
  score: number;
}

interface HitRow {
  memory_id: string;
  score: number | string;
}

// Both search legs and the final ranked fetch share this builder so access
// rules are enforced inside SQL and can never be overridden by relevance
// (SPEC §9.2, §21.4).
function buildFilterSql(filter: SearchFilter, params: unknown[]): string[] {
  const add = (value: unknown): string => `$${params.push(value)}`;

  const actorP = add(filter.actorAgentId);
  const projectsP = add(filter.accessibleProjectIds);
  const statusesP = add(filter.statuses);

  const clauses: string[] = [
    "m.status <> 'deleted'",
    `m.status = ANY(${statusesP}::text[])`,
    scopeVisibilitySql("m.scope", "m.project_id", "m.created_by_agent", actorP, projectsP),
  ];

  if (filter.projectIds?.length) {
    clauses.push(`m.project_id = ANY(${add(filter.projectIds)}::uuid[])`);
  }
  if (filter.types?.length) {
    clauses.push(`m.type = ANY(${add(filter.types)}::text[])`);
  }
  if (filter.tagNames?.length) {
    const tagsP = add(filter.tagNames.map((t) => t.toLowerCase()));
    clauses.push(`EXISTS (
      SELECT 1 FROM memory_tags mt
      JOIN tags t ON t.id = mt.tag_id
      WHERE mt.memory_id = m.id AND LOWER(t.name) = ANY(${tagsP}::text[])
    )`);
  }
  return clauses;
}

export class SearchRepository {
  constructor(private readonly tagsRepo = new TagRepository()) {}

  async semanticSearch(
    db: DbExecutor,
    queryVector: number[],
    filter: SearchFilter,
  ): Promise<SearchHit[]> {
    const params: unknown[] = [toPgVector(queryVector)];
    const clauses = buildFilterSql(filter, params);
    clauses.unshift("lat.embedding IS NOT NULL");
    const limitP = `$${params.push(filter.limit)}`;

    // LATERAL takes each memory's newest embedding: status transitions bump
    // current_version without re-embedding, so an equality join on
    // current_version would silently drop archived memories from results.
    const result = await db.query<HitRow>(
      `SELECT m.id AS memory_id, ($1::vector <=> lat.embedding) AS score
       FROM memories m
       JOIN LATERAL (
         SELECT e.embedding
         FROM memory_embeddings e
         WHERE e.memory_id = m.id AND e.status = 'active'
         ORDER BY e.memory_version DESC
         LIMIT 1
       ) lat ON true
       WHERE ${clauses.join(" AND ")}
       ORDER BY lat.embedding <=> $1::vector ASC
       LIMIT ${limitP}`,
      params,
    );
    // score = cosine distance (0 identical … 2 opposite); invert to a
    // similarity so both legs are "higher is better".
    return result.rows.map((r) => ({
      memoryId: r.memory_id,
      score: 1 - Number(r.score),
    }));
  }

  async keywordSearch(
    db: DbExecutor,
    queryText: string,
    filter: SearchFilter,
  ): Promise<SearchHit[]> {
    const params: unknown[] = [queryText];
    const clauses = buildFilterSql(filter, params);
    clauses.unshift(`m.search_vector @@ websearch_to_tsquery('english', $1)`);
    const limitP = `$${params.push(filter.limit)}`;

    // websearch_to_tsquery never raises on arbitrary user input, unlike
    // to_tsquery; the generated search_vector column is indexed by GIN.
    const result = await db.query<HitRow>(
      `SELECT m.id AS memory_id, ts_rank(m.search_vector, websearch_to_tsquery('english', $1)) AS score
       FROM memories m
       WHERE ${clauses.join(" AND ")}
       ORDER BY score DESC, m.updated_at DESC
       LIMIT ${limitP}`,
      params,
    );
    return result.rows.map((r) => ({ memoryId: r.memory_id, score: Number(r.score) }));
  }

  async fetchRanked(
    db: DbExecutor,
    orderedIds: string[],
    filter: SearchFilter,
  ): Promise<Memory[]> {
    if (orderedIds.length === 0) return [];
    const params: unknown[] = [orderedIds];
    const clauses = buildFilterSql(filter, params);

    // Re-checks visibility for the fused set; rows the filter drops simply
    // disappear and the engine compacts ranks afterwards.
    const result = await db.query<MemoryRow & { ord: number }>(
      `SELECT m.*, r.ord
       FROM UNNEST($1::uuid[]) WITH ORDINALITY AS r(id, ord)
       JOIN memories m ON m.id = r.id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.ord ASC`,
      params,
    );
    const ids = result.rows.map((row) => row.id);
    const tags = await this.tagsRepo.getTagsForMemories(db, ids);
    return result.rows.map((row) => mapMemory(row, tags.get(row.id) ?? []));
  }
}
