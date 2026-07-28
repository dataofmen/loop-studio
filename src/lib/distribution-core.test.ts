import { describe, expect, it } from "vitest";
import { computeQuestionDistribution } from "./distribution-core";

const rankingQ = {
  id: "q1",
  type: "ranking" as const,
  prompt: "선호 순위",
  config: { options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
};

describe("computeQuestionDistribution — ranking rankPositions (US-704)", () => {
  it("tallies per-option rank composition with per-option base", () => {
    const d = computeQuestionDistribution(rankingQ, [
      ["A", "B", "C"],
      ["B", "A", "C"],
      ["A", "C", "B"],
    ]);
    const a1 = d.rankPositions!.find((p) => p.label === "A" && p.position === 1);
    const a2 = d.rankPositions!.find((p) => p.label === "A" && p.position === 2);
    expect(a1).toMatchObject({ count: 2, pct: 67 });
    expect(a2).toMatchObject({ count: 1, pct: 33 });
    // every ranked option gets a cell for every observed position (0-filled)
    expect(d.rankPositions!.filter((p) => p.label === "C")).toHaveLength(3);
    const cPcts = d.rankPositions!.filter((p) => p.label === "C").map((p) => p.pct);
    expect(cPcts.reduce((s, x) => s + x, 0)).toBeGreaterThanOrEqual(99);
  });

  it("supports partial rankings (limit < options): shorter arrays, smaller bases", () => {
    const d = computeQuestionDistribution(rankingQ, [
      ["A", "B"],
      ["B", "A"],
    ]);
    // max observed position is 2 → no position-3 cells
    expect(d.rankPositions!.every((p) => p.position <= 2)).toBe(true);
    // C was never ranked → excluded entirely (same rule as avgRanks)
    expect(d.rankPositions!.some((p) => p.label === "C")).toBe(false);
  });

  it("keeps existing fields intact (counts=#1 picks, avgRanks best-first)", () => {
    const d = computeQuestionDistribution(rankingQ, [
      ["A", "B", "C"],
      ["A", "C", "B"],
      ["B", "A", "C"],
    ]);
    expect(d.counts.find((c) => c.label === "A")?.count).toBe(2);
    expect(d.avgRanks?.[0]?.label).toBe("A");
    expect(d.n).toBe(3);
  });

  it("returns empty rankPositions when no one answered", () => {
    const d = computeQuestionDistribution(rankingQ, []);
    expect(d.rankPositions).toEqual([]);
  });
});
