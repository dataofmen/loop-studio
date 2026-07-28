"use server";

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { surveys, questions } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { runLlmJson } from "@/lib/llm";
import { questionVisible, type DisplayLogic, type DisplayOp } from "@/lib/display-logic";
import { optionLabels, type ConfigOption, type ProbeConfig, type QMeta } from "@/lib/question-config";
import {
  backfillSurveyMeta,
  inferMetaForQuestion,
  type BackfillMetaSummary,
  type InferMetaOutcome,
} from "@/lib/question-meta-db";
import { ensureBaseline, recordManualRevision } from "@/lib/revisions";
import { getDemographicPreset, presetQuestionPayload } from "@/lib/demographic-presets";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";
type QuestionConfig = {
  options?: ConfigOption[];
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  rows?: string[];
  columns?: string[];
  limit?: number;
  displayLogic?: DisplayLogic;
  probe?: ProbeConfig;
  randomizeOptions?: boolean;
  optionsFrom?: { questionId: string; mode: "selected" };
  meta?: QMeta;
};

/** Throws unless the survey belongs to the current workspace. */
async function assertSurveyOwner(surveyId: string): Promise<string> {
  const workspaceId = await getWorkspaceId();
  const [s] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!s) throw new Error("not found");
  return workspaceId;
}

/** Resolves the survey/workspace for a question, asserting workspace ownership. */
async function assertQuestionOwner(
  questionId: string,
): Promise<{ surveyId: string; workspaceId: string }> {
  const [row] = await db
    .select({ surveyId: questions.surveyId, workspaceId: surveys.workspaceId })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(eq(questions.id, questionId))
    .limit(1);
  if (!row) throw new Error("not found");
  const workspaceId = await getWorkspaceId();
  if (row.workspaceId !== workspaceId) throw new Error("not found");
  return { surveyId: row.surveyId, workspaceId };
}

async function touchSurvey(surveyId: string) {
  await db
    .update(surveys)
    .set({ updatedAt: new Date() })
    .where(eq(surveys.id, surveyId));
}

export async function updateSurveyTitle(surveyId: string, title: string) {
  await assertSurveyOwner(surveyId);
  await db
    .update(surveys)
    .set({ title: title.slice(0, 200), updatedAt: new Date() })
    .where(eq(surveys.id, surveyId));
}

/** Updates the respondent-facing welcome/closing copy (null clears to default). */
export async function updateSurveyMessages(
  surveyId: string,
  patch: { welcomeMessage?: string; closingMessage?: string },
) {
  await assertSurveyOwner(surveyId);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.welcomeMessage !== undefined)
    set.welcomeMessage = patch.welcomeMessage.trim().slice(0, 1000) || null;
  if (patch.closingMessage !== undefined)
    set.closingMessage = patch.closingMessage.trim().slice(0, 1000) || null;
  await db.update(surveys).set(set).where(eq(surveys.id, surveyId));
}

export async function updateQuestion(
  questionId: string,
  patch: { prompt?: string; type?: QuestionType; config?: QuestionConfig },
  _src?: string,
) {
  const { surveyId, workspaceId } = await assertQuestionOwner(questionId);
  const set: Record<string, unknown> = {};
  if (patch.prompt !== undefined) set.prompt = patch.prompt;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.config !== undefined) set.config = patch.config;
  if (Object.keys(set).length > 0) {
    await ensureBaseline(surveyId, workspaceId);
    await db.update(questions).set(set).where(eq(questions.id, questionId));
    await touchSurvey(surveyId);
    // Version bookkeeping must never fail (or mis-report) a completed save;
    // a lost record is recovered by the next successful one (coalesced diff).
    await recordManualRevision(surveyId, workspaceId).catch((e) =>
      console.error("manual revision record failed:", e),
    );
  }
}

