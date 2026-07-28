/**
 * US-001 (construct-loop-review): pure cross-survey aggregation of one
 * construct's member questions — no DB / IO (DB entry point lives in
 * construct-analytics.ts). Ground-truth rule: only REAL responses
 * (isSynthetic=false) feed the stats; synthetic rows are counted separately
 * so the UI can say "합성만 있음".
 *
 * Type-mixing guardrails (the run's #1 risk):
 *  - scale/nps: numeric integration — per-question mean + weighted overall
 *    mean, but ONLY within the same (type, scale-range) group. A 1–5 scale is
 *    never averaged with a 0–10 NPS.
 *  - single/multi/ranking/matrix: distributions stay parallel per
 *    survey·question — labels are NEVER summed across surveys.
 *  - open: answered counts only.
 */

import {
  answerValues,
  computeQuestionDistribution,
  type Distribution,
  type QConfig,
  type QuestionType,
} from "@/lib/distribution-core";

/** One question tagged with the construct, plus its survey context. */
export type ConstructMemberQuestion = {
  questionId: string;
  quid: string;
  type: QuestionType;
  prompt: string;
  config: QConfig;
  surveyId: string;
  surveyTitle: string;
  /** ISO timestamp — members arrive survey-createdAt ascending for trends. */
  surveyCreatedAt: string;
};

export type ConstructResponseRow = {
  surveyId: string;
  isSynthetic: boolean;
  answers: Record<string, unknown>;
};

/** Per-question result: member context + its real-response distribution. */
export type ConstructQuestionResult = Omit<ConstructMemberQuestion, "config"> & {
  distribution: Distribution;
  /** Comparable-group key for numeric questions (e.g. "scale 1–5"); undefined otherwise. */
  scaleKey?: string;
};

/** Weighted mean over one comparable numeric group (same type + range). */
export type NumericOverall = {
  /** e.g. "scale 1–5", "nps 0–10" — questions are only pooled within a key. */
  scaleKey: string;
  mean: number | null;
  /** Total real answers backing the mean. */
  n: number;
};

export type ConstructAggregate = {
  /** Real responses answering ≥1 member question — the ground-truth base. */
  realResponseCount: number;
  /** Synthetic responses answering ≥1 member question (display-only). */
  syntheticResponseCount: number;
  /** scale/nps — numeric integration. */
  numeric: { perQuestion: ConstructQuestionResult[]; overall: NumericOverall[] };
  /** single/multi/ranking/matrix — parallel per survey·question, never merged. */
  choice: { perQuestion: ConstructQuestionResult[] };
  /** open — answered counts only. */
  open: { perQuestion: ConstructQuestionResult[] };
};

const NUMERIC_TYPES: QuestionType[] = ["scale", "nps"];
const OPEN_TYPES: QuestionType[] = ["open"];

function scaleKey(q: ConstructMemberQuestion): string {
  if (q.type === "nps") return "nps 0–10";
  const s = q.config.scale ?? { min: 1, max: 5 };
  return `scale ${s.min}–${s.max}`;
}

function answeredSomething(answers: Record<string, unknown>, ids: string[]): boolean {
  return ids.some((id) => {
    const v = answers[id];
    return v !== undefined && v !== null && v !== "";
  });
}

/**
 * Aggregate one construct's member questions over response rows.
 * Synthetic rows never enter any statistic — they are only tallied for the
 * syntheticResponseCount so callers can distinguish "no data at all" from
 * "synthetic only".
 */
export function aggregateConstructStats(
  members: ConstructMemberQuestion[],
  responses: ConstructResponseRow[],
): ConstructAggregate {
  const idsBySurvey = new Map<string, string[]>();
  for (const m of members) {
    const list = idsBySurvey.get(m.surveyId) ?? [];
    list.push(m.questionId);
    idsBySurvey.set(m.surveyId, list);
  }

  const real = responses.filter((r) => !r.isSynthetic);
  const realBySurvey = new Map<string, ConstructResponseRow[]>();
  for (const r of real) {
    const list = realBySurvey.get(r.surveyId) ?? [];
    list.push(r);
    realBySurvey.set(r.surveyId, list);
  }

  const countTouching = (rows: ConstructResponseRow[]) =>
    rows.filter((r) => answeredSomething(r.answers, idsBySurvey.get(r.surveyId) ?? []))
      .length;

  const results: ConstructQuestionResult[] = members.map((m) => {
    const rows = realBySurvey.get(m.surveyId) ?? [];
    const values = answerValues(rows, m.questionId);
    const { config: _config, ...rest } = m;
    return {
      ...rest,
      distribution: computeQuestionDistribution(
        { id: m.questionId, type: m.type, prompt: m.prompt, config: m.config },
        values,
      ),
      scaleKey: NUMERIC_TYPES.includes(m.type) ? scaleKey(m) : undefined,
    };
  });

  const numericPer = results.filter((r) => NUMERIC_TYPES.includes(r.type));
  const openPer = results.filter((r) => OPEN_TYPES.includes(r.type));
  const choicePer = results.filter(
    (r) => !NUMERIC_TYPES.includes(r.type) && !OPEN_TYPES.includes(r.type),
  );

  // Weighted overall mean per comparable group (same type + scale range).
  const groups = new Map<string, { sum: number; n: number }>();
  for (const m of members) {
    if (!NUMERIC_TYPES.includes(m.type)) continue;
    const r = results.find((x) => x.questionId === m.questionId)!;
    const { n, mean } = r.distribution;
    if (!n || mean == null) continue;
    const key = scaleKey(m);
    const g = groups.get(key) ?? { sum: 0, n: 0 };
    g.sum += mean * n;
    g.n += n;
    groups.set(key, g);
  }
  const overall: NumericOverall[] = [...groups.entries()].map(([key, g]) => ({
    scaleKey: key,
    mean: g.n ? Math.round((g.sum / g.n) * 100) / 100 : null,
    n: g.n,
  }));

  return {
    realResponseCount: countTouching(real),
    syntheticResponseCount: countTouching(responses.filter((r) => r.isSynthetic)),
    numeric: { perQuestion: numericPer, overall },
    choice: { perQuestion: choicePer },
    open: { perQuestion: openPer },
  };
}
