import { describe, expect, it } from "vitest";
import { assembleVegaLite } from "flint-chart";
import {
  COMPARE_SOURCE_REAL,
  COMPARE_SOURCE_SYNTHETIC,
  calibrationErrorSpec,
  compareToGroupedBarSpec,
  trendLineSpec,
  withSeverityColors,
  distributionToBarSpec,
  hasOrdinalLabels,
  likertToStackedSpec,
  matrixToStackedSpec,
  npsSegmentCounts,
  npsToStackedSpec,
  rankingToStackedSpec,
  sortCountsForDisplay,
  topBoxSummary,
  withReversedColorRamp,
} from "./flint-specs";

const counts = (pairs: [string, number, number][]) =>
  pairs.map(([label, count, pct]) => ({ label, count, pct }));

describe("sortCountsForDisplay", () => {
  it("sorts nominal options by response rate desc", () => {
    const sorted = sortCountsForDisplay(
      counts([["혜택", 3, 30], ["금리", 5, 50], ["앱 편의성", 2, 20]]),
    );
    expect(sorted.map((c) => c.label)).toEqual(["금리", "혜택", "앱 편의성"]);
  });

  it("pins 기타 options last regardless of rate", () => {
    const sorted = sortCountsForDisplay(
      counts([["기타 (직접 입력)", 9, 90], ["혜택", 1, 10]]),
    );
    expect(sorted.map((c) => c.label)).toEqual(["혜택", "기타 (직접 입력)"]);
  });

  it("keeps ordinal-looking sets (labels with digits) in defined order", () => {
    const ordinal = counts([["만 18~29세", 1, 10], ["만 30~39세", 8, 80], ["만 40~49세", 1, 10]]);
    expect(sortCountsForDisplay(ordinal).map((c) => c.label)).toEqual(
      ordinal.map((c) => c.label),
    );
    expect(hasOrdinalLabels(ordinal)).toBe(true);
  });
});

describe("distributionToBarSpec (single/multi — response rate axis)", () => {
  const nominal = counts([["혜택", 3, 30], ["금리", 5, 50], ["기타", 2, 20]]);

  it("encodes pct (응답률) on the value axis, count only as tooltip data", () => {
    const spec = distributionToBarSpec({ counts: nominal });
    expect(spec.chart_spec.encodings).toMatchObject({ y: { field: "option" }, x: { field: "pct" } });
    expect(spec.field_display_names?.pct).toBe("응답률 (%)");
    const values = (spec.data as { values: Record<string, unknown>[] }).values;
    expect(values[0]).toHaveProperty("count");
  });

  it("applies survey ordering (rate desc, 기타 last) to data and sortOrder", () => {
    const spec = distributionToBarSpec({ counts: nominal });
    const values = (spec.data as { values: Record<string, unknown>[] }).values;
    expect(values.map((v) => v.option)).toEqual(["금리", "혜택", "기타"]);
    expect(spec.semantic_types?.option).toMatchObject({ sortOrder: ["금리", "혜택", "기타"] });
  });

  it("keeps 0-count options and assembles without throwing", () => {
    const spec = distributionToBarSpec({ counts: counts([["A", 0, 0], ["B", 2, 100]]) });
    expect((spec.data as { values: unknown[] }).values).toHaveLength(2);
    expect(() => assembleVegaLite(spec)).not.toThrow();
    expect(() => assembleVegaLite(distributionToBarSpec({ counts: [] }))).not.toThrow();
  });
});

describe("topBoxSummary", () => {
  it("uses Top2Box for 5-point scales (counts in scale order)", () => {
    // 1..5 = 10%,10%,20%,40%,20% → top2 = 60%, bottom2 = 20%
    const s = topBoxSummary(counts([["1", 1, 10], ["2", 1, 10], ["3", 2, 20], ["4", 4, 40], ["5", 2, 20]]));
    expect(s).toEqual({ boxSize: 2, boxLabel: "Top2Box", topPct: 60, bottomPct: 20 });
  });

  it("uses Top3Box for 7-point scales", () => {
    const seven = counts([
      ["1", 1, 0], ["2", 0, 0], ["3", 1, 0], ["4", 1, 0], ["5", 2, 0], ["6", 3, 0], ["7", 2, 0],
    ]);
    const s = topBoxSummary(seven);
    expect(s?.boxSize).toBe(3);
    expect(s?.topPct).toBe(70); // (2+3+2)/10
    expect(s?.bottomPct).toBe(20); // (1+0+1)/10
  });

  it("returns null for degenerate scales and 0% on empty data", () => {
    expect(topBoxSummary(counts([["1", 1, 100], ["2", 0, 0]]))).toBeNull();
    const empty = topBoxSummary(counts([["1", 0, 0], ["2", 0, 0], ["3", 0, 0], ["4", 0, 0], ["5", 0, 0]]));
    expect(empty).toMatchObject({ topPct: 0, bottomPct: 0 });
  });
});

