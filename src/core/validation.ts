import { z } from "zod";
import { MEMORY_STATUSES, MEMORY_TYPES, SCOPES, SOURCE_KINDS } from "./types.js";
import { ValidationError } from "./errors.js";

const uuid = z.string().uuid();
const nonEmptyText = z.string().trim().min(1);
const tagName = z.string().trim().min(1).max(100);

const scopeProjectRefinement = (
  value: { scope: string; projectId?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (value.scope === "project" && !value.projectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectId"],
      message: "projectId is required when scope is project",
    });
  }
  if (value.scope === "global" && value.projectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectId"],
      message: "projectId must not be set when scope is global",
    });
  }
};

export const createMemorySchema = z
  .object({
    content: nonEmptyText,
    type: z.enum(MEMORY_TYPES),
    scope: z.enum(SCOPES),
    projectId: uuid.nullish(),
    importance: z.number().int().min(1).max(10).default(5),
    confidence: z.number().min(0).max(1).default(0.5),
    tags: z.array(tagName).default([]),
    sourceKind: z.enum(SOURCE_KINDS).default("agent_submission"),
    externalRef: z.string().trim().min(1).max(500).nullish(),
  })
  .superRefine(scopeProjectRefinement);

export const updateMemorySchema = z
  .object({
    content: nonEmptyText.optional(),
    type: z.enum(MEMORY_TYPES).optional(),
    scope: z.enum(SCOPES).optional(),
    projectId: uuid.nullish(),
    importance: z.number().int().min(1).max(10).optional(),
    confidence: z.number().min(0).max(1).optional(),
    tags: z.array(tagName).optional(),
    sourceKind: z.enum(SOURCE_KINDS).optional(),
    externalRef: z.string().trim().min(1).max(500).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided for update",
  });

export const listMemoriesSchema = z.object({
  projectId: uuid.optional(),
  scope: z.enum(SCOPES).optional(),
  types: z.array(z.enum(MEMORY_TYPES)).optional(),
  statuses: z.array(z.enum(MEMORY_STATUSES)).optional(),
  tags: z.array(tagName).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const memoryIdSchema = uuid;

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
  throw new ValidationError("Validation failed", { issues });
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}
