import type pg from "pg";
import { getPool } from "../db/index.js";
import { withTransaction } from "../db/tx.js";
import {
  AgentProjectAccessRepository,
  AgentRepository,
  EmbeddingRepository,
  MemoryRepository,
  ProposalRepository,
  ProjectRepository,
  type DbExecutor,
  type MemoryMutationInput,
} from "../db/repositories/index.js";
import type { EmbeddingProvider } from "../providers/embedding-provider.js";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  parseOrThrow,
  listProposalsSchema,
  proposalIdSchema,
  type Actor,
  type ApprovalResult,
  type Memory,
  type Proposal,
  type ProposalListFilterInput,
  type ProposalListResult,
} from "../core/index.js";
import { AccessManager, type AccessContext } from "./access-manager.js";
import { embedQuietly } from "./embed-write.js";

// Mirrors the PROPOSAL_TTL configuration default; M5 wiring passes
// config.limits.proposalTtl explicitly.
const DEFAULT_TTL_SECONDS = 604800;

export interface ProposalManagerDeps {
  pool?: pg.Pool;
  agents?: AgentRepository;
  projects?: ProjectRepository;
  access?: AgentProjectAccessRepository;
  memories?: MemoryRepository;
  proposals?: ProposalRepository;
  accessManager?: AccessManager;
  embeddingRepo?: EmbeddingRepository;
  embeddingProvider?: EmbeddingProvider | null;
  proposalTtlSeconds?: number;
}

export class ProposalManager {
  private readonly pool?: pg.Pool;
  private readonly agents: AgentRepository;
  private readonly projects: ProjectRepository;
  private readonly accessRepo: AgentProjectAccessRepository;
  private readonly memories: MemoryRepository;
  private readonly proposals: ProposalRepository;
  private readonly accessManager: AccessManager;
  private readonly embedDeps: {
    embeddingRepo: EmbeddingRepository;
    embeddingProvider: EmbeddingProvider | null;
  };
  private readonly ttlSeconds: number;

