/**
 * Open-text theme extraction over a survey's simulated answers.
 *
 * Themes are clustered by the local agent CLI (runLlmJson) and cached in
 * open_text_themes. Every theme keeps responseIds as evidence links so the UI
 * can drill down to the underlying answers — a theme that cannot point at
 * stored responses is dropped, never shown.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { openTextThemes, questions, responses, surveys } from "@/db/schema";
import { openAnswerText, openAnswerProbes } from "@/lib/open-answer";
import { runLlmJson } from "@/lib/llm";

/** Above this many answers we sample (and say so in the caveat). */
const THEME_SAMPLE_CAP = 200;
const MIN_ANSWERS_FOR_THEMES = 3;
const MAX_THEMES = 8;

export interface ThemeEvidence {
  responseId: string;
  text: string;
  /** Probe exchanges appended for context in the drill-down. */
  probes: { q: string; a: string }[];
}

export interface OpenTextTheme {
  name: string;
  summary: string;
  evidence: ThemeEvidence[];
}

export interface ThemeAnalysis {
  questionId: string;
  themes: OpenTextTheme[];
  /** Answer count the cache was computed against. */
  responseCount: number;
  /** Current answer count differs from the cached one → offer regenerate. */
  stale: boolean;
  sampled: boolean;
  createdAt: string;
}

export interface ThemeQuestionView {
  questionId: string;
  prompt: string;
  answerCount: number;
  analysis: ThemeAnalysis | null;
}

interface StoredTheme {
  name: string;
  summary: string;
  responseIds: string[];
}

interface AnswerRow {
  responseId: string;
  text: string;
  probes: { q: string; a: string }[];
}

async function ownedSurvey(surveyId: string, workspaceId: string) {
  const [s] = await db
    .select({ id: surveys.id, researchGoal: surveys.researchGoal })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  return s ?? null;
}

/** All non-empty open answers for one question. */
async function loadOpenAnswers(surveyId: string, questionId: string): Promise<AnswerRow[]> {
  const rows = await db
    .select({ id: responses.id, answers: responses.answers })
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true)))
    .orderBy(asc(responses.createdAt));

  const out: AnswerRow[] = [];
  for (const r of rows) {
    const v = (r.answers as Record<string, unknown>)[questionId];
    const text = openAnswerText(v).trim();
    if (!text) continue;
    out.push({ responseId: r.id, text, probes: openAnswerProbes(v) });
  }
  return out;
}

function toAnalysis(
  row: { themes: unknown; responseCount: number; createdAt: Date },
  questionId: string,
  answers: AnswerRow[],
): ThemeAnalysis {
  const byId = new Map(answers.map((a) => [a.responseId, a]));
  const stored = Array.isArray(row.themes) ? (row.themes as StoredTheme[]) : [];
  const themes: OpenTextTheme[] = stored.map((t) => ({
    name: t.name,
    summary: t.summary,
    evidence: (t.responseIds ?? [])
      .map((id) => byId.get(id))
      .filter((a): a is AnswerRow => !!a)
      .map((a) => ({ responseId: a.responseId, text: a.text, probes: a.probes })),
  }));
  return {
    questionId,
    themes,
    responseCount: row.responseCount,
    stale: answers.length !== row.responseCount,
    sampled: row.responseCount > THEME_SAMPLE_CAP,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Per-open-question view for the results tab: counts + cached analysis. */
export async function listThemeViews(
  surveyId: string,
  workspaceId: string,
): Promise<ThemeQuestionView[]> {
  if (!(await ownedSurvey(surveyId, workspaceId))) return [];
  const qs = await db
    .select({ id: questions.id, prompt: questions.prompt, type: questions.type })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));

  const views: ThemeQuestionView[] = [];
  for (const q of qs) {
    if (q.type !== "open") continue;
    const answers = await loadOpenAnswers(surveyId, q.id);
    const [cached] = await db
      .select()
      .from(openTextThemes)
      .where(eq(openTextThemes.questionId, q.id))
      .limit(1);
    views.push({
      questionId: q.id,
      prompt: q.prompt,
      answerCount: answers.length,
      analysis: cached ? toAnalysis(cached, q.id, answers) : null,
    });
  }
  return views;
}

