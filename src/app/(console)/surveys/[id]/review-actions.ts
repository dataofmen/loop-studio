"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { reviewSurvey, type SurveyReviewReport } from "@/lib/review";

export type ReviewActionResult = { error?: string; report?: SurveyReviewReport; at?: string };

/** Shape persisted in surveys.last_review. */
export type StoredReview = { report: SurveyReviewReport; at: string };

/**
 * Runs the two-layer pre-publish review (US-007 deterministic + US-008 AI)
 * on demand. Ownership is enforced inside reviewSurvey (workspace-scoped load).
 * The result is persisted on the survey so it survives navigation/refresh —
 * best-effort: a failed save still returns the fresh report.
 */
export async function reviewSurveyAction(surveyId: string): Promise<ReviewActionResult> {
  try {
    const workspaceId = await getWorkspaceId();
    const report = await reviewSurvey(surveyId, workspaceId);
    if (!report) return { error: "설문을 찾을 수 없습니다." };
    const at = new Date().toISOString();
    try {
      await db
        .update(surveys)
        .set({ lastReview: { report, at } satisfies StoredReview })
        .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)));
    } catch {
      // best-effort persistence — the fresh report is still returned
    }
    return { report, at };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "검토 실패" };
  }
}
