-- Migration 001: Initial schema
-- Creates core tables for Mnemos memory service.

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Migration tracking table
CREATE TABLE IF NOT EXISTS _migrations (
  version   INTEGER     NOT NULL PRIMARY KEY,
  name      TEXT        NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum  TEXT        NOT NULL
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  description TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agents (registered clients)
CREATE TABLE IF NOT EXISTS agents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  status      TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent project access grants
CREATE TABLE IF NOT EXISTS agent_project_access (
  agent_id    UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'member'
                          CHECK (role IN ('owner', 'member', 'reviewer')),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, project_id)
);

-- Sources (provenance tracking)
CREATE TABLE IF NOT EXISTS sources (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID        NOT NULL REFERENCES agents(id),
  source_kind     TEXT        NOT NULL CHECK (source_kind IN (
                    'agent_submission', 'import', 'manual_entry', 'system_operation'
                  )),
  external_ref    TEXT,       -- optional external conversation/session reference
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tags (reusable labels)
CREATE TABLE IF NOT EXISTS tags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Canonical memories
CREATE TABLE IF NOT EXISTS memories (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  content           TEXT        NOT NULL,
  type              TEXT        NOT NULL CHECK (type IN (
                      'semantic', 'preference', 'episodic',
                      'project', 'decision', 'procedural'
                    )),
  scope             TEXT        NOT NULL CHECK (scope IN ('global', 'project', 'private')),
  project_id        UUID        REFERENCES projects(id),
  status            TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'archived', 'superseded', 'deleted')),
  importance        INTEGER     NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  confidence        NUMERIC(3,2) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  source_id         UUID        NOT NULL REFERENCES sources(id),
  created_by_agent  UUID        NOT NULL REFERENCES agents(id),
  current_version   INTEGER     NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at       TIMESTAMPTZ
);

-- Memory-tag relation
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag_id    UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tag_id)
);

-- Immutable memory versions
CREATE TABLE IF NOT EXISTS memory_versions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL,
  content     TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  scope       TEXT        NOT NULL,
  project_id  UUID        REFERENCES projects(id),
  status      TEXT        NOT NULL,
  importance  INTEGER     NOT NULL,
  confidence  NUMERIC(3,2) NOT NULL,
  source_id   UUID        NOT NULL REFERENCES sources(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_id, version)
);

-- Memory embeddings
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id       UUID        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_version  INTEGER     NOT NULL,
  embedding       vector(384) NOT NULL,
  model           TEXT        NOT NULL,
  dimensions      INTEGER     NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'pending', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (memory_id, memory_version)
    REFERENCES memory_versions(memory_id, version)
);

-- Memory proposals
CREATE TABLE IF NOT EXISTS memory_proposals (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action              TEXT        NOT NULL CHECK (action IN (
                        'create', 'update', 'archive', 'supersede'
                      )),
  proposed_content    TEXT        NOT NULL,
  proposed_type       TEXT        NOT NULL CHECK (proposed_type IN (
                        'semantic', 'preference', 'episodic',
                        'project', 'decision', 'procedural'
                      )),
  proposed_scope      TEXT        NOT NULL CHECK (proposed_scope IN ('global', 'project', 'private')),
  proposed_project_id UUID        REFERENCES projects(id),
  target_memory_id    UUID        REFERENCES memories(id),
  target_version      INTEGER,
  rationale           TEXT,
  status              TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  source_id           UUID        NOT NULL REFERENCES sources(id),
  submitted_by_agent  UUID        NOT NULL REFERENCES agents(id),
  reviewed_by_agent   UUID        REFERENCES agents(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at         TIMESTAMPTZ
);

-- Indexes for common query patterns
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_scope ON memories(scope);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_project ON memories(project_id);
CREATE INDEX idx_memories_created ON memories(created_at DESC);
CREATE INDEX idx_memories_updated ON memories(updated_at DESC);

CREATE INDEX idx_memory_versions_memory ON memory_versions(memory_id, version DESC);
CREATE INDEX idx_memory_embeddings_status ON memory_embeddings(status);

CREATE INDEX idx_memory_proposals_status ON memory_proposals(status);
CREATE INDEX idx_memory_proposals_submitted ON memory_proposals(submitted_by_agent);
CREATE INDEX idx_memory_proposals_target ON memory_proposals(target_memory_id);

CREATE INDEX idx_sources_agent ON sources(agent_id);

-- Full-text search index on memory content
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN(search_vector);

-- Record this migration
INSERT INTO _migrations (version, name, checksum)
VALUES (1, 'initial_schema', 'initial')
ON CONFLICT (version) DO NOTHING;