import { normalizeOptions, type ConfigOption, type ProbeConfig, type QMeta } from "@/lib/question-config";
import { showIfToDisplayLogic } from "@/lib/display-logic";
import type { DisplayLogic, ShowIf } from "@/lib/display-logic";
import type { OptionsFrom } from "@/lib/carry-forward";

// Pure (no IO) question snapshot + diff logic, extracted from revisions.ts so
// the adjacent-version diffing is unit-testable without importing the DB layer.

export type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";

// Canonical QMeta (incl. origin trust tier) lives in question-config.ts;
// re-exported here so snapshot/diff consumers keep importing from this module.
export type { QMeta };

export type QConfig = {
  options?: ConfigOption[];
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  rows?: string[];
  columns?: string[];
  limit?: number;
  meta?: QMeta;
  displayLogic?: DisplayLogic;
  // Provenance link (US-010): when a question is seeded from a template, the
  // original template question's quid is preserved here (the live row gets a
  // fresh quid). Lets a survey trace which template a question came from.
  sourceQuid?: string;
  // AI follow-up probing on open questions (US-011).
  probe?: ProbeConfig;
  // Shuffle non-special options per respondent (specials stay anchored).
  randomizeOptions?: boolean;
  // Carry-forward: options = the ones selected in an earlier question.
  optionsFrom?: OptionsFrom;
};

export type RevisionQuestion = {
  // Permanent per-question identifier (Artifact 2 "quid"): stable across edits,
  // reorders and reverts so version diffs can tell apart delete/reorder/edit.
  quid: string;
  type: QuestionType;
  order: number;
  prompt: string;
  config: QConfig;
  // Transient, proposal-only: ref-form display logic from the AI (resolved to
  // config.displayLogic at apply time; never persisted in snapshots).
  showIf?: ShowIf;
  // Transient, proposal-only: ref-form carry-forward source (resolved to
  // config.optionsFrom at apply time).
  optionsFromRef?: { ref: number; mode: "selected" };
};

/**
 * Deterministic stringify with recursively sorted object keys. Postgres jsonb
 * normalizes key order on storage, so a DB round-tripped config and a freshly
 * built (insertion-ordered) one must not diff on key order alone.
 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** True when two questions have identical content (prompt/type/config). */
function contentEqual(a: RevisionQuestion, b: RevisionQuestion): boolean {
  return (
    a.prompt === b.prompt &&
    a.type === b.type &&
    stableStringify(a.config ?? {}) === stableStringify(b.config ?? {})
  );
}

export type QuestionDiff = {
  added: RevisionQuestion[];
  deleted: RevisionQuestion[];
  changed: { from: RevisionQuestion; to: RevisionQuestion }[];
  reordered: { quid: string; prompt: string; from: number; to: number }[];
  unchanged: RevisionQuestion[];
};

/**
 * Diffs two question sets by quid (Artifact 2). Falls back to prompt-matching
 * for legacy snapshots that predate quids, so deleting one question no longer
 * marks every following question as "changed".
 */
export function diffQuestions(oldQs: RevisionQuestion[], newQs: RevisionQuestion[]): QuestionDiff {
  const haveQuids = [...oldQs, ...newQs].every((q) => q.quid);
  const keyOf = (q: RevisionQuestion, idx: number) => (haveQuids ? q.quid : `${q.prompt}#${idx}`);
  const oldByKey = new Map(oldQs.map((q, i) => [keyOf(q, i), { q, order: i }]));
  const newByKey = new Map(newQs.map((q, i) => [keyOf(q, i), { q, order: i }]));

  const diff: QuestionDiff = { added: [], deleted: [], changed: [], reordered: [], unchanged: [] };
  for (const [key, { q }] of newByKey) {
    if (!oldByKey.has(key)) diff.added.push(q);
  }
  for (const [key, { q }] of oldByKey) {
    if (!newByKey.has(key)) diff.deleted.push(q);
  }
  for (const [key, n] of newByKey) {
    const o = oldByKey.get(key);
    if (!o) continue;
    if (!contentEqual(o.q, n.q)) diff.changed.push({ from: o.q, to: n.q });
    else if (o.order !== n.order)
      diff.reordered.push({ quid: n.q.quid, prompt: n.q.prompt, from: o.order + 1, to: n.order + 1 });
    else diff.unchanged.push(n.q);
  }
  return diff;
}

/** Counts per change type between a version and its immediate predecessor. */
export type ChangeSummary = { added: number; deleted: number; changed: number; reordered: number };

