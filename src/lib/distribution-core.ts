/**
 * Pure per-question distribution math, extracted from quality.ts so both the
 * per-survey report (computeDistributions) and cross-survey construct
 * aggregation (construct-stats.ts) share one implementation — and so the
 * logic is unit-testable without a DB import. No IO here.
 */

import { openAnswerText } from "@/lib/open-answer";
import { optionLabels, type ConfigOption } from "@/lib/question-config";

export type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";

export type QConfig = {
  options?: ConfigOption[];
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  rows?: string[];
  columns?: string[];
  limit?: number;
};

export type QRow = { id: string; type: QuestionType; order: number; prompt: string; config: QConfig };

export type Distribution = {
  questionId: string;
  type: QuestionType;
  prompt: string;
  n: number;
  /** option/value -> count, for single/multi/scale/nps (and aggregate column dist for matrix) */
  counts: { label: string; count: number; pct: number }[];
  /** scale/nps mean; for ranking, omitted (see avgRanks) */
  mean?: number;
  /** open only */
  answered?: number;
  /** nps only: Net Promoter Score = %promoters − %detractors (−100..100) */
  npsScore?: number;
  /** ranking only: average rank per option (1 = best); sorted best-first */
  avgRanks?: { label: string; avg: number }[];
  /**
   * ranking only: per option, how its received ranks distribute (1-based
   * position). pct base = times that option was ranked, so each option's
   * positions sum to ~100% — feeds the rank-composition stacked bar.
   */
  rankPositions?: { label: string; position: number; count: number; pct: number }[];
  /** matrix only: per-row column distribution */
  matrix?: { row: string; n: number; counts: { label: string; count: number; pct: number }[] }[];
};

/**
 * Distribution of one question over its (already extracted, non-empty)
 * answer values. Moved verbatim from quality.ts computeDistributions.
 */
