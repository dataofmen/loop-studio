import { describe, expect, it } from "vitest";
import {
  formatConstructContextLines,
  representativeQuestion,
  type ConstructReuseEntry,
} from "@/lib/construct-reuse";

const q = (prompt: string, surveyCreatedAt: string, type = "scale") => ({
  type,
  prompt,
  surveyCreatedAt,
});

describe("representativeQuestion", () => {
  it("picks the most-used wording", () => {
    const rep = representativeQuestion([
      q("전반적으로 얼마나 만족하십니까?", "2026-01-01T00:00:00Z"),
      q("전반적으로 얼마나 만족하십니까?", "2026-02-01T00:00:00Z"),
      q("서비스가 마음에 드시나요?", "2026-03-01T00:00:00Z"),
    ]);
    expect(rep).toEqual({
      type: "scale",
      prompt: "전반적으로 얼마나 만족하십니까?",
      uses: 2,
    });
  });

  it("breaks a usage tie by the most recent survey", () => {
    const rep = representativeQuestion([
      q("오래된 표현", "2026-01-01T00:00:00Z"),
      q("최신 표현", "2026-05-01T00:00:00Z"),
    ]);
    expect(rep?.prompt).toBe("최신 표현");
  });

  it("groups whitespace variants as one wording, keeping the first spelling", () => {
    const rep = representativeQuestion([
      q("얼마나  만족하십니까?", "2026-01-01T00:00:00Z"),
      q("얼마나 만족하십니까?", "2026-02-01T00:00:00Z"),
      q("다른 문항", "2026-03-01T00:00:00Z"),
    ]);
    expect(rep?.uses).toBe(2);
    expect(rep?.prompt).toBe("얼마나 만족하십니까?");
  });

  it("returns null for no members / blank prompts", () => {
    expect(representativeQuestion([])).toBeNull();
    expect(representativeQuestion([q("   ", "2026-01-01T00:00:00Z")])).toBeNull();
  });
});

describe("formatConstructContextLines", () => {
  it("includes canonical name, wording, and real-response evidence", () => {
    const entries: ConstructReuseEntry[] = [
      {
        name: "고객 만족도",
        representative: { type: "scale", prompt: "얼마나 만족하십니까?", uses: 3 },
        realResponseCount: 12,
        numericOverall: [{ scaleKey: "scale 1–5", mean: 3.8, n: 12 }],
      },
    ];
    const [line] = formatConstructContextLines(entries);
    expect(line).toContain('"고객 만족도"');
    expect(line).toContain("얼마나 만족하십니까?");
    expect(line).toContain("실제 응답 12건");
    expect(line).toContain("scale 1–5 평균 3.8 (n=12)");
  });

  it("marks constructs without real responses and skips empty means", () => {
    const entries: ConstructReuseEntry[] = [
      {
        name: "혜택 이용 행태",
        representative: { type: "multi", prompt: "어떤 혜택을 쓰시나요?", uses: 1 },
        realResponseCount: 0,
        numericOverall: [],
      },
    ];
    const [line] = formatConstructContextLines(entries);
    expect(line).toContain("실제 응답 아직 없음");
    expect(line).not.toContain("평균");
  });
});
