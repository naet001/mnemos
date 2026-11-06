import { ProviderError } from "../core/errors.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { FakeEmbeddingProvider } from "./fake-embedding-provider.js";
import type { ExtractionProvider } from "./extraction-provider.js";
import { FakeExtractionProvider } from "./fake-extraction-provider.js";

export type { EmbeddingProvider } from "./embedding-provider.js";
export { isZeroVector } from "./embedding-provider.js";
export { FakeEmbeddingProvider } from "./fake-embedding-provider.js";
export type {
  ExtractionProvider,
  ExtractionInput,
  ExtractionHints,
} from "./extraction-provider.js";
export { FakeExtractionProvider } from "./fake-extraction-provider.js";

// The initial schema hard-types memory_embeddings.embedding as vector(384);
// changing that requires a documented re-embedding migration (SPEC §10.3).
const SUPPORTED_DIMENSIONS = 384;

export function createEmbeddingProvider(config: {
  provider: string;
  model: string;
  dimensions: number;
}): EmbeddingProvider | null {
  const name = config.provider.trim().toLowerCase();
  if (name === "" || name === "none") return null;

  let provider: EmbeddingProvider;
  switch (name) {
    case "fake":
      provider = new FakeEmbeddingProvider();
      break;
    default:
      throw new ProviderError(`Unknown embedding provider "${config.provider}"`, {
        provider: config.provider,
      });
  }

  if (provider.dimensions !== config.dimensions) {
    throw new ProviderError(
      `Embedding dimensions mismatch: provider "${provider.model}" produces ${provider.dimensions}, configuration says ${config.dimensions}`,
      { provider: config.provider, model: provider.model }
    );
  }
  if (provider.dimensions !== SUPPORTED_DIMENSIONS) {
    throw new ProviderError(
      `Schema column vector(${SUPPORTED_DIMENSIONS}) cannot store ${provider.dimensions}-dimensional embeddings; a re-embedding migration is required first`,
      { dimensions: provider.dimensions }
    );
  }
  return provider;
}

export function createExtractionProvider(config: {
  provider: string;
  model: string;
}): ExtractionProvider | null {
  const name = config.provider.trim().toLowerCase();
  if (name === "" || name === "none") return null;

  switch (name) {
    case "fake":
      return new FakeExtractionProvider();
    default:
      throw new ProviderError(`Unknown extraction provider "${config.provider}"`, {
        provider: config.provider,
      });
  }
}
