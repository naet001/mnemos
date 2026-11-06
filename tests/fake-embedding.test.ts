import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../src/providers/fake-embedding-provider.js";
import { isZeroVector } from "../src/providers/embedding-provider.js";

function cosineDistance(a: number[], b: number[]): number {
  const dot = a.reduce((sum, n, i) => sum + n * b[i], 0);
  return 1 - dot; // vectors are unit-normalized
}

describe("FakeEmbeddingProvider", () => {
  const provider = new FakeEmbeddingProvider();

  it("produces identical vectors for identical text", async () => {
    const [v1, v2] = await Promise.all([
      provider.embed("The payment engine uses Go"),
      provider.embed("The payment engine uses Go"),
    ]);
    expect(v1).toEqual(v2);
  });

  it("returns 384 unit-normalized dimensions", async () => {
    const v = await provider.embed("semantic memory retrieval test");
    expect(v).toHaveLength(384);
    const norm = Math.sqrt(v.reduce((sum, n) => sum + n * n, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("scores overlapping text closer than disjoint text", async () => {
    const a = await provider.embed("the payment engine uses go and postgresql");
    const b = await provider.embed("the payment service is written in go");
    const c = await provider.embed("kitchen recipe for banana bread");
    expect(cosineDistance(a, b)).toBeLessThan(cosineDistance(a, c));
  });

  it("is case- and punctuation-insensitive", async () => {
    const [v1, v2] = await Promise.all([
      provider.embed("Hello, World!"),
      provider.embed("hello world"),
    ]);
    expect(v1).toEqual(v2);
  });

  it("yields the zero vector only for un-tokenizable text", async () => {
    expect(isZeroVector(await provider.embed(""))).toBe(true);
    expect(isZeroVector(await provider.embed("!!! ?? --"))).toBe(true);
    expect(isZeroVector(await provider.embed("word"))).toBe(false);
  });

  it("exposes model metadata", () => {
    expect(provider.model).toBe("fake-hash-384");
    expect(provider.dimensions).toBe(384);
  });
});
