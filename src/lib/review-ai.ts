/**
 * US-008: Pre-publish AI review — pure parts (no DB / IO).
 *
 * The DB + claude-CLI entry point lives in `src/lib/review.ts`; this module
 * holds the unit-testable pieces: the review prompt builder, the fail-safe
 * parser for the LLM's structured issue list, and the merger that combines
 * the deterministic layer-1 report (US-007, `review-checks.ts`) with the AI
 * layer-2 issues into ONE ordered report. Deterministic findings always come
 * first within a severity; the AI supplements.
 */

import type { LintQuestion } from "./logic-lint";
import type { DeterministicReport, MetaCompleteness, ReviewSeverity } from "./review-checks";
import { normalizeMeta, normalizeOptions, normalizeProbe } from "./question-config";
import { normalizeOptionsFrom } from "./carry-forward";
import { describeLogic, type DescribeQuestion, type DisplayLogic, type QuestionType } from "./display-logic";

/** Question shape the review needs: the lint shape plus the stable quid. */
export type ReviewQuestion = LintQuestion & { quid: string };

export type AiReviewSeverity = "error" | "warning" | "suggestion";

export type AiReviewIssue = {
  severity: AiReviewSeverity;
  /** quid of the question the issue targets, or null for survey-level issues. */
  questionRef: string | null;
  issue: string;
  suggestion: string;
};

/** One row of the merged pre-publish report (deterministic or AI). */
export type ReviewReportItem = {
  source: "deterministic" | "ai";
  severity: ReviewSeverity | AiReviewSeverity;
  code: string;
  /** Stable question code source; null = survey-level finding. */
  quid: string | null;
  /** Prompt of the owning question (display context), null for survey-level. */
  prompt: string | null;
  message: string;
  /** AI-proposed fix (AI items only). */
  suggestion: string | null;
};

export type SurveyReviewReport = {
  items: ReviewReportItem[];
  metaCompleteness: MetaCompleteness;
  /** "failed" = the CLI errored; deterministic findings are still present. */
  aiStatus: "ok" | "failed";
  aiError: string | null;
};

/** Junk/runaway defenses on LLM output. */
export const MAX_AI_ISSUES = 20;
export const MAX_AI_TEXT_CHARS = 500;

