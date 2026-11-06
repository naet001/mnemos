import type { DbExecutor } from "../tx.js";

export class TagRepository {
  async replaceMemoryTags(db: DbExecutor, memoryId: string, tags: string[]): Promise<void> {
    await db.query(`DELETE FROM memory_tags WHERE memory_id = $1`, [memoryId]);
    if (tags.length === 0) return;

    for (const name of tags) {
      const tagResult = await db.query<{ id: string }>(
        `INSERT INTO tags (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name],
      );
      const tagId = tagResult.rows[0].id;
      await db.query(
        `INSERT INTO memory_tags (memory_id, tag_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [memoryId, tagId],
      );
    }
  }

  async getTagsForMemories(db: DbExecutor, memoryIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (memoryIds.length === 0) return out;
    const result = await db.query<{ memory_id: string; name: string }>(
      `SELECT mt.memory_id, t.name
       FROM memory_tags mt
       JOIN tags t ON t.id = mt.tag_id
       WHERE mt.memory_id = ANY($1::uuid[])
       ORDER BY t.name ASC`,
      [memoryIds],
    );
    for (const row of result.rows) {
      const arr = out.get(row.memory_id) ?? [];
      arr.push(row.name);
      out.set(row.memory_id, arr);
    }
    return out;
  }
}
