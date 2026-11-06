import type pg from "pg";
import { getPool } from "../db/index.js";
import { withTransaction } from "../db/tx.js";
import {
  AgentProjectAccessRepository,
  AgentRepository,
  SearchRepository,
  type SearchFilter,
} from "../db/repositories/index.js";
import {
  NotFoundError,
  PermissionError,
  normalizeTags,
  parseOrThrow,
  searchMemorySchema,
  type Actor,
  type SearchInput,
  type SearchResult,
} from "../core/index.js";
import { isZeroVector, type EmbeddingProvider } from "../providers/embedding-provider.js";
import { logger } from "../logger/index.js";
import { rrfFuse } from "./hybrid-ranking.js";

export interface RetrievalEngineDeps {
  pool?: pg.Pool;
  agents?: AgentRepository;
  access?: AgentProjectAccessRepository;
  searchRepo?: SearchRepository;
  provider?: EmbeddingProvider | null;
}

export class RetrievalEngine {
  private readonly pool?: pg.Pool;
  private readonly agents: AgentRepository;
  private readonly accessRepo: AgentProjectAccessRepository;
  private readonly searchRepo: SearchRepository;
  private readonly provider: EmbeddingProvider | null;

  constructor(deps: RetrievalEngineDeps = {}) {
    this.pool = deps.pool;
    this.agents = deps.agents ?? new AgentRepository();
    this.accessRepo = deps.access ?? new AgentProjectAccessRepository();
    this.searchRepo = deps.searchRepo ?? new SearchRepository();
    this.provider = deps.provider ?? null;
  }

  private db(): pg.Pool {
    return this.pool ?? getPool();
  }

  async search(actor: Actor, raw: SearchInput): Promise<SearchResult> {
    const input = parseOrThrow(searchMemorySchema, raw);
    const p = this.db();
    return withTransaction(async (db) => {
      const agent = await this.agents.getById(db, actor.agentId);
      if (!agent) throw new NotFoundError("Agent not found");
      if (agent.status !== "active") throw new PermissionError("Access denied");

      const projectIds = await this.accessRepo.listProjectIdsForAgent(db, actor.agentId);
      // Each leg over-fetches; the fused set is trimmed to `limit` later.
      const filter: SearchFilter = {
        actorAgentId: actor.agentId,
        accessibleProjectIds: projectIds,
        statuses: input.statuses ?? ["active"],
        projectIds: input.projectIds,
        types: input.types,
        tagNames: input.tags ? normalizeTags(input.tags) : undefined,
        limit: Math.min(input.limit * 3, 100),
      };

      const legs: Array<Array<{ id: string }>> = [];
      const counts = { semantic: 0, keyword: 0 };

      if (this.provider) {
        try {
          const queryVector = await this.provider.embed(input.query);
          if (!isZeroVector(queryVector)) {
            const hits = await this.searchRepo.semanticSearch(db, queryVector, filter);
            counts.semantic = hits.length;
            legs.push(hits.map((h) => ({ id: h.memoryId })));
          }
        } catch (err) {
          // Query embedding failure degrades to keyword-only, never fails
          // the whole search (SPEC §15).
          logger.warn("Query embedding failed; falling back to keyword search", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const keywordHits = await this.searchRepo.keywordSearch(db, input.query, filter);
      counts.keyword = keywordHits.length;
      legs.push(keywordHits.map((h) => ({ id: h.memoryId })));

      const fused = rrfFuse(legs).slice(0, input.limit);
      const scoreById = new Map(fused.map((f) => [f.id, f.score]));
      const memories = await this.searchRepo.fetchRanked(
        db,
        fused.map((f) => f.id),
        filter,
      );

      const items = memories.map((memory, i) => ({
        memory,
        rank: i + 1,
        score: scoreById.get(memory.id) ?? 0,
      }));
      return { items, legs: counts, fused: fused.length };
    }, p);
  }
}
