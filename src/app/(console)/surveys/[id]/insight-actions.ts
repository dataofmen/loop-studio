"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { generateInsights, type InsightSummary } from "@/lib/insights";

async function assertOwner(surveyId: string): Promise<void> {
  const workspaceId = await getWorkspaceId();
  const [s] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!s) throw new Error("not found");
}

export type InsightResult = { error?: string; data?: InsightSummary };

export async function generateInsightsAction(surveyId: string): Promise<InsightResult> {
  try {
    await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    return { data: await generateInsights(surveyId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "인사이트 생성 실패" };
  }
}
