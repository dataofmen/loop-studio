"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { markReviewedWithGate, type ReviewGateResult } from "@/lib/review-gate";

/**
 * Marks the survey 검토 완료 behind the review gate. A non-ok gate returns
 * {gated, gate} WITHOUT marking; the UI's explicit confirmation re-calls with
 * force. Soft gate only.
 */
export async function markSurveyReviewed(
  surveyId: string,
  opts?: { force?: boolean },
): Promise<ReviewGateResult> {
  const workspaceId = await getWorkspaceId();
  const res = await markReviewedWithGate(surveyId, workspaceId, opts?.force === true);
  if (res.marked) revalidatePath(`/surveys/${surveyId}`);
  return res;
}

/**
 * Back to 초안 for further editing.
 *
 * Status flips deliberately do NOT touch updatedAt: it means "content last
 * modified" and drives the review-gate stale check.
 */
export async function reopenSurveyDraft(surveyId: string) {
  const workspaceId = await getWorkspaceId();
  const res = await db
    .update(surveys)
    .set({ status: "draft" })
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .returning({ id: surveys.id });
  if (res.length === 0) throw new Error("not found");
  revalidatePath(`/surveys/${surveyId}`);
}
