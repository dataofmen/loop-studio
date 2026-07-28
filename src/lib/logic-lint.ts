/**
 * Display-logic linter: validates every question's `config.displayLogic` from
 * the whole-survey perspective, surfacing broken or meaningless conditions.
 *
 * Pure (no DB / server imports) so warnings compute identically on the client
 * (editor, live as the author edits) and the server. Complements the pure
 * evaluator in `display-logic.ts`.
 */

import type { DisplayLogic, DisplayCondition, QuestionType } from "./display-logic";
import { showIfToDisplayLogic } from "./display-logic";
import { normalizeOptionsFrom } from "./carry-forward";
import type { RevisionQuestion } from "./question-diff";
import { optionLabels, type ConfigOption } from "./question-config";

/** Minimal question shape the linter needs. */
export type LintQuestion = {
  id: string;
  order: number;
  type: QuestionType | string;
  prompt: string;
  config: {
    options?: ConfigOption[];
    displayLogic?: DisplayLogic;
    limit?: number;
  } & Record<string, unknown>;
};

export type LintCode =
  | "missing_ref"
  | "forward_ref"
  | "unreachable"
  | "value_not_in_options"
  // structural codes (lintQuestionStructure — pre-publish review layer)
  | "empty_option_label"
  | "duplicate_option_label"
  | "ranking_limit_over"
  | "too_few_options"
  | "matrix_missing_rows"
  | "matrix_missing_columns"
  // carry-forward ("보기 가져오기") structural codes
  | "carry_missing_ref"
  | "carry_forward_ref"
  | "carry_source_not_choice";

export type LintWarning = {
  questionId: string;
  severity: "error" | "warning";
  code: LintCode;
  message: string;
};

function isChoice(type: string): boolean {
  return type === "single" || type === "multi" || type === "ranking";
}

/** Values a condition compares against, always as a string array. */
function condValues(c: DisplayCondition): string[] {
  return Array.isArray(c.value) ? c.value.map(String) : [String(c.value)];
}

/**
 * Whether an AND-group of conditions on ONE referenced question is mutually
 * exclusive (no single answer can satisfy them all):
 * - two `eq` conditions with different values,
 * - `eq v` together with `ne v`,
 * - `eq v` outside an `in` set, or inside a `not_in` set,
 * - numeric bounds (gte/gt/lte/lt) whose interval is empty, or an `eq` value
 *   falling outside that interval.
 */
function refConditionsContradict(conds: DisplayCondition[]): boolean {
  const eqValues = new Set<string>();
  for (const c of conds) if (c.op === "eq") eqValues.add(String(c.value));
  if (eqValues.size > 1) return true; // eq to two different values under AND

  for (const c of conds) {
    if (c.op === "ne" && eqValues.has(String(c.value))) return true;
    if (c.op === "in" && Array.isArray(c.value) && eqValues.size > 0) {
      const set = c.value.map(String);
      for (const v of eqValues) if (!set.includes(v)) return true;
    }
    if (c.op === "not_in" && Array.isArray(c.value)) {
      const set = c.value.map(String);
      for (const v of eqValues) if (set.includes(v)) return true;
    }
  }

  // Numeric bounds: intersect all gte/gt (lower) and lte/lt (upper) bounds.
  let lo = -Infinity;
  let loStrict = false;
  let hi = Infinity;
  let hiStrict = false;
  for (const c of conds) {
    const num = typeof c.value === "number" ? c.value : Number(String(c.value));
    if (!Number.isFinite(num)) continue; // non-numeric compare — not our call here
    if (c.op === "gte" || c.op === "gt") {
      const strict = c.op === "gt";
      if (num > lo || (num === lo && strict && !loStrict)) { lo = num; loStrict = strict; }
    }
    if (c.op === "lte" || c.op === "lt") {
      const strict = c.op === "lt";
      if (num < hi || (num === hi && strict && !hiStrict)) { hi = num; hiStrict = strict; }
    }
  }
  if (lo > hi || (lo === hi && (loStrict || hiStrict))) return true;
  if (eqValues.size === 1) {
    const v = Number([...eqValues][0]);
    if (Number.isFinite(v)) {
      if (v < lo || v > hi) return true;
      if ((v === lo && loStrict) || (v === hi && hiStrict)) return true;
    }
  }
  return false;
}

/**
 * Whether `logic` can never be satisfied *on its own* (ignoring transitive
 * reachability of referenced questions):
 * - match='all' with a set operator (in/not_in) whose value array is empty, or
 * - match='all' with mutually exclusive conditions on the same reference
 *   (see refConditionsContradict).
 */
function directlyUnreachable(logic: DisplayLogic): boolean {
  if (logic.match !== "all") return false;

  const emptySet = logic.conditions.some(
    (c) => (c.op === "in" || c.op === "not_in") && Array.isArray(c.value) && c.value.length === 0,
  );
  if (emptySet) return true;

  const byRef = new Map<string, DisplayCondition[]>();
  for (const c of logic.conditions) {
    const group = byRef.get(c.questionId) ?? [];
    group.push(c);
    byRef.set(c.questionId, group);
  }
  for (const group of byRef.values()) {
    if (group.length > 1 && refConditionsContradict(group)) return true;
  }
  return false;
}

