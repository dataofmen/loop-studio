"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { surveys, questions } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { analyzeQuality, type Distribution, type Warning } from "@/lib/quality";

async function assertOwner(surveyId: string): Promise<void> {
  const workspaceId = await getWorkspaceId();
  const [s] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!s) throw new Error("not found");
}

export type QualityResult = {
  error?: string;
  distributions?: Distribution[];
  warnings?: Warning[];
};

export async function analyzeQualityAction(surveyId: string): Promise<QualityResult> {
  try {
    await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    const { distributions, warnings } = await analyzeQuality(surveyId);
    return { distributions, warnings };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "분석 실패" };
  }
}

/** Applies an AI fix suggestion to a question (workspace-scoped). */
export async function applyFixAction(
  surveyId: string,
  questionId: string,
  suggestion: Warning["suggestion"],
): Promise<{ ok?: boolean; error?: string }> {
  try {
    await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }

  // Confirm the question belongs to this survey.
  const [q] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.surveyId, surveyId)))
    .limit(1);
  if (!q) return { error: "문항을 찾을 수 없습니다." };

  if (suggestion.action === "rewrite_prompt") {
    await db.update(questions).set({ prompt: suggestion.newPrompt }).where(eq(questions.id, questionId));
  } else if (suggestion.action === "replace_options") {
    const config = { ...(q.config as Record<string, unknown>), options: suggestion.newOptions };
    await db.update(questions).set({ config }).where(eq(questions.id, questionId));
  } else {
    return { ok: true };
  }
  await db.update(surveys).set({ updatedAt: new Date() }).where(eq(surveys.id, surveyId));
  revalidatePath(`/surveys/${surveyId}`);
  return { ok: true };
}
