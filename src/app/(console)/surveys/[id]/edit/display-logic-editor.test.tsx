import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The component imports the server action module (which pulls in the DB); mock it.
vi.mock("./actions", () => ({ compileDisplayLogicAction: vi.fn() }));

import { DisplayLogicEditor } from "./display-logic-editor";

const prior = [
  { id: "q1", type: "single" as const, prompt: "기간", config: { options: ["1개월 미만", "1년 이상"] } },
];
function makeQ() {
  return {
    id: "q2",
    type: "open" as const,
    prompt: "이유",
    config: {
      displayLogic: {
        match: "all" as const,
        conditions: [{ questionId: "q1", op: "in" as const, value: ["1개월 미만"] }],
      },
    },
  };
}

describe("DisplayLogicEditor delete", () => {
  test('"조건 삭제" fires onChange(undefined)', async () => {
    const onChange = vi.fn();
    render(
      <DisplayLogicEditor surveyId="s" question={makeQ()} priorQuestions={prior} onChange={onChange} />,
    );
    expect(screen.getByText("조건 삭제")).toBeTruthy();
    await userEvent.click(screen.getByText("조건 삭제"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(undefined, "clear");
  });

  test('"항상 표시" radio fires onChange(undefined)', async () => {
    const onChange = vi.fn();
    render(
      <DisplayLogicEditor surveyId="s" question={makeQ()} priorQuestions={prior} onChange={onChange} />,
    );
    await userEvent.click(screen.getByLabelText("항상 표시"));
    expect(onChange).toHaveBeenCalledWith(undefined, "clear");
  });

  test('"조건부 표시" does NOT auto-create a condition; "+ 조건 추가" does', async () => {
    const onChange = vi.fn();
    const always = { id: "q2", type: "open" as const, prompt: "이유", config: {} };
    render(
      <DisplayLogicEditor surveyId="s" question={always} priorQuestions={prior} onChange={onChange} />,
    );
    await userEvent.click(screen.getByLabelText("조건부 표시"));
    // entering conditional mode must NOT persist anything
    expect(onChange).not.toHaveBeenCalled();
    // no applied-condition summary yet, but the add button is present
    expect(screen.queryByText("현재 적용된 조건")).toBeNull();
    expect(screen.getByText("+ 조건 추가")).toBeTruthy();
    // adding a condition DOES persist one
    await userEvent.click(screen.getByText("+ 조건 추가"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg?.conditions?.length).toBe(1);
    expect(arg.conditions[0].value).toEqual(["1개월 미만"]); // non-empty default
  });

  test("box hides when question prop loses displayLogic (parent re-render)", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DisplayLogicEditor surveyId="s" question={makeQ()} priorQuestions={prior} onChange={onChange} />,
    );
    expect(screen.queryByText("현재 적용된 조건")).toBeTruthy();
    // simulate parent removing displayLogic
    rerender(
      <DisplayLogicEditor
        surveyId="s"
        question={{ id: "q2", type: "open", prompt: "이유", config: {} }}
        priorQuestions={prior}
        onChange={onChange}
      />,
    );
    expect(screen.queryByText("현재 적용된 조건")).toBeNull();
  });
});
