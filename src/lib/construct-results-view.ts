/**
 * US-002 (construct-loop-review): pure view model for the /constructs
 * "결과 보기" panel — no DB / IO. Turns a ConstructAggregate (US-001) into
 * render-ready groups:
 *  - numeric (scale/nps): one trend group per comparable scaleKey — overall
 *    weighted mean + per-question points in survey-createdAt order.
 *  - choice: distributions stay parallel per survey·question (never merged).
 *  - open: answered counts only.
 * Status distinguishes "no real responses at all" from "synthetic only" so
 * the UI can label ground-truth absence explicitly.
 */

import type {
  ConstructAggregate,
  ConstructQuestionResult,
  NumericOverall,
} from "@/lib/construct-stats";

export type ConstructResultsStatus =
  | "no-questions" // construct has no member questions
  | "no-responses" // members exist but zero responses of any kind
  | "synthetic-only" // only synthetic rows — nothing enters the stats
  | "real"; // has ground truth

export type NumericTrendPoint = {
  surveyId: string;
  surveyTitle: string;
  /** ISO timestamp of the survey (points are ordered by this, ascending). */
  surveyCreatedAt: string;
  quid: string;
  prompt: string;
  mean: number | null;
  n: number;
};

export type NumericTrendGroup = {
  scaleKey: string;
  overall: NumericOverall;
  points: NumericTrendPoint[];
};

export type ConstructResultsView = {
  status: ConstructResultsStatus;
  realResponseCount: number;
  syntheticResponseCount: number;
  numericGroups: NumericTrendGroup[];
  /** single/multi/ranking/matrix — per survey·question, survey-time order. */
  choice: ConstructQuestionResult[];
  open: { quid: string; prompt: string; surveyTitle: string; answered: number }[];
};

function toPoint(r: ConstructQuestionResult): NumericTrendPoint {
  return {
    surveyId: r.surveyId,
    surveyTitle: r.surveyTitle,
    surveyCreatedAt: r.surveyCreatedAt,
    quid: r.quid,
    prompt: r.prompt,
    mean: r.distribution.mean ?? null,
    n: r.distribution.n,
  };
}

export function buildConstructResultsView(
  memberCount: number,
  agg: ConstructAggregate,
): ConstructResultsView {
  const status: ConstructResultsStatus =
    memberCount === 0
      ? "no-questions"
      : agg.realResponseCount > 0
        ? "real"
        : agg.syntheticResponseCount > 0
          ? "synthetic-only"
          : "no-responses";

  // Group numeric per-question results by comparable scaleKey; input arrives
  // survey-createdAt ascending, and grouping preserves that order per group.
  const byKey = new Map<string, NumericTrendPoint[]>();
  for (const r of agg.numeric.perQuestion) {
    const key = r.scaleKey ?? "scale ?";
    const list = byKey.get(key) ?? [];
    list.push(toPoint(r));
    byKey.set(key, list);
  }
  const numericGroups: NumericTrendGroup[] = [...byKey.entries()].map(([scaleKey, points]) => ({
    scaleKey,
    overall:
      agg.numeric.overall.find((o) => o.scaleKey === scaleKey) ??
      { scaleKey, mean: null, n: 0 },
    points,
  }));

  return {
    status,
    realResponseCount: agg.realResponseCount,
    syntheticResponseCount: agg.syntheticResponseCount,
    numericGroups,
    choice: agg.choice.perQuestion,
    open: agg.open.perQuestion.map((r) => ({
      quid: r.quid,
      prompt: r.prompt,
      surveyTitle: r.surveyTitle,
      answered: r.distribution.answered ?? 0,
    })),
  };
}

/** "2026-07-04T…" → "2026-07-04" (pure, for point labels). */
export function shortDate(iso: string): string {
  return iso.slice(0, 10);
}
