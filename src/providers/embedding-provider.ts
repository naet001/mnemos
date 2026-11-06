// Provider contract per SPEC §6.8. Application services depend on this
// interface only; concrete adapters live beside it and are selected by
// configuration.
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly model: string;
  readonly dimensions: number;
}

export function isZeroVector(vector: number[]): boolean {
  return vector.every((n) => n === 0);
}
