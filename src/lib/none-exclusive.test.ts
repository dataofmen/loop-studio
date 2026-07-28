import { describe, test, expect } from "vitest";
import { clampNoneExclusive, noneOption, toggleMultiExclusive } from "./none-exclusive";

describe("noneOption", () => {
  test("finds the special none option; undefined otherwise", () => {
    expect(noneOption([{ label: "없음", special: "none" }, "가격"])?.label).toBe("없음");
    expect(noneOption(["가격", "배달"])).toBeUndefined();
    expect(noneOption(undefined)).toBeUndefined();
  });
});

describe("toggleMultiExclusive", () => {
  test("selecting none clears every other pick", () => {
    expect(toggleMultiExclusive(["가격", "배달"], "없음", "없음")).toEqual(["없음"]);
  });

  test("selecting a normal option removes none", () => {
    expect(toggleMultiExclusive(["없음"], "가격", "없음")).toEqual(["가격"]);
  });

  test("deselecting always just removes the pick", () => {
    expect(toggleMultiExclusive(["없음"], "없음", "없음")).toEqual([]);
    expect(toggleMultiExclusive(["가격", "배달"], "가격", "없음")).toEqual(["배달"]);
  });

  test("plain toggle when the question has no none option", () => {
    expect(toggleMultiExclusive(["가격"], "배달", undefined)).toEqual(["가격", "배달"]);
    expect(toggleMultiExclusive(["가격", "배달"], "배달", undefined)).toEqual(["가격"]);
  });
});

describe("clampNoneExclusive (rule: 공존 시 없음 제거)", () => {
  test("none + others → none dropped, substantive picks kept", () => {
    expect(clampNoneExclusive(["없음", "가격", "배달"], "없음")).toEqual(["가격", "배달"]);
  });

  test("none alone stays; answers without none untouched", () => {
    expect(clampNoneExclusive(["없음"], "없음")).toEqual(["없음"]);
    expect(clampNoneExclusive(["가격", "배달"], "없음")).toEqual(["가격", "배달"]);
    expect(clampNoneExclusive([], "없음")).toEqual([]);
  });
});
