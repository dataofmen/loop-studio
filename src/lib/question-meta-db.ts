/**
 * US-004 (question-meta-loop): DB-side metadata inference — infer + persist
 * construct/topic for questions whose meta is empty or AI-owned.
 *
 * Trust-tier contract: metadata with origin "human" (or legacy meta with no
 * origin — unknown provenance is protected) is NEVER overwritten. Every save
 * re-reads the row and re-checks the guard so a concurrent manual edit wins.
 *
 * Version-history contract: these are meta-only background writes, so they
 * deliberately skip ensureBaseline/recordManualRevision AND the survey
 * updatedAt touch — otherwise AI inference would pollute "직접 수정" versions
 * and remount the editor (edit/page.tsx keys <Editor> on updatedAt) mid-typing.
 *
 * Separate from question-meta.ts (pure/testable) because this imports @/db,
 * which vitest cannot load.
 */

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { questions, surveys } from "@/db/schema";
import { withResolvedConstruct } from "@/lib/constructs";
import { normalizeMeta, optionLabels, type QMeta } from "@/lib/question-config";
import { inferQuestionMeta } from "@/lib/question-meta";

export type InferMetaOutcome =
  | { status: "saved"; meta: QMeta }
  /** Meta is human/unknown-origin (protected), possibly set mid-flight. */
  | { status: "skipped" }
  /** Question not found / CLI failure — harmless, caller just moves on. */
  | { status: "failed" };

export type BackfillMetaSummary = {
  /** Questions whose meta was empty when the backfill started. */
  total: number;
  filled: number;
  failed: number;
  /** questionId → saved meta, for client-side state refresh. */
  metas: Record<string, QMeta>;
};

/** True when inference may write: meta absent, or owned by AI. */
function inferable(meta: QMeta | undefined): boolean {
  return !meta || meta.origin === "ai";
}

const metaConstruct = sql<string>`${questions.config}->'meta'->>'construct'`;

/**
 * Distinct construct values already used across the workspace — offered to the
 * LLM as reuse candidates so inference converges on one spelling per concept.
 */
async function workspaceConstructs(workspaceId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ construct: metaConstruct })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(and(eq(surveys.workspaceId, workspaceId), isNotNull(metaConstruct)));
  return rows.map((r) => r.construct).filter(Boolean);
}

/**
 * Persist an inferred {construct, topic} onto a question, unless a protected
 * meta appeared since inference started (fresh re-read guard — the LLM call
 * takes seconds, plenty of time for the author to type their own values).
 * The construct is resolved against the workspace vocabulary first (US-006:
 * canonical name + constructId; free text kept on resolution failure) —
 * before the re-read, so the human-wins race window stays tight.
 */
async function saveInferredMeta(
  questionId: string,
  workspaceId: string,
  inferred: { construct: string; topic: string },
): Promise<InferMetaOutcome> {
  const resolved = await withResolvedConstruct(workspaceId, inferred);
  const [fresh] = await db
    .select({ config: questions.config })
    .from(questions)
    .where(eq(questions.id, questionId))
    .limit(1);
  if (!fresh) return { status: "failed" };
  const cfg = (fresh.config ?? {}) as Record<string, unknown>;
  const freshMeta = normalizeMeta(cfg.meta);
  if (!inferable(freshMeta)) return { status: "skipped" };
  const meta: QMeta = { ...(freshMeta ?? {}), ...resolved, origin: "ai" };
  await db
    .update(questions)
    .set({ config: { ...cfg, meta } })
    .where(eq(questions.id, questionId));
  return { status: "saved", meta };
}

/**
 * Infer + save meta for one question (background editor hook). Only runs when
 * the current meta is empty or AI-owned; never throws — failures resolve to
 * { status: "failed" } so the save/response flow can never be blocked.
 */
export async function inferMetaForQuestion(
  questionId: string,
  workspaceId: string,
): Promise<InferMetaOutcome> {
  try {
    const [row] = await db
      .select({
        prompt: questions.prompt,
        type: questions.type,
        config: questions.config,
        researchGoal: surveys.researchGoal,
      })
      .from(questions)
      .innerJoin(surveys, eq(questions.surveyId, surveys.id))
      .where(and(eq(questions.id, questionId), eq(surveys.workspaceId, workspaceId)))
      .limit(1);
    if (!row) return { status: "failed" };
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    if (!inferable(normalizeMeta(cfg.meta))) return { status: "skipped" };

    const inferred = await inferQuestionMeta({
      researchGoal: row.researchGoal,
      prompt: row.prompt,
      type: row.type,
      optionLabels: optionLabels(cfg.options),
      existingConstructs: await workspaceConstructs(workspaceId),
    });
    if (!inferred) return { status: "failed" };
    return await saveInferredMeta(questionId, workspaceId, inferred);
  } catch {
    return { status: "failed" };
  }
}

/**
 * Sequentially infer meta for every EMPTY-meta question of a survey (one CLI
 * call at a time — a survey-sized burst of parallel claude spawns would thrash).
 * Constructs saved earlier in the run join the reuse-candidate list for later
 * questions, so a single backfill converges on one vocabulary.
 */
export async function backfillSurveyMeta(
  surveyId: string,
  workspaceId: string,
): Promise<BackfillMetaSummary> {
  const summary: BackfillMetaSummary = { total: 0, filled: 0, failed: 0, metas: {} };
  const [survey] = await db
    .select({ researchGoal: surveys.researchGoal })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!survey) return summary;

  const rows = await db
    .select({ id: questions.id, prompt: questions.prompt, type: questions.type, config: questions.config })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));
  // Backfill targets only questions with NO meta at all — an intentionally
  // cleared human meta ({origin:"human"}) or an earlier AI pass is left alone.
  const targets = rows.filter((r) => !normalizeMeta((r.config as Record<string, unknown> | null)?.meta));
  summary.total = targets.length;
  if (targets.length === 0) return summary;

  const constructs = await workspaceConstructs(workspaceId);
  for (const t of targets) {
    const cfg = (t.config ?? {}) as Record<string, unknown>;
    const inferred = await inferQuestionMeta({
      researchGoal: survey.researchGoal,
      prompt: t.prompt,
      type: t.type,
      optionLabels: optionLabels(cfg.options),
      existingConstructs: constructs,
    });
    if (!inferred) {
      summary.failed++;
      continue;
    }
    const outcome = await saveInferredMeta(t.id, workspaceId, inferred);
    if (outcome.status === "saved") {
      summary.filled++;
      summary.metas[t.id] = outcome.meta;
      // Accumulate the CANONICAL spelling (post-resolution) as a reuse candidate.
      const saved = outcome.meta.construct ?? inferred.construct;
      if (!constructs.includes(saved)) constructs.push(saved);
    } else if (outcome.status === "failed") {
      summary.failed++;
    }
    // "skipped" (author typed meta mid-run): neither filled nor failed.
  }
  return summary;
}
