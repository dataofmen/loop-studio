import { describe, test, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock all server actions (they import the DB).
const updateQuestion = vi.fn(async () => {});
vi.mock("./actions", () => ({
  addQuestion: vi.fn(async () => ({ id: "new", type: "open", order: 99, prompt: "새 질문", config: {} })),
  deleteQuestion: vi.fn(async () => {}),
  reorderQuestions: vi.fn(async () => {}),
  updateQuestion: (...args: unknown[]) => updateQuestion(...args),
  updateSurveyTitle: vi.fn(async () => {}),
  updateSurveyMessages: vi.fn(async () => {}),
  compileDisplayLogicAction: vi.fn(),
  inferMetaAction: vi.fn(async () => ({ status: "skipped" })),
  backfillMetaAction: vi.fn(async () => ({ total: 0, filled: 0, failed: 0, metas: {} })),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../template-actions", () => ({
  saveQuestionsAsBlockAction: vi.fn(async () => ({ id: "blk" })),
}));

import { Editor } from "./editor";

const initialQuestions = [
  { id: "q1", quid: "q_q1", type: "single" as const, order: 0, prompt: "기간", config: { options: ["1개월 미만", "1년 이상"] } },
  {
    id: "q2",
    quid: "q_q2",
    type: "open" as const,
    order: 1,
    prompt: "이유",
    config: {
      displayLogic: {
        match: "all" as const,
        conditions: [{ questionId: "q1", op: "in" as const, value: ["1개월 미만"] }],
      },
    },
  },
];

beforeEach(() => updateQuestion.mockClear());

describe("Editor delete condition", () => {
  test("clicking 조건 삭제 hides the box and persists config without displayLogic", async () => {
    render(
      <Editor
        surveyId="s"
        initialTitle="t"
        initialQuestions={structuredClone(initialQuestions)}
        initialWelcome=""
        initialClosing=""
      />,
    );

    // Q2's condition box is shown.
    expect(screen.queryByText("현재 적용된 조건")).toBeTruthy();

    await userEvent.click(screen.getByText("조건 삭제"));

    // Box must disappear (parent re-render).
    await waitFor(() => expect(screen.queryByText("현재 적용된 조건")).toBeNull());

    // And the persisted config must NOT contain displayLogic.
    const dlCalls = updateQuestion.mock.calls.filter((c) => c[0] === "q2");
    expect(dlCalls.length).toBeGreaterThan(0);
    const lastConfig = (dlCalls[dlCalls.length - 1][1] as { config?: Record<string, unknown> }).config;
    expect(lastConfig?.displayLogic).toBeUndefined();
  });

  test("after delete, nothing re-adds displayLogic (no resurrection)", async () => {
    render(
      <Editor
        surveyId="s"
        initialTitle="t"
        initialQuestions={structuredClone(initialQuestions)}
        initialWelcome=""
        initialClosing=""
      />,
    );
    await userEvent.click(screen.getByText("조건 삭제"));
    await waitFor(() => expect(screen.queryByText("현재 적용된 조건")).toBeNull());
    // wait to catch any delayed (debounced/transition) resurrection
    await new Promise((r) => setTimeout(r, 1200));
    const q2Calls = updateQuestion.mock.calls.filter((c) => c[0] === "q2");
    const anyWithDL = q2Calls.some(
      (c) => (c[1] as { config?: { displayLogic?: unknown } }).config?.displayLogic,
    );
    expect(anyWithDL).toBe(false);
    expect(screen.queryByText("현재 적용된 조건")).toBeNull();
  });
});

describe("Editor open-question probe settings (US-011)", () => {
  test("open question shows the AI probe toggle; choice question does not", () => {
    render(
      <Editor
        surveyId="s"
        initialTitle="t"
        initialQuestions={structuredClone(initialQuestions)}
        initialWelcome=""
        initialClosing=""
      />,
    );
    // Exactly one open question (q2) → exactly one toggle.
    expect(screen.getAllByText("AI 심층 질문")).toHaveLength(1);
    // Collapsed by default (probe not enabled): no detail inputs yet.
    expect(screen.queryByText("최대 후속 질문 수")).toBeNull();
  });

  test("enabling the toggle reveals maxProbes(2)/guidance and persists probe config", async () => {
    render(
      <Editor
        surveyId="s"
        initialTitle="t"
        initialQuestions={structuredClone(initialQuestions)}
        initialWelcome=""
        initialClosing=""
      />,
    );

    await userEvent.click(screen.getByRole("checkbox", { name: /AI 심층 질문/ }));

    // Detail inputs appear with the default cap of 2.
    const maxInput = (await screen.findByLabelText(/최대 후속 질문 수/)) as HTMLInputElement;
    expect(maxInput.value).toBe("2");
    const guidance = screen.getByPlaceholderText(/후속 질문 지침/) as HTMLTextAreaElement;
    expect(guidance.value).toBe("");

    // Persisted config carries probe {enabled:true, maxProbes:2}.
    await waitFor(() => {
      const probeCalls = updateQuestion.mock.calls.filter((c) => c[0] === "q2");
      expect(probeCalls.length).toBeGreaterThan(0);
      const last = (probeCalls[probeCalls.length - 1][1] as {
        config?: { probe?: { enabled?: boolean; maxProbes?: number } };
      }).config;
      expect(last?.probe?.enabled).toBe(true);
      expect(last?.probe?.maxProbes).toBe(2);
    });
  });

  test("disabling keeps probe object but enabled=false", async () => {
    const withProbe = structuredClone(initialQuestions);
    (withProbe[1].config as Record<string, unknown>).probe = {
      enabled: true,
      maxProbes: 3,
      guidance: "사례 중심",
    };
    render(
      <Editor
        surveyId="s"
        initialTitle="t"
        initialQuestions={withProbe}
        initialWelcome=""
        initialClosing=""
      />,
    );

    // Enabled probe renders its detail inputs immediately.
    expect((screen.getByLabelText(/최대 후속 질문 수/) as HTMLInputElement).value).toBe("3");

    await userEvent.click(screen.getByRole("checkbox", { name: /AI 심층 질문/ }));
    await waitFor(() => expect(screen.queryByText("최대 후속 질문 수")).toBeNull());

    const probeCalls = updateQuestion.mock.calls.filter((c) => c[0] === "q2");
    const last = (probeCalls[probeCalls.length - 1][1] as {
      config?: { probe?: { enabled?: boolean; maxProbes?: number; guidance?: string } };
    }).config;
    expect(last?.probe?.enabled).toBe(false);
    // Settings survive the toggle so re-enabling restores them.
    expect(last?.probe?.maxProbes).toBe(3);
    expect(last?.probe?.guidance).toBe("사례 중심");
  });
});

describe("Editor option drag-and-drop", () => {
  const dnd = [
    {
      id: "q1",
      quid: "q_q1",
      type: "single" as const,
      order: 0,
      prompt: "선호",
      config: {
        options: [
          { id: "o_a", label: "가" },
          { id: "o_b", label: "나" },
          { id: "o_c", label: "다" },
          { id: "o_x", label: "기타", special: "other" as const },
        ],
      },
    },
  ];
  const dataTransfer = { effectAllowed: "", setData: () => {}, getData: () => "" };

  test("special options render no drag handle", () => {
    render(
      <Editor
        surveyId="s"
        initialTitle="t"
        initialQuestions={structuredClone(dnd)}
        initialWelcome=""
        initialClosing=""
      />,
    );
    expect(screen.getAllByTitle("드래그로 순서 변경")).toHaveLength(3);
  });

  test("dropping an option onto an earlier row persists the new order (specials anchored)", async () => {
    render(
      <Editor
        surveyId="s"
        initialTitle="t"
        initialQuestions={structuredClone(dnd)}
        initialWelcome=""
        initialClosing=""
      />,
    );

    // Drag "다" (3rd handle) and drop it on the row of "가".
    const handles = screen.getAllByTitle("드래그로 순서 변경");
    fireEvent.dragStart(handles[2], { dataTransfer });
    const rowA = screen.getByDisplayValue("가").parentElement!;
    fireEvent.dragOver(rowA, { dataTransfer, clientY: 0 });
    fireEvent.drop(rowA, { dataTransfer });

    await waitFor(() => {
      const calls = updateQuestion.mock.calls.filter((c) => c[0] === "q1");
      expect(calls.length).toBeGreaterThan(0);
      const cfg = (calls[calls.length - 1][1] as {
        config?: { options?: { label: string; special?: string }[] };
      }).config;
      expect(cfg?.options?.map((o) => o.label)).toEqual(["가", "다", "나", "기타"]);
      expect(cfg?.options?.[3].special).toBe("other");
    });
  });
});
