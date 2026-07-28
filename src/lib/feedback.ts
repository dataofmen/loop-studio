/**
 * US-014: human feedback on AI-generated content.
 *
 * Founders leave like/dislike + comments on AI output (question design,
 * insight summaries). Feedback accumulates per workspace and is injected
 * into later AI generations (see buildPrompt in src/lib/surveys.ts) so the
 * system improves with each round.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { feedback } from "@/db/schema";

export type FeedbackSentiment = "up" | "down";

const TARGET_LABEL: Record<string, string> = {
  questions: "설문 문항 설계",
  insight: "AI 인사이트 요약",
};

export function feedbackTargetLabel(targetType: string): string {
  return TARGET_LABEL[targetType] ?? targetType;
}

export async function recordFeedback(args: {
  workspaceId: string;
  surveyId: string | null;
  targetType: string;
  targetRef?: string | null;
  sentiment: FeedbackSentiment;
  comment?: string | null;
}): Promise<void> {
  await db.insert(feedback).values({
    workspaceId: args.workspaceId,
    surveyId: args.surveyId,
    targetType: args.targetType,
    targetRef: args.targetRef ?? null,
    sentiment: args.sentiment,
    comment: args.comment?.trim() || null,
  });
}

export type FeedbackEntry = {
  id: string;
  targetType: string;
  sentiment: FeedbackSentiment;
  comment: string | null;
  createdAt: Date;
};

/** Recent feedback for one survey, newest first (for the panel's history list). */
export async function listSurveyFeedback(surveyId: string): Promise<FeedbackEntry[]> {
  const rows = await db
    .select({
      id: feedback.id,
      targetType: feedback.targetType,
      sentiment: feedback.sentiment,
      comment: feedback.comment,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .where(eq(feedback.surveyId, surveyId))
    .orderBy(desc(feedback.createdAt));
  return rows as FeedbackEntry[];
}

/**
 * Accumulated workspace feedback as context lines for later AI generations.
 * Only commented feedback is useful as guidance; a bare thumbs-up/down with
 * no comment carries no actionable signal for the next generation.
 */
export async function feedbackContext(
  workspaceId: string,
  opts?: { limit?: number },
): Promise<string[]> {
  const rows = await db
    .select({
      targetType: feedback.targetType,
      sentiment: feedback.sentiment,
      comment: feedback.comment,
    })
    .from(feedback)
    .where(eq(feedback.workspaceId, workspaceId))
    .orderBy(desc(feedback.createdAt))
    .limit(opts?.limit ?? 20);

  return rows
    .filter((r) => r.comment && r.comment.trim().length > 0)
    .map((r) => {
      const tag = r.sentiment === "up" ? "선호" : "개선 요청";
      return `[${tag} · ${feedbackTargetLabel(r.targetType)}] ${r.comment!.trim()}`;
    });
}
