import {
  NotFoundError,
  PermissionError,
  type Actor,
  type Memory,
  type Scope,
} from "../core/index.js";

export interface AccessContext {
  actor: Actor;
  actorActive: boolean;
  accessibleProjectIds: Set<string>;
}

export class AccessManager {
  canRead(ctx: AccessContext, memory: Pick<Memory, "scope" | "projectId" | "createdByAgent" | "status">): boolean {
    if (memory.status === "deleted") return false;
    if (!ctx.actorActive) return false;
    return this.canAccessScope(ctx, memory.scope, memory.projectId, memory.createdByAgent);
  }

  canWrite(ctx: AccessContext, memory: Pick<Memory, "scope" | "projectId" | "createdByAgent" | "status">): boolean {
    if (memory.status === "deleted") return false;
    if (!ctx.actorActive) return false;
    return this.canAccessScope(ctx, memory.scope, memory.projectId, memory.createdByAgent);
  }

  canCreate(ctx: AccessContext, scope: Scope, projectId: string | null | undefined): boolean {
    if (!ctx.actorActive) return false;
    return this.canAccessScope(ctx, scope, projectId ?? null, ctx.actor.agentId);
  }

  assertCanRead(ctx: AccessContext, memory: Pick<Memory, "scope" | "projectId" | "createdByAgent" | "status">): void {
    if (!this.canRead(ctx, memory)) {
      throw new NotFoundError("Memory not found");
    }
  }

  assertCanWrite(ctx: AccessContext, memory: Pick<Memory, "scope" | "projectId" | "createdByAgent" | "status">): void {
    if (!this.canRead(ctx, memory)) {
      throw new NotFoundError("Memory not found");
    }
  }

  assertCanCreate(ctx: AccessContext, scope: Scope, projectId: string | null | undefined): void {
    if (!ctx.actorActive) {
      throw new PermissionError("Access denied");
    }
    if (!this.canCreate(ctx, scope, projectId)) {
      if (scope === "project") {
        throw new PermissionError("Access denied");
      }
      throw new PermissionError("Access denied");
    }
  }

  private canAccessScope(
    ctx: AccessContext,
    scope: Scope,
    projectId: string | null,
    createdByAgent: string,
  ): boolean {
    switch (scope) {
      case "global":
        return true;
      case "project":
        return projectId !== null && ctx.accessibleProjectIds.has(projectId);
      case "private":
        return createdByAgent === ctx.actor.agentId;
      default:
        return false;
    }
  }
}
