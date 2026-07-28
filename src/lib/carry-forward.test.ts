import { describe, expect, it } from "vitest";
import {
  carriedOptionLabels,
  clampCarriedAnswer,
  normalizeOptionsFrom,
} from "./carry-forward";
import { lintDisplayLogic, lintProposal, type LintQuestion } from "./logic-lint";
import { mergeProposal, type RevisionQuestion } from "./question-diff";

describe("normalizeOptionsFrom", () => {
  it("accepts a valid reference and defaults mode", () => {
    expect(normalizeOptionsFrom({ questionId: "q-1" })).toEqual({ questionId: "q-1", mode: "selected" });
    expect(normalizeOptionsFrom({ questionId: "q-1", mode: "selected" })).toEqual({ questionId: "q-1", mode: "selected" });
  });
  it("rejects junk and unknown modes", () => {
    expect(normalizeOptionsFrom(null)).toBeUndefined();
    expect(normalizeOptionsFrom("q-1")).toBeUndefined();
    expect(normalizeOptionsFrom({ questionId: "" })).toBeUndefined();
    expect(normalizeOptionsFrom({ questionId: "q-1", mode: "unselected" })).toBeUndefined();
  });
});

describe("carriedOptionLabels", () => {
  const src = ["구독료 부담", "혜택 부족", "빈도 감소", "기타"];
  it("filters to the respondent's selections, keeping source order", () => {
    expect(carriedOptionLabels(src, ["빈도 감소", "구독료 부담"])).toEqual(["구독료 부담", "빈도 감소"]);
  });
  it("single-answer string works; empty/unknown answers yield []", () => {
    expect(carriedOptionLabels(src, "혜택 부족")).toEqual(["혜택 부족"]);
    expect(carriedOptionLabels(src, "")).toEqual([]);
    expect(carriedOptionLabels(src, undefined)).toEqual([]);
    expect(carriedOptionLabels(src, ["없는 보기"])).toEqual([]);
  });
});

describe("clampCarriedAnswer", () => {
  const carried = ["구독료 부담", "빈도 감소"];
  it("single: out-of-set answers snap to the first carried option", () => {
    expect(clampCarriedAnswer("single", "혜택 부족", carried)).toBe("구독료 부담");
    expect(clampCarriedAnswer("single", "빈도 감소", carried)).toBe("빈도 감소");
  });
  it("multi/ranking: intersects; empty intersection falls back to first", () => {
    expect(clampCarriedAnswer("multi", ["혜택 부족", "빈도 감소"], carried)).toEqual(["빈도 감소"]);
    expect(clampCarriedAnswer("ranking", ["혜택 부족"], carried)).toEqual(["구독료 부담"]);
  });
});

describe("carry-forward lint rules", () => {
  const src: LintQuestion = {
    id: "s",
    order: 0,
    type: "multi",
    prompt: "이유를 모두 선택",
    config: { options: ["A", "B"] },
  };
  it("flags missing / forward / non-choice sources", () => {
    const missing: LintQuestion = { id: "d", order: 1, type: "single", prompt: "결정적 이유", config: { optionsFrom: { questionId: "ghost", mode: "selected" } } };
    expect(lintDisplayLogic([src, missing]).some((w) => w.code === "carry_missing_ref")).toBe(true);

    const forward: LintQuestion = { id: "d", order: 0, type: "single", prompt: "결정적 이유", config: { optionsFrom: { questionId: "s", mode: "selected" } } };
    expect(lintDisplayLogic([{ ...src, order: 1 }, forward]).some((w) => w.code === "carry_forward_ref")).toBe(true);

    const openSrc: LintQuestion = { id: "o", order: 0, type: "open", prompt: "의견", config: {} };
    const badType: LintQuestion = { id: "d", order: 1, type: "single", prompt: "결정적 이유", config: { optionsFrom: { questionId: "o", mode: "selected" } } };
    expect(lintDisplayLogic([openSrc, badType]).some((w) => w.code === "carry_source_not_choice")).toBe(true);
  });

  it("valid carry-forward passes, and conditions referencing a piped question skip the value check", () => {
    const piped: LintQuestion = { id: "d", order: 1, type: "single", prompt: "결정적 이유", config: { optionsFrom: { questionId: "s", mode: "selected" } } };
    const gated: LintQuestion = {
      id: "g", order: 2, type: "open", prompt: "이유 설명",
      config: { displayLogic: { match: "all", conditions: [{ questionId: "d", op: "eq", value: "A" }] } },
    };
    expect(lintDisplayLogic([src, piped, gated]).filter((w) => w.severity === "error")).toEqual([]);
    expect(lintDisplayLogic([src, piped, gated]).some((w) => w.code === "value_not_in_options")).toBe(false);
  });
});

