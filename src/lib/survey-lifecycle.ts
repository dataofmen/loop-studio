/**
 * Survey list-management: duplicate / archive / delete. Each function is
 * workspace-scoped (takes `workspaceId` and self-checks ownership) so the same
 * path runs from the server action and from real-DB verification without cookie
 * dependence — the markReviewedWithGate pattern.
 *
 * Policy:
 *  - duplicate: clones questions with FRESH quids + remapped refs, status reset
 *    to draft, simulated responses NOT copied (they describe the source's run).
 *  - archive: soft `archived` flag; data preserved.
 *  - delete: HARD (cascade). Safe because every response is synthetic and can
 *    be regenerated; archive is the non-destructive option.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { newQuid, questions, surveys } from "@/db/schema";
import { normalizeOptionsFrom } from "@/lib/carry-forward";
import type { QConfig } from "@/lib/question-diff";
import { remapConfigRefs } from "@/lib/template-refs";
import { TITLE_MAX, uniqueTitle } from "@/lib/unique-title";

const INSERT_CHUNK = 500;

/** Confirms `surveyId` belongs to `workspaceId`; returns the row or null. */
async function ownedSurvey(workspaceId: string, surveyId: string) {
  const [survey] = await db
    .select()
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  return survey ?? null;
}

export type DuplicateResult =
  | { ok: true; surveyId: string }
  | { ok: false; reason: "not_found" };

/**
 * Clones a survey into a new draft in the same workspace. Title collides with
 * the source (same workspace) so it always gains a "(복사본)" suffix. Questions
 * are re-created with fresh quids and their displayLogic/optionsFrom refs are
 * rewritten from old row ids to the new ones (seedQuestions two-stage pattern).
 * Responses/personas/reviews are intentionally NOT copied.
 */
export async function duplicateSurvey(
  workspaceId: string,
  surveyId: string,
): Promise<DuplicateResult> {
  const source = await ownedSurvey(workspaceId, surveyId);
  if (!source) return { ok: false, reason: "not_found" };

  const srcQuestions = await db
    .select({
      id: questions.id,
      type: questions.type,
      order: questions.order,
      prompt: questions.prompt,
      config: questions.config,
    })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(questions.order);

  const newId = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ title: surveys.title })
      .from(surveys)
      .where(eq(surveys.workspaceId, workspaceId));
    const title = uniqueTitle(
      source.title ?? source.researchGoal,
      existing.map((r) => r.title),
      TITLE_MAX,
    );

    const [survey] = await tx
      .insert(surveys)
      .values({
        workspaceId,
        title,
        researchGoal: source.researchGoal,
        welcomeMessage: source.welcomeMessage,
        closingMessage: source.closingMessage,
        status: "draft",
        archived: false,
      })
      .returning({ id: surveys.id });

    if (srcQuestions.length === 0) return survey.id;

    // Fresh quids; configs still reference the SOURCE row ids at this point.
    const rows = srcQuestions.map((q, i) => ({
      surveyId: survey.id,
      quid: newQuid(),
      type: q.type,
      order: i,
      prompt: q.prompt,
      config: { ...(q.config as QConfig) },
    }));

    const inserted: { id: string; order: number }[] = [];
    for (let at = 0; at < rows.length; at += INSERT_CHUNK) {
      inserted.push(
        ...(await tx
          .insert(questions)
          .values(rows.slice(at, at + INSERT_CHUNK))
          .returning({ id: questions.id, order: questions.order })),
      );
    }
    // RETURNING order isn't guaranteed — rejoin by the unique `order`.
    const idByOrder = new Map(inserted.map((r) => [r.order, r.id]));
    const oldToNew = new Map(srcQuestions.map((q, i) => [q.id, idByOrder.get(i) as string]));

    // Stage 2: source-id refs → new row ids. Refs to questions outside this
    // survey can't exist, so dropUnmapped only guards against dangling data.
    for (let i = 0; i < srcQuestions.length; i++) {
      const config = rows[i].config;
      if (!config.displayLogic && !normalizeOptionsFrom(config.optionsFrom)) continue;
      const { config: remapped } = remapConfigRefs(config, oldToNew, { dropUnmapped: true });
      await tx
        .update(questions)
        .set({ config: remapped })
        .where(eq(questions.id, oldToNew.get(srcQuestions[i].id) as string));
    }

    return survey.id;
  });

  return { ok: true, surveyId: newId };
}

/** Sets the soft archive flag. No-op-safe; returns whether the survey was owned. */
export async function setSurveyArchived(
  workspaceId: string,
  surveyId: string,
  archived: boolean,
): Promise<{ ok: boolean }> {
  const res = await db
    .update(surveys)
    .set({ archived })
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .returning({ id: surveys.id });
  return { ok: res.length > 0 };
}

export type DeleteResult = { ok: true } | { ok: false; reason: "not_found" };

/**
 * Hard-deletes a survey (cascade removes questions/responses/personas/…).
 *
 * There is no "has responses" guard: every response is synthetic and can be
 * regenerated from the personas and the question set. Archiving remains the
 * non-destructive option for surveys worth keeping.
 */
export async function deleteSurvey(
  workspaceId: string,
  surveyId: string,
): Promise<DeleteResult> {
  const source = await ownedSurvey(workspaceId, surveyId);
  if (!source) return { ok: false, reason: "not_found" };

  await db.delete(surveys).where(eq(surveys.id, surveyId));
  return { ok: true };
}
