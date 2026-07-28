import { describe, test, expect } from "vitest";
import { scopeToCorpusProvince } from "./population";

describe("scopeToCorpusProvince", () => {
  test("전국 has no region constraint", () => {
    expect(scopeToCorpusProvince("전국")).toBeNull();
  });

  // Every official 시도 name must map to the corpus' suffix-less province
  // value exactly (the corpus stores "서울", "경상남", "전북", …).
  const CASES: [string, string][] = [
    ["서울특별시", "서울"],
    ["부산광역시", "부산"],
    ["대구광역시", "대구"],
    ["인천광역시", "인천"],
    ["광주광역시", "광주"],
    ["대전광역시", "대전"],
    ["울산광역시", "울산"],
    ["세종특별자치시", "세종"],
    ["경기도", "경기"],
    ["강원특별자치도", "강원"],
    ["충청북도", "충청북"],
    ["충청남도", "충청남"],
    ["전북특별자치도", "전북"],
    ["전라남도", "전라남"],
    ["경상북도", "경상북"],
    ["경상남도", "경상남"],
    ["제주특별자치도", "제주"],
  ];
  test.each(CASES)("%s → %s", (scope, expected) => {
    expect(scopeToCorpusProvince(scope)).toBe(expected);
  });
});
