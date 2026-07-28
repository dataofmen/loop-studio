import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { questions, responses } from "@/db/schema";
import { computeDistributions, type Distribution } from "@/lib/quality";
import { runLlmJson } from "@/lib/llm";
import { serializeOpenAnswer } from "@/lib/open-answer";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";
type QRow = { id: string; type: QuestionType; order: number; prompt: string };

export type Insight = {
  /** Short headline of the finding. */
  finding: string;
  /** Supporting evidence drawn from the distributions/answers. */
  evidence: string;
  /** Recommended action item. */
  action: string;
};

export type ThemeCluster = {
  /** Theme label. */
  theme: string;
  /** Representative verbatim quotes for the theme. */
  quotes: string[];
  /** How many open answers fall under this theme. */
  count: number;
};

export type InsightSummary = {
  /** Number of real responses analyzed. */
  realCount: number;
  /** 3-5 key findings with recommended actions. */
  insights: Insight[];
  /** Open-ended responses clustered by theme. */
  themes: ThemeCluster[];
};

/** Summarizes a real-response distribution into a single human line. */
function distLine(d: Distribution, i: number): string {
  if (d.type === "open") return `Q${i + 1} [open] "${d.prompt}" → ${d.answered}/${d.n} answered`;
  const parts = d.counts.map((c) => `${c.label}=${c.pct}%`).join(", ");
  return `Q${i + 1} [${d.type}] "${d.prompt}" → ${parts}${d.mean != null ? ` (mean ${d.mean})` : ""}`;
}

/**
 * US-012: feeds the real-response distributions and all open-ended answers to
 * the claude CLI and returns 3-5 key findings (+ recommended actions) plus
 * open-ended responses clustered by theme.
 */


export async function generateInsights(surveyId: string): Promise<InsightSummary> {
  const qs = (await db
    .select({ id: questions.id, type: questions.type, order: questions.order, prompt: questions.prompt })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order))) as unknown as QRow[];

  const real = await computeDistributions(surveyId);
  const realCount = real.reduce((m, d) => Math.max(m, d.n), 0);
  if (realCount === 0) return { realCount: 0, insights: [], themes: [] };

  // Collect raw open-ended answers for theme clustering.
  const realRows = await db
    .select({ answers: responses.answers })
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true)));

  const openBlocks: string[] = [];
  for (const q of qs.filter((q) => q.type === "open")) {
    const answers = realRows
      .map((r) => serializeOpenAnswer((r.answers as Record<string, unknown>)[q.id]))
      .filter((s) => s !== "");
    if (answers.length > 0) {
      openBlocks.push(`"${q.prompt}":\n${answers.map((a) => `- ${a}`).join("\n")}`);
    }
  }

  const distSummary = real.map((d, i) => distLine(d, i)).join("\n");
  const openSummary = openBlocks.length ? openBlocks.join("\n\n") : "(주관식 응답 없음)";

  const prompt = `You are a research analyst summarizing the real results of a survey (n=${realCount}). Below are the per-question response distributions and all open-ended answers.

== Distributions ==
${distSummary}

== Open-ended answers ==
${openSummary}

Analyze the data and respond with ONLY a JSON object (no prose), in Korean for all text values:
{
  "insights": [
    {
      "finding": "<핵심 발견 한 줄>",
      "evidence": "<분포/응답에 근거한 구체적 수치나 인용>",
      "action": "<권장 액션 아이템>"
    }
  ],
  "themes": [
    {
      "theme": "<주관식 응답을 묶는 주제 라벨>",
      "quotes": ["<대표 응답 인용>", "..."],
      "count": <이 주제에 속한 주관식 응답 수>
    }
  ]
}

Rules:
- "insights": 3 to 5 entries, ranked by importance. Ground every finding in the actual numbers above.
- "themes": cluster ONLY the open-ended answers by recurring topic/sentiment. If there are no open-ended answers, return [].
- Be specific and actionable; avoid generic filler.`;

  let raw: { insights?: Insight[]; themes?: ThemeCluster[] };
  try {
    raw = await runLlmJson(prompt);
  } catch {
    raw = {};
  }

  const insights: Insight[] = (Array.isArray(raw.insights) ? raw.insights : [])
    .slice(0, 5)
    .map((x) => ({
      finding: String(x?.finding ?? ""),
      evidence: String(x?.evidence ?? ""),
      action: String(x?.action ?? ""),
    }))
    .filter((x) => x.finding);

  const themes: ThemeCluster[] = (Array.isArray(raw.themes) ? raw.themes : [])
    .map((x) => ({
      theme: String(x?.theme ?? ""),
      quotes: Array.isArray(x?.quotes) ? x.quotes.map((q) => String(q)) : [],
      count: Number.isFinite(Number(x?.count)) ? Number(x?.count) : 0,
    }))
    .filter((x) => x.theme);

  return { realCount, insights, themes };
}
