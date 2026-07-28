import { describe, test, expect } from "vitest";
import { evaluateReviewGate, normalizeStoredReview } from "./review-gate-core";
import type { SurveyReviewReport } from "./review-ai";

function report(overrides?: Partial<SurveyReviewReport>): SurveyReviewReport {
  return {
    items: [],
    metaCompleteness: { total: 1, withConstruct: 1, withTopic: 1, blankRate: 0 },
    aiStatus: "ok",
    aiError: null,
    ...overrides,
  };
}
const errorItem = {
  source: "deterministic" as const,
  severity: "error" as const,
  code: "x",
  quid: null,
  prompt: null,
  message: "문제",
  suggestion: null,
};
const cleanQ = {
  id: "q1",
  order: 0,
  type: "single",
  prompt: "만족하시나요?",
  config: { options: ["예", "아니오"] },
};
const emptyPromptQ = { ...cleanQ, id: "q2", prompt: "" };

describe("normalizeStoredReview", () => {
  test("valid shape passes, junk yields null", () => {
    expect(normalizeStoredReview({ report: report(), at: "2026-07-06T00:00:00Z" })).not.toBeNull();
    expect(normalizeStoredReview(null)).toBeNull();
    expect(normalizeStoredReview({ at: "2026-07-06" })).toBeNull();
    expect(normalizeStoredReview({ report: { items: "x" }, at: "2026-07-06" })).toBeNull();
  });
});

describe("evaluateReviewGate", () => {
  const reviewedAt = "2026-07-06T10:00:00Z";
  const before = new Date("2026-07-06T09:00:00Z");
  const after = new Date("2026-07-06T11:00:00Z");

  test("fresh clean review + clean questions → ok", () => {
    const g = evaluateReviewGate({
      lastReview: { report: report(), at: reviewedAt },
      surveyUpdatedAt: before,
      questions: [cleanQ],
    });
    expect(g.ok).toBe(true);
    expect(g.reasons).toEqual([]);
  });

  test("no review → no_review", () => {
    const g = evaluateReviewGate({ lastReview: null, surveyUpdatedAt: before, questions: [cleanQ] });
    expect(g.ok).toBe(false);
    expect(g.reasons.map((r) => r.code)).toEqual(["no_review"]);
  });

  test("edited after review → stale_review", () => {
    const g = evaluateReviewGate({
      lastReview: { report: report(), at: reviewedAt },
      surveyUpdatedAt: after,
      questions: [cleanQ],
    });
    expect(g.reasons.map((r) => r.code)).toEqual(["stale_review"]);
  });

  test("ai-failed (partial) review → incomplete_review", () => {
    const g = evaluateReviewGate({
      lastReview: { report: report({ aiStatus: "failed", aiError: "timeout" }), at: reviewedAt },
      surveyUpdatedAt: before,
      questions: [cleanQ],
    });
    expect(g.reasons.map((r) => r.code)).toEqual(["incomplete_review"]);
  });

  test("stored review errors → review_errors", () => {
    const g = evaluateReviewGate({
      lastReview: { report: report({ items: [errorItem, errorItem] }), at: reviewedAt },
      surveyUpdatedAt: before,
      questions: [cleanQ],
    });
    expect(g.reasons.map((r) => r.code)).toEqual(["review_errors"]);
    expect(g.reasons[0].message).toContain("2건");
  });

  test("fresh deterministic error → structural_errors with messages", () => {
    const g = evaluateReviewGate({
      lastReview: { report: report(), at: reviewedAt },
      surveyUpdatedAt: before,
      questions: [cleanQ, emptyPromptQ],
    });
    expect(g.reasons.map((r) => r.code)).toEqual(["structural_errors"]);
    expect(g.freshErrors.length).toBeGreaterThan(0);
  });

  test("reasons accumulate (stale + errors)", () => {
    const g = evaluateReviewGate({
      lastReview: { report: report({ items: [errorItem] }), at: reviewedAt },
      surveyUpdatedAt: after,
      questions: [emptyPromptQ],
    });
    expect(g.reasons.map((r) => r.code)).toEqual([
      "stale_review",
      "review_errors",
      "structural_errors",
    ]);
  });
});