/** Generates (or regenerates) themes for one open question and caches them. */
export async function generateThemes(
  surveyId: string,
  workspaceId: string,
  questionId: string,
): Promise<ThemeAnalysis> {
  const survey = await ownedSurvey(surveyId, workspaceId);
  if (!survey) throw new Error("설문을 찾을 수 없습니다.");
  const [q] = await db
    .select({ id: questions.id, prompt: questions.prompt, type: questions.type })
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.surveyId, surveyId)))
    .limit(1);
  if (!q || q.type !== "open") throw new Error("주관식 문항이 아닙니다.");

  const answers = await loadOpenAnswers(surveyId, questionId);
  if (answers.length < MIN_ANSWERS_FOR_THEMES) {
    throw new Error(`테마 분석에는 주관식 응답이 최소 ${MIN_ANSWERS_FOR_THEMES}건 필요합니다.`);
  }

  // Sample evenly when over the cap — the caveat is surfaced via `sampled`.
  const sampled =
    answers.length <= THEME_SAMPLE_CAP
      ? answers
      : answers.filter(
          (_, i) => i % Math.ceil(answers.length / THEME_SAMPLE_CAP) === 0,
        ).slice(0, THEME_SAMPLE_CAP);

  const numbered = sampled
    .map((a, i) => {
      const probeTail = a.probes.map((p) => ` / 추가문답: ${p.q} → ${p.a}`).join("");
      return `${i + 1}. ${a.text.slice(0, 400)}${probeTail.slice(0, 400)}`;
    })
    .join("\n");

  const prompt = `당신은 설문 주관식 응답을 주제(테마)로 묶는 리서치 분석가입니다.

리서치 목표: "${survey.researchGoal}"
문항: "${q.prompt}"

아래는 번호가 붙은 응답 목록입니다 (${sampled.length}건):
${numbered}

규칙:
- 제시된 응답에서 반복되는 주제만 테마로 만들 것 (응답에 없는 주제 금지).
- 테마는 2~${MAX_THEMES}개, 각 테마에 해당하는 응답 번호를 모두 나열할 것.
- 한 응답이 여러 테마에 속할 수 있음. 어떤 테마에도 속하지 않는 응답은 빼도 됨.
- name은 5단어 이내의 한국어 명사구, summary는 한두 문장.

Return ONLY a JSON object:
{"themes": [{"name": "...", "summary": "...", "answerNumbers": [1, 4, 7]}]}`;

  const out = await runLlmJson<{
    themes?: { name?: unknown; summary?: unknown; answerNumbers?: unknown }[];
  }>(prompt);

  const stored: StoredTheme[] = [];
  for (const t of out.themes ?? []) {
    if (typeof t.name !== "string" || !t.name.trim()) continue;
    if (!Array.isArray(t.answerNumbers)) continue;
    // Evidence link validation: only numbers that map to a real sampled answer
    // survive; a theme with no valid evidence is dropped entirely.
    const ids = [
      ...new Set(
        t.answerNumbers
          .map((n) => (typeof n === "number" ? sampled[n - 1]?.responseId : undefined))
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) continue;
    stored.push({
      name: t.name.trim(),
      summary: typeof t.summary === "string" ? t.summary.trim() : "",
      responseIds: ids,
    });
    if (stored.length >= MAX_THEMES) break;
  }
  if (stored.length === 0) throw new Error("응답에서 테마를 추출하지 못했습니다 — 다시 시도해 주세요.");

  const values = {
    workspaceId,
    surveyId,
    questionId,
    themes: stored,
    responseCount: answers.length,
    model: process.env.LOOP_LLM_MODEL || "sonnet",
    createdAt: new Date(),
  };
  const [row] = await db
    .insert(openTextThemes)
    .values(values)
    .onConflictDoUpdate({
      target: openTextThemes.questionId,
      set: { themes: stored, responseCount: answers.length, model: values.model, createdAt: values.createdAt },
    })
    .returning();

  return toAnalysis(row, questionId, answers);
}
