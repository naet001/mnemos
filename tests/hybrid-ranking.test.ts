import { describe, expect, it } from "vitest";
import { rrfFuse } from "../src/services/hybrid-ranking.js";

describe("rrfFuse", () => {
  it("sums reciprocal ranks across legs", () => {
    const fused = rrfFuse(
      [[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]],
      60,
    );
    expect(fused[0].id).toBe("b"); // in both legs → highest fused score
    const b = fused.find((f) => f.id === "b")!;
    expect(b.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it("prefers documents present in both legs", () => {
    // leg2 = [x0..x8, solo]: x0 is rank 1 in both legs and must fuse highest.
    const legA = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}` }));
    const fused = rrfFuse([legA, [...legA.slice(0, 9), { id: "solo" }]], 1);
    expect(fused[0].id).toBe("x0");
  });

  it("handles empty and single legs", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
    const one = rrfFuse([[{ id: "z" }]]);
    expect(one).toHaveLength(1);
    expect(one[0].score).toBeCloseTo(1 / 61, 10);
  });

  it("is deterministic on score ties (first appearance, then id)", () => {
    const fused = rrfFuse(
      [[{ id: "b" }, { id: "a" }], [{ id: "c" }, { id: "d" }]],
      60,
    );
    // all four tie at rank 1 (1/61) or rank 2 (1/62)
    expect(fused.filter((f) => f.score > 1 / 62).map((f) => f.id)).toEqual(["b", "c"]);
    expect(fused.map((f) => f.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("respects the k parameter", () => {
    const fused = rrfFuse([[{ id: "a" }]], 0);
    expect(fused[0].score).toBeCloseTo(1, 10);
  });
});
