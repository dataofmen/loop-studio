/**
 * Review gate — pure evaluation layer.
 *
 * Split from review-gate.ts (which owns the DB-facing entrypoints) so unit
 * tests and client components can import the gate logic without pulling @/db.
 *
 * Marking a survey 검토 완료 warns — never hard-blocks — when it looks
 * unreviewed or broken: no stored review, a stale review (survey edited after
 * it), stored review errors, or fresh deterministic errors. The deterministic
 * checks (structure + logic lint) are RE-RUN at gate time because they are
 * cheap and exact; the AI review is NOT re-run — its stored report is used
 * as-is.
 */

import { runDeterministicChecks } from "@/lib/review-checks";
import type { LintQuestion } from "@/lib/logic-lint";
import type { SurveyReviewReport } from "@/lib/review-ai";

export type ReviewGateReason = {
  code:
    | "no_review"
    | "stale_review"
    | "incomplete_review"
    | "review_errors"
    | "structural_errors";
  message: string;
};

export type ReviewGate = {
  /** true → nothing to warn about; the mark proceeds without confirmation. */
  ok: boolean;
  reasons: ReviewGateReason[];
  /** Messages of fresh deterministic ERRORS (re-run at gate time). */
  freshErrors: string[];
};

export type ReviewGateResult = {
  /** The survey is now 검토 완료 (or already past that stage). */
  marked?: boolean;
  /** The mark was withheld pending explicit confirmation. */
  gated?: boolean;
  gate?: ReviewGate;
  error?: string;
};

type StoredReviewShape = { report: SurveyReviewReport; at: string };

/** Tolerant reader of the surveys.last_review jsonb — junk yields null. */
export function normalizeStoredReview(raw: unknown): StoredReviewShape | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as { report?: unknown; at?: unknown };
  if (typeof o.at !== "string" || !o.at) return null;
  const report = o.report as SurveyReviewReport | undefined;
  if (!report || typeof report !== "object" || !Array.isArray(report.items)) return null;
  return { report, at: o.at };
}

/**
 * Pure gate evaluation. `surveyUpdatedAt > review.at` marks the stored review
 * stale (same convention as the review panel); stored review errors and fresh
 * deterministic errors each add a reason. Empty reasons → ok.
 */
export function evaluateReviewGate(input: {
  lastReview: unknown;
  surveyUpdatedAt: Date | string;
  questions: LintQuestion[];
}): ReviewGate {
  const reasons: ReviewGateReason[] = [];

  const review = normalizeStoredReview(input.lastReview);
  if (!review) {
    reasons.push({ code: "no_review", message: "AI 검토를 아직 실행하지 않았습니다." });
  } else {
    const reviewedAt = Date.parse(review.at);
    const updatedAt = new Date(input.surveyUpdatedAt).getTime();
    if (Number.isFinite(reviewedAt) && Number.isFinite(updatedAt) && updatedAt > reviewedAt) {
      reasons.push({
        code: "stale_review",
        message: "마지막 검토 이후 설문이 수정되었습니다. 다시 검토하는 것을 권장합니다.",
      });
    }
    // AI layer failed → the stored review is partial; deterministic-only
    // cleanliness must not read as a fully passed review.
    if (review.report.aiStatus === "failed") {
      reasons.push({
        code: "incomplete_review",
        message: "저장된 검토가 불완전합니다 (AI 검토 실패, 구조 검사만 수행됨). 다시 검토를 권장합니다.",
      });
    }
    const errorCount = review.report.items.filter((i) => i.severity === "error").length;
    if (errorCount > 0) {
      reasons.push({
        code: "review_errors",
        message: `저장된 검토에 오류 ${errorCount}건이 남아 있습니다.`,
      });
    }
  }

  const fresh = runDeterministicChecks(input.questions).items.filter(
    (i) => i.severity === "error",
  );
  if (fresh.length > 0) {
    reasons.push({
      code: "structural_errors",
      message: `구조·로직 즉석 검사에서 오류 ${fresh.length}건이 발견되었습니다.`,
    });
  }

  return { ok: reasons.length === 0, reasons, freshErrors: fresh.map((i) => i.message) };
}
