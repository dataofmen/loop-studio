import { describe, expect, test } from "vitest";
import { sampleOcean, normalizeOcean, oceanPromptLine, oceanLabel } from "./ocean";

describe("sampleOcean", () => {
  test("deterministic: same uuid → identical profile", () => {
    expect(sampleOcean("uuid-123")).toEqual(sampleOcean("uuid-123"));
    expect(sampleOcean("uuid-123")).not.toEqual(sampleOcean("uuid-456"));
  });

  test("distribution sanity: all three levels occur across many personas, mid dominates", () => {
    const counts = { low: 0, mid: 0, high: 0 };
    for (let i = 0; i < 500; i++) {
      const p = sampleOcean(`persona-${i}`);
      for (const v of Object.values(p)) counts[v]++;
    }
    expect(counts.low).toBeGreaterThan(0);
    expect(counts.high).toBeGreaterThan(0);
    expect(counts.mid).toBeGreaterThan(counts.low);
    expect(counts.mid).toBeGreaterThan(counts.high);
  });
});

describe("normalizeOcean", () => {
  test("valid profile round-trips; garbage → null (pre-OCEAN personas)", () => {
    const p = sampleOcean("x");
    expect(normalizeOcean(p)).toEqual(p);
    expect(normalizeOcean(undefined)).toBeNull();
    expect(normalizeOcean({ openness: "extreme" })).toBeNull();
    expect(normalizeOcean("high")).toBeNull();
  });
});

describe("oceanPromptLine / oceanLabel", () => {
  test("distinctive traits produce Korean behavior instructions; all-mid injects nothing", () => {
    const allMid = { openness: "mid", conscientiousness: "mid", extraversion: "mid", agreeableness: "mid", neuroticism: "mid" } as const;
    expect(oceanPromptLine(allMid)).toBe("");
    expect(oceanLabel(allMid)).toBe("");
    const line = oceanPromptLine({ ...allMid, neuroticism: "high", agreeableness: "low" });
    expect(line).toContain("불안");
    expect(line).toContain("직설적");
    expect(oceanLabel({ ...allMid, neuroticism: "high", openness: "low" })).toBe("개방성↓ 신경증↑");
  });
});
