/**
 * US-003 (construct-loop-review): DB entry point for construct reuse context.
 * Finds workspace constructs related to a new research goal (name-token
 * overlap with the goal, most-recently-used as the tie-break), picks each
 * one's representative wording, summarizes its prior results, and returns
 * prompt-ready lines for generateSurvey.
 *
 * Best-effort by contract: any failure returns [] so survey generation in a
 * fresh workspace behaves exactly as before. Pure selection/formatting logic
 * lives in construct-reuse.ts.
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { constructs, questions, surveys } from "@/db/schema";
import { aggregateConstructResults } from "@/lib/construct-analytics";
import {
  formatConstructContextLines,
  representativeQuestion,
  type ConstructReuseEntry,
  type ReuseMemberQuestion,
} from "@/lib/construct-reuse";

const metaConstructId = sql<string>`${questions.config}->'meta'->>'constructId'`;

export type ConstructReuseContext = {
  /** Prompt-ready lines for buildPrompt (one per related construct). */
  lines: string[];
  /**
   * Ids of the same ranked constructs, in rank order — lets knowledge
   * retrieval prefer artifacts sharing a concept with the goal (US-005).
   */
  constructIds: string[];
};

const EMPTY_CONTEXT: ConstructReuseContext = { lines: [], constructIds: [] };

/**
 * Prompt-context lines (and their construct ids) describing the workspace
 * constructs most related to `goal`, at most `limit`. Only constructs
 * actually used by ≥1 question qualify (a representative wording is the
 * whole point). Empty context when the workspace has no usable constructs —
 * the graceful new-workspace path.
 */
export async function constructReuseContext(
  workspaceId: string,
  goal: string,
  opts: { limit?: number } = {},
): Promise<ConstructReuseContext> {
  const { limit = 5 } = opts;
  try {
    const vocab = await db
      .select({ id: constructs.id, name: constructs.name })
      .from(constructs)
      .where(eq(constructs.workspaceId, workspaceId));
    if (vocab.length === 0) return EMPTY_CONTEXT;

    // All construct-tagged questions of the workspace in one query.
    const memberRows = await db
      .select({
        constructId: metaConstructId,
        type: questions.type,
        prompt: questions.prompt,
        surveyCreatedAt: surveys.createdAt,
      })
      .from(questions)
      .innerJoin(surveys, eq(questions.surveyId, surveys.id))
      .where(and(eq(surveys.workspaceId, workspaceId), isNotNull(metaConstructId)));

    const membersById = new Map<string, ReuseMemberQuestion[]>();
    for (const m of memberRows) {
      const list = membersById.get(m.constructId) ?? [];
      list.push({
        type: m.type,
        prompt: m.prompt,
        surveyCreatedAt: m.surveyCreatedAt.toISOString(),
      });
      membersById.set(m.constructId, list);
    }

    // Rank by how much of the construct's wording the goal actually mentions,
    // then by most recent use. (Embedding similarity used to do the first
    // half; it went away with the local embedding model.)
    const goalText = goal.toLowerCase();
    const overlapScore = (name: string): number => {
      const tokens = name.toLowerCase().split(/[\s/·,]+/).filter((t) => t.length > 1);
      if (tokens.length === 0) return 0;
      const hits = tokens.filter((t) => goalText.includes(t)).length;
      return hits / tokens.length;
    };
    const ranked = vocab
      .filter((c) => (membersById.get(c.id) ?? []).length > 0)
      .map((c) => {
        const members = membersById.get(c.id)!;
        return {
          id: c.id,
          name: c.name,
          members,
          similarity: overlapScore(c.name),
          lastUsed: members.reduce(
            (m, q) => (q.surveyCreatedAt > m ? q.surveyCreatedAt : m),
            "",
          ),
        };
      })
      .sort((a, b) => {
        if (a.similarity !== b.similarity) return b.similarity - a.similarity;
        // ISO-8601 timestamps sort correctly as plain strings — no collator
        // needed, which keeps the server free of any Intl dependency (the
        // bundled Node is built without full ICU).
        return a.lastUsed < b.lastUsed ? 1 : a.lastUsed > b.lastUsed ? -1 : 0;
      })
      .slice(0, limit);

    const entries: ConstructReuseEntry[] = [];
    const entryIds: string[] = [];
    for (const c of ranked) {
      const representative = representativeQuestion(c.members);
      if (!representative) continue;
      // Real-response summary (ground truth only). Best-effort per construct.
      let realResponseCount = 0;
      let numericOverall: ConstructReuseEntry["numericOverall"] = [];
      try {
        const results = await aggregateConstructResults(workspaceId, c.id);
        if (results) {
          realResponseCount = results.aggregate.realResponseCount;
          numericOverall = results.aggregate.numeric.overall;
        }
      } catch {
        // keep zero-evidence entry — wording reuse is still valuable
      }
      entries.push({ name: c.name, representative, realResponseCount, numericOverall });
      entryIds.push(c.id);
    }

    return { lines: formatConstructContextLines(entries), constructIds: entryIds };
  } catch {
    return EMPTY_CONTEXT;
  }
}
