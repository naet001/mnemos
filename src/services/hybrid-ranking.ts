export interface RankedCandidate {
  id: string;
  score: number;
}

// Reciprocal Rank Fusion (SPEC §6.5/§9.2): score(d) = Σ 1/(k + rank(d)),
// rank is 1-based per leg. A document appearing in multiple legs beats one
// ranked top in a single leg, and no raw score scale is needed across legs.
// Tie-break: first appearance across legs, then id — fully deterministic.
export function rrfFuse(
  legs: ReadonlyArray<ReadonlyArray<{ id: string }>>,
  k = 60,
): RankedCandidate[] {
  const totals = new Map<string, { score: number; firstSeen: number }>();

  let seen = 0;
  for (const leg of legs) {
    for (let rank = 0; rank < leg.length; rank++) {
      const { id } = leg[rank];
      seen += 1;
      const contribution = 1 / (k + rank + 1);
      const existing = totals.get(id);
      if (existing) {
        existing.score += contribution;
      } else {
        totals.set(id, { score: contribution, firstSeen: seen });
      }
    }
  }

  return Array.from(totals.entries())
    .map(([id, entry]) => ({ id, score: entry.score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const firstA = totals.get(a.id)!.firstSeen;
      const firstB = totals.get(b.id)!.firstSeen;
      if (firstA !== firstB) return firstA - firstB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