describe("optionsFromRef in proposals", () => {
  it("lintProposal maps refs to synthetic ids (forward source flagged)", () => {
    const proposed: RevisionQuestion[] = [
      { quid: "a", type: "single", order: 0, prompt: "결정적 이유", config: {}, optionsFromRef: { ref: 2, mode: "selected" } },
      { quid: "b", type: "multi", order: 1, prompt: "이유 모두", config: { options: [{ id: "o1", label: "A" }] } },
    ];
    expect(lintProposal(proposed).some((w) => w.code === "carry_forward_ref")).toBe(true);
  });

  it("mergeProposal remaps optionsFromRef when insertions shift positions", () => {
    const cur: RevisionQuestion[] = [
      { quid: "x", type: "multi", order: 0, prompt: "이유 모두", config: { options: [{ id: "o1", label: "A" }] } },
      { quid: "y", type: "open", order: 1, prompt: "삭제될 문항", config: {} },
    ];
    const prop: RevisionQuestion[] = [
      { quid: "x", type: "multi", order: 0, prompt: "이유 모두", config: { options: [{ id: "o1", label: "A" }] } },
      // y deleted; new question carries from proposal #1
      { quid: "z", type: "single", order: 1, prompt: "결정적 이유", config: {}, optionsFromRef: { ref: 1, mode: "selected" } },
    ];
    // reject y's deletion → y re-inserted at position 2, shifting z to 3.
    const out = mergeProposal(cur, prop, { z: true });
    const z = out.find((q) => q.quid === "z");
    expect(out.map((q) => q.quid)).toEqual(["x", "y", "z"]);
    expect(z?.optionsFromRef?.ref).toBe(1); // still points at x (merged position 1)
  });
});

describe("parseJsonFromText tolerance (proposal apply regression)", () => {
  it("survives trailing commas and smart quotes; clean error otherwise", async () => {
    const { parseJsonFromText } = await import("./agent-cli");
    expect(parseJsonFromText('{"a": 1, "b": [1, 2,], }')).toEqual({ a: 1, b: [1, 2] });
    expect(parseJsonFromText('{“a”: "값"}')).toEqual({ a: "값" });
    expect(parseJsonFromText('```json\n{"ok": true}\n```')).toEqual({ ok: true });
    expect(() => parseJsonFromText("완전 깨진 출력")).toThrow("유효하지 않은 JSON");
  });
});

describe("structural lint skips carry-forward questions", () => {
  it("no 'too_few_options' for a question whose options carry forward", async () => {
    const { lintQuestionStructure } = await import("./logic-lint");
    const qs = [
      { id: "s", order: 0, type: "multi", prompt: "이유 모두", config: { options: ["A", "B"] } },
      { id: "d", order: 1, type: "single", prompt: "가장 큰 이유", config: { optionsFrom: { questionId: "s", mode: "selected" } } },
    ];
    expect(lintQuestionStructure(qs).filter((w) => w.questionId === "d")).toEqual([]);
    // a genuinely empty choice question is still flagged
    const bare = [{ id: "x", order: 0, type: "single", prompt: "빈 문항", config: {} }];
    expect(lintQuestionStructure(bare).some((w) => w.code === "too_few_options")).toBe(true);
  });
});
