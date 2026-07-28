/**
 * US-006 (question-meta-loop): resolve free-text construct values against the
 * per-workspace controlled vocabulary (`constructs` table) so "만족도" and
 * "고객 만족도" join as one concept across surveys.
 *
 * Resolution order:
 *   (1) exact match (normalized) on canonical name + aliases
 *   (2) create a new dictionary row
 *
 * Near-match absorption by embedding similarity used to sit between the two.
 * It went away with the local embedding model, and it was the weakest link
 * anyway: short Korean phrases all sit at 0.85–0.91 cosine, so it over-merged
 * unrelated concepts. Variants now join by being recorded as explicit aliases.
 *
 * Concurrent creation of the same name is converged via the
 * unique(workspace_id, name) constraint: the losing INSERT re-selects the
 * winner's row.
 *
 * DB-side module — pure matching logic lives in construct-match.ts.
 */

import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { constructs, questions, surveys } from "@/db/schema";
import {
  aliasesAfterMerge,
  aliasesAfterRename,
  aliasesWithVariant,
  canonicalConstructName,
  constructKey,
  findExactConstruct,
  normalizeAliases,
  type ConstructCandidate,
} from "@/lib/construct-match";
import { normalizeMeta, optionLabels, type QMeta } from "@/lib/question-config";
import { inferQuestionMeta } from "@/lib/question-meta";

export type ResolvedConstruct = {
  /** constructs.id — store as meta.constructId. */
  id: string;
  /** Canonical name — store as meta.construct. */
  name: string;
  /** True when this call minted a new dictionary row. */
  created: boolean;
  /** How the value resolved — surfaces in curation reports (backfill). */
  matchedBy: "exact" | "created";
};

/** All dictionary rows of a workspace, in matching shape. */
async function workspaceCandidates(workspaceId: string): Promise<ConstructCandidate[]> {
  const rows = await db
    .select({ id: constructs.id, name: constructs.name, aliases: constructs.aliases })
    .from(constructs)
    .where(eq(constructs.workspaceId, workspaceId));
  return rows.map((r) => ({ ...r, aliases: normalizeAliases(r.aliases) }));
}

/**
 * Resolve a free-text construct value to a dictionary entry, creating one when
 * no existing concept matches. Returns null only for blank/junk input.
 *
 * `absorb` (default true) controls alias matching: with absorb=false only the
 * canonical NAME is compared, so construct re-inference stores an improved
 * name verbatim instead of being re-pinned by a previously mis-absorbed alias.
 */
export async function resolveConstruct(
  workspaceId: string,
  raw: string,
  opts: { absorb?: boolean } = {},
): Promise<ResolvedConstruct | null> {
  const absorb = opts.absorb ?? true;
  const name = canonicalConstructName(raw);
  if (!name) return null;

  const candidates = await workspaceCandidates(workspaceId);

  // (1) Exact (normalized) match. absorb=true matches name OR aliases (normal
  //     joining). absorb=false matches the canonical NAME only — aliases are
  //     skipped so a fresh accurate name is never re-pinned by a previously
  //     mis-absorbed alias (which is exactly what re-inference is undoing).
  const exact = absorb
    ? findExactConstruct(candidates, name)
    : (candidates.find((c) => constructKey(c.name) === constructKey(name)) ?? null);
  if (exact) return { id: exact.id, name: exact.name, created: false, matchedBy: "exact" };

  // (2) New concept — create. A concurrent create of the same name loses on
  //     unique(workspace_id, name); converge by re-selecting the winner.
  try {
    const [row] = await db
      .insert(constructs)
      .values({ workspaceId, name, aliases: [] })
      .returning({ id: constructs.id, name: constructs.name });
    return { id: row.id, name: row.name, created: true, matchedBy: "created" };
  } catch (err) {
    const [existing] = await db
      .select({ id: constructs.id, name: constructs.name })
      .from(constructs)
      .where(and(eq(constructs.workspaceId, workspaceId), eq(constructs.name, name)))
      .limit(1);
    if (existing) return { id: existing.id, name: existing.name, created: false, matchedBy: "exact" };
    throw err;
  }
}

/**
 * Meta with its `construct` resolved to the canonical vocabulary:
 * construct → canonical name, constructId → dictionary id. Never throws —
 * on any resolution failure the free-text meta is returned unchanged, so
 * vocabulary trouble can never block saving/generating questions.
 */
