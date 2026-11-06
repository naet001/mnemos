import type { DbExecutor } from "../tx.js";
import type { Agent, AgentStatus } from "../../core/index.js";

interface AgentRow {
  id: string;
  name: string;
  status: AgentStatus;
  created_at: Date;
  updated_at: Date;
}

function map(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentRepository {
  async create(db: DbExecutor, input: { name: string; status?: AgentStatus }): Promise<Agent> {
    const result = await db.query<AgentRow>(
      `INSERT INTO agents (name, status) VALUES ($1, $2)
       RETURNING id, name, status, created_at, updated_at`,
      [input.name, input.status ?? "active"],
    );
    return map(result.rows[0]);
  }

  async getById(db: DbExecutor, id: string): Promise<Agent | null> {
    const result = await db.query<AgentRow>(
      `SELECT id, name, status, created_at, updated_at FROM agents WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async getByName(db: DbExecutor, name: string): Promise<Agent | null> {
    const result = await db.query<AgentRow>(
      `SELECT id, name, status, created_at, updated_at FROM agents WHERE name = $1`,
      [name],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
}
