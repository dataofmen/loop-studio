import { eq } from "drizzle-orm";
import { db } from "@/db";
import { surveys, questions } from "@/db/schema";
import { runLlmJson } from "@/lib/llm";
import { feedbackContext } from "@/lib/feedback";
import { constructReuseContext } from "@/lib/construct-context";
import { withResolvedConstruct } from "@/lib/constructs";
import { sanitizeShowIf, showIfToDisplayLogic } from "@/lib/display-logic";
import { normalizeOptions, promoteSpecialOptions, stampMetaOrigin, type QMeta } from "@/lib/question-config";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";

type GeneratedQuestion = {
  type: QuestionType;
  prompt: string;
  options?: string[];
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  rows?: string[];
  columns?: string[];
  limit?: number;
  meta?: QMeta;
  // Ref-form branching / carry-forward (1-based index into the generated
  // list) — resolved to live question ids after insert, like applyRevision.
  showIf?: unknown;
  optionsFromRef?: { ref?: unknown; mode?: unknown };
};

type GeneratedSurvey = {
  title: string;
  questions: GeneratedQuestion[];
};

const VALID_TYPES: QuestionType[] = [
  "single",
  "multi",
  "scale",
  "open",
  "ranking",
  "matrix",
  "nps",
];

/** Builds the generation prompt, injecting reuse context and past feedback. */
function buildPrompt(
  goal: string,
  feedback: string[],
  constructContext: string[] = [],
): string {
  const feedbackBlock =
    feedback.length > 0
      ? `\n\nHuman feedback on this workspace's past AI-generated surveys/summaries (honor it: keep what they liked, fix what they flagged):\n${feedback
          .map((f, i) => `${i + 1}. ${f}`)
          .join("\n")}`
      : "";

  const constructBlock =
    constructContext.length > 0
      ? `\n\nConcepts this workspace has measured before (its construct vocabulary), each with its proven question wording and prior evidence:\n${constructContext
          .map((c, i) => `${i + 1}. ${c}`)
          .join("\n")}\nWhen the research goal re-measures one of these concepts, REUSE the existing question wording above (verbatim, or minimally adapted) so results stay comparable across survey waves, and set that question's "meta"."construct" to the construct's canonical name EXACTLY as written above. Do NOT force unrelated concepts into the survey just because they are listed.`
      : "";

  return `You are an expert survey methodologist. Design a survey for this research goal:

"${goal}"${feedbackBlock}${constructBlock}

Return ONLY a JSON object (no prose, no markdown fences) of this exact shape:
{
  "title": "short survey title",
  "questions": [
    { "type": "single", "prompt": "...", "options": ["...", "..."] },
    { "type": "multi", "prompt": "...", "options": ["...", "..."] },
    { "type": "scale", "prompt": "...", "scale": { "min": 1, "max": 5, "minLabel": "...", "maxLabel": "..." } },
    { "type": "ranking", "prompt": "...", "options": ["...", "..."], "limit": 3 },
    { "type": "matrix", "prompt": "...", "rows": ["...", "..."], "columns": ["...", "..."] },
    { "type": "nps", "prompt": "..." },
    { "type": "open", "prompt": "..." }
  ]
}

Rules:
- Produce between 5 and 10 questions, with a mix of types.
- "single", "multi", and "ranking" MUST include a non-empty "options" array.
- "ranking" MAY include "limit" (integer): the number of top ranks to collect (e.g. 3 = "rank your top 3"). Omit "limit" to rank all options.
- "scale" MUST include "scale" with integer min/max.
- "matrix" MUST include non-empty "rows" (sub-questions) and "columns" (the shared answer scale).
- "nps" and "open" have no options (nps is a fixed 0–10 recommendation scale).
- Use "ranking", "matrix", "nps" only where they genuinely fit; do not overuse them.
- Avoid leading or biased wording. Keep prompts concise.
- The survey will be machine-reviewed before launch against these criteria — satisfy them upfront: no double-barreled questions (one thing per question); options mutually exclusive and collectively exhaustive (include 기타/해당 없음 where the list can't be complete); scale endpoints labeled (minLabel/maxLabel) and balanced with a neutral midpoint where appropriate; no ambiguous frequency/degree terms without a reference frame; earlier questions must not bias later ones (ask general → specific); cover every measurement area the research goal needs (e.g. churn goals need win-back intent/conditions).
- Any question MAY include "showIf": { "match": "all"|"any", "conditions": [{ "ref": <1-based index of an EARLIER question in YOUR list>, "op": "eq|ne|in|not_in|gte|lte|gt|lt|contains", "value": <string | number | string[]> }] } — the question is shown only when the condition on the earlier answer holds. USE THIS whenever the survey has segments (e.g. a screening question splitting current users / churned users / non-users): segment-specific questions MUST be gated with showIf instead of hedging in the wording ("현재 이용 중이라면…" 같은 문구 우회 금지). For choice questions use the exact option label strings as values.
- A choice question MAY include "optionsFromRef": { "ref": <1-based index of an EARLIER choice question>, "mode": "selected" } — its options become the ones the respondent selected in that earlier question (carry-forward). USE THIS for "위에서 선택하신 것 중 가장 …" style questions; such a question needs no "options" of its own.
- Every question MUST include a "meta" object recording design intent: { "construct": "<the single concept this question measures, e.g. 서비스 만족도>", "topic": "<short topic tag>", "source": "custom|validated|adapted", "validatedScale": "<e.g. SERVQUAL, only if adapted/validated>", "notes": "<design note>" }. "construct" and "topic" are REQUIRED on every question — never omit them; write them in the survey's language. "source", "validatedScale", and "notes" are optional — include them only when confident.`;
}