export type RevisionRow = {
  version: number;
  reason: string;
  // User-given checkpoint name (null = automatic/unnamed version).
  label: string | null;
  createdAt: Date;
  questionCount: number;
  // Change vs the immediately-lower version (quid-based diffQuestions).
  // null for the baseline version (nothing earlier to compare against).
  changeSummary: ChangeSummary | null;
  // Short plain-Korean lines describing what changed vs the predecessor.
  changeNotes: string[];
};

/** The change of `snap` relative to its predecessor as counts (null = baseline). */
export function changeSummaryOf(prev: RevisionQuestion[] | null, snap: RevisionQuestion[]): ChangeSummary | null {
  if (!prev) return null;
  const d = diffQuestions(prev, snap);
  return { added: d.added.length, deleted: d.deleted.length, changed: d.changed.length, reordered: d.reordered.length };
}

const NOTE_PROMPT_CHARS = 20;

function shortPrompt(p: string): string {
  return p.length > NOTE_PROMPT_CHARS ? `${p.slice(0, NOTE_PROMPT_CHARS)}…` : p;
}

/**
 * Short plain-Korean lines describing how `snap` differs from `prev` — one
 * line per touched question (what field/option area changed, not full values),
 * capped at `max` lines with a trailing "외 N건". [] for the baseline.
 */
export function changeNotesOf(
  prev: RevisionQuestion[] | null,
  snap: RevisionQuestion[],
  max = 4,
): string[] {
  if (!prev) return [];
  const notes: string[] = [];
  for (const d of diffQuestionsDetailed(prev, snap)) {
    if (d.status === "added") notes.push(`문항 추가: "${shortPrompt(d.prompt)}"`);
    else if (d.status === "deleted") notes.push(`문항 삭제: "${shortPrompt(d.prompt)}"`);
    else if (d.status === "reordered")
      notes.push(`문항 이동: "${shortPrompt(d.prompt)}" ${d.fromOrder}→${d.toOrder}번`);
    else if (d.status === "changed") {
      const parts: string[] = [];
      if (d.fieldChanges.some((f) => f.field === "prompt")) parts.push("내용");
      if (d.fieldChanges.some((f) => f.field === "type")) parts.push("유형");
      if (d.optionChanges.length) {
        const count = (kind: OptionChange["kind"]) =>
          d.optionChanges.filter((o) => o.kind === kind).length;
        const sub = [
          count("added") && `추가 ${count("added")}`,
          count("deleted") && `삭제 ${count("deleted")}`,
          count("renamed") && `수정 ${count("renamed")}`,
          count("reordered") && `순서 ${count("reordered")}`,
        ].filter(Boolean);
        parts.push(`보기(${sub.join("·")})`);
      }
      if (d.fieldChanges.some((f) => f.field !== "prompt" && f.field !== "type"))
        parts.push("설정");
      notes.push(`"${shortPrompt(d.prompt)}" ${parts.join("·") || "수정"}`);
    }
  }
  return notes.length > max ? [...notes.slice(0, max), `외 ${notes.length - max}건`] : notes;
}

/**
 * Turns version-ascending revision rows into newest-first RevisionRows, each
 * carrying a change summary vs its immediate predecessor. Pure (no IO) so the
 * adjacent-diff logic is unit-testable without a DB.
 */
export function summarizeRevisions(
  rows: {
    version: number;
    reason: string;
    label?: string | null;
    createdAt: Date;
    questionsSnapshot: RevisionQuestion[];
  }[],
): RevisionRow[] {
  const enriched = rows.map((r, i) => {
    const snap = r.questionsSnapshot;
    const prev = i > 0 ? rows[i - 1].questionsSnapshot : null;
    return {
      version: r.version,
      reason: r.reason,
      label: r.label ?? null,
      createdAt: r.createdAt,
      questionCount: snap.length,
      changeSummary: changeSummaryOf(prev, snap),
      changeNotes: changeNotesOf(prev, snap),
    };
  });
  // Present newest-first (matches prior UI order).
  return enriched.reverse();
}

// ── US-006: field/option-level detailed diff between two arbitrary versions ──

/** A changed non-option field of a question (prompt/type/config sub-field). */
export type FieldChange = {
  field:
    | "prompt"
    | "type"
    | "scale"
    | "rows"
    | "columns"
    | "limit"
    | "meta"
    | "displayLogic"
    | "probe"
    | "randomizeOptions"
    | "optionsFrom";
  from: unknown;
  to: unknown;
};

