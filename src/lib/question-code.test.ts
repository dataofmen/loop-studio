import { describe, expect, it } from "vitest";
import { questionCode } from "./question-code";

describe("questionCode", () => {
  it("formats as Q- + 4 unambiguous symbols", () => {
    const c = questionCode("q_1a2b3c4d");
    expect(c).toMatch(/^Q-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("is deterministic (same quid → same code)", () => {
    expect(questionCode("q_deadbeef")).toBe(questionCode("q_deadbeef"));
  });

  it("handles legacy UUID-style quids (quid=id backfill)", () => {
    const c = questionCode("550e8400-e29b-41d4-a716-446655440000");
    expect(c).toMatch(/^Q-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("distinguishes different quids", () => {
    expect(questionCode("q_11111111")).not.toBe(questionCode("q_22222222"));
  });
});
