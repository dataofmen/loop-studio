"use server";

import { redirect } from "next/navigation";
import { getWorkspaceId } from "@/lib/auth";
import { importSurveyFromMarkdown, type ImportIssue } from "@/lib/survey-import";

export type ImportState = {
  /** Line-addressed rejection list (parse/ref/structure/logic, merged). */
  errors?: ImportIssue[];
  /** Non-document failure (empty input, unexpected server error). */
  message?: string;
};

export async function importSurveyAction(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const md = String(formData.get("markdown") || "");
  if (!md.trim()) {
    return { message: "마크다운을 붙여넣거나 .md 파일을 업로드해 주세요." };
  }

  const workspaceId = await getWorkspaceId();

  let result;
  try {
    result = await importSurveyFromMarkdown(workspaceId, md);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "알 수 없는 오류";
    return { message: `설문 생성에 실패했습니다: ${msg}` };
  }

  if (!result.ok) return { errors: result.errors };
  redirect(`/surveys/${result.surveyId}`);
}