/** An option-level change, keyed by option id (label hash for legacy strings). */
export type OptionChange =
  | { kind: "added"; id: string; label: string }
  | { kind: "deleted"; id: string; label: string }
  | { kind: "renamed"; id: string; from: string; to: string }
  | { kind: "reordered"; id: string; label: string; from: number; to: number };

export type QuestionChangeStatus = "added" | "deleted" | "changed" | "reordered" | "unchanged";

/** Per-question detailed change record between two versions. */
export type QuestionChangeDetail = {
  quid: string;
  prompt: string;
  status: QuestionChangeStatus;
  // 1-based positions, only set when status === "reordered".
  fromOrder?: number;
  toOrder?: number;
  fieldChanges: FieldChange[];
  optionChanges: OptionChange[];
};

const CONFIG_FIELDS = ["scale", "rows", "columns", "limit", "meta", "displayLogic", "probe", "randomizeOptions", "optionsFrom"] as const satisfies readonly (keyof QConfig & FieldChange["field"])[];

/** Changed non-option config sub-fields (deep-equal by JSON). */
function configFieldChanges(a: QConfig, b: QConfig): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of CONFIG_FIELDS) {
    const av = a?.[f];
    const bv = b?.[f];
    if (stableStringify(av ?? null) !== stableStringify(bv ?? null)) out.push({ field: f, from: av, to: bv });
  }
  return out;
}

/**
 * Option-level diff keyed by option id. Objects with stable ids detect renames
 * (same id, changed label); legacy string options derive their id from the label
 * hash, so a rename there degrades gracefully to delete+add (the fallback).
 */
export function diffOptions(oldRaw: unknown, newRaw: unknown): OptionChange[] {
  const oldOpts = normalizeOptions(oldRaw);
  const newOpts = normalizeOptions(newRaw);
  const oldById = new Map(oldOpts.map((o, i) => [o.id, { o, idx: i }]));
  const newById = new Map(newOpts.map((o, i) => [o.id, { o, idx: i }]));
  const changes: OptionChange[] = [];
  for (const [id, { o }] of newById) {
    if (!oldById.has(id)) changes.push({ kind: "added", id, label: o.label });
  }
  for (const [id, { o }] of oldById) {
    if (!newById.has(id)) changes.push({ kind: "deleted", id, label: o.label });
  }
  for (const [id, n] of newById) {
    const old = oldById.get(id);
    if (!old) continue;
    if (old.o.label !== n.o.label) changes.push({ kind: "renamed", id, from: old.o.label, to: n.o.label });
    else if (old.idx !== n.idx)
      changes.push({ kind: "reordered", id, label: n.o.label, from: old.idx + 1, to: n.idx + 1 });
  }
  return changes;
}

/**
 * Field/option-level diff between two question sets. Matches by quid (falling
 * back to prompt+index for legacy snapshots without quids). Returns one record
 * per question in new order, with deleted questions appended.
 */
export function diffQuestionsDetailed(
  oldQs: RevisionQuestion[],
  newQs: RevisionQuestion[],
): QuestionChangeDetail[] {
  const haveQuids = [...oldQs, ...newQs].every((q) => q.quid);
  const keyOf = (q: RevisionQuestion, idx: number) => (haveQuids ? q.quid : `${q.prompt}#${idx}`);
  const oldByKey = new Map(oldQs.map((q, i) => [keyOf(q, i), { q, order: i }]));
  const newByKey = new Map(newQs.map((q, i) => [keyOf(q, i), { q, order: i }]));

  const details: QuestionChangeDetail[] = [];
  newQs.forEach((q, i) => {
    const old = oldByKey.get(keyOf(q, i));
    if (!old) {
      details.push({ quid: q.quid, prompt: q.prompt, status: "added", fieldChanges: [], optionChanges: [] });
      return;
    }
    const fieldChanges: FieldChange[] = [];
    if (old.q.prompt !== q.prompt) fieldChanges.push({ field: "prompt", from: old.q.prompt, to: q.prompt });
    if (old.q.type !== q.type) fieldChanges.push({ field: "type", from: old.q.type, to: q.type });
    fieldChanges.push(...configFieldChanges(old.q.config ?? {}, q.config ?? {}));
    const optionChanges = diffOptions(old.q.config?.options, q.config?.options);
    if (fieldChanges.length || optionChanges.length) {
      details.push({ quid: q.quid, prompt: q.prompt, status: "changed", fieldChanges, optionChanges });
    } else if (old.order !== i) {
      details.push({
        quid: q.quid,
        prompt: q.prompt,
        status: "reordered",
        fromOrder: old.order + 1,
        toOrder: i + 1,
        fieldChanges: [],
        optionChanges: [],
      });
    } else {
      details.push({ quid: q.quid, prompt: q.prompt, status: "unchanged", fieldChanges: [], optionChanges: [] });
    }
  });
  oldQs.forEach((q, i) => {
    if (!newByKey.has(keyOf(q, i)))
      details.push({ quid: q.quid, prompt: q.prompt, status: "deleted", fieldChanges: [], optionChanges: [] });
  });
  return details;
}

