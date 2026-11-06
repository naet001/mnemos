import type { EmbeddingProvider } from "../providers/embedding-provider.js";
import { isZeroVector } from "../providers/embedding-provider.js";
import type { EmbeddingRepository, DbExecutor } from "../db/repositories/index.js";
import { logger } from "../logger/index.js";

export interface EmbedDeps {
  embeddingRepo: EmbeddingRepository;
  embeddingProvider: EmbeddingProvider | null;
}

// Embed within the caller's transaction, right after the version row exists
// (composite FK requirement). A provider failure only loses the vector,
// never the memory: absence of a row means "pending" and keyword search
// still finds it (SPEC §8/§15). A future networked provider should move
// this to a post-commit outbox so no network call happens inside a tx.
export async function embedQuietly(
  deps: EmbedDeps,
  db: DbExecutor,
  memoryId: string,
  version: number,
  content: string,
): Promise<void> {
  if (!deps.embeddingProvider) return;
  try {
    const vector = await deps.embeddingProvider.embed(content);
    if (isZeroVector(vector)) return;
    await deps.embeddingRepo.upsert(db, {
      memoryId,
      memoryVersion: version,
      embedding: vector,
      model: deps.embeddingProvider.model,
      dimensions: deps.embeddingProvider.dimensions,
    });
  } catch (err) {
    logger.warn("Embedding generation failed; memory stays keyword-searchable", {
      memoryId,
      version,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
