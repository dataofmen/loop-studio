import { describe, expect, it } from "vitest";
import { computeMetaCompleteness, runDeterministicChecks } from "./review-checks";
import type { LintQuestion } from "./logic-lint";
import type { DisplayLogic } from "./display-logic";

function q(over: Partial<LintQuestion> & { id: string; order: number }): LintQuestion {
  return {
    type: "single",
    prompt: `문항 ${over.id}`,
    config: { options: ["A", "B"] },
    ...over,
  } as LintQuestion;
}

function logic(match: "all" | "any", conditions: DisplayLogic["conditions"]): DisplayLogic {
  return { match, conditions };
}

describe("computeMetaCompleteness", () => {
  it("counts construct/topic coverage and blank rate", () => {
    const questions = [
      q({ id: "q1", order: 0, config: { options: ["A", "B"], meta: { construct: "만족도", topic: "배달" } } }),
      q({ id: "q2", order: 1, config: { options: ["A", "B"], meta: { topic: "배달" } } }),
      q({ id: "q3", order: 2, config: { options: ["A", "B"] } }),
      q({ id: "q4", order: 3, config: { options: ["A", "B"], meta: { construct: "  " } } }), // blank → dropped by normalizeMeta
    ];
    const c = computeMetaCompleteness(questions);
    expect(c).toEqual({ total: 4, withConstruct: 1, withTopic: 2, blankRate: 0.75 });
  });

  it("is safe on an empty survey", () => {
    expect(computeMetaCompleteness([])).toEqual({ total: 0, withConstruct: 0, withTopic: 0, blankRate: 0 });
  });
});

describe("runDeterministicChecks", () => {
  it("returns no items for a clean, fully-tagged survey", () => {
    const questions = [
      q({ id: "q1", order: 0, config: { options: ["A", "B"], meta: { construct: "만족도" } } }),
      q({ id: "q2", order: 1, type: "open", config: { meta: { construct: "개선점" } } }),
    ];
    const report = runDeterministicChecks(questions);
    expect(report.items).toHaveLength(0);
    expect(report.metaCompleteness.blankRate).toBe(0);
  });

  it("merges lint + structure + path issues, errors first then question order", () => {
    const questions = [
      // structural error (empty label) on the FIRST question
      q({ id: "q1", order: 0, config: { options: ["A", "B", ""], meta: { construct: "c" } } }),
      // q2 only shows when q1=B...
      q({
        id: "q2",
        order: 1,
        config: {
          options: ["X", "Y"],
          meta: { construct: "c" },
          displayLogic: logic("all", [{ questionId: "q1", op: "eq", value: "B" }]),
        },
      }),
      // ...so q3 (needs q1=A AND q2=X) is path-unreachable (warning)
      q({
        id: "q3",
        order: 2,
        type: "open",
        config: {
          meta: { construct: "c" },
          displayLogic: logic("all", [
            { questionId: "q1", op: "eq", value: "A" },
            { questionId: "q2", op: "eq", value: "X" },
          ]),
        },
      }),
    ];
    const report = runDeterministicChecks(questions);
    const codes = report.items.map((i) => i.code);
    expect(codes).toEqual(["empty_option_label", "unreachable_path"]);
    expect(report.items[0].severity).toBe("error");
    expect(report.items[1]).toMatchObject({ questionId: "q3", severity: "warning" });
  });

  it("drops the linter's static unreachable when the path test flags the same question", () => {
    const questions = [
      q({ id: "q1", order: 0, config: { options: ["A", "B"], meta: { construct: "c" } } }),
      q({
        id: "q2",
        order: 1,
        type: "open",
        config: {
          meta: { construct: "c" },
          displayLogic: logic("all", [
            { questionId: "q1", op: "eq", value: "A" },
            { questionId: "q1", op: "eq", value: "B" },
          ]),
        },
      }),
    ];
    const report = runDeterministicChecks(questions);
    const q2Codes = report.items.filter((i) => i.questionId === "q2").map((i) => i.code);
    expect(q2Codes).toEqual(["unreachable_path"]); // not both unreachable + unreachable_path
  });

  it("flags empty prompts as errors", () => {
    const questions = [
      q({ id: "q1", order: 0, prompt: "   ", config: { options: ["A", "B"], meta: { construct: "c" } } }),
    ];
    const report = runDeterministicChecks(questions);
    expect(report.items.map((i) => i.code)).toContain("empty_prompt");
    expect(report.items.find((i) => i.code === "empty_prompt")?.severity).toBe("error");
  });

  it("emits a survey-level meta_gap info item when constructs are missing", () => {
    const questions = [
      q({ id: "q1", order: 0, config: { options: ["A", "B"], meta: { construct: "만족도" } } }),
      q({ id: "q2", order: 1, config: { options: ["A", "B"] } }),
    ];
    const report = runDeterministicChecks(questions);
    const gap = report.items.find((i) => i.code === "meta_gap");
    expect(gap).toMatchObject({ questionId: null, severity: "info" });
    expect(gap?.message).toContain("1개");
    expect(report.metaCompleteness).toMatchObject({ total: 2, withConstruct: 1, blankRate: 0.5 });
  });
});