/**
 * Materialize each proposed question's transient ref-form `showIf` into a
 * stored-shape `config.displayLogic` WHEN every ref resolves to a question
 * that already exists live (quid → live id). This makes proposal diffs compare
 * like-for-like — without it, a kept question whose condition the model
 * faithfully echoed still diffs as "표시 조건 → 없음" (config vs transient).
 * Conditions referencing NEW questions stay ref-form only (resolved at apply).
 */
export function materializeShowIf(
  proposed: RevisionQuestion[],
  quidToLiveId: ReadonlyMap<string, string>,
): RevisionQuestion[] {
  const liveIdAt = (ref: number) => {
    const target = proposed[ref - 1];
    return target ? quidToLiveId.get(target.quid) : undefined;
  };
  return proposed.map((q, i) => {
    let out = q;
    if (q.showIf) {
      const logic = showIfToDisplayLogic(q.showIf, liveIdAt, i + 1);
      if (logic && logic.conditions.length === q.showIf.conditions.length) {
        out = { ...out, config: { ...out.config, displayLogic: logic } };
      }
    }
    if (q.optionsFromRef && q.optionsFromRef.ref !== i + 1) {
      const srcId = liveIdAt(q.optionsFromRef.ref);
      if (srcId) {
        out = { ...out, config: { ...out.config, optionsFrom: { questionId: srcId, mode: "selected" } } };
      }
    }
    return out;
  });
}

// ── Partial proposal apply (selective accept) ──────────────────────────────

/** Author-selectable aspects of a proposed question change. */
export type FieldKey =
  | "prompt"
  | "type"
  | "options"
  | "scale"
  | "rows"
  | "columns"
  | "limit"
  | "displayLogic"
  | "probe"
  | "randomizeOptions"
  | "optionsFrom";

const CONFIG_FIELD_KEYS = [
  "options",
  "scale",
  "rows",
  "columns",
  "limit",
  "probe",
  "randomizeOptions",
] as const satisfies readonly (FieldKey & keyof QConfig)[];
// optionsFrom is handled separately in hybridQuestion (its ref-form transient
// sibling must travel with it, like displayLogic/showIf).

/**
 * Per-quid acceptance: `true` = take the whole proposed change, `false`/absent
 * = keep current, `FieldKey[]` = hybrid (take only those aspects; edits only).
 */
export type ProposalAcceptance = Record<string, boolean | FieldKey[]>;

/**
 * Metadata rides along invisibly (the author curates questions, not meta):
 * proposed meta is taken whenever available — EXCEPT human-entered meta,
 * which the AI never overwrites (trust tier).
 */
function metaFor(cur: RevisionQuestion, p: RevisionQuestion): QConfig["meta"] {
  if (cur.config.meta?.origin === "human") return cur.config.meta;
  return p.config.meta ?? cur.config.meta;
}

/** A hybrid question: current base + only the accepted aspects of the proposal. */
function hybridQuestion(
  cur: RevisionQuestion,
  p: RevisionQuestion,
  fields: FieldKey[],
): RevisionQuestion {
  const sel = new Set(fields);
  // A type change re-shapes options/scale/rows — it is all-or-nothing: taking
  // the type takes the proposed structural config with it.
  if (sel.has("type") && p.type !== cur.type) {
    return { ...p, config: { ...p.config, meta: metaFor(cur, p) } };
  }
  const config: QConfig = { ...cur.config };
  for (const k of CONFIG_FIELD_KEYS) {
    if (!sel.has(k)) continue;
    if (p.config[k] !== undefined) (config as Record<string, unknown>)[k] = p.config[k];
    else delete (config as Record<string, unknown>)[k];
  }
  let showIf: RevisionQuestion["showIf"];
  if (sel.has("displayLogic")) {
    if (p.config.displayLogic) config.displayLogic = p.config.displayLogic;
    else delete config.displayLogic;
    showIf = p.showIf; // proposal expresses new logic in ref form
  }
  let optionsFromRef: RevisionQuestion["optionsFromRef"];
  if (sel.has("optionsFrom")) {
    if (p.config.optionsFrom) config.optionsFrom = p.config.optionsFrom;
    else delete config.optionsFrom;
    optionsFromRef = p.optionsFromRef; // ref form resolved at apply
  }
  config.meta = metaFor(cur, p);
  return {
    ...cur,
    prompt: sel.has("prompt") ? p.prompt : cur.prompt,
    config,
    ...(showIf ? { showIf } : {}),
    ...(optionsFromRef ? { optionsFromRef } : {}),
  };
}

