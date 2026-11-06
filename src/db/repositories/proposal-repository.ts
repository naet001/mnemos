import type { DbExecutor } from "../tx.js";
import type {
  MemoryType,
  Proposal,
  ProposalAction,
  ProposalStatus,
  Scope,
} from "../../core/index.js";
import { scopeVisibilitySql } from "./visibility-sql.js";

export interface ProposalRow {
  id: string;
  action: ProposalAction;
  proposed_content: string;
  proposed_type: MemoryType;
  proposed_scope: Scope;
  proposed_project_id: string | null;
  target_memory_id: string | null;
  target_version: number | null;
  rationale: string | null;
  proposed_importance: number | null;
  proposed_confidence: string | number | null;
  status: ProposalStatus;
  source_id: string;
  submitted_by_agent: string;
  reviewed_by_agent: string | null;
  resulting_memory_id: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  stale?: boolean;
}

export interface LockedProposal {
  proposal: Proposal;
  stale: boolean;
}

export interface CreateProposalInput {
  action: ProposalAction;
  proposedContent: string;
  proposedType: MemoryType;
  proposedScope: Scope;
  proposedProjectId: string | null;
  targetMemoryId?: string | null;
  targetVersion?: number | null;
  rationale?: string | null;
  proposedImportance?: number | null;
  proposedConfidence?: number | null;
  sourceId: string;
  submittedByAgent: string;
}

export interface ProposalVisibilityArgs {
  actorAgentId: string;
  accessibleProjectIds: string[];
}

export interface ProposalListFilter extends ProposalVisibilityArgs {
  statuses: ProposalStatus[];
  actions?: ProposalAction[];
  projectId?: string;
  limit: number;
  offset: number;
}

function asNumber(v: string | number | null): number | null {
  if (v === null) return null;
  return typeof v === "number" ? v : Number(v);
}

export function mapProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    action: row.action,
    proposedContent: row.proposed_content,
    proposedType: row.proposed_type,
    proposedScope: row.proposed_scope,
    proposedProjectId: row.proposed_project_id,
    targetMemoryId: row.target_memory_id,
    targetVersion: row.target_version,
    rationale: row.rationale,
    proposedImportance: row.proposed_importance,
    proposedConfidence: asNumber(row.proposed_confidence),
    status: row.status,
    sourceId: row.source_id,
    submittedByAgent: row.submitted_by_agent,
    reviewedByAgent: row.reviewed_by_agent,
    resultingMemoryId: row.resulting_memory_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

// Visibility: the proposed scope decides who normally sees it, but an
// actor's own submissions are always visible so they can withdraw them even
// after losing access or when the target would otherwise hide the row. A
// non-null target must additionally be visible (or owned) so approving an
// update cannot leak a memory the reviewer cannot read.
function proposalVisibilitySql(args: ProposalVisibilityArgs, params: unknown[]): string {
  const add = (value: unknown): string => `$${params.push(value)}`;
  const actorP = add(args.actorAgentId);
  const projectsP = add(args.accessibleProjectIds);
  const scopeSql = scopeVisibilitySql(
    "p.proposed_scope",
    "p.proposed_project_id",
    "p.submitted_by_agent",
    actorP,
    projectsP,
  );
  return `(
    p.submitted_by_agent = ${actorP}
    OR ${scopeSql}
    OR (
      p.target_memory_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM memories t
        WHERE t.id = p.target_memory_id
          AND t.status <> 'deleted'
          AND ${scopeVisibilitySql("t.scope", "t.project_id", "t.created_by_agent", actorP, projectsP)}
      )
    )
  )`;
}

