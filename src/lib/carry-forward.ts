/**
 * Carry-forward options ("보기 가져오기", Qualtrics "Carry Forward Choices"):
 * a choice question whose options are the ones the respondent SELECTED in an
 * earlier choice question — e.g. "이 중 가장 결정적이었던 이유 1가지" showing
 * only the reasons picked in the previous multi-select.
 *
 * Stored as `config.optionsFrom = { questionId, mode: "selected" }` (jsonb,
 * same live-id reference style as displayLogic). PURE MODULE — used by the
 * respondent runtime, the simulation coercion, quality tallies, and the linter.
 */

import { optionLabels } from "@/lib/question-config";

export type OptionsFrom = { questionId: string; mode: "selected" };

/** Validate untrusted jsonb into a well-formed OptionsFrom (or undefined). */
export function normalizeOptionsFrom(raw: unknown): OptionsFrom | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as { questionId?: unknown; mode?: unknown };
  if (typeof o.questionId !== "string" || !o.questionId) return undefined;
  // "selected" is the only mode today; unknown modes degrade to undefined.
  if (o.mode !== undefined && o.mode !== "selected") return undefined;
  return { questionId: o.questionId, mode: "selected" };
}

/** The labels a respondent selected in a source answer (single/multi/ranking). */
function selectedLabels(sourceAnswer: unknown): string[] {
  if (typeof sourceAnswer === "string") return sourceAnswer ? [sourceAnswer] : [];
  if (Array.isArray(sourceAnswer)) return sourceAnswer.map(String).filter(Boolean);
  return [];
}

/**
 * The carried option labels: the SOURCE question's options, in their authored
 * order, filtered to the ones this respondent selected. [] when the source is
 * unanswered (callers should then hide/skip the dependent question).
 */
export function carriedOptionLabels(
  sourceOptions: unknown,
  sourceAnswer: unknown,
): string[] {
  const picked = new Set(selectedLabels(sourceAnswer));
  if (picked.size === 0) return [];
  return optionLabels(sourceOptions).filter((label) => picked.has(label));
}

/**
 * Clamp a (synthetic) answer of a carry-forward question to the respondent's
 * own source selections — a simulated persona must not pick an option it never
 * chose in the source question. Empty source selection empties the answer.
 */
export function clampCarriedAnswer(
  type: string,
  value: unknown,
  carried: string[],
): unknown {
  const allowed = new Set(carried);
  if (type === "single") {
    if (typeof value === "string" && allowed.has(value)) return value;
    return carried[0] ?? "";
  }
  if (type === "multi" || type === "ranking") {
    const arr = Array.isArray(value) ? value.map(String) : [];
    const kept = arr.filter((v) => allowed.has(v));
    if (kept.length > 0) return kept;
    return carried.length > 0 ? [carried[0]] : [];
  }
  return value;
}
