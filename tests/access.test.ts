import { describe, it, expect } from "vitest";
import { AccessManager } from "../src/services/access-manager.js";

const actorA = { agentId: "00000000-0000-4000-8000-00000000000a" };
const actorB = { agentId: "00000000-0000-4000-8000-00000000000b" };
const projectId = "00000000-0000-4000-8000-0000000000p1".slice(0, 36).replace("p1", "01");

function ctx(agentId: string, projects: string[] = [], active = true) {
  return {
    actor: { agentId },
    actorActive: active,
    accessibleProjectIds: new Set(projects),
  };
}

describe("AccessManager (A: private=creator)", () => {
  const access = new AccessManager();

  it("allows global read for active actor", () => {
    expect(
      access.canRead(ctx(actorB.agentId), {
        scope: "global",
        projectId: null,
        createdByAgent: actorA.agentId,
        status: "active",
      }),
    ).toBe(true);
  });

  it("allows project read only with project access", () => {
    const mem = {
      scope: "project" as const,
      projectId,
      createdByAgent: actorA.agentId,
      status: "active" as const,
    };
    expect(access.canRead(ctx(actorB.agentId, []), mem)).toBe(false);
    expect(access.canRead(ctx(actorB.agentId, [projectId]), mem)).toBe(true);
  });

  it("allows private read only for creator", () => {
    const mem = {
      scope: "private" as const,
      projectId: null,
      createdByAgent: actorA.agentId,
      status: "active" as const,
    };
    expect(access.canRead(ctx(actorA.agentId), mem)).toBe(true);
    expect(access.canRead(ctx(actorB.agentId), mem)).toBe(false);
  });

  it("denies deleted memories", () => {
    expect(
      access.canRead(ctx(actorA.agentId), {
        scope: "private",
        projectId: null,
        createdByAgent: actorA.agentId,
        status: "deleted",
      }),
    ).toBe(false);
  });

  it("denies inactive actor", () => {
    expect(
      access.canRead(ctx(actorA.agentId, [], false), {
        scope: "global",
        projectId: null,
        createdByAgent: actorB.agentId,
        status: "active",
      }),
    ).toBe(false);
  });

  it("assertCanRead hides unauthorized as not found", () => {
    expect(() =>
      access.assertCanRead(ctx(actorB.agentId), {
        scope: "private",
        projectId: null,
        createdByAgent: actorA.agentId,
        status: "active",
      }),
    ).toThrowError(/not found/i);
  });
});

describe("AccessManager review policy (M4)", () => {
  const access = new AccessManager();

  it("denies self-approval of global and project proposals", () => {
    expect(
      access.canReview(ctx(actorA.agentId), {
        submittedByAgent: actorA.agentId,
        proposedScope: "global",
        proposedProjectId: null,
      }),
    ).toBe(false);
    expect(
      access.canReview(ctx(actorA.agentId, [projectId]), {
        submittedByAgent: actorA.agentId,
        proposedScope: "project",
        proposedProjectId: projectId,
      }),
    ).toBe(false);
  });

  it("allows self-approval only for private (the §13.7 policy exception)", () => {
    expect(
      access.canReview(ctx(actorA.agentId), {
        submittedByAgent: actorA.agentId,
        proposedScope: "private",
        proposedProjectId: null,
      }),
    ).toBe(true);
  });

  it("requires write access for a foreign project proposal review", () => {
    const proposal = {
      submittedByAgent: actorA.agentId,
      proposedScope: "project" as const,
      proposedProjectId: projectId,
    };
    expect(access.canReview(ctx(actorB.agentId, []), proposal)).toBe(false);
    expect(access.canReview(ctx(actorB.agentId, [projectId]), proposal)).toBe(true);
  });

  it("any active agent may review global proposals; inactive may not", () => {
    const proposal = {
      submittedByAgent: actorA.agentId,
      proposedScope: "global" as const,
      proposedProjectId: null,
    };
    expect(access.canReview(ctx(actorB.agentId), proposal)).toBe(true);
    expect(access.canReview(ctx(actorB.agentId, [], false), proposal)).toBe(false);
  });

  it("see-proposal: own submissions always visible, foreign private hidden", () => {
    const privateMine = {
      submittedByAgent: actorA.agentId,
      proposedScope: "private" as const,
      proposedProjectId: null,
    };
    const privateTheirs = {
      submittedByAgent: actorB.agentId,
      proposedScope: "private" as const,
      proposedProjectId: null,
    };
    expect(access.canSeeProposal(ctx(actorA.agentId), privateMine)).toBe(true);
    expect(access.canSeeProposal(ctx(actorA.agentId), privateTheirs)).toBe(false);
    expect(() =>
      access.assertCanSeeProposal(ctx(actorA.agentId), privateTheirs),
    ).toThrowError(/not found/i);
  });
});
