/**
 * US-002: Option normalization + option-level stable identity.
 *
 * Options are historically stored as `string[]` inside `questions.config.options`
 * (jsonb). This module promotes them to a canonical `{ id, label }[]` shape where
 * `id` is a stable per-option identity that survives reordering and renaming,
 * while tolerating legacy string arrays and mixed input.
 *
 * PURE MODULE — no DB / IO. Every option consumer (respond-form, quality,
 * simulate, analysis, revisions, surveys, editor — US-003) should read through
 * `normalizeOptions` / `optionLabel` so legacy string surveys keep working.
 */

/**
 * `special` pins an option's display position and excludes it from
 * randomization (Qualtrics-style anchoring): "none" (없음) is always shown
 * first, "other" (기타) always last.
 */
export type OptionSpecial = "other" | "none";
export type OptionObject = {
  id: string;
  label: string;
  special?: OptionSpecial;
  /**
   * On a special "other" option: suppress the free-text input (US-002
   * follow-up). Absent/false = input shown (default). The option keeps its
   * last-anchored placement either way.
   */
  noText?: boolean;
};
/** Anything that may appear in a legacy or in-flight `config.options` entry. */
export type RawOption =
  | string
  | { id?: string | null; label?: string | null; special?: string | null; noText?: unknown }
  | null
  | undefined;
/** The shape a `config.options` array may take (legacy strings and/or objects). */
export type ConfigOption =
  | string
  | { id?: string | null; label?: string | null; special?: string | null; noText?: unknown };

/**
 * Deterministic FNV-1a id derived from a label. The same legacy string always
 * normalizes to the same id (stable identity for surveys that predate object
 * options), so distributions/joins keyed by option id stay consistent run to run.
 * Once stored as objects, an option keeps its id even when its label is renamed.
 */
export function optionIdFromLabel(label: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return "o_" + (h >>> 0).toString(16).padStart(8, "0");
}

/** Display label for any option shape (object → label, legacy string → itself). */
export function optionLabel(o: RawOption): string {
  if (o == null) return "";
  if (typeof o === "string") return o;
  return typeof o.label === "string" ? o.label : "";
}

/**
 * Just the display labels of a raw `config.options` value, in order. Convenience
 * for readers that key/aggregate by the label (answers are stored label-based),
 * e.g. distribution tallies, the simulation prompt, and display-logic pickers.
 */
export function optionLabels(raw: unknown): string[] {
  return normalizeOptions(raw).map((o) => o.label);
}

/**
 * Convert a raw `config.options` value (undefined | string[] | object[] | mixed)
 * into `{ id, label }[]`. Objects with an explicit non-empty id keep it; strings
 * and id-less objects get a stable id derived from their label. Duplicate ids
 * (from duplicate labels or explicit collisions) are disambiguated so every
 * returned option has a unique id. Non-array / null input yields `[]`.
 */
export function normalizeOptions(raw: unknown): OptionObject[] {
  if (!Array.isArray(raw)) return [];
  const used = new Set<string>();
  const out: OptionObject[] = [];
  for (const item of raw) {
    let label: string;
    let id: string | undefined;
    let special: OptionSpecial | undefined;
    let noText = false;
    if (typeof item === "string") {
      label = item;
    } else if (item && typeof item === "object") {
      label = typeof (item as { label?: unknown }).label === "string" ? (item as { label: string }).label : "";
      const rawId = (item as { id?: unknown }).id;
      if (typeof rawId === "string" && rawId) id = rawId;
      const rawSpecial = (item as { special?: unknown }).special;
      if (rawSpecial === "other" || rawSpecial === "none") special = rawSpecial;
      // noText only means something on the "other" special — drop it elsewhere.
      noText = special === "other" && (item as { noText?: unknown }).noText === true;
    } else {
      continue; // skip null / numbers / other junk
    }
    if (!id) id = optionIdFromLabel(label);
    // Disambiguate collisions (duplicate labels → same derived id, or explicit
    // duplicate ids) while preserving the first occurrence's id.
    let uid = id;
    let n = 2;
    while (used.has(uid)) uid = `${id}_${n++}`;
    used.add(uid);
    out.push({ id: uid, label, ...(special ? { special } : {}), ...(noText ? { noText } : {}) });
  }
  return out;
}

