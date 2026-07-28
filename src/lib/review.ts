/**
 * US-008: Pre-publish review — DB + claude-CLI entry point.
 *
 * `reviewSurvey` runs both layers of the pre-publish check and returns ONE
 * merged report:
 *   layer 1 — deterministic checks (US-007, `review-checks.ts`): logic lint,
 *             structural lint, path testing, completeness. Always present.
 *   layer 2 — whole-survey AI review via the local claude CLI (leading /
 *             double-barreled questions, option gaps, ordering bias, …).
 *             Best-effort: a CLI failure degrades to a deterministic-only
 *             report (aiStatus: "failed") instead of throwing.
 *
 * Pure prompt-building/parsing/merging lives in `review-ai.ts` (unit-tested).
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { questions, surveys } from "@/db/schema";
import { runLlmJson } from "@/lib/llm";
import { runDeterministicChecks } from "@/lib/review-checks";
import {
  buildReviewPrompt,
  mergeReviewReport,
  parseAiReviewIssues,
  type AiReviewIssue,
  type ReviewQuestion,
  type SurveyReviewReport,
} from "@/lib/review-ai";

export type { SurveyReviewReport, ReviewReportItem } from "@/lib/review-ai";

/**
 * The AI reads the whole survey at once — give it more room than a
 * single-question call. 300s matches the long-generation precedent
 * (생성·제안); 180s timed out in practice on a 10-question survey.
 */
const REVIEW_TIMEOUT_MS = 300_000;

/**
 * Reviews a workspace-owned survey before publish. Returns null when the
 * survey does not exist in this workspace.
 */
export async function reviewSurvey(
  surveyId: string,
  workspaceId: string,
): Promise<SurveyReviewReport | null> {
  const [survey] = await db
    .select({ id: surveys.id, title: surveys.title, researchGoal: surveys.researchGoal })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!survey) return null;

  const rows = await db
    .select()
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));

  const qs: ReviewQuestion[] = rows.map((r) => ({
    id: r.id,
    quid: r.quid,
    order: r.order,
    type: r.type,
    prompt: r.prompt,
    config: (r.config ?? {}) as ReviewQuestion["config"],
  }));

  const deterministic = runDeterministicChecks(qs);

  let aiIssues: AiReviewIssue[] = [];
  let aiStatus: "ok" | "failed" = "ok";
  let aiError: string | null = null;

  if (qs.length === 0) {
    aiStatus = "failed";
    aiError = "검토할 문항이 없습니다.";
  } else {
    try {
      const raw = await runLlmJson(
        buildReviewPrompt({
          title: survey.title ?? "(제목 없음)",
          researchGoal: survey.researchGoal,
          questions: qs,
        }),
        { timeoutMs: REVIEW_TIMEOUT_MS },
      );
      aiIssues = parseAiReviewIssues(raw, new Set(qs.map((q) => q.quid)));
    } catch (e) {
      aiStatus = "failed";
      aiError = e instanceof Error ? e.message : "AI 검토 호출 실패";
    }
  }

  return mergeReviewReport(qs, deterministic, aiIssues, aiStatus, aiError);
}
