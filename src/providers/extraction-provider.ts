import type { MemoryCandidate, MemoryType, Scope } from "../core/types.js";

export interface ExtractionHints {
  scope?: Scope;
  projectId?: string | null;
  type?: MemoryType;
}

export interface ExtractionInput {
  text: string;
  hints?: ExtractionHints;
}

// SPEC §6.8. Implementations must receive no pool, repositories, or
// credentials — only this input. Their output is untrusted (§13.10): the
// service re-validates every candidate regardless of what this contract
// promises, so the types here document intent, not enforcement.
export interface ExtractionProvider {
  readonly model: string;
  extract(input: ExtractionInput): Promise<MemoryCandidate[]>;
}
