import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { normalizeOptionsFrom } from "@/lib/carry-forward";
import { questions, responses } from "@/db/schema";
import {
  answerValues,
  computeQuestionDistribution,
  type Distribution,
  type QRow,
} from "@/lib/distribution-core";
import { runLlmJson } from "@/lib/llm";

// Per-question math lives in distribution-core.ts (pure, shared with
// construct-stats.ts); re-export so existing importers keep working.
export type { Distribution } from "@/lib/distribution-core";

export type Warning = {
  questionId: string;
  severity: "high" | "medium" | "low";
  message: string;
  suggestion:
    | { action: "rewrite_prompt"; newPrompt: string }
    | { action: "replace_options"; newOptions: string[] }
    | { action: "none" };
};

/** Computes per-question distributions over a survey's simulated responses. */
export async function computeDistributions(surveyId: string): Promise<Distribution[]> {
  const qs = (await db
    .select()
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order))) as unknown as QRow[];

  // Carry-forward questions have no options of their own — answers use the
  // SOURCE question's labels, so tally against those for a correct breakdown.
  const byId = new Map(qs.map((x) => [x.id, x]));
  for (const q of qs) {
    const from = normalizeOptionsFrom((q.config as { optionsFrom?: unknown }).optionsFrom);
    if (!from) continue;
    const src = byId.get(from.questionId);
    if (src?.config?.options) q.config = { ...q.config, options: src.config.options };
  }

  const rows = await db
    .select({ answers: responses.answers })
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true)));

  const answerRows = rows.map((r) => ({ answers: r.answers as Record<string, unknown> }));
  return qs.map((q) => computeQuestionDistribution(q, answerValues(answerRows, q.id)));
}

/** Asks the claude CLI to flag question-quality issues from the distributions. */
export async function analyzeQuality(
  surveyId: string,
): Promise<{ distributions: Distribution[]; warnings: Warning[] }> {
  const distributions = await computeDistributions(surveyId);
  if (distributions.every((d) => d.n === 0)) {
    return { distributions, warnings: [] };
  }

  const summary = distributions
    .map((d, i) => {
      const dist =
        d.type === "open"
          ? `${d.answered}/${d.n} answered`
          : d.counts.map((c) => `${c.label}=${c.pct}%`).join(", ") +
            (d.mean != null ? ` (mean ${d.mean})` : "");
      return `Q${i + 1} [${d.type}] "${d.prompt}" → ${dist}`;
    })
    .join("\n");

  const prompt = `You are a survey methodologist reviewing simulated response distributions for quality problems (bias, leading wording, ceiling/floor effects, skew where one option dominates, redundant or confusing options).

${summary}

Return ONLY a JSON array (no prose). One entry per question that has a problem (skip clean questions):
[
  {
    "q": <1-based question number>,
    "severity": "high" | "medium" | "low",
    "message": "<short Korean explanation of the problem>",
    "suggestion": { "action": "rewrite_prompt", "newPrompt": "<improved Korean prompt>" }
        | { "action": "replace_options", "newOptions": ["...", "..."] }
        | { "action": "none" }
  }
]`;

  let raw: { q: number; severity: Warning["severity"]; message: string; suggestion: Warning["suggestion"] }[] = [];
  try {
    raw = await runLlmJson(prompt);
  } catch {
    raw = [];
  }

  const warnings: Warning[] = [];
  for (const w of Array.isArray(raw) ? raw : []) {
    const d = distributions[w.q - 1];
    if (!d) continue;
    warnings.push({
      questionId: d.questionId,
      severity: w.severity ?? "low",
      message: String(w.message ?? ""),
      suggestion: w.suggestion ?? { action: "none" },
    });
  }
  return { distributions, warnings };
}
