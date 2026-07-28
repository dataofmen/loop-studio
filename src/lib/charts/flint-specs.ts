/**
 * Pure Distribution → Flint ChartAssemblyInput mapping. No DB, React, or Next
 * imports — client-safe (interview-core.ts convention). Rendering happens in
 * flint-chart.tsx (assembleVegaLite + vega-embed); this module only builds
 * specs, so it stays unit-testable and the heavy chart bundle stays lazy.
 *
 * Chart choices follow survey-reporting conventions, not generic dataviz —
 * see tasks/research-survey-viz.md (Evergreen ch.5, Heiberger & Robbins):
 * value axes are response rates (% of respondents, counts in tooltips),
 * Likert scales headline a Top-Box positive rate over a 100% stacked bar,
 * rankings show rank composition, matrix grids stack per row.
 */

import type { ChartAssemblyInput } from "flint-chart/core";
import type { Distribution } from "@/lib/distribution-core";

export const CHART_BASE_SIZE = { width: 720, height: 240 };
/** Console column is max-w-4xl (~896px, card padding 내부 ~840px); never stretch past it. */
export const CHART_CANVAS_SIZE = { width: 840, height: 480 };
const SINGLE_ROW_SIZE = { base: { width: 720, height: 96 }, canvas: { width: 840, height: 160 } };

const COMMON_OPTIONS = { addTooltips: true } as const;

type CountRow = { label: string; count: number; pct: number };

/** Option sets whose order carries meaning (scales, age/income bands…) — a
 * digit in any label is the practical tell. Re-sorting those misleads. */
export function hasOrdinalLabels(counts: CountRow[]): boolean {
  return counts.length > 0 && counts.some((c) => /\d/.test(c.label));
}

const OTHER_LABEL = /^\s*기타/;

/**
 * Survey-report ordering: nominal options sort by response rate (desc) with
 * "기타…" pinned last; ordinal-looking sets keep their defined order.
 */
export function sortCountsForDisplay(counts: CountRow[]): CountRow[] {
  if (hasOrdinalLabels(counts)) return [...counts];
  const others = counts.filter((c) => OTHER_LABEL.test(c.label));
  const rest = counts.filter((c) => !OTHER_LABEL.test(c.label));
  rest.sort((a, b) => b.pct - a.pct || b.count - a.count);
  return [...rest, ...others];
}

/**
 * single/multi as horizontal bars over the response rate (% of respondents).
 * multi rates can sum past 100% — the panel adds the multi-select caption.
 */
export function distributionToBarSpec(dist: Pick<Distribution, "counts">): ChartAssemblyInput {
  const ordered = sortCountsForDisplay(dist.counts);
  const rows = ordered.map((c) => ({ option: c.label, pct: c.pct, count: c.count }));
  return {
    data: { values: rows },
    semantic_types: {
      option: { semanticType: "Category", sortOrder: ordered.map((c) => c.label) },
      pct: "Percentage",
      count: "Quantity",
    },
    field_display_names: { option: "보기", pct: "응답률 (%)", count: "응답 수" },
    chart_spec: {
      chartType: "Bar Chart",
      encodings: { y: { field: "option" }, x: { field: "pct" } },
      baseSize: CHART_BASE_SIZE,
      canvasSize: CHART_CANVAS_SIZE,
    },
    options: { ...COMMON_OPTIONS },
  };
}

/**
 * Top-Box summary for Likert/rating scales: the positive share (headline
 * metric in survey reporting) plus the same-width negative share. 5-point and
 * shorter scales use Top2Box, 6-point and longer use Top3Box.
 */
export function topBoxSummary(counts: CountRow[]): {
  boxSize: number;
  boxLabel: string;
  topPct: number;
  bottomPct: number;
} | null {
  const k = counts.length;
  if (k < 3) return null;
  const boxSize = k >= 6 ? 3 : 2;
  const total = counts.reduce((s, c) => s + c.count, 0);
  const sum = (rows: CountRow[]) => rows.reduce((s, c) => s + c.count, 0);
  // counts arrive in scale order (min..max) from distribution-core.
  const top = sum(counts.slice(k - boxSize));
  const bottom = sum(counts.slice(0, boxSize));
  return {
    boxSize,
    boxLabel: `Top${boxSize}Box`,
    topPct: total ? Math.round((top / total) * 100) : 0,
    bottomPct: total ? Math.round((bottom / total) * 100) : 0,
  };
}

/**
 * Likert/rating scale as a single-row 100% stacked bar in scale order with a
 * sequential ramp (stronger answer = darker). Top-Box headline is rendered by
 * the panel via topBoxSummary().
 */
