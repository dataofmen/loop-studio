"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceId } from "@/lib/auth";
import {
  aggregateConstructResults,
  type ConstructResults,
} from "@/lib/construct-analytics";
import {
  listConstructAliases,
  backfillWorkspaceConstructs,
  listConstructQuestions,
  mergeConstructs,
  reinferWorkspaceConstructs,
  removeAlias,
  renameConstruct,
  type ConstructBackfillSummary,
  type ConstructQuestionRef,
  type CurateResult,
  type ReinferSummary,
} from "@/lib/constructs";
import { describeDroppedRefs } from "@/lib/template-refs";
import { createTemplateFromConstructQuestions } from "@/lib/templates";

/** Member questions of a construct — evidence for rename/merge decisions. */
export async function constructQuestionsAction(
  constructId: string,
): Promise<ConstructQuestionRef[]> {
  const workspaceId = await getWorkspaceId();
  return listConstructQuestions(workspaceId, constructId);
}

/**
 * US-002: cross-survey results of one construct (real responses only —
 * synthetic rows are tallied separately for the "합성만 있음" label).
 * Returns null when the construct isn't in this workspace.
 */
export async function constructResultsAction(
  constructId: string,
): Promise<ConstructResults | null> {
  const workspaceId = await getWorkspaceId();
  return aggregateConstructResults(workspaceId, constructId);
}

export type ConstructTemplateResult =
  | { ok: true; templateId: string; construct: string; droppedNotice?: string }
  | { ok: false; error: string };

/**
 * US-004: snapshot hand-picked member questions of a construct (across
 * surveys) into a question-bank template. Ownership of both the construct and
 * every selected question is validated inside the lib call.
 */
export async function createConstructTemplateAction(
  constructId: string,
  questionIds: string[],
  name: string,
): Promise<ConstructTemplateResult> {
  const workspaceId = await getWorkspaceId();
  try {
    const r = await createTemplateFromConstructQuestions(
      workspaceId,
      constructId,
      questionIds,
      name,
    );
    return {
      ok: true,
      templateId: r.id,
      construct: r.constructName,
      droppedNotice: describeDroppedRefs(r.dropped) ?? undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "템플릿 생성에 실패했습니다.",
    };
  }
}

/** Aliases currently absorbed into a construct, for the curation UI. */
export async function listAliasesAction(
  constructId: string,
): Promise<{ canonical: string; aliases: string[] }> {
  const workspaceId = await getWorkspaceId();
  return listConstructAliases(workspaceId, constructId);
}

/** Remove a mis-absorbed alias so future spellings re-resolve fresh. */
export async function removeAliasAction(
  constructId: string,
  alias: string,
): Promise<CurateResult> {
  const workspaceId = await getWorkspaceId();
  const result = await removeAlias(workspaceId, constructId, alias);
  if (result.ok) revalidatePath("/constructs");
  return result;
}

/** Rename a construct's canonical name (old name demoted to alias). */
export async function renameConstructAction(
  constructId: string,
  newName: string,
): Promise<CurateResult> {
  const workspaceId = await getWorkspaceId();
  const result = await renameConstruct(workspaceId, constructId, newName);
  if (result.ok) revalidatePath("/constructs");
  return result;
}

/** Merge source into target (destructive — client confirms first). */
export async function mergeConstructsAction(
  sourceId: string,
  targetId: string,
): Promise<CurateResult> {
  const workspaceId = await getWorkspaceId();
  const result = await mergeConstructs(workspaceId, sourceId, targetId);
  if (result.ok) revalidatePath("/constructs");
  return result;
}

/**
 * US-007 wiring: canonicalize legacy free-text constructs across the
 * workspace (assigns constructId, absorbs spellings as aliases).
 */
export async function backfillConstructsAction(): Promise<ConstructBackfillSummary> {
  const workspaceId = await getWorkspaceId();
  const summary = await backfillWorkspaceConstructs(workspaceId);
  revalidatePath("/constructs");
  return summary;
}

/**
 * Construct re-review: re-run inference (improved prompt) over the workspace's
 * empty/AI-origin question meta to fix mismatched constructs. Human meta is
 * protected; existing topics are kept. Heavier than backfill (one claude call
 * per question) — the client shows a spinner + before/after report.
 */
export async function reinferConstructsAction(): Promise<ReinferSummary> {
  const workspaceId = await getWorkspaceId();
  const summary = await reinferWorkspaceConstructs(workspaceId);
  revalidatePath("/constructs");
  return summary;
}
