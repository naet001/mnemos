import type pg from "pg";
import { getPool } from "../db/index.js";
import { withTransaction } from "../db/tx.js";
import {
  AgentProjectAccessRepository,
  AgentRepository,
  MemoryRepository,
  ProposalRepository,
  ProjectRepository,
  SourceRepository,
  type CreateProposalInput,
  type DbExecutor,
} from "../db/repositories/index.js";
import type { ExtractionProvider, ExtractionHints } from "../providers/extraction-provider.js";
import { logger } from "../logger/index.js";
import {
  AppError,
  NotFoundError,
  ValidationError,
  parseOrThrow,
  rememberSchema,
  candidateBatchSchema,
  type Actor,
  type Memory,
  type MemoryCandidate,
  type Proposal,
  type RememberInput,
  type RememberResult,
} from "../core/index.js";
import { AccessManager, type AccessContext } from "./access-manager.js";
import {
  CONFLICT_POOL_LIMIT,
  decideConflict,
  looksLikeSecret,
} from "./conflict-detection.js";

export interface MemoryAssistantDeps {
  pool?: pg.Pool;
  agents?: AgentRepository;
  projects?: ProjectRepository;
  access?: AgentProjectAccessRepository;
  sources?: SourceRepository;
  memories?: MemoryRepository;
  proposals?: ProposalRepository;
  accessManager?: AccessManager;
  extractionProvider?: ExtractionProvider | null;
}

export class MemoryAssistant {
  private readonly pool?: pg.Pool;
  private readonly agents: AgentRepository;
  private readonly projects: ProjectRepository;
  private readonly accessRepo: AgentProjectAccessRepository;
  private readonly sources: SourceRepository;
  private readonly memories: MemoryRepository;
  private readonly proposals: ProposalRepository;
  private readonly accessManager: AccessManager;
  private readonly extractionProvider: ExtractionProvider | null;

  constructor(deps: MemoryAssistantDeps = {}) {
    this.pool = deps.pool;
    this.agents = deps.agents ?? new AgentRepository();
    this.projects = deps.projects ?? new ProjectRepository();
    this.accessRepo = deps.access ?? new AgentProjectAccessRepository();
    this.sources = deps.sources ?? new SourceRepository();
    this.memories = deps.memories ?? new MemoryRepository();
    this.proposals = deps.proposals ?? new ProposalRepository();
    this.accessManager = deps.accessManager ?? new AccessManager();
    this.extractionProvider = deps.extractionProvider ?? null;
  }

  private db(): pg.Pool {
    return this.pool ?? getPool();
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(fn, this.db());
  }

  private async getAccessContext(db: DbExecutor, actor: Actor): Promise<AccessContext> {
    const agent = await this.agents.getById(db, actor.agentId);
    if (!agent) {
      throw new NotFoundError("Agent not found");
    }
    const projectIds = await this.accessRepo.listProjectIdsForAgent(db, actor.agentId);
    return {
      actor,
      actorActive: agent.status === "active",
      accessibleProjectIds: new Set(projectIds),
    };
  }

