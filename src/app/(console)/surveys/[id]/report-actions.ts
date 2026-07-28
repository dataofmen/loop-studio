"use server";

import { getWorkspaceId } from "@/lib/auth";
import {
  generateStudyReport,
  listStudyReports,
  reportToMarkdown,
  type StudyReportRow,
} from "@/lib/reports";

export async function generateReportAction(
  surveyId: string,
): Promise<{ data?: StudyReportRow; error?: string }> {
  try {
    const workspaceId = await getWorkspaceId();
    const row = await generateStudyReport(surveyId, workspaceId);
    return { data: row };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "리포트 생성에 실패했습니다." };
  }
}

export async function listReportsAction(
  surveyId: string,
): Promise<{ data?: StudyReportRow[]; error?: string }> {
  try {
    const workspaceId = await getWorkspaceId();
    return { data: await listStudyReports(surveyId, workspaceId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "리포트 조회에 실패했습니다." };
  }
}

export async function exportReportMarkdownAction(
  surveyId: string,
  reportId: string,
): Promise<{ data?: { filename: string; markdown: string }; error?: string }> {
  try {
    const workspaceId = await getWorkspaceId();
    const rows = await listStudyReports(surveyId, workspaceId);
    const row = rows.find((r) => r.id === reportId);
    if (!row) return { error: "리포트를 찾을 수 없습니다." };
    return {
      data: {
        filename: `study-report-${row.createdAt.slice(0, 10)}.md`,
        markdown: reportToMarkdown(row.report),
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "내보내기에 실패했습니다." };
  }
}
