import { describe, expect, it } from "vitest";
import { lintDisplayLogic, lintQuestionStructure, type LintQuestion } from "./logic-lint";
import type { DisplayLogic } from "./display-logic";

let seq = 0;
function q(over: Partial<LintQuestion> & { id: string }): LintQuestion {
  return {
    order: seq++,
    type: "single",
    prompt: `문항 ${over.id}`,
    config: { options: ["A", "B"] },
    ...over,
    id: over.id,
  } as LintQuestion;
}

function logic(match: "all" | "any", conditions: DisplayLogic["conditions"]): DisplayLogic {
  return { match, conditions };
}

function codesFor(warnings: ReturnType<typeof lintDisplayLogic>, id: string): string[] {
  return warnings.filter((w) => w.questionId === id).map((w) => w.code);
}

describe("lintDisplayLogic — contradiction (unsatisfiable all-match)", () => {
  it("flags all-match with two different eq values on the same question", () => {
    const q1 = q({ id: "q1" });
    const q2 = q({
      id: "q2",
      config: {
        options: ["X", "Y"],
        displayLogic: logic("all", [
          { questionId: "q1", op: "eq", value: "A" },
          { questionId: "q1", op: "eq", value: "B" },
        ]),
      },
    });
    expect(codesFor(lintDisplayLogic([q1, q2]), "q2")).toContain("unreachable");
  });

  it("flags eq v together with ne v", () => {
    const q1 = q({ id: "q1" });
    const q2 = q({
      id: "q2",
      config: {
        displayLogic: logic("all", [
          { questionId: "q1", op: "eq", value: "A" },
          { questionId: "q1", op: "ne", value: "A" },
        ]),
      },
    });
    expect(codesFor(lintDisplayLogic([q1, q2]), "q2")).toContain("unreachable");
  });

  it("flags an empty numeric interval (gte 4 AND lte 2)", () => {
    const q1 = q({ id: "q1", type: "scale", config: {} });
    const q2 = q({
      id: "q2",
      config: {
        displayLogic: logic("all", [
          { questionId: "q1", op: "gte", value: 4 },
          { questionId: "q1", op: "lte", value: 2 },
        ]),
      },
    });
    expect(codesFor(lintDisplayLogic([q1, q2]), "q2")).toContain("unreachable");
  });

  it("does NOT flag the same conditions under any-match (OR)", () => {
    const q1 = q({ id: "q1" });
    const q2 = q({
      id: "q2",
      config: {
        options: ["X", "Y"],
        displayLogic: logic("any", [
          { questionId: "q1", op: "eq", value: "A" },
          { questionId: "q1", op: "eq", value: "B" },
        ]),
      },
    });
    expect(codesFor(lintDisplayLogic([q1, q2]), "q2")).not.toContain("unreachable");
  });

  it("propagates unreachability transitively (all-match on a dead question)", () => {
    const q1 = q({ id: "q1" });
    const q2 = q({
      id: "q2",
      config: {
        displayLogic: logic("all", [
          { questionId: "q1", op: "eq", value: "A" },
          { questionId: "q1", op: "eq", value: "B" },
        ]),
      },
    });
    const q3 = q({
      id: "q3",
      config: { displayLogic: logic("all", [{ questionId: "q2", op: "eq", value: "X" }]) },
    });
    const warnings = lintDisplayLogic([q1, q2, q3]);
    expect(codesFor(warnings, "q2")).toContain("unreachable");
    expect(codesFor(warnings, "q3")).toContain("unreachable");
  });
});

describe("lintQuestionStructure", () => {
  it("flags empty option labels as error", () => {
    const bad = q({ id: "q1", config: { options: ["A", "  ", "B"] } });
    const w = lintQuestionStructure([bad]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ questionId: "q1", severity: "error", code: "empty_option_label" });
  });

  it("flags duplicate option labels as warning (trim-insensitive)", () => {
    const bad = q({ id: "q1", config: { options: ["서울", "부산", " 서울 "] } });
    const w = lintQuestionStructure([bad]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ questionId: "q1", severity: "warning", code: "duplicate_option_label" });
    expect(w[0].message).toContain("서울");
  });

  it("flags ranking limit greater than the option count", () => {
    const bad = q({ id: "q1", type: "ranking", config: { options: ["A", "B", "C"], limit: 5 } });
    const w = lintQuestionStructure([bad]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ questionId: "q1", severity: "error", code: "ranking_limit_over" });
  });

  it("accepts ranking limit equal to the option count", () => {
    const ok = q({ id: "q1", type: "ranking", config: { options: ["A", "B", "C"], limit: 3 } });
    expect(lintQuestionStructure([ok])).toHaveLength(0);
  });

  it("flags choice questions with fewer than 2 options", () => {
    const bad = q({ id: "q1", config: { options: ["A"] } });
    const w = lintQuestionStructure([bad]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ questionId: "q1", severity: "error", code: "too_few_options" });
  });

  it("ignores non-choice questions entirely", () => {
    const open = q({ id: "q1", type: "open", config: {} });
    const scale = q({ id: "q2", type: "scale", config: {} });
    expect(lintQuestionStructure([open, scale])).toHaveLength(0);
  });

  it("flags a matrix without rows/columns as errors (US-006 contract audit)", () => {
    const bad = q({ id: "q1", type: "matrix", config: {} });
    const codes = lintQuestionStructure([bad]).map((w) => w.code);
    expect(codes).toContain("matrix_missing_rows");
    expect(codes).toContain("matrix_missing_columns");
  });

  it("accepts a matrix with rows and columns", () => {
    const ok = q({
      id: "q1",
      type: "matrix",
      config: { rows: ["속도", "가격"], columns: ["불만", "보통", "만족"] },
    });
    expect(lintQuestionStructure([ok])).toHaveLength(0);
  });
});