export function likertToStackedSpec(dist: Pick<Distribution, "counts">): ChartAssemblyInput {
  const rows = dist.counts.map((c) => ({
    group: "전체",
    answer: c.label,
    pct: c.pct,
    count: c.count,
  }));
  return {
    data: { values: rows },
    semantic_types: {
      group: "Category",
      answer: { semanticType: "Category", sortOrder: dist.counts.map((c) => c.label) },
      pct: "Percentage",
      count: "Quantity",
    },
    field_display_names: { group: "", answer: "응답", pct: "응답률 (%)", count: "응답 수" },
    chart_spec: {
      chartType: "Stacked Bar Chart",
      encodings: {
        y: { field: "group" },
        x: { field: "pct" },
        color: { field: "answer", scheme: "blues" },
      },
      baseSize: SINGLE_ROW_SIZE.base,
      canvasSize: SINGLE_ROW_SIZE.canvas,
    },
    options: { ...COMMON_OPTIONS },
  };
}

/** NPS segments derived from the 0–10 counts distribution (boundaries: ≤6, 7–8, ≥9). */
export const NPS_SEGMENTS = [
  { key: "detractor", label: "비판자 (0–6)", min: 0, max: 6 },
  { key: "passive", label: "중립 (7–8)", min: 7, max: 8 },
  { key: "promoter", label: "추천자 (9–10)", min: 9, max: 10 },
] as const;

export function npsSegmentCounts(
  counts: CountRow[],
): { label: string; count: number; pct: number }[] {
  const total = counts.reduce((s, c) => s + c.count, 0);
  return NPS_SEGMENTS.map((seg) => {
    const count = counts.reduce((s, c) => {
      const v = Number(c.label);
      return Number.isFinite(v) && v >= seg.min && v <= seg.max ? s + c.count : s;
    }, 0);
    return { label: seg.label, count, pct: total ? Math.round((count / total) * 100) : 0 };
  });
}

/** NPS as a single-row horizontal stacked bar: detractor/passive/promoter shares. */
export function npsToStackedSpec(dist: Pick<Distribution, "counts">): ChartAssemblyInput {
  const segs = npsSegmentCounts(dist.counts);
  const rows = segs.map((s) => ({ group: "전체", segment: s.label, pct: s.pct, count: s.count }));
  return {
    data: { values: rows },
    semantic_types: {
      group: "Category",
      segment: { semanticType: "Category", sortOrder: segs.map((s) => s.label) },
      pct: "Percentage",
      count: "Quantity",
    },
    field_display_names: { group: "", segment: "구간", pct: "응답률 (%)", count: "응답 수" },
    chart_spec: {
      chartType: "Stacked Bar Chart",
      encodings: { y: { field: "group" }, x: { field: "pct" }, color: { field: "segment" } },
      baseSize: SINGLE_ROW_SIZE.base,
      canvasSize: SINGLE_ROW_SIZE.canvas,
    },
    options: { ...COMMON_OPTIONS },
  };
}

/**
 * Ranking as rank-composition 100% stacked bars: each option row shows how
 * its received ranks distribute (base = times that option was ranked). Rows
 * are ordered by average rank (winner on top); avg rank stays as a caption.
 */
export function rankingToStackedSpec(
  dist: Pick<Distribution, "rankPositions"> & {
    avgRanks?: { label: string; avg: number }[];
  },
): ChartAssemblyInput | null {
  const positions = dist.rankPositions ?? [];
  if (positions.length === 0) return null;
  const rowOrder = (dist.avgRanks ?? []).map((r) => r.label);
  const posLabels = [...new Set(positions.map((p) => p.position))]
    .sort((a, b) => a - b)
    .map((p) => `${p}순위`);
  const rows = positions.map((p) => ({
    option: p.label,
    rank: `${p.position}순위`,
    pct: p.pct,
    count: p.count,
  }));
  return {
    data: { values: rows },
    semantic_types: {
      option: { semanticType: "Category", sortOrder: rowOrder },
      rank: { semanticType: "Category", sortOrder: posLabels },
      pct: "Percentage",
      count: "Quantity",
    },
    field_display_names: { option: "보기", rank: "순위", pct: "응답률 (%)", count: "응답 수" },
    chart_spec: {
      chartType: "Stacked Bar Chart",
      encodings: {
        y: { field: "option" },
        x: { field: "pct" },
        color: { field: "rank", scheme: "blues" },
      },
      baseSize: CHART_BASE_SIZE,
      canvasSize: CHART_CANVAS_SIZE,
    },
    options: { ...COMMON_OPTIONS },
  };
}

