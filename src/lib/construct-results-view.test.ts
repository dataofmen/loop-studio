import { describe, expect, test } from "vitest";
import {
  aggregateConstructStats,
  type ConstructMemberQuestion,
  type ConstructResponseRow,
} from "@/lib/construct-stats";
import { buildConstructResultsView, shortDate } from "@/lib/construct-results-view";

const scaleQ = (
  id: string,
  surveyId: string,
  over: Partial<ConstructMemberQuestion> = {},
): ConstructMemberQuestion => ({
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

const resp = (
  surveyId: string,
  answers: Record<string, unknown>,
  isSynthetic = false,
): ConstructResponseRow => ({ surveyId, isSynthetic, answers });

describe("buildConstructResultsView", () => {
  test("no members → no-questions status", () => {
    const view = buildConstructResultsView(0, aggregateConstructStats([], []));
    expect(view.status).toBe("no-questions");
    expect(view.numericGroups).toEqual([]);
  });

  test("members but zero responses → no-responses", () => {
    const view = buildConstructResultsView(
      1,
      aggregateConstructStats([scaleQ("qa", "s1")], []),
    );
    expect(view.status).toBe("no-responses");
    expect(view.realResponseCount).toBe(0);
    expect(view.syntheticResponseCount).toBe(0);
  });

  test("synthetic only → synthetic-only status, stats stay empty", () => {
    const view = buildConstructResultsView(
      1,
      aggregateConstructStats([scaleQ("qa", "s1")], [resp("s1", { qa: 4 }, true)]),
    );
    expect(view.status).toBe("synthetic-only");
    expect(view.syntheticResponseCount).toBe(1);
    expect(view.realResponseCount).toBe(0);
    // synthetic rows never enter numbers — the group's overall has no data
    expect(view.numericGroups[0].overall.n).toBe(0);
  });

  test("numeric points group by scaleKey and keep survey-time order", () => {
    const members = [
      scaleQ("qa", "s1", { surveyCreatedAt: "2026-06-01T00:00:00.000Z" }),
      scaleQ("qb", "s2", { surveyCreatedAt: "2026-07-01T00:00:00.000Z" }),
      scaleQ("qn", "s2", {
        type: "nps",
        config: {},
        surveyCreatedAt: "2026-07-01T00:00:00.000Z",
      }),
    ];
    const view = buildConstructResultsView(
      3,
      aggregateConstructStats(members, [
        resp("s1", { qa: 4 }),
        resp("s2", { qb: 2, qn: 9 }),
      ]),
    );
    expect(view.status).toBe("real");
    const keys = view.numericGroups.map((g) => g.scaleKey).sort();
    expect(keys).toEqual(["nps 0–10", "scale 1–5"]);
    const scaleGroup = view.numericGroups.find((g) => g.scaleKey === "scale 1–5")!;
    // survey-createdAt ascending: s1(6월) before s2(7월)
    expect(scaleGroup.points.map((p) => p.surveyId)).toEqual(["s1", "s2"]);
    expect(scaleGroup.points.map((p) => p.mean)).toEqual([4, 2]);
    expect(scaleGroup.overall.mean).toBe(3); // (4+2)/2 weighted
  });

  test("open answered counts and choice pass through per survey·question", () => {
    const members = [
      scaleQ("qo", "s1", { type: "open", config: {} }),
      {
        ...scaleQ("qc", "s1"),
        type: "single" as const,
        config: { options: [{ label: "가격" }, { label: "품질" }] },
      },
    ];
    const view = buildConstructResultsView(
      2,
      aggregateConstructStats(members, [resp("s1", { qo: "좋아요", qc: "가격" })]),
    );
    expect(view.open).toEqual([
      { quid: "q_qo", prompt: "만족도를 평가해주세요", surveyTitle: "Survey s1", answered: 1 },
    ]);
    expect(view.choice).toHaveLength(1);
    expect(view.choice[0].distribution.counts.find((c) => c.label === "가격")?.count).toBe(1);
  });

  test("shortDate trims ISO timestamps", () => {
    expect(shortDate("2026-07-04T12:34:56.000Z")).toBe("2026-07-04");
  });
});
