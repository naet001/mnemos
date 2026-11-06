import type pg from "pg";
import { getPool } from "../db/index.js";
import { withTransaction } from "../db/tx.js";
import {
  AgentProjectAccessRepository,
  AgentRepository,
  EmbeddingRepository,
  MemoryRepository,
  ProjectRepository,
  SourceRepository,
  TagRepository,
  type DbExecutor,
} from "../db/repositories/index.js";
import type { EmbeddingProvider } from "../providers/embedding-provider.js";
import {
  NotFoundError,
  PermissionError,
  ValidationError,
  createMemorySchema,
  listMemoriesSchema,
  memoryIdSchema,
  normalizeTags,
  parseOrThrow,
  updateMemorySchema,
  type Actor,
  type CreateMemoryInput,
  type ListMemoriesFilter,
  type Memory,
  type MemoryListResult,
  type MemoryVersion,
  type UpdateMemoryInput,
} from "../core/index.js";
import { AccessManager, type AccessContext } from "./access-manager.js";
import { embedQuietly } from "./embed-write.js";

export interface MemoryManagerDeps {
  pool?: pg.Pool;
  agents?: AgentRepository;
  projects?: ProjectRepository;
  access?: AgentProjectAccessRepository;
  sources?: SourceRepository;
  tags?: TagRepository;
  memories?: MemoryRepository;
  accessManager?: AccessManager;
  embeddingRepo?: EmbeddingRepository;
  embeddingProvider?: EmbeddingProvider | null;
}

export class MemoryManager {
  private readonly pool?: pg.Pool;
  private readonly agents: AgentRepository;
  private readonly projects: ProjectRepository;
  private readonly accessRepo: AgentProjectAccessRepository;
  private readonly sources: SourceRepository;
  private readonly tags: TagRepository;
  private readonly memories: MemoryRepository;
  private readonly accessManager: AccessManager;
  private readonly embeddingRepo: EmbeddingRepository;
  private readonly embeddingProvider: EmbeddingProvider | null;

