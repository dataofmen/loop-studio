import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { surveys, responses, personas } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";

/** Loads a survey scoped to the current workspace, or null if not found. */
export async function loadOwnedSurvey(id: string) {
  const workspaceId = await getWorkspaceId();
  const [survey] = await db
    .select()
    .from(surveys)
    .where(and(eq(surveys.id, id), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  return survey ? { survey, workspaceId } : null;
}

/** Per-survey counts used across the tabbed views. */
export async function surveyCounts(surveyId: string) {
  const [[{ personaCount }], [{ syntheticCount }]] = await Promise.all([
    db
      .select({ personaCount: sql<number>`count(*)::int` })
      .from(personas)
      .where(eq(personas.surveyId, surveyId)),
    db
      .select({ syntheticCount: sql<number>`count(*)::int` })
      .from(responses)
      .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true))),
  ]);
  return { personaCount, syntheticCount };
}
