/**
 * US-003: mutual exclusivity of the special "none" (없음) option in
 * multi-select questions. Pure — no DB / IO.
 *
 * Two enforcement points share these helpers:
 * - the respond form's toggle (interactive: picking none clears the rest,
 *   picking anything else clears none)
 * - stored-answer clamps (server re-sanitization of submissions and synthetic
 *   simulation output, where a contradictory combination can arrive fully
 *   formed)
 */

import { normalizeOptions, type OptionObject } from "@/lib/question-config";

/** The special "none" option of a question's raw `config.options`, if any. */
export function noneOption(rawOptions: unknown): OptionObject | undefined {
  return normalizeOptions(rawOptions).find((o) => o.special === "none");
}

/**
 * Multi-select toggle with none-exclusivity:
 * - toggling an already-selected label always just deselects it
 * - selecting the none label clears every other pick (none stands alone)
 * - selecting any other label removes the none label
 * Without a none label this is a plain toggle.
 */
export function toggleMultiExclusive(
  current: string[],
  picked: string,
  noneLabel?: string,
): string[] {
  if (current.includes(picked)) return current.filter((x) => x !== picked);
  if (noneLabel && picked === noneLabel) return [picked];
  const base = noneLabel ? current.filter((x) => x !== noneLabel) : current;
  return [...base, picked];
}

/**
 * Clamp rule for fully-formed multi answers (server re-sanitization, synthetic
 * simulation): when the none label coexists with other picks, DROP the none
 * label and keep the substantive picks — having selected concrete options
 * contradicts "none of these", and the concrete picks carry the information.
 * A none-only answer is left as-is.
 */
export function clampNoneExclusive(values: string[], noneLabel: string): string[] {
  if (values.length > 1 && values.includes(noneLabel)) {
    return values.filter((v) => v !== noneLabel);
  }
  return values;
}