export async function addQuestion(surveyId: string) {
  const workspaceId = await assertSurveyOwner(surveyId);
  await ensureBaseline(surveyId, workspaceId);
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${questions.order}), -1)` })
    .from(questions)
    .where(eq(questions.surveyId, surveyId));
  const [created] = await db
    .insert(questions)
    .values({
      surveyId,
      type: "open",
      order: (max ?? -1) + 1,
      prompt: "새 질문",
      config: {},
    })
    .returning();
  await touchSurvey(surveyId);
  await recordManualRevision(surveyId, workspaceId).catch((e) =>
    console.error("manual revision record failed:", e),
  );
  return created;
}

/**
 * US-602: inserts standard demographic preset questions (appended at the end;
 * the author drags them where needed — quota screeners belong up front).
 * Keys resolve against the preset module (the single source of options), so a
 * tampered client can only ever insert the standard questions.
 */
export async function addDemographicPresets(surveyId: string, keys: string[]) {
  const workspaceId = await assertSurveyOwner(surveyId);
  const presets = [...new Set(keys)]
    .map((k) => getDemographicPreset(k))
    .filter((p): p is NonNullable<typeof p> => !!p);
  if (presets.length === 0) return [];

  await ensureBaseline(surveyId, workspaceId);
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${questions.order}), -1)` })
    .from(questions)
    .where(eq(questions.surveyId, surveyId));

  const created = await db
    .insert(questions)
    .values(
      presets.map((p, i) => ({
        surveyId,
        order: (max ?? -1) + 1 + i,
        ...presetQuestionPayload(p),
      })),
    )
    .returning();
  await touchSurvey(surveyId);
  await recordManualRevision(surveyId, workspaceId).catch((e) =>
    console.error("manual revision record failed:", e),
  );
  return created;
}

export async function deleteQuestion(questionId: string) {
  const { surveyId, workspaceId } = await assertQuestionOwner(questionId);
  await ensureBaseline(surveyId, workspaceId);
  await db.delete(questions).where(eq(questions.id, questionId));
  await touchSurvey(surveyId);
  await recordManualRevision(surveyId, workspaceId).catch((e) =>
    console.error("manual revision record failed:", e),
  );
}

/** Persists a new order; orderedIds must be the survey's full question id list. */
export async function reorderQuestions(surveyId: string, orderedIds: string[]) {
  const workspaceId = await assertSurveyOwner(surveyId);
  await ensureBaseline(surveyId, workspaceId);
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(questions)
        .set({ order: i })
        .where(and(eq(questions.id, orderedIds[i]), eq(questions.surveyId, surveyId)));
    }
  });
  await touchSurvey(surveyId);
  await recordManualRevision(surveyId, workspaceId).catch((e) =>
    console.error("manual revision record failed:", e),
  );
}

export async function listQuestions(surveyId: string) {
  await assertSurveyOwner(surveyId);
  return db
    .select()
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));
}

/**
 * Background meta inference for one question (US-004). Fills construct/topic
 * when meta is empty or AI-owned; human-entered metadata is never overwritten.
 * Never throws — any failure is harmless to the editing/save flow.
 */
export async function inferMetaAction(questionId: string): Promise<InferMetaOutcome> {
  try {
    const { workspaceId } = await assertQuestionOwner(questionId);
    return await inferMetaForQuestion(questionId, workspaceId);
  } catch {
    return { status: "failed" };
  }
}

/** One-click backfill: infer meta for every empty-meta question of the survey. */
export async function backfillMetaAction(surveyId: string): Promise<BackfillMetaSummary> {
  const workspaceId = await assertSurveyOwner(surveyId);
  return backfillSurveyMeta(surveyId, workspaceId);
}

const VALID_OPS: DisplayOp[] = ["eq", "ne", "in", "not_in", "gte", "lte", "gt", "lt", "contains"];

export type CompileDisplayLogicState = {
  error?: string;
  logic?: DisplayLogic;
  explanation?: string;
  tests?: string[];
};

/**
 * AI-assisted display logic: the human describes the condition in natural
 * language; the claude CLI compiles it into a structured DisplayLogic against the
 * survey's earlier questions. Returns a Korean explanation + a couple of sample
 * evaluations so the human can confirm before applying.
 */
