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
