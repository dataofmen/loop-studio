import { describe, test, expect } from "vitest";
import {
  answerSelectsLabel,
  otherOption,
  sanitizeOtherTexts,
  OTHER_TEXT_MAX,
} from "./other-text";

const qSingle = {
  id: "q1",
  type: "single",
  config: { options: ["배달", "포장", { label: "기타", special: "other" }] },
};
const qMulti = {
  id: "q2",
  type: "multi",
  config: { options: [{ label: "없음", special: "none" }, "가격", { label: "기타", special: "other" }] },
};
const qNoOther = { id: "q3", type: "single", config: { options: ["예", "아니오"] } };
const qOpen = { id: "q4", type: "open", config: {} };
const qRanking = {
  id: "q5",
  type: "ranking",
  config: { options: ["가격", "속도", { label: "기타", special: "other" }] },
};
const qNoTextOther = {
  id: "q6",
  type: "single",
  config: { options: ["앱", { label: "기타", special: "other", noText: true }] },
};
const QS = [qSingle, qMulti, qNoOther, qOpen, qRanking, qNoTextOther];

describe("otherOption / answerSelectsLabel", () => {
  test("finds the special other option across legacy/object shapes", () => {
    expect(otherOption(qSingle.config.options)?.label).toBe("기타");
    expect(otherOption(qNoOther.config.options)).toBeUndefined();
    expect(otherOption(undefined)).toBeUndefined();
  });

  test("answerSelectsLabel: single string, multi array, junk", () => {
    expect(answerSelectsLabel("기타", "기타")).toBe(true);
    expect(answerSelectsLabel("포장", "기타")).toBe(false);
    expect(answerSelectsLabel(["가격", "기타"], "기타")).toBe(true);
    expect(answerSelectsLabel(["가격"], "기타")).toBe(false);
    expect(answerSelectsLabel({ a: 1 }, "기타")).toBe(false);
    expect(answerSelectsLabel(null, "기타")).toBe(false);
  });
});

describe("sanitizeOtherTexts", () => {
  test("keeps text only when the other option is actually selected", () => {
    const out = sanitizeOtherTexts(
      { q1: "직접 요리", q2: "메뉴 다양성" },
      QS,
      { q1: "기타", q2: ["가격", "기타"] },
    );
    expect(out).toEqual({ q1: "직접 요리", q2: "메뉴 다양성" });
  });

  test("drops: not selected, unknown qid, non-choice question, no other option", () => {
    const out = sanitizeOtherTexts(
      { q1: "텍스트", q3: "텍스트", q4: "텍스트", qX: "텍스트" },
      QS,
      { q1: "포장", q3: "예", q4: "주관식 답" },
    );
    expect(out).toEqual({});
  });

  test("trims, caps length, drops blanks and non-strings", () => {
    const long = "가".repeat(OTHER_TEXT_MAX + 50);
    const out = sanitizeOtherTexts(
      { q1: `  ${long}  `, q2: "   " },
      QS,
      { q1: "기타", q2: ["기타"] },
    );
    expect(out.q1).toHaveLength(OTHER_TEXT_MAX);
    expect(out.q2).toBeUndefined();
    expect(sanitizeOtherTexts({ q1: 42 }, QS, { q1: "기타" })).toEqual({});
  });

  test("ranking: text kept when 기타 is among the ranked picks", () => {
    const out = sanitizeOtherTexts({ q5: "직접 방문" }, QS, { q5: ["기타", "가격"] });
    expect(out).toEqual({ q5: "직접 방문" });
    expect(sanitizeOtherTexts({ q5: "직접 방문" }, QS, { q5: ["가격", "속도"] })).toEqual({});
  });

  test("noText other: smuggled text dropped even when 기타 is selected", () => {
    expect(sanitizeOtherTexts({ q6: "밀반입" }, QS, { q6: "기타" })).toEqual({});
  });

  test("junk container yields empty map", () => {
    expect(sanitizeOtherTexts(null, QS, {})).toEqual({});
    expect(sanitizeOtherTexts(["기타"], QS, {})).toEqual({});
    expect(sanitizeOtherTexts("기타", QS, {})).toEqual({});
  });
});