export class ProposalRepository {
  async create(db: DbExecutor, input: CreateProposalInput): Promise<Proposal> {
    const result = await db.query<ProposalRow>(
      `INSERT INTO memory_proposals (
         action, proposed_content, proposed_type, proposed_scope,
         proposed_project_id, target_memory_id, target_version, rationale,
         proposed_importance, proposed_confidence, source_id, submitted_by_agent
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.action,
        input.proposedContent,
        input.proposedType,
        input.proposedScope,
        input.proposedProjectId,
        input.targetMemoryId ?? null,
        input.targetVersion ?? null,
        input.rationale ?? null,
        input.proposedImportance ?? null,
        input.proposedConfidence ?? null,
        input.sourceId,
        input.submittedByAgent,
      ],
    );
    return mapProposal(result.rows[0]);
  }

  async getById(db: DbExecutor, id: string): Promise<Proposal | null> {
    const result = await db.query<ProposalRow>(
      `SELECT * FROM memory_proposals WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapProposal(row) : null;
  }

  async getVisible(
    db: DbExecutor,
    id: string,
    args: ProposalVisibilityArgs,
  ): Promise<Proposal | null> {
    const params: unknown[] = [];
    const visibility = proposalVisibilitySql(args, params);
    params.push(id);
    const result = await db.query<ProposalRow>(
      `SELECT * FROM memory_proposals p
       WHERE p.id = $${params.length} AND ${visibility}`,
      params,
    );
    const row = result.rows[0];
    return row ? mapProposal(row) : null;
  }

  // Lock-first read for any decision path: the FOR UPDATE re-fetch returns
  // the latest committed row under READ COMMITTED, so a concurrent approval
  // cannot pass the pending check twice. `stale` uses the DB clock to avoid
  // app/DB skew; ttl <= 0 means never expires (config PROPOSAL_TTL=0).
  async getForUpdate(
    db: DbExecutor,
    id: string,
    ttlSeconds: number,
  ): Promise<LockedProposal | null> {
    const result = await db.query<ProposalRow>(
      `SELECT *,
         ( $2::int > 0
           AND EXTRACT(EPOCH FROM (NOW() - created_at)) > $2::int ) AS stale
       FROM memory_proposals p
       WHERE p.id = $1::uuid
       FOR UPDATE`,
      [id, ttlSeconds],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { proposal: mapProposal(row), stale: row.stale === true };
  }

  async list(
    db: DbExecutor,
    filter: ProposalListFilter,
  ): Promise<{ rows: Proposal[]; total: number }> {
    const params: unknown[] = [];
    const visibility = proposalVisibilitySql(
      { actorAgentId: filter.actorAgentId, accessibleProjectIds: filter.accessibleProjectIds },
      params,
    );
    const clauses = [visibility, `p.status = ANY($${params.push(filter.statuses)}::text[])`];
    if (filter.actions?.length) {
      clauses.push(`p.action = ANY($${params.push(filter.actions)}::text[])`);
    }
    if (filter.projectId) {
      clauses.push(`p.proposed_project_id = $${params.push(filter.projectId)}`);
    }
    const whereSql = `WHERE ${clauses.join(" AND ")}`;

    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_proposals p ${whereSql}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? "0");
    const result = await db.query<ProposalRow>(
      `SELECT * FROM memory_proposals p ${whereSql}
       ORDER BY (p.status = 'pending') DESC, p.created_at DESC, p.id DESC
       LIMIT $${params.push(filter.limit)} OFFSET $${params.push(filter.offset)}`,
      params,
    );
    return { rows: result.rows.map(mapProposal), total };
  }

  // Caller already holds the row lock from getForUpdate.
  async markDecision(
    db: DbExecutor,
    id: string,
    opts: {
      status: "approved" | "rejected";
      reviewerAgentId: string;
      resultingMemoryId?: string | null;
    },
  ): Promise<Proposal> {
    const result = await db.query<ProposalRow>(
      `UPDATE memory_proposals
       SET status = $1,
           reviewed_by_agent = $2,
           reviewed_at = NOW(),
           resulting_memory_id = COALESCE($3, resulting_memory_id)
       WHERE id = $4
       RETURNING *`,
      [opts.status, opts.reviewerAgentId, opts.resultingMemoryId ?? null, id],
    );
    return mapProposal(result.rows[0]);
  }

  // Expiry is not a review: reviewer columns stay NULL (expiry time is
  // derivable from created_at + ttl).
  private static readonly expireWhere = (idParam?: string): string =>
    `status = 'pending' AND $1::int > 0
     AND created_at < NOW() - make_interval(secs => $1::int)${idParam ? ` AND id = ${idParam}` : ""}`;

  async expireIfStale(db: DbExecutor, id: string, ttlSeconds: number): Promise<number> {
    const result = await db.query(
      `UPDATE memory_proposals SET status = 'expired'
       WHERE ${ProposalRepository.expireWhere("$2")}
       RETURNING id`,
      [ttlSeconds, id],
    );
    return result.rowCount ?? 0;
  }

  async expirePending(db: DbExecutor, ttlSeconds: number): Promise<number> {
    const result = await db.query(
      `UPDATE memory_proposals SET status = 'expired'
       WHERE ${ProposalRepository.expireWhere()}`,
      [ttlSeconds],
    );
    return result.rowCount ?? 0;
  }
}