export async function compileDisplayLogicAction(
  surveyId: string,
  questionId: string,
  description: string,
): Promise<CompileDisplayLogicState> {
  try {
    await assertQuestionOwner(questionId);
  } catch {
    return { error: "문항을 찾을 수 없습니다." };
  }
  if (description.trim().length < 5) return { error: "조건을 문장으로 설명해 주세요." };

  const rows = await db
    .select({ id: questions.id, order: questions.order, type: questions.type, prompt: questions.prompt, config: questions.config })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));
  const target = rows.find((r) => r.id === questionId);
  if (!target) return { error: "문항을 찾을 수 없습니다." };
  const prior = rows.filter((r) => r.order < target.order);
  if (prior.length === 0) return { error: "앞선 문항이 없어 조건을 만들 수 없습니다." };

  const catalog = prior
    .map((q, i) => {
      const opts = optionLabels((q.config as { options?: ConfigOption[] })?.options);
      return `[${i + 1}] type=${q.type} prompt="${q.prompt}"${opts.length ? ` options=${JSON.stringify(opts)}` : ""}`;
    })
    .join("\n");

  const prompt = `You compile a survey "display condition" from a natural-language description.
The condition decides whether a LATER question is shown, based on answers to these EARLIER questions:
${catalog}

Description (Korean): "${description}"

Operators: eq, ne, in, not_in (value = array), gte, lte, gt, lt (numeric), contains.
Return ONLY JSON (no prose, no fences):
{
  "match": "all" | "any",
  "conditions": [ { "ref": <1-based index into the list above>, "op": "<operator>", "value": <string | number | string[]> } ],
  "explanation": "<one short Korean sentence describing when the question will show>"
}
Rules: reference questions only by their [n] index via "ref". For choice questions use the exact option strings. Use "in" with an array for "one of several options". Keep it minimal.`;

  let out: { match?: string; conditions?: { ref?: number; op?: string; value?: unknown }[]; explanation?: string };
  try {
    out = await runLlmJson(prompt);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "AI 생성 실패" };
  }

  const conditions: DisplayLogic["conditions"] = [];
  for (const c of out.conditions ?? []) {
    const idx = Number(c.ref) - 1;
    if (!(idx >= 0 && idx < prior.length)) continue;
    if (!VALID_OPS.includes(c.op as DisplayOp)) continue;
    const value =
      c.op === "in" || c.op === "not_in"
        ? (Array.isArray(c.value) ? c.value.map(String) : c.value == null ? [] : [String(c.value)])
        : typeof c.value === "number"
          ? c.value
          : String(c.value);
    // Skip nonsensical conditions the model sometimes emits (e.g. in/not_in with
    // no values, or an empty scalar) — an empty in-set is never satisfiable.
    if ((c.op === "in" || c.op === "not_in") && (!Array.isArray(value) || value.length === 0)) continue;
    if (c.op !== "in" && c.op !== "not_in" && (value === "" || value === null || value === undefined)) continue;
    conditions.push({ questionId: prior[idx].id, op: c.op as DisplayOp, value });
  }
  if (conditions.length === 0)
    return { error: "조건을 해석하지 못했습니다. 값(예: 어떤 보기)을 포함해 더 구체적으로 설명해 주세요." };

  const logic: DisplayLogic = { match: out.match === "any" ? "any" : "all", conditions };

  // Build sample evaluations against the first condition's referenced question so
  // the human can sanity-check ("... = 불만족 → 표시됨 / ... = 만족 → 숨김").
  const tests: string[] = [];
  const first = conditions[0];
  const refQ = prior.find((p) => p.id === first.questionId);
  const refOpts = optionLabels((refQ?.config as { options?: ConfigOption[] } | undefined)?.options);
  const sampleTrue = Array.isArray(first.value) ? first.value[0] : first.value;
  if (sampleTrue !== undefined && sampleTrue !== "") {
    const show = questionVisible(logic, { [first.questionId]: sampleTrue as string });
    tests.push(`${refQ?.prompt.slice(0, 16)} = "${sampleTrue}" → ${show ? "표시됨" : "숨김"}`);
  }
  const other = refOpts.find((o) => !(Array.isArray(first.value) ? first.value.includes(o) : String(first.value) === o));
  if (other) {
    const show = questionVisible(logic, { [first.questionId]: other });
    tests.push(`${refQ?.prompt.slice(0, 16)} = "${other}" → ${show ? "표시됨" : "숨김"}`);
  }

  return { logic, explanation: String(out.explanation ?? ""), tests };
}