export async function withResolvedConstruct(
  workspaceId: string,
  meta: QMeta,
  opts: { absorb?: boolean } = {},
): Promise<QMeta> {
  if (!meta.construct) return meta;
  try {
    const resolved = await resolveConstruct(workspaceId, meta.construct, opts);
    if (!resolved) return meta;
    return { ...meta, construct: resolved.name, constructId: resolved.id };
  } catch {
    return meta;
  }
}

const metaConstruct = sql<string>`${questions.config}->'meta'->>'construct'`;
const metaConstructId = sql<string>`${questions.config}->'meta'->>'constructId'`;

// ---------------------------------------------------------------------------
// US-008: vocabulary curation — list, rename, merge.
// Like all meta-only writes, question rewrites here skip version recording and
// the survey updatedAt touch (see question-meta-db.ts rationale); `origin` is
// preserved — these are explicit user-invoked curation actions, same contract
// as backfillWorkspaceConstructs below.
// ---------------------------------------------------------------------------

export type ConstructListItem = {
  id: string;
  name: string;
  aliases: string[];
  /** Questions in the workspace whose meta.constructId points here. */
  usageCount: number;
};

/** Vocabulary rows of a workspace with per-construct question usage counts. */
export async function listWorkspaceConstructs(
  workspaceId: string,
): Promise<ConstructListItem[]> {
  const rows = await db
    .select({ id: constructs.id, name: constructs.name, aliases: constructs.aliases })
    .from(constructs)
    .where(eq(constructs.workspaceId, workspaceId))
    .orderBy(asc(constructs.name));
  const counts = await db
    .select({ constructId: metaConstructId, n: count() })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(and(eq(surveys.workspaceId, workspaceId), isNotNull(metaConstructId)))
    .groupBy(metaConstructId);
  const usage = new Map(counts.map((c) => [c.constructId, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    aliases: normalizeAliases(r.aliases),
    usageCount: usage.get(r.id) ?? 0,
  }));
}

/** One question referencing a construct — the evidence for curation decisions. */
export type ConstructQuestionRef = {
  questionId: string;
  surveyId: string;
  surveyTitle: string;
  quid: string;
  prompt: string;
  origin: "human" | "ai" | null;
};

/**
 * Every workspace question whose meta points at `constructId`, grouped-ready
 * (survey title included) so the vocabulary page can show what a concept is
 * actually made of before renaming/merging it.
 */
