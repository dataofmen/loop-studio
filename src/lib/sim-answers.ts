/**
 * US-015: pure answer coercion for the synthetic simulation (no DB / IO).
 *
 * Simulation deliberately skips AI probing (US-011..014): synthetic open
 * answers are stored as plain scalar strings — never the probed
 * `{answer, probes}` object — so aggregation and analysis see the same
 * legacy-compatible shape regardless of whether a question has probing
 * enabled. If a sim model echoes a structured object anyway, only its base
 * text survives; any probes it invents are dropped.
 */

import { openAnswerText } from "@/lib/open-answer";

export type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";

/** Empty storage value for a question that a respondent never saw. */
export function emptyFor(type: QuestionType): unknown {
  if (type === "scale" || type === "nps") return null;
  if (type === "multi" || type === "ranking") return [];
  if (type === "matrix") return {};
  return "";
}

/** Coerces a model answer to the storage shape for its question type. */
export function coerceSimAnswer(type: QuestionType, value: unknown): unknown {
  if (type === "scale" || type === "nps") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "multi" || type === "ranking")
    return Array.isArray(value) ? value.map((x) => String(x)) : value == null ? [] : [String(value)];
  if (type === "matrix")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  // open / single: always a scalar string. Objects are either a probed-shape
  // echo (take the base text, drop probes) or junk ("") — never "[object Object]".
  if (value == null) return "";
  if (typeof value === "object") return openAnswerText(value).trim();
  return String(value);
}
