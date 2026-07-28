/**
 * The stored shape of an open-text answer. Pure (no DB / IO).
 *
 * An open question can be configured with AI follow-up probing
 * (`config.probe`), which makes the stored value an object carrying the base
 * answer plus the probe exchanges instead of a bare string. Every consumer —
 * distributions, themes, insights, reports, CSV/SPSS export — must accept both
 * shapes, so the readers live here rather than being re-derived per call site.
 *
 * Probe *generation* is design-time metadata only: this app doesn't field
 * surveys, so nothing here runs an interviewer. Simulated answers and any
 * externally-produced data still arrive in these shapes.
 */

import { MAX_PROBES_CAP } from "@/lib/question-config";

/** One completed probe exchange (AI question, respondent answer). */
export type ProbeQA = { q: string; a: string };

/** Length caps keep untrusted text from bloating prompts and CSV cells. */
export const MAX_ANSWER_CHARS = 2000;
export const MAX_PROBE_QUESTION_CHARS = 300;

/** Legacy scalar string, or the probed object form. */
export type OpenAnswer = string | { answer: string; probes: ProbeQA[] };

/**
 * Normalize a list of probe Q&As from untrusted storage: entries must have
 * non-blank string q/a; strings are trimmed and length-capped; at most
 * MAX_PROBES_CAP entries survive.
 */
export function sanitizeProbeQAs(raw: unknown): ProbeQA[] {
  if (!Array.isArray(raw)) return [];
  const out: ProbeQA[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PROBES_CAP) break;
    if (item == null || typeof item !== "object") continue;
    const { q, a } = item as { q?: unknown; a?: unknown };
    if (typeof q !== "string" || typeof a !== "string") continue;
    const qt = q.trim().slice(0, MAX_PROBE_QUESTION_CHARS);
    const at = a.trim().slice(0, MAX_ANSWER_CHARS);
    if (!qt || !at) continue;
    out.push({ q: qt, a: at });
  }
  return out;
}

/** True when a stored answer value is the probed `{answer, probes}` object. */
export function isProbedAnswer(v: unknown): v is { answer: string; probes: unknown } {
  return (
    v != null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as { answer?: unknown }).answer === "string" &&
    Array.isArray((v as { probes?: unknown }).probes)
  );
}

/** Base answer text from either stored shape ("" for junk/non-open values). */
export function openAnswerText(v: unknown): string {
  if (typeof v === "string") return v;
  if (isProbedAnswer(v)) return v.answer;
  return "";
}

/** Probe Q&As from a stored answer value ([] for scalar/junk). */
export function openAnswerProbes(v: unknown): ProbeQA[] {
  return isProbedAnswer(v) ? sanitizeProbeQAs(v.probes) : [];
}

/**
 * One-line serialization of a stored open answer — base text plus any probe
 * Q&As — for CSV cells and LLM prompt blocks. "" for junk/empty.
 */
export function serializeOpenAnswer(v: unknown): string {
  const text = openAnswerText(v).trim();
  if (!text) return "";
  const probes = openAnswerProbes(v);
  if (!probes.length) return text;
  const parts = probes.map((p, i) => `[AI 후속 ${i + 1}] Q: ${p.q} → A: ${p.a}`);
  return [text, ...parts].join(" | ");
}
