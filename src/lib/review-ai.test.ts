import { describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  mergeReviewReport,
  parseAiReviewIssues,
  MAX_AI_ISSUES,
  MAX_AI_TEXT_CHARS,
  type ReviewQuestion,
} from "./review-ai";
import { runDeterministicChecks } from "./review-checks";

function q(over: Partial<ReviewQuestion> & { id: string; quid: string; order: number }): ReviewQuestion {
  return {
    type: "single",
    prompt: `문항 ${over.id}`,
    config: { options: ["A", "B"] },
    ...over,
  } as ReviewQuestion;
}

const QUIDS = new Set(["q_aaaa1111", "q_bbbb2222"]);

describe("parseAiReviewIssues", () => {
  it("parses valid issues and keeps severity/questionRef", () => {
    const out = parseAiReviewIssues(
      {
        issues: [
          { severity: "error", questionRef: "q_aaaa1111", issue: "유도 질문입니다.", suggestion: "중립적으로 수정" },
          { severity: "warning", questionRef: null, issue: "순서가 편향을 만듭니다.", suggestion: "" },
        ],
      },
      QUIDS,
    );
    expect(out).toEqual([
      { severity: "error", questionRef: "q_aaaa1111", issue: "유도 질문입니다.", suggestion: "중립적으로 수정" },
      { severity: "warning", questionRef: null, issue: "순서가 편향을 만듭니다.", suggestion: "" },
    ]);
  });

  it("degrades junk fail-safe: non-object, missing issues, junk entries", () => {
    expect(parseAiReviewIssues(null, QUIDS)).toEqual([]);
    expect(parseAiReviewIssues("text", QUIDS)).toEqual([]);
    expect(parseAiReviewIssues([], QUIDS)).toEqual([]);
    expect(parseAiReviewIssues({ issues: "no" }, QUIDS)).toEqual([]);
    expect(
      parseAiReviewIssues({ issues: [null, 3, { severity: "error" }, { issue: "   " }] }, QUIDS),
    ).toEqual([]);
  });

  it("coerces unknown severity to suggestion and unknown questionRef to null", () => {
    const out = parseAiReviewIssues(
      { issues: [{ severity: "critical", questionRef: "q_zzzz9999", issue: "모호한 표현" }] },
      QUIDS,
    );
    expect(out).toEqual([
      { severity: "suggestion", questionRef: null, issue: "모호한 표현", suggestion: "" },
    ]);
  });

  it("caps issue count and text length", () => {
    const many = Array.from({ length: MAX_AI_ISSUES + 10 }, (_, i) => ({
      severity: "warning",
      questionRef: null,
      issue: `이슈 ${i} ` + "x".repeat(MAX_AI_TEXT_CHARS + 100),
    }));
    const out = parseAiReviewIssues({ issues: many }, QUIDS);
    expect(out).toHaveLength(MAX_AI_ISSUES);
    expect(out[0].issue.length).toBeLessThanOrEqual(MAX_AI_TEXT_CHARS);
  });
});

describe("buildReviewPrompt", () => {
  it("serializes quid, options, scale, display logic and meta", () => {
    const questions: ReviewQuestion[] = [
      q({ id: "id1", quid: "q_aaaa1111", order: 0, config: { options: ["예", "아니오"] } }),
      q({
        id: "id2",
        quid: "q_bbbb2222",
        order: 1,
        type: "scale",
        config: {
          scale: { min: 1, max: 5, minLabel: "불만", maxLabel: "만족" },
          meta: { construct: "배달 만족도", topic: "배달" },
          displayLogic: { match: "all", conditions: [{ questionId: "id1", op: "eq", value: "예" }] },
        },
      }),
    ];
    const prompt = buildReviewPrompt({ title: "테스트", researchGoal: "만족도 파악", questions });
    expect(prompt).toContain("q_aaaa1111");
    expect(prompt).toContain("보기: 예 | 아니오");
    expect(prompt).toContain("척도: 1 – 5 (불만 ↔ 만족)");
    expect(prompt).toContain("표시 조건:");
    expect(prompt).toContain('구성 개념 "배달 만족도"');
    expect(prompt).toContain('"questionRef"');
  });
});

describe("mergeReviewReport", () => {
  const questions: ReviewQuestion[] = [
    q({ id: "id1", quid: "q_aaaa1111", order: 0, config: { options: ["A", "B"], meta: { construct: "만족도" } } }),
    q({ id: "id2", quid: "q_bbbb2222", order: 1, config: { options: ["A", "B"], meta: { construct: "충성도" } } }),
  ];

  it("orders by severity, deterministic before AI within a severity, maps quid/prompt", () => {
    const deterministic = {
      items: [
        { questionId: "id2", severity: "warning" as const, code: "unreachable", message: "도달 불가" },
      ],
      metaCompleteness: { total: 2, withConstruct: 2, withTopic: 0, blankRate: 0 },
    };
    const ai = [
      { severity: "error" as const, questionRef: "q_aaaa1111", issue: "유도 질문", suggestion: "수정" },
      { severity: "warning" as const, questionRef: null, issue: "순서 편향", suggestion: "" },
      { severity: "suggestion" as const, questionRef: "q_bbbb2222", issue: "표현 개선", suggestion: "구체화" },
    ];
    const report = mergeReviewReport(questions, deterministic, ai, "ok");

    expect(report.items.map((i) => [i.source, i.severity, i.code])).toEqual([
      ["ai", "error", "ai_review"],
      ["deterministic", "warning", "unreachable"],
      ["ai", "warning", "ai_review"],
      ["ai", "suggestion", "ai_review"],
    ]);
    // deterministic item resolved id → quid + prompt
    expect(report.items[1].quid).toBe("q_bbbb2222");
    expect(report.items[1].prompt).toBe("문항 id2");
    // ai survey-level issue keeps null quid
    expect(report.items[2].quid).toBeNull();
    expect(report.items[3].suggestion).toBe("구체화");
    expect(report.aiStatus).toBe("ok");
  });

  it("keeps deterministic findings on AI failure (graceful degrade)", () => {
    const deterministic = runDeterministicChecks(questions);
    const report = mergeReviewReport(questions, deterministic, [], "failed", "CLI down");
    expect(report.aiStatus).toBe("failed");
    expect(report.aiError).toBe("CLI down");
    // clean fixture → no items, but the report shape is intact
    expect(report.items).toEqual([]);
    expect(report.metaCompleteness.total).toBe(2);
  });
});