/**
 * Matrix (grid) as per-row 100% stacked bars — the survey-report standard for
 * items sharing one scale (not a heatmap). Column order and colors follow the
 * defined column order.
 */
export function matrixToStackedSpec(
  matrix: NonNullable<Distribution["matrix"]>,
): ChartAssemblyInput | null {
  if (matrix.length === 0) return null;
  const rowOrder = matrix.map((r) => r.row);
  const colOrder = matrix[0]?.counts.map((c) => c.label) ?? [];
  const rows: Record<string, unknown>[] = [];
  for (const r of matrix) {
    for (const c of r.counts) {
      rows.push({ row: r.row, option: c.label, pct: c.pct, count: c.count });
    }
  }
  return {
    data: { values: rows },
    semantic_types: {
      row: { semanticType: "Category", sortOrder: rowOrder },
      option: { semanticType: "Category", sortOrder: colOrder },
      pct: "Percentage",
      count: "Quantity",
    },
    field_display_names: { row: "항목", option: "응답", pct: "응답률 (%)", count: "응답 수" },
    chart_spec: {
      chartType: "Stacked Bar Chart",
      encodings: {
        y: { field: "row" },
        x: { field: "pct" },
        color: { field: "option", scheme: "blues" },
      },
      baseSize: CHART_BASE_SIZE,
      canvasSize: CHART_CANVAS_SIZE,
    },
    options: { ...COMMON_OPTIONS },
  };
}

/**
 * Explicit tooltip channel listing every data field with its Korean display
 * name (mark.tooltip=true only surfaces encoded channels, dropping 응답 수).
 * Applied by FlintChart onto the assembled Vega-Lite spec.
 */
export function tooltipEncoding(
  input: ChartAssemblyInput,
): { field: string; title: string; type: "quantitative" | "nominal" }[] {
  const values = "values" in input.data ? input.data.values : [];
  const sample = values?.[0];
  if (!sample) return [];
  const names = input.field_display_names ?? {};
  return Object.keys(sample)
    .filter((f) => (names[f] ?? f) !== "") // skip synthetic axis fields (e.g. group="전체")
    .map((f) => ({
      field: f,
      title: names[f] ?? f,
      type: typeof (sample as Record<string, unknown>)[f] === "number" ? "quantitative" : "nominal",
    }));
}

/** Calibration severity thresholds (existing panel convention: 20/40%). */
export function calibrationSeverity(error: number): "양호" | "주의" | "높음" {
  if (error <= 20) return "양호";
  if (error <= 40) return "주의";
  return "높음";
}

export const SEVERITY_COLOR_RANGE: Record<"양호" | "주의" | "높음", string> = {
  양호: "#10b981", // emerald-500
  주의: "#eab308", // yellow-500
  높음: "#ef4444", // red-500 (destructive)
};

/**
 * Calibration error per question as horizontal bars, worst first, colored by
 * the 20/40% severity convention (색상은 withSeverityColors 패치로 고정).
 */
export function calibrationErrorSpec(
  perQuestion: { questionId: string; prompt: string; error: number | null | undefined }[],
): ChartAssemblyInput | null {
  const rows = perQuestion
    .filter((q): q is { questionId: string; prompt: string; error: number } => q.error != null)
    .map((q, i) => ({
      question: `${i + 1}. ${q.prompt}`,
      error: q.error,
      severity: calibrationSeverity(q.error),
    }))
    .sort((a, b) => b.error - a.error);
  if (rows.length === 0) return null;
  return {
    data: { values: rows },
    semantic_types: {
      question: { semanticType: "Category", sortOrder: rows.map((r) => r.question) },
      error: "Percentage",
      severity: {
        semanticType: "Category",
        sortOrder: ["양호", "주의", "높음"],
      },
    },
    field_display_names: { question: "문항", error: "오차 (%)", severity: "판정" },
    chart_spec: {
      chartType: "Bar Chart",
      encodings: {
        y: { field: "question" },
        x: { field: "error" },
        color: { field: "severity" },
      },
      baseSize: CHART_BASE_SIZE,
      canvasSize: CHART_CANVAS_SIZE,
    },
    options: { ...COMMON_OPTIONS },
  };
}

/** Post-assembly patch pinning severity colors (emerald/yellow/destructive). */
export function withSeverityColors<T>(vlSpec: T): T {
  const spec = vlSpec as { encoding?: { color?: { scale?: Record<string, unknown> } } };
  if (spec?.encoding?.color) {
    spec.encoding.color.scale = {
      domain: Object.keys(SEVERITY_COLOR_RANGE),
      range: Object.values(SEVERITY_COLOR_RANGE),
    };
  }
  return vlSpec;
}

