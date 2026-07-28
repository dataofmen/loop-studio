import { describe, expect, it } from "vitest";
import { coerceSimAnswer, emptyFor } from "./sim-answers";

describe("coerceSimAnswer", () => {
  it("keeps open answers as plain scalar strings (probes omitted)", () => {
    expect(coerceSimAnswer("open", "배달이 빨라서 좋아요")).toBe("배달이 빨라서 좋아요");
    // A model echoing the probed shape must degrade to its base text only —
    // synthetic responses never store {answer, probes}.
    expect(
      coerceSimAnswer("open", {
        answer: "가격이 부담돼요",
        probes: [{ q: "어떤 상황에서요?", a: "야식 주문 때" }],
      }),
    ).toBe("가격이 부담돼요");
  });

  it("never yields '[object Object]' for open/single junk objects", () => {
    expect(coerceSimAnswer("open", { foo: "bar" })).toBe("");
    expect(coerceSimAnswer("open", ["a", "b"])).toBe("");
    expect(coerceSimAnswer("single", { answer: 1 })).toBe("");
    expect(coerceSimAnswer("open", null)).toBe("");
    expect(coerceSimAnswer("open", undefined)).toBe("");
  });

  it("coerces scalar primitives for open/single", () => {
    expect(coerceSimAnswer("single", "매우 만족")).toBe("매우 만족");
    expect(coerceSimAnswer("open", 42)).toBe("42");
  });

  it("keeps non-open types unchanged (aggregate-compatible shapes)", () => {
    expect(coerceSimAnswer("scale", "4")).toBe(4);
    expect(coerceSimAnswer("scale", "junk")).toBeNull();
    expect(coerceSimAnswer("nps", 9)).toBe(9);
    expect(coerceSimAnswer("multi", ["A", "B"])).toEqual(["A", "B"]);
    expect(coerceSimAnswer("multi", "A")).toEqual(["A"]);
    expect(coerceSimAnswer("ranking", null)).toEqual([]);
    expect(coerceSimAnswer("matrix", { 맛: "만족" })).toEqual({ 맛: "만족" });
    expect(coerceSimAnswer("matrix", "junk")).toEqual({});
  });
});

describe("emptyFor", () => {
  it("matches the storage shape per type", () => {
    expect(emptyFor("scale")).toBeNull();
    expect(emptyFor("nps")).toBeNull();
    expect(emptyFor("multi")).toEqual([]);
    expect(emptyFor("ranking")).toEqual([]);
    expect(emptyFor("matrix")).toEqual({});
    expect(emptyFor("open")).toBe("");
    expect(emptyFor("single")).toBe("");
  });
});
