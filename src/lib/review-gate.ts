/**
 * Review gate — DB-facing entrypoints.
 *
 * Marking a survey "검토 완료" asserts the questionnaire is sound before
 * spending simulation budget on it. The pure gate evaluation
 * (evaluateReviewGate, normalizeStoredReview) lives in review-gate-core.ts so
 * unit tests and client components can import it without pulling @/db.
 *
 * Soft gate by design: a non-ok gate withholds the mark pending an explicit
 * confirmation, never hard-blocks.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { questions, surveys } from "@/db/schema";
import type { LintQuestion } from "@/lib/logic-lint";
import { evaluateReviewGate, type ReviewGate, type ReviewGateResult } from "@/lib/review-gate-core";

export {
  evaluateReviewGate,
  normalizeStoredReview,
  type ReviewGate,
  type ReviewGateReason,
  type ReviewGateResult,
} from "@/lib/review-gate-core";

/** Question rows → LintQuestion mapping shared by the gate's DB entrypoints. */
function toLintQuestions(
  rows: { id: string; order: number; type: string; prompt: string; config: unknown }[],
): LintQuestion[] {
  return rows.map((r) => ({
    id: r.id,
    order: r.order,
    type: r.type,
    prompt: r.prompt,
    config: (r.config ?? {}) as LintQuestion["config"],
  }));
}

/** Gate state of a workspace-owned survey (for the publish button badge). */
export async function loadReviewGate(
  surveyId: string,
  workspaceId: string,
): Promise<ReviewGate | null> {
  const [survey] = await db
    .select({ lastReview: surveys.lastReview, updatedAt: surveys.updatedAt })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!survey) return null;
  const rows = await db
    .select({
      id: questions.id,
      order: questions.order,
      type: questions.type,
      prompt: questions.prompt,
      config: questions.config,
    })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));
  return evaluateReviewGate({
    lastReview: survey.lastReview,
    surveyUpdatedAt: survey.updatedAt,
    questions: toLintQuestions(rows),
  });
}

/**
 * Marks the survey 검토 완료 with the gate applied: a non-ok gate withholds the
 * mark and returns it for the UI's explicit "그래도 완료 처리" confirmation;
 * `force` (that confirmation) marks it regardless. Soft gate by design.
 *
 * A survey that already has simulated data stays `simulated` — the mark is a
 * design-quality assertion, not a step backwards in the pipeline.
 */
export async function markReviewedWithGate(
  surveyId: string,
  workspaceId: string,
  force = false,
): Promise<ReviewGateResult> {
  if (!force) {
    const gate = await loadReviewGate(surveyId, workspaceId);
    if (!gate) return { error: "설문을 찾을 수 없습니다." };
    if (!gate.ok) return { gated: true, gate };
  }
  // Status flip only — updatedAt stays put. It means "content last modified"
  // and drives the stale check; bumping it here would mark the fresh review
  // stale immediately with nothing edited.
  const res = await db
    .update(surveys)
    .set({ status: "reviewed" })
    .where(
      and(
        eq(surveys.id, surveyId),
        eq(surveys.workspaceId, workspaceId),
        // Don't demote an already-simulated survey.
        eq(surveys.status, "draft"),
      ),
    )
    .returning({ id: surveys.id });
  // Zero rows also means "already reviewed/simulated" — that's still success.
  if (res.length === 0) {
    const [exists] = await db
      .select({ id: surveys.id })
      .from(surveys)
      .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
      .limit(1);
    if (!exists) return { error: "설문을 찾을 수 없습니다." };
  }
  return { marked: true };
}
