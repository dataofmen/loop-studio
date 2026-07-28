import { describe, expect, it } from "vitest";
import { uniqueTitle } from "./unique-title";

describe("uniqueTitle", () => {
  it("returns the base title when nothing collides", () => {
    expect(uniqueTitle("고객 만족도 설문", [])).toBe("고객 만족도 설문");
    expect(uniqueTitle("A", ["B", "C"])).toBe("A");
  });

  it("appends (복사본) on the first collision", () => {
    expect(uniqueTitle("설문", ["설문"])).toBe("설문 (복사본)");
  });

  it("increments the number when (복사본) is also taken", () => {
    expect(uniqueTitle("설문", ["설문", "설문 (복사본)"])).toBe("설문 (복사본 2)");
    expect(uniqueTitle("설문", ["설문", "설문 (복사본)", "설문 (복사본 2)"])).toBe(
      "설문 (복사본 3)",
    );
  });

  it("skips gaps — returns the first free variant, not the count", () => {
    // (복사본) is free even though (복사본 2) exists.
    expect(uniqueTitle("설문", ["설문", "설문 (복사본 2)"])).toBe("설문 (복사본)");
  });

  it("ignores null/undefined entries in the existing set", () => {
    expect(uniqueTitle("설문", [null, undefined, "다른 설문"])).toBe("설문");
  });

  it("never exceeds the cap — trims the base to fit the suffix", () => {
    const base = "가".repeat(200);
    const out = uniqueTitle(base, [base], 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(" (복사본)")).toBe(true);
  });

  it("caps the base itself when no collision", () => {
    const base = "가".repeat(250);
    expect(uniqueTitle(base, [], 200)).toBe("가".repeat(200));
  });
});
