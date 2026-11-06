-- Migration 002: Embedding uniqueness
-- One embedding row per memory version; enables ON CONFLICT upserts.

ALTER TABLE memory_embeddings
  DROP CONSTRAINT IF EXISTS uq_embeddings_memory_version,
  ADD CONSTRAINT uq_embeddings_memory_version UNIQUE (memory_id, memory_version);