/**
 * Computes which questions are unreachable, propagating transitively:
 * - A question is unreachable if its logic is directly unreachable, OR
 * - match='all': ANY referenced question is unreachable (that AND-clause dies), OR
 * - match='any': ALL referenced questions are unreachable (no OR-clause can fire).
 * Iterates to a fixpoint.
 */
function computeUnreachable(questions: LintQuestion[]): Set<string> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const unreachable = new Set<string>();

  for (const q of questions) {
    const logic = q.config.displayLogic;
    if (logic && logic.conditions.length > 0 && directlyUnreachable(logic)) {
      unreachable.add(q.id);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const q of questions) {
      if (unreachable.has(q.id)) continue;
      const logic = q.config.displayLogic;
      if (!logic || logic.conditions.length === 0) continue;

      // Only consider references that actually resolve (missing refs are a
      // separate error and shouldn't drive transitivity).
      const refStates = logic.conditions
        .map((c) => byId.get(c.questionId))
        .filter((ref): ref is LintQuestion => !!ref)
        .map((ref) => unreachable.has(ref.id));
      if (refStates.length === 0) continue;

      const dead =
        logic.match === "all" ? refStates.some(Boolean) : refStates.every(Boolean);
      if (dead) {
        unreachable.add(q.id);
        changed = true;
      }
    }
  }
  return unreachable;
}

/**
 * Lints all questions' display logic and returns warnings (empty = clean).
 * Order-independent; each warning is tied to the owning question.
 */
