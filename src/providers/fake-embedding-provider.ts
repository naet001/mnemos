import type { EmbeddingProvider } from "./embedding-provider.js";

const DIMENSIONS = 384;
const PROBES_PER_TOKEN = 4;

// FNV-1a 32-bit — deterministic across runs and platforms.
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Deterministic stand-in for a real embedding model: each token is hashed
// into PROBES_PER_TOKEN buckets, then L2-normalized. Cosine similarity
// between two such vectors measures lexical token overlap, not semantics —
// enough to exercise the retrieval pipeline without any vendor.
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = "fake-hash-384";
  readonly dimensions = DIMENSIONS;

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0);

    for (const token of tokens) {
      for (let probe = 0; probe < PROBES_PER_TOKEN; probe++) {
        const idx = fnv1a32(`${token}:${probe}`) % DIMENSIONS;
        vector[idx] += 1;
      }
    }

    const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
    // Empty/no-token text yields the zero vector; callers must skip storing
    // it (pgvector cosine distance on a zero vector is NaN).
    if (norm === 0) return vector;
    return vector.map((n) => n / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
