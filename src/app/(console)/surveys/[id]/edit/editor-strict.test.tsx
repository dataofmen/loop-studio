import { describe, test, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const updateQuestion = vi.fn(async () => {});
vi.mock("./actions", () => ({
  addQuestion: vi.fn(async () => ({ id: "new", type: "open", order: 99, prompt: "새", config: {} })),
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
      displayLogic: { match: "all" as const, conditions: [{ questionId: "q1", op: "in" as const, value: ["1개월 미만"] }] },
    },
  },
];

beforeEach(() => updateQuestion.mockClear());

describe("Editor delete under StrictMode (matches Next dev)", () => {
  test("delete hides box, no resurrection under StrictMode", async () => {
    render(
      <StrictMode>
        <Editor surveyId="s" initialTitle="t" initialQuestions={structuredClone(initialQuestions)} initialWelcome="" initialClosing="" />
      </StrictMode>,
    );
    expect(screen.queryByText("현재 적용된 조건")).toBeTruthy();
    await userEvent.click(screen.getByText("조건 삭제"));
    await waitFor(() => expect(screen.queryByText("현재 적용된 조건")).toBeNull());
    await new Promise((r) => setTimeout(r, 1200));
    const q2 = updateQuestion.mock.calls.filter((c) => c[0] === "q2");
    console.log("q2 updateQuestion calls:", q2.map((c) => ({ hasDL: !!(c[1] as any)?.config?.displayLogic, src: c[2] })));
    expect(q2.some((c) => (c[1] as any)?.config?.displayLogic)).toBe(false);
    expect(screen.queryByText("현재 적용된 조건")).toBeNull();
  });
});