/**
 * Merge an AI proposal with the current questions, honoring per-question (or
 * per-field) acceptance. Unaccepted edits keep the CURRENT content (at the
 * proposal's position), unaccepted additions are dropped, and unaccepted
 * deletions are re-inserted after their nearest surviving predecessor from the
 * current order. Field-level acceptance builds a hybrid question (e.g. take
 * the option changes but keep the current display logic).
 *
 * Transient `showIf` refs (1-based index into the PROPOSED list) are remapped
 * to the merged list's positions; conditions whose target dropped out of the
 * merge are removed (empty showIf is deleted entirely).
 */
export function mergeProposal(
  current: RevisionQuestion[],
  proposed: RevisionQuestion[],
  accepted: ReadonlySet<string> | ProposalAcceptance,
): RevisionQuestion[] {
  const acceptance: ProposalAcceptance =
    accepted instanceof Set
      ? Object.fromEntries([...accepted].map((q) => [q, true]))
      : (accepted as ProposalAcceptance);
  const accOf = (quid: string) => acceptance[quid] ?? false;
  const isAccepted = (quid: string) => {
    const a = accOf(quid);
    return a === true || (Array.isArray(a) && a.length > 0);
  };

  const curByQuid = new Map(current.map((q) => [q.quid, q]));
  const propQuids = new Set(proposed.map((q) => q.quid));

  const merged: RevisionQuestion[] = [];
  // For each merged item, the 1-based index it had in `proposed` (null when it
  // came from current-only re-insertion) — drives the showIf ref remap.
  const fromProposedIdx: (number | null)[] = [];

  proposed.forEach((p, i) => {
    const cur = curByQuid.get(p.quid);
    if (!cur) {
      // Addition: include only when accepted (whole-question — no hybrid).
      if (isAccepted(p.quid)) {
        merged.push({ ...p });
        fromProposedIdx.push(i + 1);
      }
      return;
    }
    // Kept question at the proposal's slot: whole proposal, hybrid, or current.
    // Every branch routes meta through metaFor — human meta is inviolable.
    const a = accOf(p.quid);
    if (a === true) merged.push({ ...p, config: { ...p.config, meta: metaFor(cur, p) } });
    else if (Array.isArray(a) && a.length > 0) merged.push(hybridQuestion(cur, p, a));
    else merged.push({ ...cur, config: { ...cur.config, meta: metaFor(cur, p) } });
    fromProposedIdx.push(i + 1);
  });

  // Unaccepted deletions: re-insert after the nearest preceding current
  // question that survived into the merge (start when none).
  current.forEach((c, ci) => {
    if (propQuids.has(c.quid) || isAccepted(c.quid)) return;
    let insertAt = 0;
    for (let j = ci - 1; j >= 0; j--) {
      const pos = merged.findIndex((m) => m.quid === current[j].quid);
      if (pos >= 0) {
        insertAt = pos + 1;
        break;
      }
    }
    merged.splice(insertAt, 0, { ...c });
    fromProposedIdx.splice(insertAt, 0, null);
  });

  const propToMerged = new Map<number, number>();
  fromProposedIdx.forEach((p, mi) => {
    if (p != null) propToMerged.set(p, mi + 1);
  });

  return merged.map((q, i) => {
    const base: RevisionQuestion = { ...q, order: i };
    if (q.showIf) {
      const conditions = q.showIf.conditions.flatMap((c) => {
        const ref = propToMerged.get(c.ref);
        return ref ? [{ ...c, ref }] : [];
      });
      if (conditions.length) base.showIf = { ...q.showIf, conditions };
      else delete base.showIf;
    }
    if (q.optionsFromRef) {
      const ref = propToMerged.get(q.optionsFromRef.ref);
      if (ref) base.optionsFromRef = { ...q.optionsFromRef, ref };
      else delete base.optionsFromRef;
    }
    return base;
  });
}
