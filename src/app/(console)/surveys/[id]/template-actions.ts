"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { describeDroppedRefs } from "@/lib/template-refs";
import {
  createSurveyFromTemplate,
  decomposeTemplateById,
  generateTemplateSummary,
  insertTemplateQuestions,
  listTemplateQuestions,
  saveAsTemplate,
  saveQuestionsAsBlock,
} from "@/lib/templates";

async function assertOwner(surveyId: string): Promise<string> {
  const workspaceId = await getWorkspaceId();
  const [s] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!s) throw new Error("not found");
  return workspaceId;
}

/** Saves the current survey's question set as a reusable workspace template (US-008). */
export async function saveTemplateAction(
  surveyId: string,
  name: string,
  description: string,
): Promise<{
  error?: string;
  id?: string;
  name?: string;
  derived?: { blocks: number; questions: number };
}> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  if (name.trim().length < 2) return { error: "템플릿 이름을 입력해 주세요." };
  try {
    const { id, derived } = await saveAsTemplate(
      surveyId,
      workspaceId,
      name.trim(),
      description.trim() || null,
    );
    revalidatePath(`/surveys/${surveyId}`);
    return { id, name: name.trim(), derived };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "템플릿 저장 실패" };
  }
}

/**
 * Saves a hand-picked subset of the survey's questions as a reusable block
 * (US-904) or single question (US-906). Selection is by quid.
 */
export async function saveQuestionsAsBlockAction(
  surveyId: string,
  quids: string[],
  name: string,
  opts: { description?: string; kind?: "block" | "question" } = {},
): Promise<{ error?: string; id?: string; droppedNotice?: string }> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  if (name.trim().length < 2) return { error: "이름을 입력해 주세요." };
  if (quids.length === 0) return { error: "문항을 1개 이상 선택하세요." };
  try {
    const { id, dropped } = await saveQuestionsAsBlock(surveyId, workspaceId, quids, name.trim(), {
      description: opts.description?.trim() || null,
      kind: opts.kind ?? "block",
    });
    revalidatePath(`/surveys/${surveyId}/edit`);
    return { id, droppedNotice: describeDroppedRefs(dropped) ?? undefined };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "블록 저장 실패" };
  }
}

/**
 * Creates a new draft survey seeded from a template (US-010). Returns the new
 * survey id (the client navigates) plus a notice when template refs pointing
 * outside the snapshot were dropped during seeding — never a silent loss.
 */
export async function createSurveyFromTemplateAction(
  templateId: string,
): Promise<{ error?: string; id?: string; droppedNotice?: string }> {
  const workspaceId = await getWorkspaceId();
  try {
    const { id, dropped } = await createSurveyFromTemplate(workspaceId, templateId);
    return { id, droppedNotice: describeDroppedRefs(dropped) ?? undefined };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "설문 생성 실패" };
  }
}

/**
 * Inserts a template's questions into an existing survey at a position (US-010).
 * `quids` (US-905) limits insertion to selected snapshot questions; omit/empty
 * inserts the whole template.
 */
export async function insertTemplateQuestionsAction(
  surveyId: string,
  templateId: string,
  atIndex?: number,
  quids?: string[],
): Promise<{ error?: string; inserted?: number; droppedNotice?: string }> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    const { inserted, dropped } = await insertTemplateQuestions(
      surveyId,
      workspaceId,
      templateId,
      atIndex,
      { quids },
    );
    revalidatePath(`/surveys/${surveyId}/edit`);
    return { inserted, droppedNotice: describeDroppedRefs(dropped) ?? undefined };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "템플릿 삽입 실패" };
  }
}

/** Template questions (quid/type/prompt) for the editor insert picker (US-905). */
export async function listInsertableTemplatesAction(): Promise<
  { id: string; name: string; kind: string; questions: { quid: string; type: string; prompt: string }[] }[]
> {
  const workspaceId = await getWorkspaceId();
  return listTemplateQuestions(workspaceId);
}

/**
 * US-908 (retroactive): decomposes an existing survey template into block/
 * question sub-templates on demand — for templates saved before auto-decompose
 * existed. edit_surveys gated; refuses non-survey / already-derived templates.
 */
export async function decomposeTemplateAction(
  templateId: string,
): Promise<{ error?: string; derived?: { blocks: number; questions: number } }> {
  const workspaceId = await getWorkspaceId();
  try {
    const derived = await decomposeTemplateById(templateId, workspaceId);
    revalidatePath("/templates");
    return { derived };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "분해 실패" };
  }
}

/** Generates + stores a one-line AI summary for a template (US-907). */
export async function generateTemplateSummaryAction(
  templateId: string,
): Promise<{ error?: string; summary?: string }> {
  const workspaceId = await getWorkspaceId();
  try {
    const { summary } = await generateTemplateSummary(templateId, workspaceId);
    revalidatePath("/templates");
    return { summary };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "요약 생성 실패" };
  }
}
