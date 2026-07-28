import { describe, expect, it } from "vitest";
import { lintProposal } from "./logic-lint";
import type { RevisionQuestion } from "./question-diff";

const gate: RevisionQuestion = {
  quid: "g",
  type: "single",
  order: 0,
  prompt: "이용 상태를 선택해 주세요",
  config: { options: [{ id: "o1", label: "가입한 적 없음" }, { id: "o2", label: "이용 중" }] },
};

describe("lintProposal", () => {
  it("flags a condition citing an option label that no longer exists", () => {
    const dependent: RevisionQuestion = {
      quid: "d",
      type: "multi",
      order: 1,
      prompt: "가입하지 않으신 이유는?",
      config: { options: [{ id: "x", label: "부담" }] },
      showIf: { match: "all", conditions: [{ ref: 1, op: "eq", value: "가입·이용해 본 적 없음" }] },
    };
    const warnings = lintProposal([gate, dependent]);
    expect(warnings.some((w) => w.code === "value_not_in_options")).toBe(true);
  });

  it("passes when condition values match the referenced question's labels", () => {
    const dependent: RevisionQuestion = {
      quid: "d",
      type: "multi",
      order: 1,
      prompt: "가입하지 않으신 이유는?",
      config: { options: [{ id: "x", label: "부담" }] },
      showIf: { match: "all", conditions: [{ ref: 1, op: "eq", value: "가입한 적 없음" }] },
    };
    expect(lintProposal([gate, dependent])).toEqual([]);
  });

  it("does not false-positive on kept questions' live displayLogic (not linted)", () => {
    const kept: RevisionQuestion = {
      quid: "k",
      type: "open",
      order: 1,
      prompt: "의견",
      config: {
        displayLogic: { match: "all", conditions: [{ questionId: "live-uuid", op: "eq", value: "x" }] },
      },
    };
    expect(lintProposal([gate, kept])).toEqual([]);
  });
});
