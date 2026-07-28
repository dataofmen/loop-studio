/**
 * Path testing for display logic (pre-publish review layer, US-007).
 *
 * Explores virtual respondent answer combinations with the SAME evaluator the
 * respondent form uses (`questionVisible`), and reports questions that no
 * combination can ever reveal. Strictly stronger than the linter's static
 * `unreachable` rule: it catches cross-question impossibilities, e.g.
 * "Q3 shows when Q1=A and Q2=X, but Q2 itself only shows when Q1=B".
 *
 * Candidate answers per referenced question:
 * - choice (single/multi/ranking): every option label, exhaustively,
 * - scale/nps: the boundary values plus any values conditions compare against,
 * - open/matrix: the values conditions compare against (+ a sentinel for open),
 * - plus "unanswered" for every question (a hidden dependency is unanswered).
 *
 * A combination is consistent only when every answered dependency is itself
 * visible under the earlier answers (evaluated in question order). When the
 * combination space exceeds `maxCombos` the question is skipped rather than
 * guessed at — this module never reports a false positive.
 *
 * PURE MODULE — no DB / IO (same contract as logic-lint.ts / display-logic.ts).
 */

import {
  questionVisible,
  sanitizeDisplayLogic,
  type DisplayCondition,
  type DisplayLogic,
} from "./display-logic";
import { optionLabels } from "./question-config";
import type { LintQuestion } from "./logic-lint";

export type PathTestIssue = {
  questionId: string;
  code: "unreachable_path";
  message: string;
};

/** Combination-space cap per target question; beyond it we skip, not guess. */
export const MAX_PATH_COMBOS = 20000;

type AnswerCandidate =
  | string
  | number
  | string[]
  | Record<string, string>
  | undefined;

/** All condition values (as strings) that any question's logic compares `refId` against. */
function referencedValues(questions: LintQuestion[], refId: string): string[] {
  const out: string[] = [];
  for (const q of questions) {
    const logic = sanitizeDisplayLogic(q.config.displayLogic);
    if (!logic) continue;
    for (const c of logic.conditions) {
      if (c.questionId !== refId) continue;
      if (Array.isArray(c.value)) out.push(...c.value.map(String));
      else out.push(String(c.value));
    }
  }
  return [...new Set(out)];
}

/** Candidate answers a virtual respondent may give to `q` (undefined = skipped/hidden). */
function candidateAnswers(q: LintQuestion, questions: LintQuestion[]): AnswerCandidate[] {
  const candidates: AnswerCandidate[] = [undefined];

  if (q.type === "single") {
    candidates.push(...optionLabels(q.config.options));
  } else if (q.type === "multi" || q.type === "ranking") {
    // One selection per option covers eq/in/contains/not_in on any single label.
    candidates.push(...optionLabels(q.config.options).map((l) => [l]));
  } else if (q.type === "scale" || q.type === "nps") {
    const scale = (q.config as { scale?: { min?: number; max?: number } }).scale;
    const min = q.type === "nps" ? 0 : (scale?.min ?? 1);
    const max = q.type === "nps" ? 10 : (scale?.max ?? 5);
    const values = new Set<number>([min, max]);
    // Boundaries alone would miss `eq 3` on a 1–5 scale — add compared values.
    for (const v of referencedValues(questions, q.id)) {
      const num = Math.round(Number(v));
      if (Number.isFinite(num) && num >= min && num <= max) values.add(num);
    }
    candidates.push(...values);
  } else if (q.type === "open") {
    const values = referencedValues(questions, q.id);
    candidates.push(...values);
    // A free-text answer can always differ from every compared value (ne/not_in).
    candidates.push("__path_test_other__");
  } else if (q.type === "matrix") {
    const rows = (q.config as { rows?: string[] }).rows ?? [];
    const columns = (q.config as { columns?: string[] }).columns ?? [];
    const row = rows[0] ?? "row";
    candidates.push(...columns.map((c) => ({ [row]: c })));
  }

  return candidates;
}

/** Transitive closure of questions the target's visibility depends on, in question order. */
function dependencyClosure(
  target: LintQuestion,
  byId: Map<string, LintQuestion>,
): LintQuestion[] {
  const seen = new Set<string>([target.id]); // never assign the target its own answer
  const deps: LintQuestion[] = [];
  const queue: DisplayCondition[] = [
    ...(sanitizeDisplayLogic(target.config.displayLogic)?.conditions ?? []),
  ];
  while (queue.length > 0) {
    const cond = queue.shift()!;
    if (seen.has(cond.questionId)) continue;
    seen.add(cond.questionId);
    const ref = byId.get(cond.questionId);
    if (!ref) continue; // missing_ref — reported by the linter, not here
    deps.push(ref);
    queue.push(...(sanitizeDisplayLogic(ref.config.displayLogic)?.conditions ?? []));
  }
  return deps.sort((a, b) => a.order - b.order);
}

/** Whether any consistent answer combination over `deps` makes `logic` true. */
function anyCombinationVisible(
  logic: DisplayLogic,
  deps: LintQuestion[],
  candidatesByDep: AnswerCandidate[][],
): boolean {
  // Mixed-radix enumeration over the candidate lists.
  const radices = candidatesByDep.map((c) => c.length);
  const digits = new Array(deps.length).fill(0);
  const total = radices.reduce((a, b) => a * b, 1);

  for (let i = 0; i < total; i++) {
    const answers: Record<string, AnswerCandidate> = {};
    let consistent = true;
    for (let d = 0; d < deps.length; d++) {
      const dep = deps[d];
      const value = candidatesByDep[d][digits[d]];
      const visible = questionVisible(
        sanitizeDisplayLogic(dep.config.displayLogic),
        answers,
      );
      if (!visible && value !== undefined) {
        consistent = false; // a hidden question cannot carry an answer
        break;
      }
      if (value !== undefined) answers[dep.id] = value;
    }
    if (consistent && questionVisible(logic, answers)) return true;

    // increment mixed-radix counter
    for (let d = deps.length - 1; d >= 0; d--) {
      digits[d]++;
      if (digits[d] < radices[d]) break;
      digits[d] = 0;
    }
  }
  return false;
}

/**
 * Questions with display logic that NO consistent virtual-respondent answer
 * combination can reveal. Questions whose logic references missing questions
 * are skipped (the linter's missing_ref error already covers them), as are
 * questions whose combination space exceeds `maxCombos`.
 */
export function pathTestUnreachable(
  questions: LintQuestion[],
  maxCombos: number = MAX_PATH_COMBOS,
): PathTestIssue[] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const issues: PathTestIssue[] = [];

  for (const q of questions) {
    const logic = sanitizeDisplayLogic(q.config.displayLogic);
    if (!logic) continue;

    // Missing refs are a different (already-linted) problem; don't double-report.
    if (logic.conditions.some((c) => c.questionId !== q.id && !byId.has(c.questionId))) continue;

    const deps = dependencyClosure(q, byId);
    const candidatesByDep = deps.map((dep) => candidateAnswers(dep, questions));
    const total = candidatesByDep.reduce((acc, c) => acc * c.length, 1);
    if (total > maxCombos) continue; // too big to enumerate — never guess

    if (!anyCombinationVisible(logic, deps, candidatesByDep)) {
      issues.push({
        questionId: q.id,
        code: "unreachable_path",
        message:
          "가능한 모든 응답 조합을 탐색해도 이 문항이 표시되는 경로가 없습니다. 표시 조건(앞 문항들의 조건 연쇄 포함)을 확인하세요.",
      });
    }
  }

  return issues;
}
