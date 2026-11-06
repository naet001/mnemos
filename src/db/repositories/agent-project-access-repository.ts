import type { DbExecutor } from "../tx.js";

export class AgentProjectAccessRepository {
  async grant(
    db: DbExecutor,
    input: { agentId: string; projectId: string; role?: "owner" | "member" | "reviewer" },
  ): Promise<void> {
    await db.query(
      `INSERT INTO agent_project_access (agent_id, project_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, project_id) DO UPDATE SET role = EXCLUDED.role`,
      [input.agentId, input.projectId, input.role ?? "member"],
    );
  }

  async listProjectIdsForAgent(db: DbExecutor, agentId: string): Promise<string[]> {
    const result = await db.query<{ project_id: string }>(
      `SELECT project_id FROM agent_project_access WHERE agent_id = $1`,
      [agentId],
    );
    return result.rows.map((r) => r.project_id);
  }

  async hasAccess(db: DbExecutor, agentId: string, projectId: string): Promise<boolean> {
    const result = await db.query<{ ok: number }>(
      `SELECT 1 AS ok FROM agent_project_access WHERE agent_id = $1 AND project_id = $2`,
      [agentId, projectId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
