import type { MemoryType } from "../core/types.js";

export const CONFLICT_POOL_LIMIT = 200;

export interface ConflictPoolItem {
  id: string;
  content: string;
  type: MemoryType;
  currentVersion: number;
}

export interface ConflictDecision {
  action: "create" | "update";
  targetMemoryId?: string;
  targetVersion?: number;
  // Exact token-set match against an active memory: emit nothing.
  duplicate?: boolean;
  containment?: number;
}

export interface ConflictOptions {
  containment?: number;
  minShared?: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "these",
  "those", "from", "has", "have", "had", "not", "but", "all", "any", "can",
  "will", "shall", "should", "would", "could", "their", "there", "them",
  "they", "them", "its", "you", "your", "our", "we", "us", "he", "she",
  "his", "her", "who", "what", "when", "where", "why", "how", "than",
  "then", "into", "onto", "over", "under", "again", "once", "only", "own",
  "same", "so", "too", "very", "just", "also", "does", "did", "doing",
  "a", "an", "of", "to", "in", "on", "at", "by", "or", "if", "is", "it",
  "be", "as", "do", "no", "yes", "get", "got", "use", "used", "using",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

// Asymmetric: containment measures how much of the candidate is already
// covered by the existing item, so a short submission that is a subset of a
// long memory conflicts, while the reverse (restating more detail) does not.
export function tokenContainment(candidate: string, existing: string): { shared: number; containment: number } {
  const candidateSet = new Set(tokenize(candidate));
  const existingSet = new Set(tokenize(existing));
  if (candidateSet.size === 0) return { shared: 0, containment: 0 };
  let shared = 0;
  for (const token of candidateSet) {
    if (existingSet.has(token)) shared += 1;
  }
  return { shared, containment: shared / candidateSet.size };
}

// Why not the keyword/semantic search legs: websearch_to_tsquery ANDs all
// lexemes, so a one-word paraphrase does not match at all (measured against
// the live tsvector), and ts_rank/cosine values are not comparable across
// documents, so no threshold could ride on them. Recall comes from the
// bounded pool the caller fetches; this function only decides. A future
// OR-tsquery or real embedding top-k can replace the pool without changing
// this signature.
export function decideConflict(
  candidate: { content: string; type: MemoryType },
  pool: ConflictPoolItem[],
  options: ConflictOptions = {},
): ConflictDecision {
  const containmentThreshold = options.containment ?? 0.6;
  const minShared = options.minShared ?? 3;

  const candidateTokens = new Set(tokenize(candidate.content));
  if (candidateTokens.size === 0) return { action: "create" };

  let best: ConflictDecision | null = null;
  for (const item of pool) {
    if (item.type !== candidate.type) continue; // §8.2 conservatism
    const { shared, containment } = tokenContainment(candidate.content, item.content);
    const itemTokens = new Set(tokenize(item.content));
    if (
      shared === candidateTokens.size &&
      shared === itemTokens.size
    ) {
      return { action: "create", duplicate: true, containment: 1 };
    }
    if (shared < minShared || containment < containmentThreshold) continue;
    if (!best || containment > best.containment!) {
      best = {
        action: "update",
        targetMemoryId: item.id,
        targetVersion: item.currentVersion,
        containment,
      };
    }
  }
  return best ?? { action: "create" };
}

// SPEC §13.9: reject obvious credential shapes at intake. Narrow anchored
// patterns to keep false positives low; rejects, never redacts.
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /AIza[0-9A-Za-z_-]{35}/,
  /\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S{12,}/i,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