const SEVERITY_ORDER: Record<ReviewReportItem["severity"], number> = {
  error: 0,
  warning: 1,
  suggestion: 2,
  info: 3,
};

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function questionLine(q: ReviewQuestion, i: number, all: ReviewQuestion[]): string {
  const parts: string[] = [`Q${i + 1} (quid: ${q.quid}) [${q.type}] "${q.prompt}"`];

  // Carry-forward: the static option list is NOT what respondents see — say so
  // explicitly or the model re-flags "전체 보기 고정" on already-fixed questions.
  const from = normalizeOptionsFrom((q.config as { optionsFrom?: unknown }).optionsFrom);
  if (from) {
    const srcIdx = all.findIndex((p) => p.id === from.questionId);
    parts.push(
      `  보기 가져오기: ${srcIdx >= 0 ? `Q${srcIdx + 1}` : "이전 문항"}에서 응답자가 선택한 항목만 보기로 표시됨 (동적 — 아래 정적 보기 목록은 무시됨, 원본 무응답 시 이 문항은 자동 건너뜀)`,
    );
  }

  const opts = normalizeOptions(q.config.options);
  if (opts.length > 0 && !from) {
    const labeled = opts.map((o) =>
      o.special === "none" ? `${o.label}[처음 고정]` : o.special === "other" ? `${o.label}[마지막 고정]` : o.label,
    );
    parts.push(`  보기: ${labeled.join(" | ")}`);
    if ((q.config as { randomizeOptions?: unknown }).randomizeOptions === true) {
      parts.push("  보기 순서: 응답자마다 무작위 (고정 표시 보기 제외) — 순서 편향 대응 이미 적용됨");
    }
  }

  const scale = q.config.scale as { min?: number; max?: number; minLabel?: string; maxLabel?: string } | undefined;
  if (q.type === "scale" && scale) {
    const anchors = [scale.minLabel, scale.maxLabel].filter(Boolean).join(" ↔ ");
    parts.push(`  척도: ${scale.min ?? 1} – ${scale.max ?? 5}${anchors ? ` (${anchors})` : ""}`);
  }
  if (q.type === "nps") parts.push("  척도: 0 – 10 (추천 의향)");
  if (q.type === "ranking" && typeof q.config.limit === "number" && q.config.limit > 0) {
    parts.push(`  순위 선택: 상위 ${q.config.limit}개`);
  }

  const logic = q.config.displayLogic as DisplayLogic | undefined;
  if (logic && Array.isArray(logic.conditions) && logic.conditions.length > 0) {
    const prior: DescribeQuestion[] = all.map((p) => ({
      id: p.id,
      type: p.type as QuestionType,
      prompt: p.prompt,
      config: { options: p.config.options },
    }));
    parts.push(`  표시 조건: ${describeLogic(logic, prior)}`);
  }

  const probe = normalizeProbe((q.config as { probe?: unknown }).probe);
  if (q.type === "open" && probe?.enabled) {
    parts.push(`  AI 심층 질문: 켜짐 (답변 후 AI가 이유를 파고드는 후속 질문 최대 ${probe.maxProbes}회 — 개방형 후속 탐침은 이미 존재)`);
  }

  const meta = normalizeMeta((q.config as { meta?: unknown }).meta);
  if (meta?.construct || meta?.topic) {
    const bits = [
      meta.construct ? `구성 개념 "${meta.construct}"` : null,
      meta.topic ? `주제 "${meta.topic}"` : null,
    ].filter(Boolean);
    parts.push(`  meta: ${bits.join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Builds the claude CLI prompt for the whole-survey AI review. The model must
 * reference questions by their quid so issues survive reordering/edits.
 */
export function buildReviewPrompt(input: {
  title: string;
  researchGoal: string;
  questions: ReviewQuestion[];
}): string {
  const questionBlock = input.questions.map((q, i) => questionLine(q, i, input.questions)).join("\n");

  return `You are a senior survey methodologist reviewing a survey before launch. Respond in Korean.

설문 제목: "${input.title}"
리서치 목표: "${input.researchGoal}"

== 문항 전체 ==
${questionBlock}

Review the WHOLE survey for quality issues a respondent-facing launch must not have:
- 유도 질문(leading): 특정 답을 전제하거나 암시하는 문구
- 이중 질문(double-barreled): 한 문항이 두 가지를 동시에 물음
- 보기 누락/비MECE: 선택지가 상호배타적이지 않거나 응답자가 고를 답이 없는 경우 (기타/해당 없음 부재 포함)
- 척도 문제: 라벨 불균형, 중립점 부재, 범위가 목표와 안 맞음
- 문항 순서: 앞 문항이 뒤 문항의 답을 편향시키는 배치, 민감한 질문의 위치
- 모호한 표현: 응답자마다 다르게 해석될 용어, 기준 없는 빈도/정도 표현
- 리서치 목표 대비 공백: 목표에 답하는 데 필요한데 빠진 측정 영역

Return ONLY a JSON object (no prose, no fences):
{
  "issues": [
    {
      "severity": "error" | "warning" | "suggestion",
      "questionRef": "<해당 문항의 quid, 설문 전체 이슈면 null>",
      "issue": "<무엇이 문제인지 한두 문장>",
      "suggestion": "<구체적 수정 제안 한두 문장>"
    }
  ]
}

이 플랫폼이 지원하는 구조 기능 (제안은 이 안에서 실행 가능하게 쓸 것):
- 문항 표시 조건: 앞 문항의 답에 따라 문항을 보이거나 숨김 (위 "표시 조건"으로 표기)
- 보기 가져오기(carry-forward): 앞 문항에서 선택한 항목만 보기로 노출 (위 "보기 가져오기"로 표기)
- 보기 무작위 표시 + 기타/없음 고정, 주관식 AI 후속 질문(프로빙)

Rules:
- 위에 이미 표기된 설정(표시 조건, 보기 가져오기, 무작위, AI 심층 질문)을 다시 제안하거나 그 부재를 지적하지 말 것 — 표기가 곧 현재 상태다.
- 표시 조건을 평가할 때는 반드시 위 "표시 조건" 문장을 근거로 할 것. 조건이 표기되지 않은 문항은 모든 응답자에게 보인다.
- severity 기준: error = 응답을 왜곡하거나 답할 수 없게 만드는 문제, warning = 데이터 품질을 떨어뜨리는 문제, suggestion = 개선 여지.
- questionRef는 반드시 위 목록의 quid 문자열 그대로. 설문 수준(순서/공백) 이슈만 null.
- 실제 문제만 보고할 것 — 억지 이슈 금지. 문제없는 설문이면 "issues": [].
- 이슈는 최대 ${MAX_AI_ISSUES}개, 심각한 것부터.`;
}

// ---------------------------------------------------------------------------
// Parsing (fail-safe: junk input degrades to fewer/no issues, never throws)
// ---------------------------------------------------------------------------

/**
 * Parse the LLM's JSON output into validated issues. Items with a blank issue
 * text are dropped; unknown severities degrade to "suggestion"; a questionRef
 * that is not a real quid of this survey becomes null (survey-level) rather
 * than pointing the UI at a non-existent question.
 */
export function parseAiReviewIssues(raw: unknown, validQuids: Set<string>): AiReviewIssue[] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const list = (raw as { issues?: unknown }).issues;
  if (!Array.isArray(list)) return [];

  const out: AiReviewIssue[] = [];
  for (const item of list) {
    if (out.length >= MAX_AI_ISSUES) break;
    if (item == null || typeof item !== "object") continue;
    const o = item as { severity?: unknown; questionRef?: unknown; issue?: unknown; suggestion?: unknown };

    const issue = typeof o.issue === "string" ? o.issue.trim().slice(0, MAX_AI_TEXT_CHARS) : "";
    if (!issue) continue;

    const severity: AiReviewSeverity =
      o.severity === "error" || o.severity === "warning" || o.severity === "suggestion"
        ? o.severity
        : "suggestion";

    const ref = typeof o.questionRef === "string" ? o.questionRef.trim() : null;
    const questionRef = ref && validQuids.has(ref) ? ref : null;

    const suggestion =
      typeof o.suggestion === "string" ? o.suggestion.trim().slice(0, MAX_AI_TEXT_CHARS) : "";

    out.push({ severity, questionRef, issue, suggestion });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Merges the deterministic report (layer 1) with the AI issues (layer 2).
 * Ordering: severity (error → warning → suggestion → info); within a severity
 * deterministic items come first (they are proofs, the AI supplements), then
 * question order, survey-level items last.
 */
export function mergeReviewReport(
  questions: ReviewQuestion[],
  deterministic: DeterministicReport,
  aiIssues: AiReviewIssue[],
  aiStatus: "ok" | "failed",
  aiError: string | null = null,
): SurveyReviewReport {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const byQuid = new Map(questions.map((q) => [q.quid, q]));

  const items: ReviewReportItem[] = [];
  for (const d of deterministic.items) {
    const q = d.questionId ? byId.get(d.questionId) : undefined;
    items.push({
      source: "deterministic",
      severity: d.severity,
      code: d.code,
      quid: q?.quid ?? null,
      prompt: q?.prompt ?? null,
      message: d.message,
      suggestion: null,
    });
  }
  for (const a of aiIssues) {
    const q = a.questionRef ? byQuid.get(a.questionRef) : undefined;
    items.push({
      source: "ai",
      severity: a.severity,
      code: "ai_review",
      quid: q?.quid ?? null,
      prompt: q?.prompt ?? null,
      message: a.issue,
      suggestion: a.suggestion || null,
    });
  }

  const orderOf = new Map(questions.map((q) => [q.quid, q.order]));
  items.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    if (a.source !== b.source) return a.source === "deterministic" ? -1 : 1;
    const ao = a.quid ? (orderOf.get(a.quid) ?? Infinity) : Infinity;
    const bo = b.quid ? (orderOf.get(b.quid) ?? Infinity) : Infinity;
    return ao - bo;
  });

  return { items, metaCompleteness: deterministic.metaCompleteness, aiStatus, aiError };
}
