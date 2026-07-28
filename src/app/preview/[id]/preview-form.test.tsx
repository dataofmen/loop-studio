import { describe, test, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PreviewForm } from "./preview-form";

/**
 * The preview stores nothing, so these assert what the author actually sees
 * while walking their own questionnaire: which options appear, when the
 * inline "other" input shows up, how carry-forward and none-exclusivity
 * behave, and that the walkthrough reaches its end screen.
 */
function renderForm(questions: Parameters<typeof PreviewForm>[0]["questions"]) {
  render(<PreviewForm questions={questions} title="테스트 설문" backHref="/surveys/s1" />);
}

const OTHER_INPUT = "기타 내용을 입력해 주세요…";

/** A multi option's badge shows ✓ once selected. */
function isChecked(label: string): boolean {
  const btn = screen.getByText(label).closest("button");
  return (btn?.textContent ?? "").includes("✓");
}

describe("PreviewForm 기타 자유 입력", () => {
  const qOtherSingle = {
    id: "q1",
    type: "single" as const,
    prompt: "주 이용 채널은?",
    config: { options: ["앱", "웹", { label: "기타", special: "other" }] },
  };

  test("single: 기타 선택 → 자동 진행 대신 인라인 입력이 열린다", async () => {
    renderForm([qOtherSingle]);
    await userEvent.click(screen.getByText("시작하기"));

    await userEvent.click(screen.getByText("기타"));
    const input = await screen.findByPlaceholderText(OTHER_INPUT);
    await userEvent.type(input, "전화 주문");
    expect((input as HTMLInputElement).value).toBe("전화 주문");
    // Still on the question — 기타 must not auto-advance.
    expect(screen.getByText("주 이용 채널은?")).toBeTruthy();
  });

  test("single: 기타 → 다른 보기로 바꾸면 입력창이 닫힌다", async () => {
    renderForm([qOtherSingle, { id: "q2", type: "open" as const, prompt: "의견?", config: {} }]);
    await userEvent.click(screen.getByText("시작하기"));

    await userEvent.click(screen.getByText("기타"));
    await userEvent.type(await screen.findByPlaceholderText(OTHER_INPUT), "버릴 텍스트");
    // Switching to a normal option discards the typed text and auto-advances.
    await userEvent.click(screen.getByText("앱"));
    await waitFor(() => expect(screen.getByText("의견?")).toBeTruthy());
    expect(screen.queryByPlaceholderText(OTHER_INPUT)).toBeNull();
  });

  test("multi: 기타 체크 → 입력, 체크 해제 → 입력창 폐기", async () => {
    renderForm([
      {
        id: "q1",
        type: "multi" as const,
        prompt: "불만족 이유는?",
        config: { options: ["가격", "배달", { label: "기타", special: "other" }] },
      },
    ]);
    await userEvent.click(screen.getByText("시작하기"));

    await userEvent.click(screen.getByText("가격"));
    await userEvent.click(screen.getByText("기타"));
    await userEvent.type(await screen.findByPlaceholderText(OTHER_INPUT), "메뉴 다양성");
    await userEvent.click(screen.getByText("기타"));
    expect(screen.queryByPlaceholderText(OTHER_INPUT)).toBeNull();
    expect(isChecked("가격")).toBe(true);
  });

  test("noText 기타: 입력창 없이 일반 보기처럼 자동 진행", async () => {
    renderForm([
      {
        id: "q1",
        type: "single" as const,
        prompt: "주 이용 채널은?",
        config: { options: ["앱", { label: "기타", special: "other", noText: true }] },
      },
    ]);
    await userEvent.click(screen.getByText("시작하기"));

    await userEvent.click(screen.getByText("기타"));
    expect(screen.queryByPlaceholderText(OTHER_INPUT)).toBeNull();
    // Last question → auto-advance lands on the end screen.
    await waitFor(() => expect(screen.getByText("마지막 화면")).toBeTruthy());
  });

  test("carry-forward: 원본 기타의 입력 텍스트가 가져온 보기에 표시된다", async () => {
    renderForm([
      {
        id: "q1",
        type: "multi" as const,
        prompt: "이용해 본 채널은?",
        config: { options: ["앱", { label: "기타", special: "other" }] },
      },
      {
        id: "q2",
        type: "single" as const,
        prompt: "가장 자주 쓰는 채널은?",
        config: { optionsFrom: { questionId: "q1", mode: "selected" } },
      },
    ]);
    await userEvent.click(screen.getByText("시작하기"));

    await userEvent.click(screen.getByText("앱"));
    await userEvent.click(screen.getByText("기타"));
    await userEvent.type(await screen.findByPlaceholderText(OTHER_INPUT), "전화 주문");
    await userEvent.click(screen.getByText("다음"));

    // Only the selected options carry over, and 기타 shows what was typed.
    expect(await screen.findByText("기타: 전화 주문")).toBeTruthy();
    expect(screen.getByText("앱")).toBeTruthy();
  });
});