describe("likertToStackedSpec", () => {
  const scale = counts([["1", 1, 10], ["2", 1, 10], ["3", 2, 20], ["4", 4, 40], ["5", 2, 20]]);

  it("builds a single-row 100% stack in scale order", () => {
    const spec = likertToStackedSpec({ counts: scale });
    expect(spec.chart_spec.chartType).toBe("Stacked Bar Chart");
    expect(spec.semantic_types?.answer).toMatchObject({ sortOrder: ["1", "2", "3", "4", "5"] });
    const values = (spec.data as { values: Record<string, unknown>[] }).values;
    expect(values.every((v) => v.group === "전체")).toBe(true);
    expect(values.reduce((s, v) => s + (v.pct as number), 0)).toBe(100);
  });

  it("assembles without throwing", () => {
    expect(() => assembleVegaLite(likertToStackedSpec({ counts: scale }))).not.toThrow();
  });
});

describe("npsSegmentCounts / npsToStackedSpec", () => {
  const npsCounts = counts([
    ["0", 1, 10], ["1", 0, 0], ["2", 0, 0], ["3", 0, 0], ["4", 0, 0],
    ["5", 0, 0], ["6", 2, 20], ["7", 3, 30], ["8", 1, 10], ["9", 2, 20], ["10", 1, 10],
  ]);

  it("splits at the 6/7 and 8/9 boundaries", () => {
    expect(npsSegmentCounts(npsCounts)).toEqual([
      { label: "비판자 (0–6)", count: 3, pct: 30 },
      { label: "중립 (7–8)", count: 4, pct: 40 },
      { label: "추천자 (9–10)", count: 3, pct: 30 },
    ]);
  });

  it("handles empty distribution without NaN and assembles", () => {
    expect(npsSegmentCounts([]).every((s) => s.count === 0 && s.pct === 0)).toBe(true);
    expect(() => assembleVegaLite(npsToStackedSpec({ counts: npsCounts }))).not.toThrow();
  });
});

describe("rankingToStackedSpec", () => {
  const dist = {
    avgRanks: [
      { label: "B", avg: 1.4 },
      { label: "A", avg: 1.9 },
      { label: "C", avg: 2.7 },
    ],
    rankPositions: [
      { label: "A", position: 1, count: 2, pct: 40 },
      { label: "A", position: 2, count: 2, pct: 40 },
      { label: "A", position: 3, count: 1, pct: 20 },
      { label: "B", position: 1, count: 3, pct: 60 },
      { label: "B", position: 2, count: 2, pct: 40 },
      { label: "B", position: 3, count: 0, pct: 0 },
      { label: "C", position: 1, count: 0, pct: 0 },
      { label: "C", position: 2, count: 1, pct: 20 },
      { label: "C", position: 3, count: 4, pct: 80 },
    ],
  };

  it("orders rows by average rank (winner first) and ranks 1위→k위", () => {
    const spec = rankingToStackedSpec(dist)!;
    expect(spec.semantic_types?.option).toMatchObject({ sortOrder: ["B", "A", "C"] });
    expect(spec.semantic_types?.rank).toMatchObject({ sortOrder: ["1순위", "2순위", "3순위"] });
  });

  it("returns null without rankPositions (fallback path) and assembles otherwise", () => {
    expect(rankingToStackedSpec({ rankPositions: [] })).toBeNull();
    expect(rankingToStackedSpec({})).toBeNull();
    expect(() => assembleVegaLite(rankingToStackedSpec(dist)!)).not.toThrow();
  });

  it("withReversedColorRamp flips the assembled ramp (1순위 darkest)", () => {
    const vl = withReversedColorRamp(
      assembleVegaLite(rankingToStackedSpec(dist)!) as {
        encoding?: { color?: { scale?: { reverse?: boolean } } };
      },
    );
    expect(vl.encoding?.color?.scale?.reverse).toBe(true);
    // no-op on specs without a color scale
    expect(() => withReversedColorRamp({})).not.toThrow();
  });
});