/**
 * Detects catch-all / none-of-the-above semantics from a plain option label,
 * so AI-generated string options ("기타(직접 입력)", "해당 없음", …) get their
 * special behavior (anchoring + free-text input) automatically instead of
 * arriving as inert plain options.
 *
 * `conservative` skips the bare "기타" match — used for manually typed labels
 * in the editor, where "기타" can legitimately mean guitar. AI ingestion uses
 * the non-conservative form: our prompts ask for 기타 as a catch-all, so a
 * bare "기타" there is a catch-all in practice.
 */
export function specialFromLabel(
  label: string,
  opts?: { conservative?: boolean },
): OptionSpecial | undefined {
  const t = label.trim();
  if (!t) return undefined;
  if (/직접\s*입력/.test(t)) return "other";
  if (/^기타\s*[(（:：]/.test(t)) return "other";
  if (!opts?.conservative && t === "기타") return "other";
  if (/^(해당\s*)?(사항\s*)?없음$/.test(t)) return "none";
  return undefined;
}

/**
 * Promotes label-detected specials on a normalized option list. Existing
 * explicit specials always win; at most one "other" and one "none" result.
 * Ids and order are untouched (display anchoring comes from displayOptions).
 */
export function promoteSpecialOptions(
  options: OptionObject[],
  opts?: { conservative?: boolean },
): OptionObject[] {
  let hasOther = options.some((o) => o.special === "other");
  let hasNone = options.some((o) => o.special === "none");
  return options.map((o) => {
    if (o.special) return o;
    const s = specialFromLabel(o.label, opts);
    if (s === "other" && !hasOther) {
      hasOther = true;
      return { ...o, special: "other" as const };
    }
    if (s === "none" && !hasNone) {
      hasNone = true;
      return { ...o, special: "none" as const };
    }
    return o;
  });
}

// ---------------------------------------------------------------------------
// Option display order: pinned specials + optional per-respondent shuffle.
// ---------------------------------------------------------------------------

/** Deterministic 32-bit hash of a string (FNV-1a) for shuffle seeding. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny seeded PRNG so a respondent's shuffle is session-stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Options in respondent-facing display order: "none" specials first, "other"
 * specials last, and everything else in authoring order — or seeded-shuffled
 * when `randomize` is on (specials are anchored and never shuffled, per the
 * Qualtrics advanced-randomization convention). The same seed always yields
 * the same order, so a respondent never sees options reshuffle mid-session.
 * Display-only: stored answers and analysis keep the authoring order.
 */
export function displayOptions(
  options: OptionObject[],
  randomize: boolean,
  seed: number,
): OptionObject[] {
  const first = options.filter((o) => o.special === "none");
  const last = options.filter((o) => o.special === "other");
  const middle = options.filter((o) => !o.special);
  if (randomize && middle.length > 1) {
    const rand = mulberry32(seed);
    for (let i = middle.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [middle[i], middle[j]] = [middle[j], middle[i]];
    }
  }
  return [...first, ...middle, ...last];
}

// ---------------------------------------------------------------------------
// Question metadata (`config.meta`) — construct/topic tagging with a trust
// tier: `origin` records whether the metadata came from the author ("human")
// or was inferred by AI ("ai"). Human metadata must never be overwritten by
// automatic inference, so every writer/reader goes through normalizeMeta.
// ---------------------------------------------------------------------------

export type QMetaOrigin = "human" | "ai";
export type QMetaSource = "custom" | "validated" | "adapted";

export type QMeta = {
  construct?: string;
  topic?: string;
  population?: string;
  source?: QMetaSource;
  validatedScale?: string;
  notes?: string;
  /** Who authored this metadata: "human" (직접 입력) or "ai" (AI 추정). */
  origin?: QMetaOrigin;
  /**
   * Id of the workspace `constructs` dictionary row `construct` resolved to
   * (US-006). When present, `construct` holds that row's canonical name.
   * Internal pointer — never rendered or edited directly; a manual edit of
   * `construct` drops it (the free text no longer matches the dictionary).
   */
  constructId?: string;
};

const META_TEXT_FIELDS = ["construct", "topic", "population", "validatedScale", "notes"] as const;
/** Length cap per free-text meta field — junk/LLM runaway defense. */
export const META_FIELD_MAX = 500;

/**
 * Normalize a raw `config.meta` value (jsonb → unknown) into a well-formed
 * QMeta, or undefined when absent / junk. Free-text fields are trimmed,
 * length-capped and dropped when blank or non-string; `source` and `origin`
 * only admit their known values. Pure (no IO) so it is unit-testable and safe
 * on both client and server.
 */
export function normalizeMeta(raw: unknown): QMeta | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: QMeta = {};
  for (const f of META_TEXT_FIELDS) {
    const v = o[f];
    if (typeof v !== "string") continue;
    const t = v.trim().slice(0, META_FIELD_MAX);
    if (t) out[f] = t;
  }
  const src = o.source;
  if (src === "custom" || src === "validated" || src === "adapted") out.source = src;
  if (o.origin === "human" || o.origin === "ai") out.origin = o.origin;
  // Dictionary pointer only makes sense alongside its construct text.
  if (typeof o.constructId === "string" && o.constructId.trim() && out.construct) {
    out.constructId = o.constructId.trim().slice(0, 64);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * normalizeMeta + origin trust stamp for AI-produced question payloads.
 * Missing/invalid origin defaults to `origin`; pass `force: true` when the
 * payload is freshly AI-generated so a hallucinated `origin: "human"` can
 * never claim the human trust tier. Fallback mode (no force) preserves an
 * echoed `origin: "human"` on questions the model kept unchanged.
 */
export function stampMetaOrigin(
  raw: unknown,
  origin: QMetaOrigin,
  opts?: { force?: boolean },
): QMeta | undefined {
  const meta = normalizeMeta(raw);
  if (!meta) return undefined;
  return { ...meta, origin: opts?.force ? origin : meta.origin ?? origin };
}

// ---------------------------------------------------------------------------
// US-011: AI follow-up probing config on open questions (`config.probe`).
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_PROBES = 2;
export const MAX_PROBES_CAP = 5;

export type ProbeConfig = {
  /** Whether AI follow-up probing is on for this open question. */
  enabled: boolean;
  /** How many follow-up questions the AI may ask (1..MAX_PROBES_CAP, default 2). */
  maxProbes: number;
  /** Optional author guidance steering what the follow-ups should dig into. */
  guidance?: string;
};

/**
 * Normalize a raw `config.probe` value (jsonb → unknown) into a well-formed
 * ProbeConfig, or undefined when absent / junk. `maxProbes` defaults to 2 and
 * is clamped to 1..MAX_PROBES_CAP; `guidance` is kept only when a non-blank
 * string. Every probe consumer (editor, probe generation, respond runtime)
 * should read through this so malformed jsonb never reaches the LLM path.
 */
export function normalizeProbe(raw: unknown): ProbeConfig | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as { enabled?: unknown; maxProbes?: unknown; guidance?: unknown };
  const n = Number(o.maxProbes);
  const maxProbes = Number.isFinite(n)
    ? Math.min(MAX_PROBES_CAP, Math.max(1, Math.floor(n)))
    : DEFAULT_MAX_PROBES;
  const guidance =
    typeof o.guidance === "string" && o.guidance.trim() ? o.guidance : undefined;
  return { enabled: o.enabled === true, maxProbes, ...(guidance ? { guidance } : {}) };
}
