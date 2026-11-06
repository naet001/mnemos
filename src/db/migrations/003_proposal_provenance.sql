-- Migration 003: Proposal provenance and review shape
-- SPEC §7.5 ("the proposal that produced the memory"), §6.3 (assistant
-- suggests importance/confidence), §8.1 (target required for non-create),
-- §7.2 (project scope requires a project).

ALTER TABLE memory_proposals
  ADD COLUMN resulting_memory_id UUID REFERENCES memories(id),
  ADD COLUMN proposed_importance   INTEGER      CHECK (proposed_importance BETWEEN 1 AND 10),
  ADD COLUMN proposed_confidence   NUMERIC(3,2) CHECK (proposed_confidence BETWEEN 0 AND 1);

ALTER TABLE memory_proposals
  ADD CONSTRAINT chk_proposal_target_shape CHECK (
    (action = 'create'    AND target_memory_id IS NULL AND target_version IS NULL)
    OR
    (action <> 'create'   AND target_memory_id IS NOT NULL AND target_version IS NOT NULL)
  ),
  ADD CONSTRAINT chk_proposal_scope_project CHECK (
    (proposed_scope = 'project') = (proposed_project_id IS NOT NULL)
  );

-- Drives the lazy TTL sweep and pending-first listing without a scan.
CREATE INDEX idx_memory_proposals_pending
  ON memory_proposals (created_at) WHERE status = 'pending';
CREATE INDEX idx_memory_proposals_resulting
  ON memory_proposals (resulting_memory_id);
