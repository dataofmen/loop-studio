import { describe, expect, it } from "vitest";
import { fieldChangeView, fmtDisplayLogic, questionSummaryLines } from "./compare-text";
import type { RevisionQuestion } from "./question-diff";

const promptOf = (id: string) => (id === "q-gate" ? "현재 배민클럽을 구독 중이신가요?" : undefined);

describe("fmtDisplayLogic", () => {
  it("renders eq / in conditions with referenced question prompts", () => {
    expect(
      fmtDisplayLogic(
        { match: "all", conditions: [{ questionId: "q-gate", op: "eq", value: "구독 중" }] },
        promptOf,
      ),
    ).toBe("「현재 배민클럽을 구독 중이신가요?」 = 구독 중일 때 표시");
    expect(
      fmtDisplayLogic(
        { match: "any", conditions: [{ questionId: "q-gate", op: "in", value: ["구독 중", "과거 구독"] }] },
        promptOf,
      ),
    ).toContain("[구독 중, 과거 구독] 중 하나");
  });

  it("falls back to 이전 문항 for unknown refs and 없음 for empty logic", () => {
    expect(
      fmtDisplayLogic({ match: "all", conditions: [{ questionId: "ghost", op: "eq", value: "x" }] }, promptOf),
    ).toContain("「이전 문항」");
    expect(fmtDisplayLogic(undefined, promptOf)).toBe("없음");
    expect(fmtDisplayLogic({ match: "all", conditions: [] }, promptOf)).toBe("없음");
  });
});

describe("fieldChangeView", () => {
  it("renders scale / limit / probe / randomizeOptions with meaningful values", () => {
    expect(fieldChangeView({ field: "scale", from: { min: 1, max: 5 }, to: { min: 0, max: 10, minLabel: "별로", maxLabel: "최고" } }, promptOf)).toEqual({
      label: "척도",
      from: "1–5",
      to: "0–10 (별로 ~ 최고)",
    });
    expect(fieldChangeView({ field: "limit", from: undefined, to: 3 }, promptOf)).toEqual({
      label: "선택 제한",
      from: "전체 순위",
      to: "상위 3개",
    });
    const probe = fieldChangeView(
      { field: "probe", from: undefined, to: { enabled: true, maxProbes: 2, guidance: "사례" } },
      promptOf,
    );
    expect(probe.from).toBe("꺼짐");
    expect(probe.to).toBe("켜짐 (최대 2회, 지침: 사례)");
    expect(fieldChangeView({ field: "randomizeOptions", from: undefined, to: true }, promptOf)).toEqual({
      label: "보기 무작위 표시",
      from: "꺼짐",
      to: "켜짐",
    });
  });

  it("renders displayLogic before/after as sentences", () => {
    const v = fieldChangeView(
      {
        field: "displayLogic",
        from: undefined,
        to: { match: "all", conditions: [{ questionId: "q-gate", op: "eq", value: "구독 중" }] },
      },
      promptOf,
    );
    expect(v.from).toBe("없음");
    expect(v.to).toContain("구독 중이신가요?」 = 구독 중일 때 표시");
  });

  it("renders meta origin as a human-readable label (직접 입력 / AI 추정)", () => {
    const v = fieldChangeView(
      {
        field: "meta",
        from: { construct: "satisfaction", origin: "ai" },
        to: { construct: "satisfaction", origin: "human" },
      },
      promptOf,
    );
    expect(v.label).toBe("메타데이터");
    expect(v.from).toBe("구성 개념: satisfaction · 입력 방식: AI 추정");
    expect(v.to).toBe("구성 개념: satisfaction · 입력 방식: 직접 입력");
  });

  it("hides the internal constructId pointer in meta rendering (US-006)", () => {
    const v = fieldChangeView(
      {
        field: "meta",
        from: undefined,
        to: { construct: "고객 만족도", constructId: "3f2a", origin: "ai" },
      },
      promptOf,
    );
    expect(v.to).toBe("구성 개념: 고객 만족도 · 입력 방식: AI 추정");
    expect(v.to).not.toContain("3f2a");
  });

  it("maps type codes to Korean labels", () => {
    expect(fieldChangeView({ field: "type", from: "open", to: "scale" }, promptOf)).toEqual({
      label: "문항 유형",
      from: "주관식",
      to: "척도",
    });
  });
});

describe("questionSummaryLines", () => {
  it("lists the full content of a question", () => {
    const q: RevisionQuestion = {
      quid: "q_x",
      type: "single",
      order: 0,
      prompt: "구독 기간은?",
      config: {
        options: [
          { id: "o1", label: "1개월" },
          { id: "o2", label: "1년", special: "other" },
        ],
        displayLogic: { match: "all", conditions: [{ questionId: "q-gate", op: "eq", value: "구독 중" }] },
        probe: { enabled: true, maxProbes: 3 },
        randomizeOptions: true,
      },
    };
    const lines = questionSummaryLines(q, promptOf);
    expect(lines[0]).toBe("유형: 단일 선택");
    expect(lines).toContain("보기: 1개월, 1년");
    expect(lines.some((l) => l.startsWith("표시 조건:") && l.includes("구독 중"))).toBe(true);
    expect(lines).toContain("AI 심층 질문: 켜짐 (최대 3회)");
    expect(lines).toContain("보기 무작위 표시: 켜짐");
  });

  it("keeps it minimal for a bare open question", () => {
    const q: RevisionQuestion = { quid: "q_y", type: "open", order: 0, prompt: "의견?", config: {} };
    expect(questionSummaryLines(q, promptOf)).toEqual(["유형: 주관식"]);
  });
});
