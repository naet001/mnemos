import {
  NotFoundError,
  PermissionError,
  type Actor,
  type Memory,
  type Proposal,
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
    if (!this.canWrite(ctx, memory)) {
      throw new NotFoundError("Memory not found");
    }
  }

  assertCanCreate(ctx: AccessContext, scope: Scope, projectId: string | null | undefined): void {
    if (!ctx.actorActive) {
      throw new PermissionError("Access denied");
    }
    if (!this.canCreate(ctx, scope, projectId)) {
      throw new PermissionError("Access denied");
    }
  }

  // SPEC §13.7 grants approval to authorized reviewers, not submitters —
  // except for private scope, where the submitter is the only audience and
  // a no-self-approval rule would make every private proposal unreviewable
  // until it expired. §13.7's "unless explicitly granted that permission by
  // policy" is that grant. Applies to approve only: rejecting is withdrawal
  // and the submitter may always withdraw their own pending proposal.
  canReview(
    ctx: AccessContext,
    proposal: Pick<Proposal, "submittedByAgent" | "proposedScope" | "proposedProjectId">,
  ): boolean {
    if (!ctx.actorActive) return false;
    const self = proposal.submittedByAgent === ctx.actor.agentId;
    if (self && proposal.proposedScope !== "private") return false;
    return this.canAccessScope(
      ctx,
      proposal.proposedScope,
      proposal.proposedProjectId,
      proposal.submittedByAgent,
    );
  }

  assertCanReview(
    ctx: AccessContext,
    proposal: Pick<Proposal, "submittedByAgent" | "proposedScope" | "proposedProjectId">,
  ): void {
    if (!this.canReview(ctx, proposal)) {
      throw new PermissionError("Access denied");
    }
  }

  // Mirror of the SQL visibility predicate in proposal-repository, applied
  // in TS where the loaded row is already in hand (approve/reject paths).
  canSeeProposal(
    ctx: AccessContext,
    proposal: Pick<Proposal, "proposedScope" | "proposedProjectId" | "submittedByAgent">,
  ): boolean {
    if (!ctx.actorActive) return false;
    if (proposal.submittedByAgent === ctx.actor.agentId) return true;
    return this.canAccessScope(
      ctx,
      proposal.proposedScope,
      proposal.proposedProjectId,
      proposal.submittedByAgent,
    );
  }

  assertCanSeeProposal(
    ctx: AccessContext,
    proposal: Pick<Proposal, "proposedScope" | "proposedProjectId" | "submittedByAgent">,
  ): void {
    if (!this.canSeeProposal(ctx, proposal)) {
      throw new NotFoundError("Proposal not found");
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