export function computeQuestionDistribution(
  q: Pick<QRow, "id" | "type" | "prompt" | "config">,
  values: unknown[],
): Distribution {
  const n = values.length;

  if (q.type === "single") {
    const tally = new Map<string, number>();
    for (const opt of optionLabels(q.config.options)) tally.set(opt, 0);
    for (const v of values) tally.set(String(v), (tally.get(String(v)) ?? 0) + 1);
    return { questionId: q.id, type: q.type, prompt: q.prompt, n, counts: toCounts(tally, n) };
  } else if (q.type === "multi") {
    const tally = new Map<string, number>();
    for (const opt of optionLabels(q.config.options)) tally.set(opt, 0);
    for (const v of values) for (const x of Array.isArray(v) ? v : [v]) tally.set(String(x), (tally.get(String(x)) ?? 0) + 1);
    return { questionId: q.id, type: q.type, prompt: q.prompt, n, counts: toCounts(tally, n) };
  } else if (q.type === "scale") {
    const s = q.config.scale ?? { min: 1, max: 5 };
    const tally = new Map<string, number>();
    for (let i = s.min; i <= s.max; i++) tally.set(String(i), 0);
    let sum = 0;
    for (const v of values) {
      const num = Math.round(Number(v));
      tally.set(String(num), (tally.get(String(num)) ?? 0) + 1);
      sum += num;
    }
    return {
      questionId: q.id,
      type: q.type,
      prompt: q.prompt,
      n,
      counts: toCounts(tally, n),
      mean: n ? Math.round((sum / n) * 100) / 100 : undefined,
    };
  } else if (q.type === "nps") {
    // 0–10 distribution + NPS score (promoters 9–10 minus detractors 0–6).
    const tally = new Map<string, number>();
    for (let i = 0; i <= 10; i++) tally.set(String(i), 0);
    let sum = 0;
    let promoters = 0;
    let detractors = 0;
    for (const v of values) {
      const num = Math.max(0, Math.min(10, Math.round(Number(v))));
      tally.set(String(num), (tally.get(String(num)) ?? 0) + 1);
      sum += num;
      if (num >= 9) promoters++;
      else if (num <= 6) detractors++;
    }
    return {
      questionId: q.id,
      type: q.type,
      prompt: q.prompt,
      n,
      counts: toCounts(tally, n),
      mean: n ? Math.round((sum / n) * 100) / 100 : undefined,
      npsScore: n ? Math.round(((promoters - detractors) / n) * 100) : undefined,
    };
  } else if (q.type === "ranking") {
    // Average rank per option (1-based, lower = preferred) + #1-pick frequency.
    const opts = optionLabels(q.config.options);
    const rankSum = new Map<string, number>();
    const rankCnt = new Map<string, number>();
    const firstPick = new Map<string, number>();
    const posTally = new Map<string, Map<number, number>>();
    for (const opt of opts) firstPick.set(opt, 0);
    for (const v of values) {
      const arr = Array.isArray(v) ? v.map((x) => String(x)) : [];
      arr.forEach((opt, idx) => {
        rankSum.set(opt, (rankSum.get(opt) ?? 0) + (idx + 1));
        rankCnt.set(opt, (rankCnt.get(opt) ?? 0) + 1);
        const byPos = posTally.get(opt) ?? new Map<number, number>();
        byPos.set(idx + 1, (byPos.get(idx + 1) ?? 0) + 1);
        posTally.set(opt, byPos);
      });
      if (arr[0] != null) firstPick.set(arr[0], (firstPick.get(arr[0]) ?? 0) + 1);
    }
    const maxPos = Math.max(0, ...[...posTally.values()].flatMap((m) => [...m.keys()]));
    const rankPositions = opts
      .filter((opt) => rankCnt.get(opt))
      .flatMap((opt) => {
        const byPos = posTally.get(opt)!;
        const base = rankCnt.get(opt)!;
        return Array.from({ length: maxPos }, (_, i) => i + 1).map((position) => ({
          label: opt,
          position,
          count: byPos.get(position) ?? 0,
          pct: base ? Math.round(((byPos.get(position) ?? 0) / base) * 100) : 0,
        }));
      });
    // Only options actually ranked by someone get an average (unranked ones
    // would otherwise show avg 0 and sort as if they were the top pick).
    const avgRanks = opts
      .filter((opt) => rankCnt.get(opt))
      .map((opt) => ({
        label: opt,
        avg: Math.round((rankSum.get(opt)! / rankCnt.get(opt)!) * 100) / 100,
      }))
      .sort((a, b) => a.avg - b.avg);
    const firstTally = new Map(opts.map((o) => [o, firstPick.get(o) ?? 0] as const));
    return {
      questionId: q.id,
      type: q.type,
      prompt: q.prompt,
      n,
      counts: toCounts(firstTally, n), // bar = how often each option was ranked #1
      avgRanks,
      rankPositions,
    };
  } else if (q.type === "matrix") {
    // Per-row column distribution + aggregate column distribution across all cells.
    const rowLabels = q.config.rows ?? [];
    const cols = q.config.columns ?? [];
    const agg = new Map<string, number>();
    for (const c of cols) agg.set(c, 0);
    let cells = 0;
    const matrix = rowLabels.map((row) => {
      const tally = new Map<string, number>();
      for (const c of cols) tally.set(c, 0);
      let rn = 0;
      for (const v of values) {
        const obj = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
        const choice = obj ? String(obj[row] ?? "") : "";
        if (!choice) continue;
        tally.set(choice, (tally.get(choice) ?? 0) + 1);
        agg.set(choice, (agg.get(choice) ?? 0) + 1);
        rn++;
        cells++;
      }
      return { row, n: rn, counts: toCounts(tally, rn) };
    });
    return {
      questionId: q.id,
      type: q.type,
      prompt: q.prompt,
      n,
      counts: toCounts(agg, cells),
      matrix,
    };
  } else {
    // open: answers may be legacy scalar strings or probed {answer, probes}
    // objects (US-013) — count via openAnswerText so both shapes register.
    const answered = values.filter((v) => openAnswerText(v).trim() !== "").length;
    return { questionId: q.id, type: q.type, prompt: q.prompt, n, counts: [], answered };
  }
}

/** Answer values of one question across response rows, blanks dropped. */
export function answerValues(
  rows: { answers: Record<string, unknown> }[],
  questionId: string,
): unknown[] {
  return rows
    .map((r) => r.answers[questionId])
    .filter((v) => v !== undefined && v !== null && v !== "");
}

export function toCounts(tally: Map<string, number>, n: number) {
  return [...tally.entries()].map(([label, count]) => ({
    label,
    count,
    pct: n ? Math.round((count / n) * 100) : 0,
  }));
}