/** Maps a validated generated question to a DB row payload. */
function toQuestionConfig(q: GeneratedQuestion): Record<string, unknown> {
  // Freshly generated metadata is AI-authored by definition — force the "ai"
  // trust tier so it can never masquerade as human input (US-003).
  const stamped = stampMetaOrigin(q.meta, "ai", { force: true });
  const meta = stamped ? { meta: stamped } : {};
  // promoteSpecialOptions: an AI-written "기타(직접 입력)"/"해당 없음" string
  // becomes a real special option (anchored, free-text input on).
  if (q.type === "single" || q.type === "multi") {
    return { options: promoteSpecialOptions(normalizeOptions(q.options)), ...meta };
  }
  if (q.type === "ranking") {
    return {
      options: promoteSpecialOptions(normalizeOptions(q.options)),
      ...(q.limit && q.limit > 0 ? { limit: Math.floor(q.limit) } : {}),
      ...meta,
    };
  }
  if (q.type === "scale") {
    return { scale: q.scale ?? { min: 1, max: 5 }, ...meta };
  }
  if (q.type === "matrix") {
    return { rows: q.rows ?? [], columns: q.columns ?? [], ...meta };
  }
  return { ...meta };
}

function validate(survey: GeneratedSurvey): GeneratedSurvey {
  if (!survey || !Array.isArray(survey.questions) || survey.questions.length === 0) {
    throw new Error("Generated survey has no questions");
  }
  for (const q of survey.questions) {
    if (!VALID_TYPES.includes(q.type)) {
      throw new Error(`Invalid question type: ${q.type}`);
    }
    if (!q.prompt || typeof q.prompt !== "string") {
      throw new Error("Question missing prompt");
    }
    const carries = Number.isInteger(Number(q.optionsFromRef?.ref)) && Number(q.optionsFromRef?.ref) >= 1;
    if (
      (q.type === "single" || q.type === "multi" || q.type === "ranking") &&
      !carries &&
      (!Array.isArray(q.options) || q.options.length === 0)
    ) {
      throw new Error(`Choice question missing options: ${q.prompt}`);
    }
    if (
      q.type === "matrix" &&
      (!Array.isArray(q.rows) || q.rows.length === 0 || !Array.isArray(q.columns) || q.columns.length === 0)
    ) {
      throw new Error(`Matrix question missing rows/columns: ${q.prompt}`);
    }
  }
  return survey;
}

/**
 * Generates a draft survey from a research goal via the claude CLI,
 * injecting the workspace's reuse context, and persists it.
 * Returns the new survey id.
 */
export async function generateSurvey(
  workspaceId: string,
  goal: string,
): Promise<string> {
  // Inject reusable constructs (US-003, construct-loop-review): concepts this
  // workspace measured before, with their proven wording — so re-measured
  // concepts keep comparable wording and tag to the existing canonical
  // construct. Empty for a fresh workspace (behavior unchanged).
  const constructCtx = await constructReuseContext(workspaceId, goal, { limit: 5 });

  // Inject accumulated human feedback (US-014) so the system improves each round.
  const feedbackLines = await feedbackContext(workspaceId, { limit: 20 });

  // Full-survey generation with reuse context and branching is a long
  // generation — same budget as proposeRevision (well past 120s).
  const generated = validate(
    await runLlmJson<GeneratedSurvey>(
      buildPrompt(goal, feedbackLines, constructCtx.lines),
      { timeoutMs: 300_000 },
    ),
  );

  const [survey] = await db
    .insert(surveys)
    .values({
      workspaceId,
      title: generated.title?.slice(0, 200) || goal.slice(0, 200),
      researchGoal: goal,
      status: "draft",
    })
    .returning({ id: surveys.id });

  // Resolve each question's construct against the workspace vocabulary
  // (US-006): canonical name + constructId. Sequential on purpose — a row
  // created for question 1 is exact-matched (not re-created) by question 5.
  // withResolvedConstruct never throws; failures keep the free-text meta.
  const configs: Record<string, unknown>[] = [];
  for (const q of generated.questions) {
    const cfg = toQuestionConfig(q);
    const meta = cfg.meta as QMeta | undefined;
    if (meta?.construct) cfg.meta = await withResolvedConstruct(workspaceId, meta);
    configs.push(cfg);
  }

  const inserted = await db
    .insert(questions)
    .values(
      generated.questions.map((q, i) => ({
        surveyId: survey.id,
        type: q.type,
        order: i,
        prompt: q.prompt,
        config: configs[i],
      })),
    )
    .returning({ id: questions.id, order: questions.order });
  inserted.sort((a, b) => a.order - b.order);
  const ids = inserted.map((r) => r.id);

  // Resolve ref-form branching/carry-forward to live question ids (two-phase,
  // same as applyRevision): the model expresses "showIf"/"optionsFromRef" as
  // 1-based positions in its own list, which only now have row ids.
  for (let i = 0; i < generated.questions.length; i++) {
    const q = generated.questions[i];
    const showIf = sanitizeShowIf(q.showIf);
    const ofrRaw = q.optionsFromRef;
    const ofrRef = ofrRaw && Number.isInteger(Number(ofrRaw.ref)) ? Number(ofrRaw.ref) : 0;
    if (!showIf && !(ofrRef >= 1)) continue;
    const cfg = { ...configs[i] } as Record<string, unknown>;
    if (showIf) {
      const logic = showIfToDisplayLogic(showIf, (ref) => ids[ref - 1], i + 1);
      if (logic) cfg.displayLogic = logic;
    }
    if (ofrRef >= 1 && ofrRef <= ids.length && ofrRef !== i + 1) {
      cfg.optionsFrom = { questionId: ids[ofrRef - 1], mode: "selected" };
    }
    await db.update(questions).set({ config: cfg }).where(eq(questions.id, ids[i]));
  }

  return survey.id;
}