  // SPEC §6.3/§8: submissions become proposals, never silent canonical
  // memories. Extraction runs before the transaction (§14: a failed
  // extraction must not leave partial rows); everything from the source row
  // to the proposals commits or rolls back together.
  async remember(actor: Actor, raw: RememberInput): Promise<RememberResult> {
    const input = parseOrThrow(rememberSchema, raw);
    if (looksLikeSecret(input.content)) {
      throw new ValidationError("Submission rejected: content appears to contain credentials", {
        reason: "secret-like content",
      });
    }

    const hints: ExtractionHints = {
      scope: input.scope,
      projectId: input.projectId ?? null,
      type: input.type,
    };
    const { candidates, degraded } = await this.extractCandidates(input.content, hints);
    const prepared = this.prepareCandidates(candidates, hints);

    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      const pool = await this.buildConflictPool(db, ctx);

      const source = await this.sources.create(db, {
        agentId: actor.agentId,
        sourceKind: "agent_submission",
        externalRef: input.externalRef ?? null,
      });

      const created: Proposal[] = [];
      let skippedDuplicates = 0;
      for (const candidate of prepared) {
        this.accessManager.assertCanCreate(ctx, candidate.scope, candidate.projectId);
        if (candidate.scope === "project" && candidate.projectId) {
          const project = await this.projects.getById(db, candidate.projectId);
          if (!project) throw new NotFoundError("Project not found");
        }

        const decision = decideConflict(
          { content: candidate.content, type: candidate.type },
          pool.get(candidate.type) ?? [],
        );
        if (decision.duplicate) {
          skippedDuplicates += 1;
          continue;
        }

        const proposalInput: CreateProposalInput = {
          action: decision.action,
          proposedContent: candidate.content,
          proposedType: candidate.type,
          proposedScope: candidate.scope,
          proposedProjectId: candidate.projectId ?? null,
          targetMemoryId: decision.targetMemoryId ?? null,
          targetVersion: decision.targetVersion ?? null,
          rationale: decision.targetMemoryId
            ? `${candidate.rationale ?? "candidate"} (similar memory ${decision.targetMemoryId})`
            : candidate.rationale ?? null,
          proposedImportance: candidate.importance ?? null,
          proposedConfidence: candidate.confidence ?? null,
          sourceId: source.id,
          submittedByAgent: actor.agentId,
        };
        created.push(await this.proposals.create(db, proposalInput));
      }

      return {
        sourceId: source.id,
        proposals: created,
        extraction: {
          provider: this.extractionProvider?.model ?? null,
          degraded,
          candidates: prepared.length,
        },
        skippedDuplicates,
      };
    });
  }

  private async extractCandidates(
    text: string,
    hints: ExtractionHints,
  ): Promise<{ candidates: unknown[]; degraded: boolean }> {
    if (this.extractionProvider) {
      try {
        const candidates = await this.extractionProvider.extract({ text, hints });
        if (candidates.length > 0) {
          return { candidates, degraded: false };
        }
        logger.warn("Extraction produced no candidates; submitting raw content", {
          provider: this.extractionProvider.model,
        });
        return { candidates: [this.fallbackCandidate(text, hints)], degraded: true };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.warn("Extraction provider failed; submitting raw content", {
          provider: this.extractionProvider.model,
          error: err instanceof Error ? err.message : String(err),
        });
        return { candidates: [this.fallbackCandidate(text, hints)], degraded: true };
      }
    }
    // No provider configured: the raw submission itself becomes one
    // proposal. Still only ever a proposal, so §14 holds.
    return { candidates: [this.fallbackCandidate(text, hints)], degraded: true };
  }

  // Unclassified raw text: semantic is the only honest default type (§7.1).
  private fallbackCandidate(content: string, hints: ExtractionHints): MemoryCandidate {
    return {
      content,
      type: hints.type ?? "semantic",
      scope: hints.scope ?? "global",
      projectId: hints.scope === "project" ? hints.projectId ?? null : null,
      rationale: "raw submission; extraction unavailable",
    };
  }

  // Hints override provider output (a provider must never steer scope),
  // then the batch is schema-validated as a whole: one malformed candidate
  // means contract-broken output and zero rows, never a silently dropped
  // candidate that hides a vendor regression (§13.10).
  private prepareCandidates(raw: unknown[], hints: ExtractionHints): MemoryCandidate[] {
    const overridden = raw.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const candidate = { ...(item as Record<string, unknown>) };
      if (hints.scope) {
        candidate.scope = hints.scope;
        candidate.projectId = hints.scope === "project" ? hints.projectId ?? null : null;
      } else if (candidate.scope === "project") {
        // Project UUIDs only ever come from hints, never from a provider.
        candidate.projectId = hints.projectId ?? null;
      }
      if (hints.type) candidate.type = hints.type;
      return candidate;
    });

    const validated = parseOrThrow(candidateBatchSchema, overridden);
    const seen = new Set<string>();
    const out: MemoryCandidate[] = [];
    for (const candidate of validated) {
      const key = candidate.content.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...candidate, projectId: candidate.projectId ?? null });
    }
    return out;
  }

  // One bounded read per submission (not per candidate); conflict matching
  // is same-type only, so grouping in TS keeps decideConflict pure.
  private async buildConflictPool(
    db: DbExecutor,
    ctx: AccessContext,
  ): Promise<Map<string, Memory[]>> {
    const { rows } = await this.memories.list(db, {
      actorAgentId: ctx.actor.agentId,
      accessibleProjectIds: Array.from(ctx.accessibleProjectIds),
      statuses: ["active"],
      limit: CONFLICT_POOL_LIMIT,
      offset: 0,
    });
    const byType = new Map<string, Memory[]>();
    for (const memory of rows) {
      const bucket = byType.get(memory.type);
      if (bucket) bucket.push(memory);
      else byType.set(memory.type, [memory]);
    }
    return byType;
  }
}