export async function listConstructQuestions(
  workspaceId: string,
  constructId: string,
): Promise<ConstructQuestionRef[]> {
  const rows = await db
    .select({
      questionId: questions.id,
      surveyId: surveys.id,
      surveyTitle: surveys.title,
      quid: questions.quid,
      prompt: questions.prompt,
      config: questions.config,
    })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(and(eq(surveys.workspaceId, workspaceId), eq(metaConstructId, constructId)))
    .orderBy(asc(surveys.title), asc(questions.order));
  return rows.map((r) => {
    const meta = normalizeMeta((r.config as Record<string, unknown> | null)?.meta);
    return {
      questionId: r.questionId,
      surveyId: r.surveyId,
      surveyTitle: r.surveyTitle ?? "(제목 없음)",
      quid: r.quid,
      prompt: r.prompt,
      origin: meta?.origin ?? null,
    };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Rewrite every workspace question pointing at `fromConstructId` to the given
 * canonical name + id (rename keeps the id, merge repoints to the target's).
 * Returns the number of questions updated.
 */
async function repointQuestions(
  tx: Tx,
  workspaceId: string,
  fromConstructId: string,
  next: { construct: string; constructId: string },
): Promise<number> {
  const rows = await tx
    .select({ id: questions.id, config: questions.config })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(and(eq(surveys.workspaceId, workspaceId), eq(metaConstructId, fromConstructId)));
  let updated = 0;
  for (const row of rows) {
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const meta = normalizeMeta(cfg.meta) ?? {};
    const nextMeta: QMeta = { ...meta, ...next };
    await tx
      .update(questions)
      .set({ config: { ...cfg, meta: nextMeta } })
      .where(eq(questions.id, row.id));
    updated++;
  }
  return updated;
}

export type CurateResult =
  | { ok: true; updatedQuestions: number }
  | { ok: false; error: string };

/**
 * Rename a construct's canonical name. The old name is demoted to an alias
 * (nothing stops resolving), and every question pointing at this constructId
 * gets its meta.construct string rewritten in the same transaction.
 */
export async function renameConstruct(
  workspaceId: string,
  constructId: string,
  rawNewName: string,
): Promise<CurateResult> {
  const name = canonicalConstructName(rawNewName);
  if (!name) return { ok: false, error: "새 이름이 비어 있습니다." };
  const candidates = await workspaceCandidates(workspaceId);
  const row = candidates.find((c) => c.id === constructId);
  if (!row) return { ok: false, error: "construct를 찾을 수 없습니다." };
  if (name === row.name) return { ok: true, updatedQuestions: 0 };
  const collision = findExactConstruct(
    candidates.filter((c) => c.id !== constructId),
    name,
  );
  if (collision) {
    return {
      ok: false,
      error: `"${collision.name}"이(가) 이미 그 이름/별칭을 사용합니다 — 병합을 사용하세요.`,
    };
  }
  const aliases = aliasesAfterRename(row, name);
  let updatedQuestions = 0;
  await db.transaction(async (tx) => {
    await tx
      .update(constructs)
      .set({ name, aliases })
      .where(and(eq(constructs.id, constructId), eq(constructs.workspaceId, workspaceId)));
    updatedQuestions = await repointQuestions(tx, workspaceId, constructId, {
      construct: name,
      constructId,
    });
  });
  return { ok: true, updatedQuestions };
}

/**
 * Merge construct `sourceId` into `targetId` (destructive — caller confirms):
 * the source's name + aliases become target aliases, every question pointing
 * at the source is repointed to the target's canonical name + id, and the
 * source row is deleted — all in one transaction.
 */
export async function mergeConstructs(
  workspaceId: string,
  sourceId: string,
  targetId: string,
): Promise<CurateResult> {
  if (sourceId === targetId) {
    return { ok: false, error: "같은 construct끼리는 병합할 수 없습니다." };
  }
  const rows = await db
    .select({ id: constructs.id, name: constructs.name, aliases: constructs.aliases })
    .from(constructs)
    .where(
      and(eq(constructs.workspaceId, workspaceId), inArray(constructs.id, [sourceId, targetId])),
    );
  const source = rows.find((r) => r.id === sourceId);
  const target = rows.find((r) => r.id === targetId);
  if (!source || !target) return { ok: false, error: "construct를 찾을 수 없습니다." };
  const aliases = aliasesAfterMerge(
    { name: target.name, aliases: normalizeAliases(target.aliases) },
    { name: source.name, aliases: normalizeAliases(source.aliases) },
  );
  let updatedQuestions = 0;
  await db.transaction(async (tx) => {
    await tx.update(constructs).set({ aliases }).where(eq(constructs.id, targetId));
    updatedQuestions = await repointQuestions(tx, workspaceId, sourceId, {
      construct: target.name,
      constructId: targetId,
    });
    await tx.delete(constructs).where(eq(constructs.id, sourceId));
  });
  return { ok: true, updatedQuestions };
}

/** Alias list of a construct, for the curation UI. */
export async function listConstructAliases(
  workspaceId: string,
  constructId: string,
): Promise<{ canonical: string; aliases: string[] }> {
  const [row] = await db
    .select({ name: constructs.name, aliases: constructs.aliases })
    .from(constructs)
    .where(and(eq(constructs.id, constructId), eq(constructs.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return { canonical: "", aliases: [] };
  return { canonical: row.name, aliases: normalizeAliases(row.aliases) };
}

/**
 * Removes an alias from a construct so a spelling that was mis-absorbed stops
 * attracting FUTURE questions here (they will re-resolve fresh). Existing
 * questions are NOT moved — their construct was already rewritten to the
 * canonical name and the original spelling→question link is not stored, so a
 * reliable re-point is impossible; the UI states this. Returns ok:false when
 * the alias is not present.
 */
export async function removeAlias(
  workspaceId: string,
  constructId: string,
  alias: string,
): Promise<CurateResult> {
  const [row] = await db
    .select({ aliases: constructs.aliases })
    .from(constructs)
    .where(and(eq(constructs.id, constructId), eq(constructs.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return { ok: false, error: "construct를 찾을 수 없습니다." };
  const aliases = normalizeAliases(row.aliases);
  const key = constructKey(alias);
  const next = aliases.filter((a) => constructKey(a) !== key);
  if (next.length === aliases.length) return { ok: false, error: "해당 별칭이 없습니다." };
  await db
    .update(constructs)
    .set({ aliases: next })
    .where(and(eq(constructs.id, constructId), eq(constructs.workspaceId, workspaceId)));
  return { ok: true, updatedQuestions: 0 };
}

/** One backfill decision — which spelling went where, and how it matched. */
export type BackfillMapping = {
  quid: string;
  prompt: string;
  /** The question's original free-text spelling. */
  from: string;
  /** Canonical name it resolved to. */
  to: string;
  how: "exact" | "created";
};

export type ConstructBackfillSummary = {
  /** Questions with a free-text construct and no constructId at scan time. */
  scanned: number;
  updated: number;
  failed: number;
  /** Per-question mapping decisions (capped) so the run is auditable. */
  mappings: BackfillMapping[];
};

const BACKFILL_REPORT_CAP = 100;

/**
 * US-007: one-shot canonicalization of legacy free-text constructs — every
 * question in the workspace whose meta has a construct but no constructId is
 * resolved against the vocabulary and rewritten to canonical name + id.
 *
 * This is an explicit user-invoked curation action (US-008 vocabulary page
 * button), NOT background AI inference — so it also normalizes human-origin
 * metas. Nothing semantic is lost: the author's original spelling survives as
 * a dictionary alias (resolveConstruct absorbs it), and `origin` is preserved
 * untouched. Like all meta-only writes it skips version recording and the
 * survey updatedAt touch (see question-meta-db.ts rationale).
 *
 * Repeated values resolve once per run (cache by normalized key).
 * Per-question failures are counted, never thrown.
 */
export async function backfillWorkspaceConstructs(
  workspaceId: string,
): Promise<ConstructBackfillSummary> {
  const rows = await db
    .select({ id: questions.id, quid: questions.quid, prompt: questions.prompt, config: questions.config })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(
      and(
        eq(surveys.workspaceId, workspaceId),
        isNotNull(metaConstruct),
        isNull(metaConstructId),
      ),
    );
  const summary: ConstructBackfillSummary = {
    scanned: rows.length,
    updated: 0,
    failed: 0,
    mappings: [],
  };
  const cache = new Map<string, ResolvedConstruct | null>();
  for (const row of rows) {
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const meta = normalizeMeta(cfg.meta);
    if (!meta?.construct || meta.constructId) continue; // jsonb junk / raced
    try {
      const key = constructKey(meta.construct);
      let resolved = cache.get(key);
      // A cache hit means an earlier question this run already resolved the
      // same spelling — its dictionary row exists now, so it reports "exact".
      const cached = resolved !== undefined;
      if (resolved === undefined) {
        resolved = await resolveConstruct(workspaceId, meta.construct);
        cache.set(key, resolved);
      }
      if (!resolved) {
        summary.failed++;
        continue;
      }
      const next: QMeta = { ...meta, construct: resolved.name, constructId: resolved.id };
      await db
        .update(questions)
        .set({ config: { ...cfg, meta: next } })
        .where(eq(questions.id, row.id));
      summary.updated++;
      if (summary.mappings.length < BACKFILL_REPORT_CAP) {
        summary.mappings.push({
          quid: row.quid,
          prompt: row.prompt,
          from: meta.construct,
          to: resolved.name,
          how: cached ? "exact" : resolved.matchedBy,
        });
      }
    } catch {
      summary.failed++;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Construct re-review: bulk re-inference with the improved prompt.
// ---------------------------------------------------------------------------

/** Bounded-concurrency map — keeps parallel claude spawns from thrashing. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One re-inference decision — the construct before/after, per question. */
export type ReinferMapping = {
  quid: string;
  prompt: string;
  from: string;
  to: string;
  changed: boolean;
};

export type ReinferSummary = {
  /** Inferable questions considered (empty or AI-origin meta). */
  scanned: number;
  /** Construct newly filled or changed. */
  updated: number;
  /** Re-inferred to the same construct (no change). */
  unchanged: number;
  /** Protected meta (human / unknown origin) left untouched. */
  skipped: number;
  failed: number;
  mappings: ReinferMapping[];
};

const REINFER_REPORT_CAP = 100;
const REINFER_CONCURRENCY = 4;

/** Trust-tier: only empty or AI-origin meta may be (re)inferred (human wins). */
function reinferable(meta: QMeta | undefined): boolean {
  return !meta || meta.origin === "ai";
}

/**
 * Re-runs question-meta inference (improved prompt) across the workspace to fix
 * mismatched constructs saved by the old prompt. Scope follows the meta trust
 * tier — only empty or AI-origin meta is rewritten; human/unknown-origin meta
 * is protected. To avoid regressing the already-accurate `topic` field, an
 * existing non-empty topic is KEPT; only construct + constructId are refreshed
 * (a missing topic is filled from inference). Resolution runs with absorb=false
 * so the improved name is stored verbatim (exact-name reuse or a new row) rather
 * than re-absorbed into a near-but-wrong bucket. Each write re-reads the row and
 * re-checks the guard so a concurrent manual edit wins. Meta-only write —
 * skips version recording + the survey updatedAt touch (question-meta-db.ts
 * rationale). Per-question failures are counted, never thrown.
 */
export async function reinferWorkspaceConstructs(workspaceId: string): Promise<ReinferSummary> {
  const rows = await db
    .select({
      id: questions.id,
      quid: questions.quid,
      prompt: questions.prompt,
      type: questions.type,
      config: questions.config,
      researchGoal: surveys.researchGoal,
    })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(eq(surveys.workspaceId, workspaceId))
    .orderBy(asc(questions.id));

  const summary: ReinferSummary = {
    scanned: 0,
    updated: 0,
    failed: 0,
    unchanged: 0,
    skipped: 0,
    mappings: [],
  };
  const candidates = await workspaceCandidates(workspaceId);
  const candidateNames = candidates.map((c) => c.name);

  const targets = rows.filter((r) => reinferable(normalizeMeta((r.config as Record<string, unknown> | null)?.meta)));
  summary.skipped = rows.length - targets.length;
  summary.scanned = targets.length;

  const outcomes = await mapPool(targets, REINFER_CONCURRENCY, async (row) => {
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const before = normalizeMeta(cfg.meta);
    try {
      const inferred = await inferQuestionMeta({
        researchGoal: row.researchGoal,
        prompt: row.prompt,
        type: row.type,
        optionLabels: optionLabels(cfg.options),
        existingConstructs: candidateNames,
      });
      if (!inferred) return { kind: "failed" as const };
      // Resolve the fresh construct only; keep an existing non-empty topic.
      // absorb:false — store the improved name verbatim (exact-reuse or new
      // row), never re-absorbed into a near-but-wrong existing bucket.
      const resolved = await withResolvedConstruct(
        workspaceId,
        { construct: inferred.construct },
        { absorb: false },
      );
      const nextTopic = before?.topic && before.topic.trim() ? before.topic : inferred.topic;

      // Re-read + guard: a manual edit during the CLI call must win.
      const [fresh] = await db
        .select({ config: questions.config })
        .from(questions)
        .where(eq(questions.id, row.id))
        .limit(1);
      if (!fresh) return { kind: "failed" as const };
      const freshCfg = (fresh.config ?? {}) as Record<string, unknown>;
      const freshMeta = normalizeMeta(freshCfg.meta);
      if (!reinferable(freshMeta)) return { kind: "skipped" as const };

      const fromConstruct = freshMeta?.construct ?? "";
      const meta: QMeta = {
        ...(freshMeta ?? {}),
        construct: resolved.construct,
        constructId: resolved.constructId,
        topic: nextTopic,
        origin: "ai",
      };
      await db.update(questions).set({ config: { ...freshCfg, meta } }).where(eq(questions.id, row.id));
      return {
        kind: "saved" as const,
        mapping: {
          quid: row.quid,
          prompt: row.prompt,
          from: fromConstruct,
          to: resolved.construct ?? "",
          changed: constructKey(fromConstruct) !== constructKey(resolved.construct ?? ""),
        },
      };
    } catch {
      return { kind: "failed" as const };
    }
  });

  for (const o of outcomes) {
    if (o.kind === "failed") summary.failed++;
    else if (o.kind === "skipped") summary.skipped++;
    else {
      if (o.mapping.changed) summary.updated++;
      else summary.unchanged++;
      if (summary.mappings.length < REINFER_REPORT_CAP) summary.mappings.push(o.mapping);
    }
  }
  return summary;
}
