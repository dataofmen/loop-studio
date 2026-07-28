/**
 * Pre-publish deterministic review (US-007, layer 1 of the pre-publish check).
 *
 * Merges every deterministic (non-LLM) survey check into ONE report:
 * - display-logic lint (`lintDisplayLogic`) — broken refs, contradictions,
 *   statically unreachable questions,
 * - structural lint (`lintQuestionStructure`) — option labels, ranking limit,
 * - path testing (`pathTestUnreachable`) — exhaustive virtual-respondent
 *   combination search for questions no answer path can ever reveal,
 * - completeness — empty prompts and metadata blank rate (construct/topic).
 *
 * PURE MODULE (no DB / IO) so US-008 can run it on the server next to the AI
 * review, and tests can drive it with plain fixtures. The AI layer (US-008)
 * merges its own issues AFTER these — deterministic findings come first.
 */

import {
  lintDisplayLogic,
  lintQuestionStructure,
  type LintQuestion,
} from "./logic-lint";
import { pathTestUnreachable } from "./path-test";
import { normalizeMeta } from "./question-config";

export type ReviewSeverity = "error" | "warning" | "info";

export type ReviewCheckItem = {
  /** Owning question id, or null for survey-level findings. */
  questionId: string | null;
  severity: ReviewSeverity;
  code: string;
  message: string;
};

export type MetaCompleteness = {
  total: number;
  withConstruct: number;
  withTopic: number;
  /** Share (0..1) of questions with no construct metadata. */
  blankRate: number;
};

export type DeterministicReport = {
  items: ReviewCheckItem[];
  metaCompleteness: MetaCompleteness;
};

const SEVERITY_RANK: Record<ReviewSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Metadata coverage over the survey's questions (construct is the loop's key field). */
export function computeMetaCompleteness(questions: LintQuestion[]): MetaCompleteness {
  let withConstruct = 0;
  let withTopic = 0;
  for (const q of questions) {
    const meta = normalizeMeta((q.config as { meta?: unknown }).meta);
    if (meta?.construct) withConstruct++;
    if (meta?.topic) withTopic++;
  }
  const total = questions.length;
  return {
    total,
    withConstruct,
    withTopic,
    blankRate: total === 0 ? 0 : (total - withConstruct) / total,
  };
}

/**
 * Runs every deterministic check and returns one merged, ordered report.
 * Ordering: severity (error → warning → info), then question order, survey-level
 * items last within their severity. When the path test proves a question
 * unreachable, the linter's weaker static `unreachable` warning for the same
 * question is dropped (same finding, stronger evidence).
 */
export function runDeterministicChecks(questions: LintQuestion[]): DeterministicReport {
  const items: ReviewCheckItem[] = [];

  const pathIssues = pathTestUnreachable(questions);
  const pathFlagged = new Set(pathIssues.map((i) => i.questionId));

  for (const w of lintDisplayLogic(questions)) {
    if (w.code === "unreachable" && pathFlagged.has(w.questionId)) continue;
    items.push({ questionId: w.questionId, severity: w.severity, code: w.code, message: w.message });
  }
  for (const w of lintQuestionStructure(questions)) {
    items.push({ questionId: w.questionId, severity: w.severity, code: w.code, message: w.message });
  }
  for (const i of pathIssues) {
    items.push({ questionId: i.questionId, severity: "warning", code: i.code, message: i.message });
  }

  // Completeness: empty prompts are answerable-but-meaningless — flag as error.
  for (const q of questions) {
    if (q.prompt.trim() === "") {
      items.push({
        questionId: q.id,
        severity: "error",
        code: "empty_prompt",
        message: "문항 내용이 비어 있습니다. 질문 문구를 입력하세요.",
      });
    }
  }

  const metaCompleteness = computeMetaCompleteness(questions);
  if (metaCompleteness.total > 0 && metaCompleteness.blankRate > 0) {
    const missing = metaCompleteness.total - metaCompleteness.withConstruct;
    items.push({
      questionId: null,
      severity: "info",
      code: "meta_gap",
      message: `${metaCompleteness.total}개 문항 중 ${missing}개에 개념(construct) 메타데이터가 없습니다. 개념을 지정하면 설문 간 결과 누적·보정 이월이 가능해집니다.`,
    });
  }

  const orderOf = new Map(questions.map((q) => [q.id, q.order]));
  items.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const ao = a.questionId ? (orderOf.get(a.questionId) ?? Infinity) : Infinity;
    const bo = b.questionId ? (orderOf.get(b.questionId) ?? Infinity) : Infinity;
    return ao - bo;
  });

  return { items, metaCompleteness };
}
