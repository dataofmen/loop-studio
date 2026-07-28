/**
 * US-002 (기타 자유 입력): pure helpers for the special "other" option's free
 * text. No DB / IO.
 *
 * Storage design: the typed text lives in a SEPARATE per-response jsonb column
 * (`responses.other_texts`, questionId -> string), NOT inside `answers`.
 * `answers[qid]` keeps holding the plain option label ("기타"), so every
 * label-based consumer — distribution tallies, display-logic evaluation,
 * carry-forward clamps, simulation clamps, quality report — keeps working
 * without change. The alternative ({label, otherText} inside answers) would
 * have forced a normalizer into every `String(v)` cast across the codebase.
 */

import { normalizeOptions, type OptionObject } from "@/lib/question-config";

/** Length cap for one "other" free text — short phrase, junk/runaway defense. */
export const OTHER_TEXT_MAX = 200;

/** The special "other" option of a question's raw `config.options`, if any. */
export function otherOption(rawOptions: unknown): OptionObject | undefined {
  return normalizeOptions(rawOptions).find((o) => o.special === "other");
}

/** Whether a stored answer value actually selects the given option label. */
export function answerSelectsLabel(value: unknown, label: string): boolean {
  if (typeof value === "string") return value === label;
  if (Array.isArray(value)) return value.some((v) => String(v) === label);
  return false;
}

export type OtherTextQuestion = {
  id: string;
  type: string;
  config: { options?: unknown } | null;
};

/** Question types whose options can carry a special "other" free text. */
export function isOtherTextType(type: string): boolean {
  return type === "single" || type === "multi" || type === "ranking";
}

/**
 * Server-side re-sanitization of a client/model-supplied otherTexts map.
 * Keeps an entry only when: the question exists and is a choice type
 * (single/multi/ranking), it has a special "other" option with text input on,
 * and the (already sanitized) answer for it actually selects that option's
 * label. Values are trimmed and length-capped; blanks and everything else
 * (unknown qids, junk types) are dropped.
 */
export function sanitizeOtherTexts(
  raw: unknown,
  questions: OtherTextQuestion[],
  answers: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const [qid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const text = v.trim().slice(0, OTHER_TEXT_MAX);
    if (!text) continue;
    const q = byId.get(qid);
    if (!q || !isOtherTextType(q.type)) continue;
    const other = otherOption(q.config?.options);
    if (!other || other.noText) continue;
    if (!answerSelectsLabel(answers[qid], other.label)) continue;
    out[qid] = text;
  }
  return out;
}
