"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import {
  recordFeedback,
  listSurveyFeedback,
  type FeedbackEntry,
  type FeedbackSentiment,
} from "@/lib/feedback";

async function assertOwner(surveyId: string): Promise<string> {
  const workspaceId = await getWorkspaceId();
  const [s] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!s) throw new Error("not found");
  return workspaceId;
}

export type FeedbackResult = { error?: string; data?: FeedbackEntry[] };

export async function submitFeedbackAction(input: {
  surveyId: string;
  targetType: string;
  sentiment: FeedbackSentiment;
  comment?: string;
}): Promise<FeedbackResult> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(input.surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  if (input.sentiment !== "up" && input.sentiment !== "down") {
    return { error: "잘못된 입력입니다." };
  }
  try {
    await recordFeedback({
      workspaceId,
      surveyId: input.surveyId,
      targetType: input.targetType,
      sentiment: input.sentiment,
      comment: input.comment,
    });
    return { data: await listSurveyFeedback(input.surveyId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "피드백 저장 실패" };
  }
}
