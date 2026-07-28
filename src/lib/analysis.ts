import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { questions, responses } from "@/db/schema";
import {
  isProbedAnswer,
  openAnswerProbes,
  openAnswerText,
  serializeOpenAnswer,
  type ProbeQA,
} from "@/lib/open-answer";
import { computeDistributions, type Distribution } from "@/lib/quality";
import { otherOption } from "@/lib/other-text";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";
type QRow = { id: string; type: QuestionType; order: number; prompt: string; config: unknown };

/** One open-ended simulated answer: base text plus any probe exchanges. */
export type OpenResponseItem = { text: string; probes: ProbeQA[] };

export type OpenResponses = {
  questionId: string;
  prompt: string;
  answers: OpenResponseItem[];
};

export type ResponseAnalysis = {
  responseCount: number;
  /** Per-question distributions over the simulated responses (in order). */
  distributions: Distribution[];
  /** Simulated open-ended answers, per open question. */
  openResponses: OpenResponses[];
  /**
   * "Other" free texts per question (only questions with a special "other"
   * option and at least one text), keyed for display under that question's
   * distribution.
   */
  otherTexts: { questionId: string; texts: string[] }[];
};

/** Aggregates a survey's simulated responses for the analysis dashboard. */
export async function getResponseAnalysis(surveyId: string): Promise<ResponseAnalysis> {
  const qs = (await db
    .select({
      id: questions.id,
      type: questions.type,
      order: questions.order,
      prompt: questions.prompt,
      config: questions.config,
    })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order))) as unknown as QRow[];

  const [distributions, rows] = await Promise.all([
    computeDistributions(surveyId),
    db
      .select({ id: responses.id, answers: responses.answers, otherTexts: responses.otherTexts })
      .from(responses)
      .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true))),
  ]);

  const openResponses: OpenResponses[] = [];
  for (const q of qs.filter((x) => x.type === "open")) {
    const answers = rows
      .map((r): OpenResponseItem => {
        const v = (r.answers as Record<string, unknown>)[q.id];
        return { text: openAnswerText(v).trim(), probes: openAnswerProbes(v) };
      })
      .filter((a) => a.text !== "");
    openResponses.push({ questionId: q.id, prompt: q.prompt, answers });
  }

  // What personas "typed" for a special "other" option.
  const otherTexts: { questionId: string; texts: string[] }[] = [];
  for (const q of qs) {
    const other = otherOption((q.config as { options?: unknown } | null)?.options);
    if (!other || other.noText) continue;
    const texts = rows
      .map((r) => (r.otherTexts as Record<string, unknown> | null)?.[q.id])
      .filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (texts.length) otherTexts.push({ questionId: q.id, texts });
  }

  const responseCount = distributions.reduce((m, d) => Math.max(m, d.n), 0);

  return { responseCount, distributions, openResponses, otherTexts };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function answerToCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join("; ");
  // probed open answers ({answer, probes}) → text plus serialized probe Q&As
  if (isProbedAnswer(value)) return serializeOpenAnswer(value);
  // matrix answers are {row: column} objects → "row: column" pairs
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join("; ");
  return String(value);
}

/**
 * Exports raw simulated responses as CSV.
 * One row per response; columns are question prompts in order plus metadata.
 */
export async function buildResponsesCsv(surveyId: string): Promise<string> {
  const qs = (await db
    .select({
      id: questions.id,
      type: questions.type,
      order: questions.order,
      prompt: questions.prompt,
      config: questions.config,
    })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order))) as unknown as QRow[];

  const rows = await db
    .select({
      personaId: responses.personaId,
      createdAt: responses.createdAt,
      answers: responses.answers,
      otherTexts: responses.otherTexts,
      surveyVersion: responses.surveyVersion,
    })
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true)))
    .orderBy(asc(responses.createdAt));

  // US-002: a question with a text-input "other" option gets a companion
  // column right after its own, holding the respondent's typed free text.
  const hasOther = (q: QRow) => {
    const o = otherOption((q.config as { options?: unknown } | null)?.options);
    return o != null && !o.noText;
  };

  const header = [
    "persona_id",
    "created_at",
    "survey_version",
    ...qs.flatMap((q, i) =>
      hasOther(q) ? [`Q${i + 1}. ${q.prompt}`, `Q${i + 1}. 기타 입력`] : [`Q${i + 1}. ${q.prompt}`],
    ),
  ];

  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    const answers = (r.answers ?? {}) as Record<string, unknown>;
    const others = (r.otherTexts ?? {}) as Record<string, unknown>;
    const cells = [
      r.personaId ?? "",
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? ""),
      r.surveyVersion ?? "",
      ...qs.flatMap((q) => {
        const cell = answerToCell(answers[q.id]);
        if (!hasOther(q)) return [cell];
        const t = others[q.id];
        return [cell, typeof t === "string" ? t : ""];
      }),
    ];
    lines.push(cells.map((c) => csvEscape(String(c))).join(","));
  }

  return lines.join("\r\n");
}
