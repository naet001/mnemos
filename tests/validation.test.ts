import { describe, it, expect } from "vitest";
import {
  createMemorySchema,
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
