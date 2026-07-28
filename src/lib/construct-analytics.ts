/**
 * US-001 (construct-loop-review): construct-level result aggregation across
 * surveys — a concept's results accumulate instead of being trapped per
 * survey. DB-side entry point; all statistics live in the pure module
 * construct-stats.ts (unit-tested, no IO).
 *
 * Ground truth rule: only real responses (is_synthetic=false) feed the
 * numbers; synthetic rows are counted separately for display.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { constructs, questions, responses, surveys } from "@/db/schema";
import {
  aggregateConstructStats,
  type ConstructAggregate,
  type ConstructMemberQuestion,
} from "@/lib/construct-stats";
import type { QConfig, QuestionType } from "@/lib/distribution-core";

const metaConstructId = sql<string>`${questions.config}->'meta'->>'constructId'`;

export type ConstructResults = {
  construct: { id: string; name: string };
  /** Member questions in survey-createdAt order (trend-ready). */
  memberCount: number;
  aggregate: ConstructAggregate;
};

/**
 * Aggregate every workspace question pointing at `constructId` over its
 * surveys' responses. Returns null when the construct doesn't exist in this
 * workspace (ownership check — foreign ids never leak data).
 */
export async function aggregateConstructResults(
  workspaceId: string,
  constructId: string,
): Promise<ConstructResults | null> {
  const [row] = await db
    .select({ id: constructs.id, name: constructs.name })
    .from(constructs)
    .where(and(eq(constructs.id, constructId), eq(constructs.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;

  const memberRows = await db
    .select({
      questionId: questions.id,
      quid: questions.quid,
      type: questions.type,
      prompt: questions.prompt,
      config: questions.config,
      surveyId: surveys.id,
      surveyTitle: surveys.title,
      surveyCreatedAt: surveys.createdAt,
    })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(and(eq(surveys.workspaceId, workspaceId), eq(metaConstructId, constructId)))
    .orderBy(asc(surveys.createdAt), asc(questions.order));

  const members: ConstructMemberQuestion[] = memberRows.map((m) => ({
    questionId: m.questionId,
    quid: m.quid,
    type: m.type as QuestionType,
    prompt: m.prompt,
    config: (m.config ?? {}) as QConfig,
    surveyId: m.surveyId,
    surveyTitle: m.surveyTitle ?? "(제목 없음)",
    surveyCreatedAt: m.surveyCreatedAt.toISOString(),
  }));

  const surveyIds = [...new Set(members.map((m) => m.surveyId))];
  const responseRows = surveyIds.length
    ? await db
        .select({
          surveyId: responses.surveyId,
          isSynthetic: responses.isSynthetic,
          answers: responses.answers,
        })
        .from(responses)
        .where(inArray(responses.surveyId, surveyIds))
    : [];

  const aggregate = aggregateConstructStats(
    members,
    responseRows.map((r) => ({
      surveyId: r.surveyId,
      isSynthetic: r.isSynthetic,
      answers: (r.answers ?? {}) as Record<string, unknown>,
    })),
  );

  return { construct: row, memberCount: members.length, aggregate };
}
