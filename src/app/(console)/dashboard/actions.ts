"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getWorkspaceId } from "@/lib/auth";
import {
  deleteSurvey,
  duplicateSurvey,
  setSurveyArchived,
  type DeleteResult,
} from "@/lib/survey-lifecycle";
import { generateSurvey } from "@/lib/surveys";

export type CreateSurveyState = { error?: string };

export async function createSurveyAction(
  _prev: CreateSurveyState,
  formData: FormData,
): Promise<CreateSurveyState> {
  const goal = String(formData.get("goal") || "").trim();
  if (goal.length < 5) {
    return { error: "리서치 목표를 조금 더 구체적으로 입력해 주세요 (5자 이상)." };
  }

  const workspaceId = await getWorkspaceId();

  let surveyId: string;
  try {
    surveyId = await generateSurvey(workspaceId, goal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "알 수 없는 오류";
    return { error: `설문 생성에 실패했습니다: ${msg}` };
  }

  redirect(`/surveys/${surveyId}`);
}

/** Duplicate a survey (fresh draft, "(복사본)" title); redirects to the copy. */
export async function duplicateSurveyAction(surveyId: string): Promise<void> {
  const workspaceId = await getWorkspaceId();
  const res = await duplicateSurvey(workspaceId, surveyId);
  if (!res.ok) return; // not owned — no-op
  revalidatePath("/dashboard");
  redirect(`/surveys/${res.surveyId}`);
}

/** Toggle the soft archive flag; stays on the dashboard. */
export async function setSurveyArchivedAction(
  surveyId: string,
  archived: boolean,
): Promise<void> {
  const workspaceId = await getWorkspaceId();
  await setSurveyArchived(workspaceId, surveyId, archived);
  revalidatePath("/dashboard");
}

/**
 * Delete a survey. Refused (returns the reason) when real responses exist so
 * the UI can steer to archive; on success revalidates the list.
 */
export async function deleteSurveyAction(surveyId: string): Promise<DeleteResult> {
  const workspaceId = await getWorkspaceId();
  const res = await deleteSurvey(workspaceId, surveyId);
  if (res.ok) revalidatePath("/dashboard");
  return res;
}
