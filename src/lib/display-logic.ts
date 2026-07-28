/**
 * Conditional question display ("skip logic"): a question can carry a
 * `displayLogic` that gates whether it is shown to a respondent, based on their
 * answers to earlier questions. Stored inside `questions.config` (jsonb), so it
 * rides the existing snapshot/revision plumbing with no migration.
 *
 * This module is intentionally pure (no DB / server imports) so it can run both
 * on the respondent client (respond-form) and on the server (simulation).
 */

import type { ConfigOption } from "@/lib/question-config";

export type DisplayOp =
  | "eq" // answer equals value
  | "ne" // answer not equal
  | "in" // answer (or any selected option) is one of value[]
  | "not_in" // answer is none of value[]
  | "gte" // numeric >=
  | "lte" // numeric <=
  | "gt" // numeric >
  | "lt" // numeric <
  | "contains"; // array answer includes value / string answer contains value

export type DisplayCondition = {
  /** The referenced earlier question's id (answers are keyed by question id). */
  questionId: string;
  op: DisplayOp;
  /** Scalar for eq/ne/gte/..., array for in/not_in. */
  value: string | number | string[];
};

export type DisplayLogic = {
  /** "all" = every condition (AND), "any" = at least one (OR). */
  match: "all" | "any";
  conditions: DisplayCondition[];
};

/** Answer value as stored in responses.answers (keyed by question id). */
type AnswerValue = string | number | string[] | Record<string, string> | null | undefined;

function toNum(v: unknown): number {
  return typeof v === "number" ? v : Number(String(v));
}
function toStrArray(v: string | number | string[]): string[] {
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

/** Evaluates a single condition against the respondent's answers. */
function evalCondition(cond: DisplayCondition, answers: Record<string, AnswerValue>): boolean {
  const a = answers[cond.questionId];
  // An unanswered dependency means the condition cannot be satisfied.
  if (a === undefined || a === null || a === "") return false;

  const answerStrings = Array.isArray(a)
    ? a.map(String)
    : typeof a === "object"
      ? Object.values(a).map(String)
      : [String(a)];

  switch (cond.op) {
    case "eq":
      return answerStrings.length === 1 && answerStrings[0] === String(cond.value);
    case "ne":
      return !(answerStrings.length === 1 && answerStrings[0] === String(cond.value));
    case "in": {
      const set = toStrArray(cond.value);
      return answerStrings.some((x) => set.includes(x));
    }
    case "not_in": {
      const set = toStrArray(cond.value);
      return !answerStrings.some((x) => set.includes(x));
    }
    case "gte":
      return toNum(a) >= toNum(cond.value);
    case "lte":
      return toNum(a) <= toNum(cond.value);
    case "gt":
      return toNum(a) > toNum(cond.value);
    case "lt":
      return toNum(a) < toNum(cond.value);
    case "contains":
      return answerStrings.includes(String(cond.value));
    default:
      return false;
  }
}

/**
 * Whether a question should be shown given the respondent's current answers.
 * No logic (or empty conditions) → always visible.
 */
export function questionVisible(
  logic: DisplayLogic | null | undefined,
  answers: Record<string, AnswerValue>,
): boolean {
  // Ignore degenerate conditions (e.g. an empty `in`) rather than hiding the
  // question — a broken condition should never make a question disappear.
  const clean = sanitizeDisplayLogic(logic);
  if (!clean) return true;
  const results = clean.conditions.map((c) => evalCondition(c, answers));
  return clean.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

/** True when a config object carries an active display condition. */
export function hasDisplayLogic(logic: DisplayLogic | null | undefined): boolean {
  return !!logic && Array.isArray(logic.conditions) && logic.conditions.length > 0;
}

/**
 * Drops unsatisfiable/degenerate conditions (in/not_in with no values, empty
 * scalar) and returns undefined when nothing meaningful remains. Applied when
 * loading a survey so a broken condition (e.g. an AI-emitted empty `in`) never
 * shows in the editor and can't be re-persisted.
 */
export function sanitizeDisplayLogic(
  logic: DisplayLogic | null | undefined,
): DisplayLogic | undefined {
  if (!logic || !Array.isArray(logic.conditions)) return undefined;
  const conditions = logic.conditions.filter((c) => {
    if (c.op === "in" || c.op === "not_in") return Array.isArray(c.value) && c.value.length > 0;
    return c.value !== "" && c.value !== null && c.value !== undefined;
  });
  return conditions.length > 0 ? { match: logic.match === "any" ? "any" : "all", conditions } : undefined;
}

/** Returns a question config with its displayLogic sanitized (key removed if empty). */
export function sanitizeConfig<T extends { displayLogic?: DisplayLogic }>(config: T): T {
  const dl = sanitizeDisplayLogic(config.displayLogic);
  const next = { ...config } as T;
  if (dl) next.displayLogic = dl;
  else delete next.displayLogic;
  return next;
}

// ---------------------------------------------------------------------------
// Plain-Korean description helpers (moved here from the editor so the logic
// map, the linter, and the per-question editor share ONE implementation).
// ---------------------------------------------------------------------------

export type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";

/** Minimal question shape needed to describe a condition (id, type, prompt, options). */
export type DescribeQuestion = {
  id: string;
  type: QuestionType;
  prompt: string;
  config: { options?: ConfigOption[] };
};

/** Human-readable Korean phrase for a single condition. */
export function describeCondition(c: DisplayCondition, prior: DescribeQuestion[]): string {
  const ref = prior.find((q) => q.id === c.questionId);
  const label = ref ? `"${ref.prompt.slice(0, 24)}"` : "이전 문항";
  const v = Array.isArray(c.value) ? c.value.map((x) => `'${x}'`).join(", ") : `'${c.value}'`;
  switch (c.op) {
    case "in":
      return `${label} 응답이 [${v}] 중 하나`;
    case "not_in":
      return `${label} 응답이 [${v}] 중 어느 것도 아님`;
    case "eq":
      return `${label} 응답이 ${v}`;
    case "ne":
      return `${label} 응답이 ${v}가 아님`;
    case "gte":
      return `${label} ≥ ${c.value}`;
    case "lte":
      return `${label} ≤ ${c.value}`;
    case "gt":
      return `${label} > ${c.value}`;
    case "lt":
      return `${label} < ${c.value}`;
    case "contains":
      return `${label} 응답에 ${v} 포함`;
    default:
      return `${label} 조건`;
  }
}

/** Full plain-Korean description of the active display logic. */
export function describeLogic(logic: DisplayLogic, prior: DescribeQuestion[]): string {
  const joiner = logic.match === "any" ? " 또는 " : " 그리고 ";
  return logic.conditions.map((c) => describeCondition(c, prior)).join(joiner);
}

// ---------------------------------------------------------------------------
// Ref-form conditions ("showIf") for AI revision proposals.
//
// Proposal questions have no live row ids yet, so an AI proposal expresses
// display logic by 1-based index into ITS OWN question list. The refs are
// resolved to real question ids only after applyRevision has reconciled the
// rows (insert/update), when every proposed index has a live id.
// ---------------------------------------------------------------------------

export const DISPLAY_OPS: DisplayOp[] = [
  "eq", "ne", "in", "not_in", "gte", "lte", "gt", "lt", "contains",
];

export type ShowIfCondition = { ref: number; op: DisplayOp; value: string | number | string[] };
export type ShowIf = { match: "all" | "any"; conditions: ShowIfCondition[] };

/**
 * Validate untrusted showIf input (LLM output / client payload) into a
 * well-formed ShowIf, or undefined when nothing valid remains. Mirrors the
 * value rules of compileDisplayLogicAction: in/not_in need a non-empty array,
 * scalar ops need a non-empty scalar.
 */
export function sanitizeShowIf(raw: unknown): ShowIf | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as { match?: unknown; conditions?: unknown };
  if (!Array.isArray(o.conditions)) return undefined;
  const conditions: ShowIfCondition[] = [];
  for (const c of o.conditions) {
    if (c == null || typeof c !== "object") continue;
    const { ref, op, value } = c as { ref?: unknown; op?: unknown; value?: unknown };
    const idx = Number(ref);
    if (!Number.isInteger(idx) || idx < 1) continue;
    if (!DISPLAY_OPS.includes(op as DisplayOp)) continue;
    const v =
      op === "in" || op === "not_in"
        ? (Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)])
        : typeof value === "number"
          ? value
          : String(value ?? "");
    if ((op === "in" || op === "not_in") && (!Array.isArray(v) || v.length === 0)) continue;
    if (op !== "in" && op !== "not_in" && (v === "" || v === null)) continue;
    conditions.push({ ref: idx, op: op as DisplayOp, value: v });
  }
  if (!conditions.length) return undefined;
  return { match: o.match === "any" ? "any" : "all", conditions };
}

