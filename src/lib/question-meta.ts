/**
 * US-002 (question-meta-loop): Infer question metadata (construct/topic) from
 * the question content + the survey's research goal via the claude CLI.
 *
 * `buildInferMetaPrompt` / `parseInferredMeta` are PURE (no IO) so they are
 * unit-testable; `inferQuestionMeta` is the LLM entry point. It never throws —
 * any CLI/parse failure resolves to null so background inference (US-004) can
 * never block the editing or save flow.
 */

import { runLlmJson } from "@/lib/llm";
import { META_FIELD_MAX } from "@/lib/question-config";

export type InferredMeta = { construct: string; topic: string };

export type InferMetaInput = {
  /** The survey's research goal (surveys.researchGoal). */
  researchGoal: string;
  /** The question's prompt text. */
  prompt: string;
  /** Question type (single/multi/scale/ranking/matrix/nps/open). */
  type: string;
  /** Option labels, when the type has options. */
  optionLabels?: string[];
  /**
   * Existing workspace construct vocabulary, offered as reuse candidates so
   * inference converges on canonical names instead of minting variants.
   */
  existingConstructs?: string[];
};

/** Input caps — keep author/LLM-supplied text from bloating the prompt. */
export const MAX_GOAL_CHARS = 1000;
export const MAX_PROMPT_CHARS = 500;
export const MAX_OPTION_LABELS = 20;
export const MAX_OPTION_LABEL_CHARS = 100;
export const MAX_CANDIDATE_CONSTRUCTS = 50;

// Background inference — no respondent is waiting, but don't hang the queue.
const INFER_TIMEOUT_MS = 60_000;

/** Trim + cap a free-text prompt input; "" for non-strings. */
function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Build the claude CLI prompt. When the workspace already has constructs,
 * they are listed as candidates the model must reuse verbatim on a concept
 * match — free-text drift into near-duplicate names is the main failure mode
 * the controlled vocabulary (US-005+) exists to prevent.
 */
export function buildInferMetaPrompt(input: InferMetaInput): string {
  const goal = clip(input.researchGoal, MAX_GOAL_CHARS);
  const prompt = clip(input.prompt, MAX_PROMPT_CHARS);
  const type = clip(input.type, 30);

  const labels = (input.optionLabels ?? [])
    .map((l) => clip(l, MAX_OPTION_LABEL_CHARS))
    .filter(Boolean)
    .slice(0, MAX_OPTION_LABELS);
  const optionsLine = labels.length
    ? `\n선택지: ${labels.map((l) => `"${l}"`).join(", ")}`
    : "";

  const candidates = Array.from(
    new Set(
      (input.existingConstructs ?? [])
        .map((c) => clip(c, META_FIELD_MAX))
        .filter(Boolean),
    ),
  ).slice(0, MAX_CANDIDATE_CONSTRUCTS);
  // Candidates are a REUSE HINT, not a menu to pick from. The old prompt said
  // "같은 개념이면 반드시 그대로 재사용" — the model then forced a question into
  // the nearest existing bucket even across domains (e.g. a banking "이용 상태"
  // → subscription "구독 이용 상태"). Reuse only on a true concept match; a
  // forced fit is worse than a fresh construct.
  const candidateBlock = candidates.length
    ? `\n이 워크스페이스에 이미 존재하는 construct 목록 (참고용 후보 — 의미가 정확히 같을 때만 표기를 그대로 재사용, 억지로 끼워맞추지 말 것):\n${candidates
        .map((c) => `- ${c}`)
        .join("\n")}\n`
    : "";

  return `You are a survey methodologist annotating a survey question with measurement metadata. Respond in Korean.

리서치 목표: "${goal}"
문항 유형: "${type}"
문항: "${prompt}"${optionsLine}
${candidateBlock}
개념 구분 (중요):
- "construct"는 이 문항이 재려는 잠재 속성/측정 개념을 짧은 한국어 명사구로. 응답으로부터 추론하려는 추상적 대상이다.
- "topic"은 그 문항이 다루는 구체적 소재/주제 하나. 문항 표면의 대상이다.
- 두 값은 추상화 층위가 다르다. 같은 예: 문항 "배달 속도에 얼마나 만족하십니까?" → construct "고객 만족도"(측정 개념), topic "배달 속도"(소재).

지침:
- construct는 이 문항의 의미에 맞는 개념을 붙일 것. 후보 목록에 의미가 정확히 일치하는 것이 있으면 그 표기를 그대로 쓰고, 없거나 도메인/의미가 다르면 (구독↔은행처럼) 억지로 맞추지 말고 새 개념명을 제안할 것.
- construct는 문항의 방향과 어긋나면 안 된다. 예: '선택에 영향을 주는 요인'을 '불만족 요인'으로 붙이지 말 것.
- topic은 문항 소재를 그대로 반영하는 짧은 태그 하나 (예: "배달 품질", "가격"). 약어보다 서술형 표기를 선호.
- 확신이 없어도 가장 그럴듯한 값을 반드시 채울 것 (빈 값 금지).

Return ONLY a JSON object (no prose, no fences):
{"construct": "<측정 개념>", "topic": "<소재 태그>"}`;
}

/**
 * Parse/sanitize the LLM's JSON output. Anything malformed — junk shapes,
 * non-string or blank fields — resolves to null (fail-safe: the caller simply
 * skips saving). Values are trimmed and capped to META_FIELD_MAX so runaway
 * output never lands in `config.meta`.
 */
export function parseInferredMeta(raw: unknown): InferredMeta | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as { construct?: unknown; topic?: unknown };
  const construct = clip(o.construct, META_FIELD_MAX);
  const topic = clip(o.topic, META_FIELD_MAX);
  if (!construct || !topic) return null;
  return { construct, topic };
}

/**
 * Infer {construct, topic} for one question via the claude CLI. Returns null
 * on any failure (CLI missing, timeout, malformed output) — callers treat
 * null as "no inference this time" and must never block on it.
 */
export async function inferQuestionMeta(
  input: InferMetaInput,
): Promise<InferredMeta | null> {
  try {
    const out = await runLlmJson<unknown>(buildInferMetaPrompt(input), {
      timeoutMs: INFER_TIMEOUT_MS,
    });
    return parseInferredMeta(out);
  } catch {
    return null;
  }
}