  constructor(deps: ProposalManagerDeps = {}) {
    this.pool = deps.pool;
    this.agents = deps.agents ?? new AgentRepository();
    this.projects = deps.projects ?? new ProjectRepository();
    this.accessRepo = deps.access ?? new AgentProjectAccessRepository();
    this.memories = deps.memories ?? new MemoryRepository();
    this.proposals = deps.proposals ?? new ProposalRepository();
    this.accessManager = deps.accessManager ?? new AccessManager();
    this.embedDeps = {
      embeddingRepo: deps.embeddingRepo ?? new EmbeddingRepository(),
      embeddingProvider: deps.embeddingProvider ?? null,
    };
    this.ttlSeconds = deps.proposalTtlSeconds ?? DEFAULT_TTL_SECONDS;
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

  private visibilityArgs(ctx: AccessContext): {
    actorAgentId: string;
    accessibleProjectIds: string[];
  } {
    return {
      actorAgentId: ctx.actor.agentId,
      accessibleProjectIds: Array.from(ctx.accessibleProjectIds),
    };
  }

  async getProposal(actor: Actor, id: string): Promise<Proposal> {
    const proposalId = parseOrThrow(proposalIdSchema, id);
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      if (!ctx.actorActive) throw new PermissionError("Access denied");
      await this.proposals.expireIfStale(db, proposalId, this.ttlSeconds);
      const proposal = await this.proposals.getVisible(db, proposalId, this.visibilityArgs(ctx));
      if (!proposal) throw new NotFoundError("Proposal not found");
      this.accessManager.assertCanSeeProposal(ctx, proposal);
      return proposal;
    });
  }

  // Listing writes: the bulk expiry flip commits in its own transaction so
  // expired rows are recorded even if nobody ever reviews them. It can
  // briefly block on a concurrent approve's row lock; the re-checked WHERE
  // under READ COMMITTED skips rows that were just decided.
  async listProposals(actor: Actor, raw: ProposalListFilterInput = {}): Promise<ProposalListResult> {
    const filter = parseOrThrow(listProposalsSchema, raw);
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      if (!ctx.actorActive) throw new PermissionError("Access denied");
      await this.proposals.expirePending(db, this.ttlSeconds);
      const { rows, total } = await this.proposals.list(db, {
        ...this.visibilityArgs(ctx),
        statuses: filter.statuses,
        actions: filter.actions,
        projectId: filter.projectId,
        limit: filter.limit,
        offset: filter.offset,
      });
      return { items: rows, total, limit: filter.limit, offset: filter.offset };
    });
  }

  async reject(actor: Actor, id: string): Promise<Proposal> {
    const proposalId = parseOrThrow(proposalIdSchema, id);
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      // Lock-first: the FOR UPDATE re-fetch makes double-decide impossible.
      const locked = await this.proposals.getForUpdate(db, proposalId, this.ttlSeconds);
      if (!locked) throw new NotFoundError("Proposal not found");
      this.accessManager.assertCanSeeProposal(ctx, locked.proposal);
      if (locked.proposal.status !== "pending") {
        throw new ConflictError("Proposal already decided", { status: locked.proposal.status });
      }
      // Rejecting is withdrawal, not review: no canReview gate, so the
      // submitter can always withdraw their own pending proposal.
      return this.proposals.markDecision(db, proposalId, {
        status: "rejected",
        reviewerAgentId: actor.agentId,
      });
    });
  }

  async approve(actor: Actor, id: string): Promise<ApprovalResult> {
    const proposalId = parseOrThrow(proposalIdSchema, id);
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      // 1. Lock first — see ProposalRepository.getForUpdate.
      const locked = await this.proposals.getForUpdate(db, proposalId, this.ttlSeconds);
      if (!locked) throw new NotFoundError("Proposal not found");
      const proposal = locked.proposal;
      this.accessManager.assertCanSeeProposal(ctx, proposal);
      // 2. Past-TTL: refuse without writing. The flip to 'expired' is
      // recorded by getProposal/listProposals; writing here would roll
      // back with this error and record nothing anyway.
      if (locked.stale) {
        throw new ConflictError("Proposal expired; submit a fresh one", { proposalId });
      }
      if (proposal.status !== "pending") {
        throw new ConflictError("Proposal already decided", { status: proposal.status });
      }
      // 3. Review policy incl. the private-scope self-approval exception.
      this.accessManager.assertCanReview(ctx, proposal);

      const memory = await this.applyApproved(db, ctx, proposal);
      const decided = await this.proposals.markDecision(db, proposalId, {
        status: "approved",
        reviewerAgentId: actor.agentId,
        resultingMemoryId: memory.id,
      });
      return { proposal: decided, memory };
    });
  }

  // Lock order is always memory_proposals → memories, and MemoryManager
  // paths lock only memories, so no cycle exists. Stale targets fail on
  // applyMutation's version predicate, which aborts the whole transaction
  // before any proposal or memory state changes.
  private async applyApproved(
    db: DbExecutor,
    ctx: AccessContext,
    proposal: Proposal,
  ): Promise<Memory> {
    switch (proposal.action) {
      case "create": {
        this.accessManager.assertCanCreate(ctx, proposal.proposedScope, proposal.proposedProjectId);
        await this.assertProjectExists(db, proposal.proposedScope, proposal.proposedProjectId);
        return this.applyCreate(db, proposal);
      }
      case "update": {
        const target = await this.requireTarget(db, proposal);
        this.accessManager.assertCanWrite(ctx, target);
        this.accessManager.assertCanCreate(ctx, proposal.proposedScope, proposal.proposedProjectId);
        await this.assertProjectExists(db, proposal.proposedScope, proposal.proposedProjectId);
        if (target.status !== "active") {
          throw new ConflictError("Proposal target is no longer active", {
            targetStatus: target.status,
          });
        }
        return this.applyUpdate(db, proposal, target);
      }
      case "archive": {
        const target = await this.requireTarget(db, proposal);
        this.accessManager.assertCanWrite(ctx, target);
        if (target.status !== "active") {
          throw new ConflictError("Proposal target is no longer active", {
            targetStatus: target.status,
          });
        }
        return this.applyStatus(db, proposal, target, "archived");
      }
      case "supersede": {
        const target = await this.requireTarget(db, proposal);
        this.accessManager.assertCanWrite(ctx, target);
        this.accessManager.assertCanCreate(ctx, proposal.proposedScope, proposal.proposedProjectId);
        await this.assertProjectExists(db, proposal.proposedScope, proposal.proposedProjectId);
        if (target.status !== "active") {
          throw new ConflictError("Proposal target is no longer active", {
            targetStatus: target.status,
          });
        }
        // Flip the target first: a stale target short-circuits before the
        // replacement row exists.
        await this.applyStatus(db, proposal, target, "superseded");
        return this.applyCreate(db, proposal);
      }
    }
  }

  private async requireTarget(db: DbExecutor, proposal: Proposal): Promise<Memory> {
    if (!proposal.targetMemoryId || proposal.targetVersion === null) {
      throw new ConflictError("Proposal is missing its target reference");
    }
    const target = await this.memories.getById(db, proposal.targetMemoryId);
    if (!target) throw new NotFoundError("Memory not found");
    return target;
  }

  private async assertProjectExists(
    db: DbExecutor,
    scope: Proposal["proposedScope"],
    projectId: string | null,
  ): Promise<void> {
    if (scope !== "project" || !projectId) return;
    const project = await this.projects.getById(db, projectId);
    if (!project) throw new NotFoundError("Project not found");
  }

  // Provenance: the approved memory reuses the submission's source row and
  // keeps the submitter as author; the reviewer is recorded on the proposal
  // (§7.5). created_by_agent never transfers through an update.
  private async applyCreate(db: DbExecutor, proposal: Proposal): Promise<Memory> {
    const mutation: MemoryMutationInput = {
      content: proposal.proposedContent,
      type: proposal.proposedType,
      scope: proposal.proposedScope,
      projectId: proposal.proposedProjectId,
      status: "active",
      importance: proposal.proposedImportance ?? 5,
      confidence: proposal.proposedConfidence ?? 0.5,
      sourceId: proposal.sourceId,
      archivedAt: null,
    };
    const memory = await this.memories.create(db, {
      ...mutation,
      createdByAgent: proposal.submittedByAgent,
      currentVersion: 1,
    });
    await this.memories.insertVersion(db, memory.id, 1, mutation);
    await embedQuietly(this.embedDeps, db, memory.id, 1, mutation.content);
    return memory;
  }

  private async applyUpdate(db: DbExecutor, proposal: Proposal, target: Memory): Promise<Memory> {
    if (proposal.targetVersion === null) {
      throw new ConflictError("Proposal is missing its target version");
    }
    const newVersion = proposal.targetVersion + 1;
    const mutation: MemoryMutationInput = {
      content: proposal.proposedContent,
      type: proposal.proposedType,
      scope: proposal.proposedScope,
      projectId: proposal.proposedProjectId,
      status: target.status,
      importance: proposal.proposedImportance ?? target.importance,
      confidence: proposal.proposedConfidence ?? target.confidence,
      sourceId: proposal.sourceId,
      archivedAt: target.archivedAt,
    };
    await this.memories.applyMutation(db, target.id, proposal.targetVersion, newVersion, mutation);
    await this.memories.insertVersion(db, target.id, newVersion, mutation);
    await embedQuietly(this.embedDeps, db, target.id, newVersion, mutation.content);
    return (await this.memories.getById(db, target.id)) ?? target;
  }

  // proposed_* columns on archive/supersede proposals are a reviewer-facing
  // snapshot of the target and deliberately ignored here; freshness is
  // guarded by target_version alone (every status change bumps it; tag
  // replacement does not, but approvals never touch tags).
  private async applyStatus(
    db: DbExecutor,
    proposal: Proposal,
    target: Memory,
    status: "archived" | "superseded",
  ): Promise<Memory> {
    if (proposal.targetVersion === null) {
      throw new ConflictError("Proposal is missing its target version");
    }
    const newVersion = proposal.targetVersion + 1;
    const mutation: MemoryMutationInput = {
      content: target.content,
      type: target.type,
      scope: target.scope,
      projectId: target.projectId,
      status,
      importance: target.importance,
      confidence: target.confidence,
      sourceId: proposal.sourceId,
      archivedAt: status === "archived" ? new Date() : target.archivedAt,
    };
    await this.memories.applyMutation(db, target.id, proposal.targetVersion, newVersion, mutation);
    await this.memories.insertVersion(db, target.id, newVersion, mutation);
    return (await this.memories.getById(db, target.id)) ?? target;
  }
}