describe("matrixToStackedSpec", () => {
  const matrix = [
    { row: "속도", n: 3, counts: counts([["만족", 2, 67], ["불만", 1, 33]]) },
    { row: "가격", n: 3, counts: counts([["만족", 1, 33], ["불만", 2, 67]]) },
  ];

  it("emits one cell per row×option with pinned row/column orders", () => {
    const spec = matrixToStackedSpec(matrix)!;
    const values = (spec.data as { values: Record<string, unknown>[] }).values;
    expect(values).toHaveLength(4);
    expect(values[0]).toEqual({ row: "속도", option: "만족", pct: 67, count: 2 });
    expect(spec.semantic_types?.row).toMatchObject({ sortOrder: ["속도", "가격"] });
    expect(spec.semantic_types?.option).toMatchObject({ sortOrder: ["만족", "불만"] });
    expect(spec.chart_spec.chartType).toBe("Stacked Bar Chart");
  });

  it("returns null on empty matrix and assembles otherwise", () => {
    expect(matrixToStackedSpec([])).toBeNull();
    expect(() => assembleVegaLite(matrixToStackedSpec(matrix)!)).not.toThrow();
  });
});

describe("calibrationErrorSpec / trendLineSpec (US-706)", () => {
  it("sorts questions worst-first and tags 20/40% severity", () => {
    const spec = calibrationErrorSpec([
      { questionId: "a", prompt: "A", error: 15 },
      { questionId: "b", prompt: "B", error: 55 },
      { questionId: "c", prompt: "C", error: null },
      { questionId: "d", prompt: "D", error: 30 },
    ])!;
    const values = (spec.data as { values: Record<string, unknown>[] }).values;
    expect(values.map((v) => v.error)).toEqual([55, 30, 15]);
    expect(values.map((v) => v.severity)).toEqual(["높음", "주의", "양호"]);
    expect(() => assembleVegaLite(spec)).not.toThrow();
  });

  it("returns null when no question has an error value", () => {
    expect(calibrationErrorSpec([{ questionId: "a", prompt: "A", error: null }])).toBeNull();
  });

  it("withSeverityColors pins the emerald/yellow/destructive range", () => {
    const vl = withSeverityColors(
      assembleVegaLite(calibrationErrorSpec([{ questionId: "a", prompt: "A", error: 50 }])!) as {
        encoding?: { color?: { scale?: { domain?: string[]; range?: string[] } } };
      },
    );
    expect(vl.encoding?.color?.scale?.domain).toEqual(["양호", "주의", "높음"]);
    expect(vl.encoding?.color?.scale?.range?.[2]).toBe("#ef4444");
  });

  it("trendLineSpec labels rounds R1..Rn and fixes the score domain to 0–100", () => {
    const spec = trendLineSpec([
      { id: "1", score: 62, surveyTitle: "S1", createdAt: "2026-07-01T00:00:00Z", realCount: 10 },
      { id: "2", score: 74, surveyTitle: "S2", createdAt: "2026-07-08T00:00:00Z", realCount: 12 },
    ])!;
    const values = (spec.data as { values: Record<string, unknown>[] }).values;
    expect(values.map((v) => v.round)).toEqual(["R1", "R2"]);
    expect(spec.semantic_types?.score).toMatchObject({ intrinsicDomain: [0, 100] });
    expect(() => assembleVegaLite(spec)).not.toThrow();
    expect(trendLineSpec([])).toBeNull();
  });
});

describe("compareToGroupedBarSpec", () => {
  const real = { counts: counts([["A", 6, 60], ["B", 4, 40]]) };
  const synthetic = { counts: counts([["A", 20, 20], ["B", 80, 80]]) };

  it("emits a real/synthetic pct pair per option", () => {
    const spec = compareToGroupedBarSpec(real, synthetic);
    const values = (spec.data as { values: Record<string, unknown>[] }).values;
    expect(values).toEqual([
      { option: "A", source: COMPARE_SOURCE_REAL, pct: 60 },
      { option: "A", source: COMPARE_SOURCE_SYNTHETIC, pct: 20 },
      { option: "B", source: COMPARE_SOURCE_REAL, pct: 40 },
      { option: "B", source: COMPARE_SOURCE_SYNTHETIC, pct: 80 },
    ]);
  });

  it("uses pct (not count) so differing n cannot mislead", () => {
    const spec = compareToGroupedBarSpec(real, synthetic);
    expect(spec.chart_spec.encodings).toMatchObject({ x: { field: "pct" } });
  });

  it("fills 0 for options missing from the synthetic side and assembles", () => {
    const spec = compareToGroupedBarSpec(real, { counts: counts([["A", 1, 100]]) });
    const values = (spec.data as { values: Record<string, unknown>[] }).values;
    const bSyn = values.find((r) => r.option === "B" && r.source === COMPARE_SOURCE_SYNTHETIC);
    expect(bSyn?.pct).toBe(0);
    expect(() => assembleVegaLite(compareToGroupedBarSpec(real, synthetic))).not.toThrow();
  });
});
