"use server";

import { getWorkspaceId } from "@/lib/auth";
import { listThemeViews, generateThemes, type ThemeQuestionView } from "@/lib/themes";

export async function loadThemeViewsAction(
  surveyId: string,
): Promise<{ data?: ThemeQuestionView[]; error?: string }> {
  try {
    const workspaceId = await getWorkspaceId();
    return { data: await listThemeViews(surveyId, workspaceId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "테마 조회에 실패했습니다." };
  }
}

export async function generateThemesAction(
  surveyId: string,
  questionId: string,
): Promise<{ data?: ThemeQuestionView[]; error?: string }> {
  try {
    const workspaceId = await getWorkspaceId();
    await generateThemes(surveyId, workspaceId, questionId);
    return { data: await listThemeViews(surveyId, workspaceId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "테마 생성에 실패했습니다." };
  }
}
