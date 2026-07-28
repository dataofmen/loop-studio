/**
 * US-005 (markdown format): export a survey as Loop Survey Markdown.
 *
 * The inverse of survey-import: live question rows reference each other by ROW
 * ID (the id space respond/lint/editor use), while markdown references are
 * stable `#q_<quid>` tokens — so refs are rewritten row id → quid before
 * serialization (the saveAsTemplate direction of the two-stage remap). A ref
 * whose target row no longer exists cannot become a resolvable token, so it is
 * dropped (dropUnmapped) — keeping every export re-importable (US-004 rejects
 * dangling refs outright).
 *
 * Ownership is the CALLER's job: the route handler goes through
 * loadOwnedSurvey and hands the already-scoped survey row here.
 */

import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { questions } from "@/db/schema";
import type { QConfig, QuestionType } from "@/lib/question-diff";
import {
  serializeSurveyMarkdown,
  type SerializeQuestion,
} from "@/lib/survey-markdown";
import { remapConfigRefs } from "@/lib/template-refs";

/** The survey fields the export reads (a loadOwnedSurvey row satisfies this). */
export type ExportSurvey = {
  id: string;
  title: string | null;
  researchGoal: string;
  welcomeMessage: string | null;
  closingMessage: string | null;
};

/**
 * Download filename: `<title|survey>-<id8>.md`. The title part keeps letters
 * (any script), digits, `-` and `_`; runs of anything else collapse to `-`.
 */
export function exportFilename(title: string | null, surveyId: string): string {
  const base = (title ?? "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "survey"}-${surveyId.replace(/-/g, "").slice(0, 8)}.md`;
}

/**
 * Loads the survey's questions (in order), rewrites row-id refs to quid form
 * and renders Loop Survey Markdown.
 */
export async function buildSurveyMarkdownExport(
  survey: ExportSurvey,
): Promise<{ filename: string; markdown: string }> {
  const rows = await db
    .select({
      id: questions.id,
      quid: questions.quid,
      type: questions.type,
      prompt: questions.prompt,
      config: questions.config,
    })
    .from(questions)
    .where(eq(questions.surveyId, survey.id))
    .orderBy(asc(questions.order));

  const idToQuid = new Map(rows.map((r) => [r.id, r.quid]));
  const serializable: SerializeQuestion[] = rows.map((r) => ({
    quid: r.quid,
    type: r.type as QuestionType,
    prompt: r.prompt,
    config: remapConfigRefs((r.config ?? {}) as QConfig, idToQuid, { dropUnmapped: true }).config,
  }));

  return {
    filename: exportFilename(survey.title, survey.id),
    markdown: serializeSurveyMarkdown(survey, serializable),
  };
}
