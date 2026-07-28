/**
 * US-003 (construct-loop-review): pure logic for construct reuse context —
 * when a new survey is generated, previously measured concepts (constructs)
 * are injected into the design prompt with their proven question wording so
 * the AI re-uses comparable wording across waves.
 *
 * PURE MODULE — no DB / IO, unit-testable. The DB entry point that loads the
 * vocabulary, ranks by goal similarity, and summarizes real responses lives
 * in src/lib/construct-context.ts.
 */

/** One question tagged with a construct, as needed to pick a representative. */
export type ReuseMemberQuestion = {
  type: string;
  prompt: string;
  /** ISO timestamp of the owning survey's creation (recency tie-break). */
  surveyCreatedAt: string;
};

export type RepresentativeQuestion = {
  type: string;
  prompt: string;
  /** How many member questions use this exact wording. */
  uses: number;
};

/** Grouping key for "same wording": trimmed, internal whitespace collapsed. */
function wordingKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ");
}

/**
 * The construct's representative question: the most-used wording among its
 * member questions (ties broken by the most recently created survey). The
 * first-seen spelling of the winning wording is kept. Null for no members.
 */
export function representativeQuestion(
  members: ReuseMemberQuestion[],
): RepresentativeQuestion | null {
  const groups = new Map<
    string,
    { type: string; prompt: string; uses: number; latest: string }
  >();
  for (const m of members) {
    const key = wordingKey(m.prompt);
    if (!key) continue;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        type: m.type,
        prompt: key,
        uses: 1,
        latest: m.surveyCreatedAt,
      });
    } else {
      g.uses++;
      if (m.surveyCreatedAt > g.latest) g.latest = m.surveyCreatedAt;
    }
  }
  let best: { type: string; prompt: string; uses: number; latest: string } | null = null;
  for (const g of groups.values()) {
    if (!best || g.uses > best.uses || (g.uses === best.uses && g.latest > best.latest)) {
      best = g;
    }
  }
  return best ? { type: best.type, prompt: best.prompt, uses: best.uses } : null;
}

/** Weighted overall mean of one comparable numeric group (construct-stats shape). */
export type ReuseNumericOverall = {
  scaleKey: string;
  mean: number | null;
  n: number;
};

/** Everything the prompt needs to describe one reusable construct. */
export type ConstructReuseEntry = {
  /** Canonical vocabulary name — the model must echo it as meta.construct. */
  name: string;
  representative: RepresentativeQuestion;
  /** Real (is_synthetic=false) responses touching this construct. */
  realResponseCount: number;
  /** Per-scale weighted means over real responses (empty when none). */
  numericOverall: ReuseNumericOverall[];
};

/**
 * One prompt-context line per construct: canonical name, proven wording, and
 * a real-response summary when ground truth exists.
 */
export function formatConstructContextLines(entries: ConstructReuseEntry[]): string[] {
  return entries.map((e) => {
    const means = e.numericOverall
      .filter((o) => o.mean != null && o.n > 0)
      .map((o) => `${o.scaleKey} 평균 ${o.mean} (n=${o.n})`)
      .join(", ");
    const evidence =
      e.realResponseCount > 0
        ? `실제 응답 ${e.realResponseCount}건${means ? ` — ${means}` : ""}`
        : "실제 응답 아직 없음";
    return `construct "${e.name}" — 대표 문항 [${e.representative.type}] "${e.representative.prompt}" (동일 표현 ${e.representative.uses}회 사용; ${evidence})`;
  });
}
