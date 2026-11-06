import type { MemoryCandidate, MemoryType } from "../core/types.js";
import type { ExtractionHints, ExtractionInput, ExtractionProvider } from "./extraction-provider.js";

const MAX_CANDIDATES = 10;
const MIN_TOKENS = 3;

// First match wins; order is specificity, not alphabetical. Lexical
// heuristics only — this classifies surface wording, not meaning (same
// honesty convention as FakeEmbeddingProvider).
const TYPE_RULES: Array<{ type: MemoryType; pattern: RegExp }> = [
  { type: "decision", pattern: /\b(decided|chose|chosen|instead of|rationale|because)\b/ },
  { type: "procedural", pattern: /\b(always|never|run|runs|step|steps|command|commands|must)\b/ },
  { type: "preference", pattern: /\b(prefer|prefers|like|likes|dislike|convention|conventions|style|tab|tabs)\b/ },
  { type: "project", pattern: /\b(repo|repository|release|releases|deadline|deadlines|milestone|milestones|sprint|sprints|blocked|blocker|blockers)\b/ },
  { type: "episodic", pattern: /\b(yesterday|today|completed|fixed|happened|shipped|last week|last month)\b/ },
];

const HIGH_IMPORTANCE = /\b(critical|must|never|blocking|urgent)\b/;

function classifyType(sentence: string): MemoryType {
  const lower = sentence.toLowerCase();
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(lower)) return rule.type;
  }
  return "semantic";
}

export class FakeExtractionProvider implements ExtractionProvider {
  readonly model = "fake-extract-v1";

  async extract(input: ExtractionInput): Promise<MemoryCandidate[]> {
    const hints: ExtractionHints = input.hints ?? {};
    const sentences = input.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const seen = new Set<string>();
    const candidates: MemoryCandidate[] = [];
    let index = 0;
    for (const sentence of sentences) {
      index += 1;
      if (candidates.length >= MAX_CANDIDATES) break;
      const tokenCount = sentence.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).length;
      if (tokenCount < MIN_TOKENS) continue;

      const key = sentence.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);

      // Scope/project come only from hints — a provider must never invent a
      // project UUID (§13.10). Type: explicit hint overrides classification.
      const type = hints.type ?? classifyType(sentence);
      candidates.push({
        content: sentence,
        type,
        scope: hints.scope ?? "global",
        projectId: hints.scope === "project" ? hints.projectId ?? null : null,
        importance: HIGH_IMPORTANCE.test(sentence) ? 7 : 5,
        confidence: 0.7,
        rationale: `sentence ${index}/${sentences.length}, classified ${type}`,
      });
    }
    return candidates;
  }
}