/**
 * Calibration score trend across rounds as a line chart (y fixed to 0–100 via
 * intrinsicDomain so a flat 60-ish run can't masquerade as a climb).
 */
export function trendLineSpec(
  trend: { id: string; score: number; surveyTitle: string; createdAt: string; realCount: number }[],
): ChartAssemblyInput | null {
  if (trend.length === 0) return null;
  const rows = trend.map((p, i) => ({
    round: `R${i + 1}`,
    score: p.score,
    survey: p.surveyTitle,
    date: p.createdAt.slice(0, 10),
    real: p.realCount,
  }));
  return {
    data: { values: rows },
    semantic_types: {
      round: { semanticType: "Category", sortOrder: rows.map((r) => r.round) },
      score: { semanticType: "Quantity", intrinsicDomain: [0, 100] },
      survey: "Category",
      date: "Category",
      real: "Quantity",
    },
    field_display_names: {
      round: "라운드",
      score: "보정 점수",
      survey: "설문",
      date: "일자",
      real: "실제 응답",
    },
    chart_spec: {
      chartType: "Line Chart",
      encodings: { x: { field: "round" }, y: { field: "score" } },
      baseSize: CHART_BASE_SIZE,
      canvasSize: CHART_CANVAS_SIZE,
    },
    options: { ...COMMON_OPTIONS },
  };
}

/**
 * Post-assembly patch: reverse a sequential color ramp so the FIRST category
 * gets the darkest shade (survey convention: 1순위/strongest answer darkest —
 * Evergreen ch.5). Flint's encoding-level `scheme` cannot express reversal,
 * so this operates on the assembled Vega-Lite spec (still pure JSON-in/out).
 */
export function withReversedColorRamp<T>(vlSpec: T): T {
  const spec = vlSpec as { encoding?: { color?: { scale?: Record<string, unknown> } } };
  if (spec?.encoding?.color?.scale) {
    spec.encoding.color.scale = { ...spec.encoding.color.scale, reverse: true };
  }
  return vlSpec;
}

/**
 * Real vs synthetic comparison as a Grouped Bar. Percent-based on purpose:
 * real/synthetic n differ, so raw counts would mislead.
 */
export const COMPARE_SOURCE_REAL = "실제";
export const COMPARE_SOURCE_SYNTHETIC = "합성";

/** App color convention for the compare mode: real=primary(indigo), synthetic=purple. */
export const COMPARE_COLOR_RANGE = ["#4f46e5", "#c084fc"];

/**
 * Post-assembly patch pinning the real/synthetic colors to the app convention
 * (Flint's encoding scheme can't fix an explicit range; pure JSON-in/out).
 */
export function withCompareColors<T>(vlSpec: T): T {
  const spec = vlSpec as { encoding?: { color?: { scale?: Record<string, unknown> } } };
  if (spec?.encoding?.color) {
    spec.encoding.color.scale = {
      domain: [COMPARE_SOURCE_REAL, COMPARE_SOURCE_SYNTHETIC],
      range: COMPARE_COLOR_RANGE,
    };
  }
  return vlSpec;
}

export function compareToGroupedBarSpec(
  real: Pick<Distribution, "counts">,
  synthetic: Pick<Distribution, "counts">,
): ChartAssemblyInput {
  const synByLabel = new Map(synthetic.counts.map((c) => [c.label, c]));
  const ordered = sortCountsForDisplay(real.counts);
  const rows: Record<string, unknown>[] = [];
  for (const c of ordered) {
    rows.push({ option: c.label, source: COMPARE_SOURCE_REAL, pct: c.pct });
    rows.push({
      option: c.label,
      source: COMPARE_SOURCE_SYNTHETIC,
      pct: synByLabel.get(c.label)?.pct ?? 0,
    });
  }
  return {
    data: { values: rows },
    semantic_types: {
      option: { semanticType: "Category", sortOrder: ordered.map((c) => c.label) },
      source: {
        semanticType: "Category",
        sortOrder: [COMPARE_SOURCE_REAL, COMPARE_SOURCE_SYNTHETIC],
      },
      pct: "Percentage",
    },
    field_display_names: { option: "보기", source: "출처", pct: "응답률 (%)" },
    chart_spec: {
      chartType: "Grouped Bar Chart",
      encodings: { y: { field: "option" }, x: { field: "pct" }, group: { field: "source" } },
      baseSize: CHART_BASE_SIZE,
      canvasSize: CHART_CANVAS_SIZE,
    },
    options: { ...COMMON_OPTIONS },
  };
}