describe("PreviewForm 없음 배타", () => {
  test("multi: 없음 선택 → 전부 해제, 다른 보기 선택 → 없음 해제", async () => {
    renderForm([
      {
        id: "q1",
        type: "multi" as const,
        prompt: "최근 겪은 불편은?",
        config: { options: [{ label: "없음", special: "none" }, "가격", "배달"] },
      },
    ]);
    await userEvent.click(screen.getByText("시작하기"));

    await userEvent.click(screen.getByText("가격"));
    await userEvent.click(screen.getByText("배달"));
    await userEvent.click(screen.getByText("없음"));
    expect(isChecked("없음")).toBe(true);
    expect(isChecked("가격")).toBe(false);
    expect(isChecked("배달")).toBe(false);

    // Then a normal option again → 없음 clears.
    await userEvent.click(screen.getByText("배달"));
    expect(isChecked("없음")).toBe(false);
    expect(isChecked("배달")).toBe(true);
  });
});

describe("PreviewForm 표시 로직·AI 후속 질문 안내", () => {
  test("표시 조건이 맞지 않는 문항은 건너뛴다", async () => {
    renderForm([
      {
        id: "q1",
        type: "single" as const,
        prompt: "배달앱을 쓰시나요?",
        config: { options: ["예", "아니오"] },
      },
      {
        id: "q2",
        type: "open" as const,
        prompt: "어떤 앱을 쓰시나요?",
        config: {
          displayLogic: { match: "all", conditions: [{ questionId: "q1", op: "eq", value: "예" }] },
        },
      },
      { id: "q3", type: "open" as const, prompt: "마지막 의견은?", config: {} },
    ]);
    await userEvent.click(screen.getByText("시작하기"));

    await userEvent.click(screen.getByText("아니오"));
    // q2's condition fails → straight to q3.
    await waitFor(() => expect(screen.getByText("마지막 의견은?")).toBeTruthy());
    expect(screen.queryByText("어떤 앱을 쓰시나요?")).toBeNull();
  });

  test("probe 설정 문항은 후속 질문을 생성하지 않고 안내만 표시한다", async () => {
    renderForm([
      {
        id: "q1",
        type: "open" as const,
        prompt: "배달앱에 바라는 점은?",
        config: { probe: { enabled: true, maxProbes: 2 } },
      },
    ]);
    await userEvent.click(screen.getByText("시작하기"));

    expect(screen.getByText(/AI 후속 질문 최대 2회로 설정된 문항입니다/)).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText("자유롭게 작성해 주세요…"), "배달비 인하");
    await userEvent.click(screen.getByText("마치기"));
    await waitFor(() => expect(screen.getByText("마지막 화면")).toBeTruthy());
  });
});

describe("PreviewForm 나가기", () => {
  test("설문으로 돌아가는 링크가 항상 보인다", () => {
    renderForm([{ id: "q1", type: "open" as const, prompt: "의견?", config: {} }]);
    const back = screen.getByText("← 설문으로 돌아가기");
    expect(back.getAttribute("href")).toBe("/surveys/s1");
  });
});

describe("PreviewForm 재시작", () => {
  test("처음부터 다시 보기로 답이 초기화된다", async () => {
    renderForm([
      {
        id: "q1",
        type: "single" as const,
        prompt: "주 이용 채널은?",
        config: { options: ["앱", "웹"] },
      },
    ]);
    await userEvent.click(screen.getByText("시작하기"));
    await userEvent.click(screen.getByText("앱"));
    await waitFor(() => expect(screen.getByText("마지막 화면")).toBeTruthy());

    await userEvent.click(screen.getByText("처음부터 다시 보기"));
    expect(screen.getByText("시작하기")).toBeTruthy();
  });
});
