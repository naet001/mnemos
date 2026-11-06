import type { DbExecutor } from "../tx.js";
import type { Project } from "../../core/index.js";

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}

function map(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  async create(db: DbExecutor, input: { name: string; description?: string }): Promise<Project> {
    const result = await db.query<ProjectRow>(
      `INSERT INTO projects (name, description) VALUES ($1, $2)
       RETURNING id, name, description, created_at, updated_at`,
      [input.name, input.description ?? ""],
    );
    return map(result.rows[0]);
  }

  async getById(db: DbExecutor, id: string): Promise<Project | null> {
    const result = await db.query<ProjectRow>(
      `SELECT id, name, description, created_at, updated_at FROM projects WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async list(db: DbExecutor): Promise<Project[]> {
    const result = await db.query<ProjectRow>(
      `SELECT id, name, description, created_at, updated_at FROM projects ORDER BY name ASC`,
    );
    return result.rows.map(map);
  }
}
