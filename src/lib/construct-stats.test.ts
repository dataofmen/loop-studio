import { describe, expect, test } from "vitest";
import {
  aggregateConstructStats,
  type ConstructMemberQuestion,
  type ConstructResponseRow,
} from "@/lib/construct-stats";

const scaleQ = (id: string, surveyId: string, over: Partial<ConstructMemberQuestion> = {}): ConstructMemberQuestion => ({
  questionId: id,
  quid: `q_${id}`,
  type: "scale",
  prompt: "만족도를 평가해주세요",
  config: { scale: { min: 1, max: 5 } },
  surveyId,
  surveyTitle: `Survey ${surveyId}`,
  surveyCreatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const singleQ = (id: string, surveyId: string, options: string[]): ConstructMemberQuestion => ({
  questionId: id,
  quid: `q_${id}`,
  type: "single",
  prompt: "가장 중요한 요소는?",
  config: { options: options.map((label) => ({ label })) },
  surveyId,
  surveyTitle: `Survey ${surveyId}`,
  surveyCreatedAt: "2026-07-01T00:00:00.000Z",
});

const resp = (
  surveyId: string,
  answers: Record<string, unknown>,
  isSynthetic = false,
): ConstructResponseRow => ({ surveyId, isSynthetic, answers });

describe("aggregateConstructStats", () => {
  test("synthetic responses are excluded from all statistics", () => {
    const members = [scaleQ("qa", "s1")];
    const agg = aggregateConstructStats(members, [
      resp("s1", { qa: 5 }),
      resp("s1", { qa: 3 }),
      resp("s1", { qa: 1 }, true), // synthetic — must not move the mean
      resp("s1", { qa: 1 }, true),
    ]);
    expect(agg.realResponseCount).toBe(2);
    expect(agg.syntheticResponseCount).toBe(2);
    const per = agg.numeric.perQuestion[0];
    expect(per.distribution.n).toBe(2);
    expect(per.distribution.mean).toBe(4); // (5+3)/2 — synthetic 1s ignored
    expect(agg.numeric.overall).toEqual([{ scaleKey: "scale 1–5", mean: 4, n: 2 }]);
  });

  test("scale means integrate across surveys as a weighted overall mean", () => {
    const members = [scaleQ("qa", "s1"), scaleQ("qb", "s2")];
    const agg = aggregateConstructStats(members, [
      // s1: mean 4 over 2 answers
      resp("s1", { qa: 5 }),
      resp("s1", { qa: 3 }),
      // s2: mean 2 over 1 answer
      resp("s2", { qb: 2 }),
    ]);
    expect(agg.numeric.perQuestion.map((p) => p.distribution.mean)).toEqual([4, 2]);
    // weighted: (4*2 + 2*1) / 3 = 3.33
    expect(agg.numeric.overall).toEqual([{ scaleKey: "scale 1–5", mean: 3.33, n: 3 }]);
  });

  test("scale and nps are never pooled into one mean (separate scaleKeys)", () => {
    const members = [
      scaleQ("qa", "s1"),
      scaleQ("qn", "s2", { type: "nps", config: {} }),
    ];
    const agg = aggregateConstructStats(members, [
      resp("s1", { qa: 5 }),
      resp("s2", { qn: 10 }),
    ]);
    const keys = agg.numeric.overall.map((o) => o.scaleKey).sort();
    expect(keys).toEqual(["nps 0–10", "scale 1–5"]);
    const nps = agg.numeric.perQuestion.find((p) => p.type === "nps")!;
    expect(nps.distribution.npsScore).toBe(100);
  });

  test("choice distributions stay parallel per survey — labels never summed", () => {
    const members = [
      singleQ("qa", "s1", ["가격", "품질"]),
      singleQ("qb", "s2", ["가격", "품질"]),
    ];
    const agg = aggregateConstructStats(members, [
      resp("s1", { qa: "가격" }),
      resp("s1", { qa: "가격" }),
      resp("s2", { qb: "품질" }),
    ]);
    expect(agg.choice.perQuestion).toHaveLength(2);
    const [a, b] = agg.choice.perQuestion;
    expect(a.surveyId).toBe("s1");
    expect(a.distribution.counts.find((c) => c.label === "가격")?.count).toBe(2);
    expect(b.surveyId).toBe("s2");
    // s2's 가격 stays 0 — s1's picks must not bleed across surveys
    expect(b.distribution.counts.find((c) => c.label === "가격")?.count).toBe(0);
    expect(b.distribution.counts.find((c) => c.label === "품질")?.count).toBe(1);
    expect(agg.numeric.perQuestion).toHaveLength(0);
  });

  test("open questions report answered counts only; probed shape counts", () => {
    const members = [scaleQ("qo", "s1", { type: "open", config: {} })];
    const agg = aggregateConstructStats(members, [
      resp("s1", { qo: "좋아요" }),
      resp("s1", { qo: { answer: "괜찮아요", probes: [] } }),
      resp("s1", { qo: "인상 깊었던 점은 없음" }, true), // synthetic
      resp("s1", {}),
    ]);
    const per = agg.open.perQuestion[0];
    expect(per.distribution.answered).toBe(2);
    expect(agg.realResponseCount).toBe(2);
    expect(agg.numeric.overall).toEqual([]);
  });

  test("no members / no responses degrade to empty aggregate", () => {
    const agg = aggregateConstructStats([], []);
    expect(agg.realResponseCount).toBe(0);
    expect(agg.syntheticResponseCount).toBe(0);
    expect(agg.numeric.perQuestion).toEqual([]);
    expect(agg.choice.perQuestion).toEqual([]);
    expect(agg.open.perQuestion).toEqual([]);
  });
});