  constructor(deps: MemoryManagerDeps = {}) {
    this.pool = deps.pool;
    this.agents = deps.agents ?? new AgentRepository();
    this.projects = deps.projects ?? new ProjectRepository();
    this.accessRepo = deps.access ?? new AgentProjectAccessRepository();
    this.sources = deps.sources ?? new SourceRepository();
    this.tags = deps.tags ?? new TagRepository();
    this.memories = deps.memories ?? new MemoryRepository(this.tags);
    this.accessManager = deps.accessManager ?? new AccessManager();
    this.embeddingRepo = deps.embeddingRepo ?? new EmbeddingRepository();
    this.embeddingProvider = deps.embeddingProvider ?? null;
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

  async createMemory(actor: Actor, rawInput: CreateMemoryInput): Promise<Memory> {
    const input = parseOrThrow(createMemorySchema, rawInput);
    const tags = normalizeTags(input.tags);
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      this.accessManager.assertCanCreate(ctx, input.scope, input.projectId);
      if (input.scope === "project" && input.projectId) {
        const project = await this.projects.getById(db, input.projectId);
        if (!project) throw new NotFoundError("Project not found");
      }

      const source = await this.sources.create(db, {
        agentId: actor.agentId,
        sourceKind: input.sourceKind,
        externalRef: input.externalRef ?? null,
      });

      const memory = await this.memories.create(db, {
        content: input.content,
        type: input.type,
        scope: input.scope,
        projectId: input.projectId ?? null,
        status: "active",
        importance: input.importance,
        confidence: input.confidence,
        sourceId: source.id,
        createdByAgent: actor.agentId,
        currentVersion: 1,
        archivedAt: null,
      });

      await this.memories.insertVersion(db, memory.id, 1, {
        content: memory.content,
        type: memory.type,
        scope: memory.scope,
        projectId: memory.projectId,
        status: "active",
        importance: memory.importance,
        confidence: memory.confidence,
        sourceId: source.id,
        archivedAt: null,
      });

      await this.tags.replaceMemoryTags(db, memory.id, tags);
      await embedQuietly(
        { embeddingRepo: this.embeddingRepo, embeddingProvider: this.embeddingProvider },
        db, memory.id, 1, memory.content,
      );
      const created = await this.memories.getById(db, memory.id);
      if (!created) throw new NotFoundError("Memory not found");
      return created;
    });
  }

  async getMemory(actor: Actor, id: string): Promise<Memory> {
    const memoryId = parseOrThrow(memoryIdSchema, id);
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      const memory = await this.memories.getById(db, memoryId);
      if (!memory) throw new NotFoundError("Memory not found");
      this.accessManager.assertCanRead(ctx, memory);
      return memory;
    });
  }

  async listMemories(actor: Actor, rawFilter: ListMemoriesFilter = {}): Promise<MemoryListResult> {
    const filter = parseOrThrow(listMemoriesSchema, rawFilter);
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      if (!ctx.actorActive) throw new PermissionError("Access denied");

      const { rows, total } = await this.memories.list(db, {
        actorAgentId: actor.agentId,
        accessibleProjectIds: Array.from(ctx.accessibleProjectIds),
        statuses: filter.statuses ?? ["active"],
        scope: filter.scope,
        projectId: filter.projectId,
        types: filter.types,
        tagNames: filter.tags ? normalizeTags(filter.tags) : undefined,
        limit: filter.limit,
        offset: filter.offset,
      });
      return { items: rows, total, limit: filter.limit, offset: filter.offset };
    });
  }

  async updateMemory(
    actor: Actor,
    id: string,
    rawInput: UpdateMemoryInput,
    expectedVersion: number,
  ): Promise<Memory> {
    const memoryId = parseOrThrow(memoryIdSchema, id);
    const input = parseOrThrow(updateMemorySchema, rawInput);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new ValidationError("expectedVersion must be a positive integer");
    }
    const tags = input.tags ? normalizeTags(input.tags) : undefined;
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      const current = await this.memories.getById(db, memoryId);
      if (!current) throw new NotFoundError("Memory not found");
      this.accessManager.assertCanWrite(ctx, current);

      const nextScope = input.scope ?? current.scope;
      const nextProjectId =
        input.projectId !== undefined ? input.projectId : current.projectId;
      if (nextScope === "project" && !nextProjectId) {
        throw new ValidationError("projectId is required when scope is project");
      }
      if (nextScope === "global" && nextProjectId) {
        throw new ValidationError("projectId must not be set when scope is global");
      }
      this.accessManager.assertCanCreate(ctx, nextScope, nextProjectId);
      if (nextScope === "project" && nextProjectId) {
        const project = await this.projects.getById(db, nextProjectId);
        if (!project) throw new NotFoundError("Project not found");
      }

      const source = await this.sources.create(db, {
        agentId: actor.agentId,
        sourceKind: input.sourceKind ?? "agent_submission",
        externalRef: input.externalRef ?? null,
      });

      const mutation = {
        content: input.content ?? current.content,
        type: input.type ?? current.type,
        scope: nextScope,
        projectId: nextProjectId ?? null,
        status: current.status,
        importance: input.importance ?? current.importance,
        confidence: input.confidence ?? current.confidence,
        sourceId: source.id,
        archivedAt: current.archivedAt,
      };
      const newVersion = expectedVersion + 1;
      await this.memories.applyMutation(db, memoryId, expectedVersion, newVersion, mutation);
      await this.memories.insertVersion(db, memoryId, newVersion, mutation);
      if (tags !== undefined) {
        await this.tags.replaceMemoryTags(db, memoryId, tags);
      }
      await embedQuietly(
        { embeddingRepo: this.embeddingRepo, embeddingProvider: this.embeddingProvider },
        db, memoryId, newVersion, mutation.content,
      );
      const updated = await this.memories.getById(db, memoryId);
      if (!updated) throw new NotFoundError("Memory not found");
      return updated;
    });
  }

  async archiveMemory(actor: Actor, id: string, expectedVersion?: number): Promise<Memory> {
    return this.transitionStatus(actor, id, "archived", expectedVersion);
  }

  async softDeleteMemory(actor: Actor, id: string, expectedVersion?: number): Promise<Memory> {
    return this.transitionStatus(actor, id, "deleted", expectedVersion);
  }

  private async transitionStatus(
    actor: Actor,
    id: string,
    status: "archived" | "deleted",
    expectedVersion?: number,
  ): Promise<Memory> {
    const memoryId = parseOrThrow(memoryIdSchema, id);
    if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
      throw new ValidationError("expectedVersion must be a positive integer");
    }
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      const current = await this.memories.getById(db, memoryId);
      if (!current) throw new NotFoundError("Memory not found");
      this.accessManager.assertCanWrite(ctx, current);
      const effectiveExpected = expectedVersion ?? current.currentVersion;

      const source = await this.sources.create(db, {
        agentId: actor.agentId,
        sourceKind: "system_operation",
        externalRef: null,
      });
      const archivedAt = status === "archived" ? new Date() : current.archivedAt;
      const mutation = {
        content: current.content,
        type: current.type,
        scope: current.scope,
        projectId: current.projectId,
        status,
        importance: current.importance,
        confidence: current.confidence,
        sourceId: source.id,
        archivedAt,
      };
      const newVersion = effectiveExpected + 1;
      await this.memories.applyMutation(db, memoryId, effectiveExpected, newVersion, mutation);
      await this.memories.insertVersion(db, memoryId, newVersion, mutation);
      const updated = await this.memories.getById(db, memoryId);
      if (!updated) throw new NotFoundError("Memory not found");
      return updated;
    });
  }

  async getMemoryHistory(actor: Actor, id: string): Promise<MemoryVersion[]> {
    const memoryId = parseOrThrow(memoryIdSchema, id);
    return this.tx(async (db) => {
      const ctx = await this.getAccessContext(db, actor);
      const memory = await this.memories.getById(db, memoryId);
      if (!memory) throw new NotFoundError("Memory not found");
      this.accessManager.assertCanRead(ctx, memory);
      return this.memories.listVersions(db, memoryId);
    });
  }
}
