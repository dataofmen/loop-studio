/**
 * US-006 (question-meta-loop): pure matching logic for the workspace construct
 * vocabulary — normalization, cosine similarity, and match decisions.
 *
 * PURE MODULE — no DB / IO, so it is unit-testable. The DB entry point that
 * loads candidates and persists resolutions lives in src/lib/constructs.ts
 * (imports @/db, which vitest cannot load).
 */

/** Embedding cosine similarity at/above which two constructs are the same concept. */
export const CONSTRUCT_SIMILARITY_THRESHOLD = 0.85;

/**
 * Canonical stored form of a construct label: trimmed, internal whitespace
 * collapsed, case preserved. "" for junk/blank input.
 */
export function canonicalConstructName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Matching key for exact-match comparison: canonical form, lowercased — so
 * " NPS  점수 " and "nps 점수" resolve to the same concept.
 */
export function constructKey(raw: unknown): string {
  return canonicalConstructName(raw).toLowerCase();
}

/** A dictionary row as needed for matching (embedding optional). */
export type ConstructCandidate = {
  id: string;
  name: string;
  aliases: string[];
  embedding?: number[] | null;
};

/** Coerce a jsonb aliases value into a clean string[]. */
export function normalizeAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
}

/**
 * Exact match of `raw` against candidates' name + aliases, using the
 * normalized key. Returns the first match (dictionary rows are unique per
 * key in practice) or null.
 */
export function findExactConstruct(
  candidates: ConstructCandidate[],
  raw: string,
): ConstructCandidate | null {
  const key = constructKey(raw);
  if (!key) return null;
  for (const c of candidates) {
    if (constructKey(c.name) === key) return c;
    if (c.aliases.some((a) => constructKey(a) === key)) return c;
  }
  return null;
}

/**
 * Cosine similarity of two vectors. 0 for mismatched dimensions or zero-norm
 * input (treated as "no similarity" rather than an error — degrade, not throw).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export type EmbeddingMatch = { candidate: ConstructCandidate; similarity: number };

/**
 * Best embedding match among candidates that HAVE an embedding, or null when
 * none reaches the threshold. Candidates without embeddings (Ollama was down
 * when they were created) simply never match by similarity — they remain
 * reachable via exact name/alias match.
 */
export function bestEmbeddingMatch(
  candidates: ConstructCandidate[],
  query: number[],
  threshold: number = CONSTRUCT_SIMILARITY_THRESHOLD,
): EmbeddingMatch | null {
  let best: EmbeddingMatch | null = null;
  for (const c of candidates) {
    if (!Array.isArray(c.embedding) || c.embedding.length === 0) continue;
    const similarity = cosineSimilarity(c.embedding, query);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { candidate: c, similarity };
    }
  }
  return best;
}

/**
 * Aliases after absorbing `raw` into a matched candidate: appends the
 * canonical form of `raw` unless its key already equals the candidate's name
 * or an existing alias. Returns null when nothing needs to change (caller
 * skips the UPDATE).
 */
export function aliasesWithVariant(
  candidate: ConstructCandidate,
  raw: string,
): string[] | null {
  const variant = canonicalConstructName(raw);
  const key = constructKey(variant);
  if (!key || constructKey(candidate.name) === key) return null;
  if (candidate.aliases.some((a) => constructKey(a) === key)) return null;
  return [...candidate.aliases, variant];
}

/** A row's name + aliases, as needed by the rename/merge alias math (US-008). */
export type ConstructLabelSet = { name: string; aliases: string[] };

/** Dedupe labels by key, excluding keys in `exclude`; first spelling wins. */
function dedupeLabels(labels: string[], exclude: Set<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const label of labels) {
    const v = canonicalConstructName(label);
    const k = constructKey(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * Aliases after renaming a construct to `newName`: the old canonical name is
 * demoted to an alias (so questions/templates still matching the old spelling
 * keep resolving here), and any alias colliding with the new name is dropped.
 * A case/whitespace-only rename (same key) demotes nothing.
 */
export function aliasesAfterRename(current: ConstructLabelSet, newName: string): string[] {
  const newKey = constructKey(newName);
  return dedupeLabels([...current.aliases, current.name], new Set([newKey]));
}

/**
 * Target aliases after absorbing `source` in a merge: union of the target's
 * aliases, the source's name, and the source's aliases — deduped by key,
 * never containing the target's canonical name.
 */
export function aliasesAfterMerge(
  target: ConstructLabelSet,
  source: ConstructLabelSet,
): string[] {
  return dedupeLabels(
    [...target.aliases, source.name, ...source.aliases],
    new Set([constructKey(target.name)]),
  );
}
