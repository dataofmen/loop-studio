import { describe, expect, it } from "vitest";
import { pathTestUnreachable } from "./path-test";
import { lintDisplayLogic, type LintQuestion } from "./logic-lint";
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

describe("pathTestUnreachable", () => {
  it("catches a cross-question impossibility the static linter misses", () => {
    // Q2 only shows when Q1=B, but Q3 needs Q1=A AND Q2=X — Q2 can never be
    // answered while Q1=A, so Q3 has no path. Each clause is individually fine.
    const q1 = q({ id: "q1", order: 0 });
    const q2 = q({
      id: "q2",
      order: 1,
      config: {
        options: ["X", "Y"],
        displayLogic: logic("all", [{ questionId: "q1", op: "eq", value: "B" }]),
      },
    });
    const q3 = q({
      id: "q3",
      order: 2,
      type: "open",
      config: {
        displayLogic: logic("all", [
          { questionId: "q1", op: "eq", value: "A" },
          { questionId: "q2", op: "eq", value: "X" },
        ]),
      },
    });
    const questions = [q1, q2, q3];

    // The static linter does NOT see this (no single-ref contradiction).
    expect(lintDisplayLogic(questions).filter((w) => w.code === "unreachable")).toHaveLength(0);

    const issues = pathTestUnreachable(questions);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ questionId: "q3", code: "unreachable_path" });
  });

  it("finds the path when the dependency chain is consistent", () => {
    const q1 = q({ id: "q1", order: 0 });
    const q2 = q({
      id: "q2",
      order: 1,
      config: {
        options: ["X", "Y"],
        displayLogic: logic("all", [{ questionId: "q1", op: "eq", value: "A" }]),
      },
    });
    const q3 = q({
      id: "q3",
      order: 2,
      type: "open",
      config: {
        displayLogic: logic("all", [
          { questionId: "q1", op: "eq", value: "A" },
          { questionId: "q2", op: "eq", value: "X" },
        ]),
      },
    });
    expect(pathTestUnreachable([q1, q2, q3])).toHaveLength(0);
  });

  it("covers scale mid-values compared by conditions, not just boundaries", () => {
    const q1 = q({ id: "q1", order: 0, type: "scale", config: {} }); // 1..5
    const q2 = q({
      id: "q2",
      order: 1,
      type: "open",
      config: { displayLogic: logic("all", [{ questionId: "q1", op: "eq", value: 3 }]) },
    });
    expect(pathTestUnreachable([q1, q2])).toHaveLength(0);
  });

  it("flags a scale condition outside the scale's range", () => {
    const q1 = q({ id: "q1", order: 0, type: "scale", config: {} }); // 1..5
    const q2 = q({
      id: "q2",
      order: 1,
      type: "open",
      config: { displayLogic: logic("all", [{ questionId: "q1", op: "gte", value: 7 }]) },
    });
    const issues = pathTestUnreachable([q1, q2]);
    expect(issues).toHaveLength(1);
    expect(issues[0].questionId).toBe("q2");
  });

  it("handles any-match: reachable when at least one OR clause has a path", () => {
    const q1 = q({ id: "q1", order: 0 });
    const q2 = q({
      id: "q2",
      order: 1,
      type: "open",
      config: {
        displayLogic: logic("any", [
          { questionId: "q1", op: "eq", value: "없는보기" },
          { questionId: "q1", op: "eq", value: "A" },
        ]),
      },
    });
    expect(pathTestUnreachable([q1, q2])).toHaveLength(0);
  });

  it("skips (never guesses) when the combination space exceeds maxCombos", () => {
    const q1 = q({ id: "q1", order: 0, config: { options: ["A", "B", "C", "D"] } });
    const q2 = q({
      id: "q2",
      order: 1,
      type: "open",
      config: {
        displayLogic: logic("all", [
          { questionId: "q1", op: "eq", value: "A" },
          { questionId: "q1", op: "eq", value: "B" }, // truly unreachable...
        ]),
      },
    });
    // ...but the cap of 1 forces a skip — no false positive, no guess.
    expect(pathTestUnreachable([q1, q2], 1)).toHaveLength(0);
    expect(pathTestUnreachable([q1, q2])).toHaveLength(1);
  });

  it("skips questions whose logic references a missing question (linter's job)", () => {
    const q1 = q({ id: "q1", order: 0 });
    const q2 = q({
      id: "q2",
      order: 1,
      type: "open",
      config: { displayLogic: logic("all", [{ questionId: "ghost", op: "eq", value: "A" }]) },
    });
    expect(pathTestUnreachable([q1, q2])).toHaveLength(0);
  });

  it("multi-select dependencies satisfy contains/in via single selections", () => {
    const q1 = q({ id: "q1", order: 0, type: "multi", config: { options: ["A", "B", "C"] } });
    const q2 = q({
      id: "q2",
      order: 1,
      type: "open",
      config: { displayLogic: logic("all", [{ questionId: "q1", op: "contains", value: "B" }]) },
    });
    expect(pathTestUnreachable([q1, q2])).toHaveLength(0);
  });
});