export function lintDisplayLogic(questions: LintQuestion[]): LintWarning[] {
  const warnings: LintWarning[] = [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const unreachable = computeUnreachable(questions);

  for (const q of questions) {
    // ── carry-forward ("보기 가져오기") structural checks ──
    const from = normalizeOptionsFrom(q.config.optionsFrom);
    if (from) {
      const src = byId.get(from.questionId);
      if (!src) {
        warnings.push({
          questionId: q.id,
          severity: "error",
          code: "carry_missing_ref",
          message: "보기를 가져올 원본 문항이 삭제되었거나 존재하지 않습니다. 다시 지정하세요.",
        });
      } else if (src.order >= q.order) {
        warnings.push({
          questionId: q.id,
          severity: "error",
          code: "carry_forward_ref",
          message: `보기를 뒤 문항("${src.prompt.slice(0, 20)}")에서 가져옵니다. 앞 문항만 참조할 수 있습니다.`,
        });
      } else if (!isChoice(src.type)) {
        warnings.push({
          questionId: q.id,
          severity: "error",
          code: "carry_source_not_choice",
          message: "보기를 가져올 원본은 선택형(단일/복수/순위) 문항이어야 합니다.",
        });
      }
    }

    const logic = q.config.displayLogic;
    if (!logic || !Array.isArray(logic.conditions) || logic.conditions.length === 0) continue;

    for (const c of logic.conditions) {
      const ref = byId.get(c.questionId);

      // missing_ref (error)
      if (!ref) {
        warnings.push({
          questionId: q.id,
          severity: "error",
          code: "missing_ref",
          message: "참조하는 문항이 삭제되었거나 존재하지 않습니다. 조건을 제거하거나 다시 지정하세요.",
        });
        continue;
      }

      // forward_ref (error): reference must be an EARLIER question
      if (ref.order >= q.order) {
        warnings.push({
          questionId: q.id,
          severity: "error",
          code: "forward_ref",
          message: `조건이 뒤 문항("${ref.prompt.slice(0, 20)}")을 참조합니다. 앞 문항만 참조할 수 있습니다.`,
        });
      }

      // value_not_in_options (warning): choice ref, value(s) not among its options.
      // Skip when the referenced question carries forward its options — the
      // effective option set is dynamic (a respondent's earlier selections).
      const refCarries = Boolean(normalizeOptionsFrom(ref.config.optionsFrom));
      if (!refCarries && isChoice(ref.type) && c.op !== "gte" && c.op !== "lte" && c.op !== "gt" && c.op !== "lt") {
        const options = optionLabels(ref.config.options);
        const missing = condValues(c).filter((v) => v !== "" && !options.includes(v));
        if (missing.length > 0) {
          warnings.push({
            questionId: q.id,
            severity: "warning",
            code: "value_not_in_options",
            message: `조건 값 [${missing.join(", ")}]이(가) 참조 문항의 선택지에 없어 절대 충족되지 않습니다.`,
          });
        }
      }
    }

    // unreachable (warning): whole question can never be shown
    if (unreachable.has(q.id)) {
      warnings.push({
        questionId: q.id,
        severity: "warning",
        code: "unreachable",
        message: "이 문항의 표시 조건은 어떤 응답으로도 충족될 수 없어 항상 숨겨집니다.",
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Structural lint (pre-publish review layer, US-007). Separate from
// lintDisplayLogic so the display-logic editor UI keeps its logic-only
// warnings; the pre-publish report (review-checks.ts) merges both.
// ---------------------------------------------------------------------------

function hasOptions(type: string): boolean {
  return type === "single" || type === "multi" || type === "ranking";
}

/**
 * Lints option/config structure of every question (no display-logic concerns):
 * - empty option labels (error) — a blank choice can't be answered meaningfully,
 * - duplicate option labels (warning) — answers are stored label-based, so
 *   duplicates collapse into one bucket in analysis,
 * - ranking `limit` greater than the number of options (error),
 * - choice questions with fewer than 2 options (error).
 */
export function lintQuestionStructure(questions: LintQuestion[]): LintWarning[] {
  const warnings: LintWarning[] = [];

  for (const q of questions) {
    // Matrix structure (US-006 contract audit): without rows the respond form
    // deadlocks (it requires EVERY row answered — zero rows never satisfies),
    // and without columns there is nothing to pick.
    if (q.type === "matrix") {
      const rows = Array.isArray(q.config.rows) ? q.config.rows : [];
      const cols = Array.isArray(q.config.columns) ? q.config.columns : [];
      if (rows.length === 0) {
        warnings.push({
          questionId: q.id,
          severity: "error",
          code: "matrix_missing_rows",
          message: "행렬 문항에 행(평가 항목)이 없습니다. 최소 1개가 필요합니다.",
        });
      }
      if (cols.length === 0) {
        warnings.push({
          questionId: q.id,
          severity: "error",
          code: "matrix_missing_columns",
          message: "행렬 문항에 열(응답 선택지)이 없습니다. 최소 1개가 필요합니다.",
        });
      }
    }
    if (!hasOptions(q.type)) continue;
    // Carry-forward questions have NO static options by design — their option
    // set is the respondent's earlier selections, so every static-option rule
    // below would false-positive. Source validity is checked by the
    // carry_* rules in lintDisplayLogic.
    if (normalizeOptionsFrom(q.config.optionsFrom)) continue;
    const labels = optionLabels(q.config.options);

    if (labels.length < 2) {
      warnings.push({
        questionId: q.id,
        severity: "error",
        code: "too_few_options",
        // Zero options usually means a carry-forward question whose source
        // link was never set (or was lost) — say so, or the finding is opaque.
        message:
          labels.length === 0
            ? "선택형 문항에 보기가 없습니다. 보기를 추가하거나, '위에서 선택하신 것 중…'처럼 앞 문항의 선택을 이어받는 문항이라면 편집기에서 '보기 가져오기'를 설정하세요."
            : `선택형 문항의 보기가 ${labels.length}개입니다. 최소 2개가 필요합니다.`,
      });
    }

    const emptyCount = labels.filter((l) => l.trim() === "").length;
    if (emptyCount > 0) {
      warnings.push({
        questionId: q.id,
        severity: "error",
        code: "empty_option_label",
        message: `빈 보기 라벨이 ${emptyCount}개 있습니다. 라벨을 채우거나 보기를 삭제하세요.`,
      });
    }

    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const l of labels) {
      const t = l.trim();
      if (!t) continue;
      if (seen.has(t)) dups.add(t);
      seen.add(t);
    }
    if (dups.size > 0) {
      warnings.push({
        questionId: q.id,
        severity: "warning",
        code: "duplicate_option_label",
        message: `중복된 보기 라벨이 있습니다: ${[...dups].join(", ")}. 응답 집계 시 하나로 합쳐집니다.`,
      });
    }

    if (q.type === "ranking") {
      const limit = typeof q.config.limit === "number" ? q.config.limit : 0;
      if (limit > labels.length) {
        warnings.push({
          questionId: q.id,
          severity: "error",
          code: "ranking_limit_over",
          message: `순위 선택 개수(${limit})가 보기 수(${labels.length})보다 큽니다.`,
        });
      }
    }
  }

  return warnings;
}

// ── Proposal linting (US-008 follow-up) ─────────────────────────────────────

/**
 * Lint an AI proposal BEFORE it is applied: resolves each question's ref-form
 * `showIf` against the proposal's own ordering (synthetic ids = 1-based index)
 * and runs the standard display-logic linter over the result. Catches the
 * classic LLM slip — renaming/splitting an option without updating conditions
 * that referenced the old label — deterministically.
 *
 * Kept questions' stored `config.displayLogic` (live row ids) is intentionally
 * NOT linted here: those ids don't exist in the proposal and would flag false
 * missing_refs; the editor lints them after apply.
 */
export function lintProposal(proposed: RevisionQuestion[]): LintWarning[] {
  const qs: LintQuestion[] = proposed.map((q, i) => ({
    id: String(i + 1),
    order: i,
    type: q.type,
    prompt: q.prompt,
    config: {
      options: q.config.options,
      displayLogic: q.showIf
        ? showIfToDisplayLogic(
            q.showIf,
            (ref) => (ref >= 1 && ref <= proposed.length ? String(ref) : undefined),
            i + 1,
          )
        : undefined,
      optionsFrom:
        q.optionsFromRef && q.optionsFromRef.ref >= 1 && q.optionsFromRef.ref <= proposed.length
          ? { questionId: String(q.optionsFromRef.ref), mode: "selected" as const }
          : undefined,
    },
  }));
  return lintDisplayLogic(qs);
}