/**
 * Resolve a ref-form ShowIf into stored DisplayLogic using `idAt(ref)` (live
 * question id for the proposal's 1-based index). Conditions whose ref cannot
 * be resolved — out of range, or pointing at the question itself via
 * `selfRef` — are dropped; undefined when none survive.
 */
export function showIfToDisplayLogic(
  showIf: ShowIf,
  idAt: (ref: number) => string | undefined,
  selfRef?: number,
): DisplayLogic | undefined {
  const conditions: DisplayCondition[] = [];
  for (const c of showIf.conditions) {
    if (selfRef !== undefined && c.ref === selfRef) continue;
    const questionId = idAt(c.ref);
    if (!questionId) continue;
    conditions.push({ questionId, op: c.op, value: c.value });
  }
  if (!conditions.length) return undefined;
  return { match: showIf.match, conditions };
}

/**
 * Present stored DisplayLogic in ref form (for the AI revision prompt), using
 * `refOf(questionId)` (1-based index of the referenced question in the current
 * list). Conditions referencing unknown questions are dropped.
 */
export function displayLogicToShowIf(
  logic: DisplayLogic,
  refOf: (questionId: string) => number | undefined,
): ShowIf | undefined {
  const conditions: ShowIfCondition[] = [];
  for (const c of logic.conditions) {
    const ref = refOf(c.questionId);
    if (ref === undefined) continue;
    conditions.push({ ref, op: c.op, value: c.value });
  }
  if (!conditions.length) return undefined;
  return { match: logic.match, conditions };
}
