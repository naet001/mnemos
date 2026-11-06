import { describe, it, expect } from "vitest";
import {
  candidateBatchSchema,
  createMemorySchema,
  listProposalsSchema,
  memoryCandidateSchema,
  rememberSchema,
  updateMemorySchema,
  listMemoriesSchema,
  normalizeTags,
} from "../src/core/index.js";

describe("createMemorySchema", () => {
  it("accepts valid global memory and applies defaults", () => {
    const v = createMemorySchema.parse({
      content: "The payment engine uses Go and PostgreSQL.",
      type: "project",
      scope: "global",
    });
    expect(v.importance).toBe(5);
    expect(v.confidence).toBe(0.5);
    expect(v.tags).toEqual([]);
    expect(v.sourceKind).toBe("agent_submission");
  });

  it("requires projectId for project scope", () => {
    const r = createMemorySchema.safeParse({
      content: "x",
      type: "semantic",
      scope: "project",
    });
    expect(r.success).toBe(false);
  });

  it("rejects projectId for global scope", () => {
    const r = createMemorySchema.safeParse({
      content: "x",
      type: "semantic",
      scope: "global",
      projectId: "00000000-0000-4000-8000-000000000001",
    });
    expect(r.success).toBe(false);
  });
});

describe("updateMemorySchema", () => {
  it("rejects empty update", () => {
    expect(updateMemorySchema.safeParse({}).success).toBe(false);
  });

  it("accepts partial updates", () => {
    expect(updateMemorySchema.parse({ importance: 9 })).toEqual({ importance: 9 });
  });
});

describe("listMemoriesSchema", () => {
  it("applies defaults", () => {
    expect(listMemoriesSchema.parse({})).toMatchObject({ limit: 20, offset: 0 });
  });
});

describe("normalizeTags", () => {
  it("trims, drops empty, and dedupes case-insensitively preserving first form", () => {
    expect(normalizeTags([" Go ", "go", "DB", "", "db "])).toEqual(["Go", "DB"]);
  });
});

const validUuid = "00000000-0000-4000-8000-000000000001";

describe("memoryCandidateSchema (untrusted extraction output)", () => {
  it("accepts a minimal candidate", () => {
    const v = memoryCandidateSchema.parse({
      content: "The gateway listens on port 8443.",
      type: "semantic",
      scope: "global",
      projectId: null,
    });
    expect(v.type).toBe("semantic");
  });

  it("enforces the same scope/project rules as memories", () => {
    expect(
      memoryCandidateSchema.safeParse({ content: "x", type: "semantic", scope: "project" }).success,
    ).toBe(false);
    expect(
      memoryCandidateSchema.safeParse({
        content: "x",
        type: "semantic",
        scope: "global",
        projectId: validUuid,
      }).success,
    ).toBe(false);
  });

  it("caps content length and rejects junk types", () => {
    expect(
      memoryCandidateSchema.safeParse({
        content: "a".repeat(4001),
        type: "semantic",
        scope: "global",
      }).success,
    ).toBe(false);
    expect(
      memoryCandidateSchema.safeParse({ content: "ok", type: "wisdom", scope: "global" }).success,
    ).toBe(false);
  });

  it("silently drops unknown keys a provider might inject", () => {
    const v = memoryCandidateSchema.parse({
      content: "ok enough tokens here",
      type: "semantic",
      scope: "global",
      tags: ["sneaky"],
      status: "deleted",
      role: "owner",
    });
    expect(v).not.toHaveProperty("tags");
    expect(v).not.toHaveProperty("status");
    expect(v).not.toHaveProperty("role");
  });
});

describe("candidateBatchSchema", () => {
  const candidate = { content: "ok", type: "semantic" as const, scope: "global" as const };
  it("requires at least one candidate", () => {
    expect(candidateBatchSchema.safeParse([]).success).toBe(false);
  });
  it("caps the batch at ten", () => {
    expect(candidateBatchSchema.safeParse(Array.from({ length: 11 }, () => candidate)).success).toBe(false);
  });
});

describe("rememberSchema", () => {
  it("accepts bare content and caps submission size", () => {
    expect(rememberSchema.safeParse({ content: "note this" }).success).toBe(true);
    expect(rememberSchema.safeParse({ content: "x".repeat(8001) }).success).toBe(false);
  });
});

describe("listProposalsSchema", () => {
  it("defaults to pending only", () => {
    expect(listProposalsSchema.parse({})).toMatchObject({
      statuses: ["pending"],
      limit: 20,
      offset: 0,
    });
  });
});
