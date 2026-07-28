import { describe, expect, it } from "vitest";
import {
  displayLogicToShowIf,
  sanitizeShowIf,
  showIfToDisplayLogic,
  type DisplayLogic,
} from "./display-logic";

describe("sanitizeShowIf", () => {
  it("accepts a well-formed showIf and defaults match to all", () => {
    const s = sanitizeShowIf({ conditions: [{ ref: 1, op: "eq", value: "구독 중" }] });
    expect(s).toEqual({ match: "all", conditions: [{ ref: 1, op: "eq", value: "구독 중" }] });
  });

  it("drops junk: bad refs, unknown ops, empty in-sets, empty scalars", () => {
    const s = sanitizeShowIf({
      match: "any",
      conditions: [
        { ref: 0, op: "eq", value: "x" }, // ref < 1
        { ref: 2, op: "maybe", value: "x" }, // unknown op
        { ref: 2, op: "in", value: [] }, // empty set
        { ref: 2, op: "eq", value: "" }, // empty scalar
        { ref: 2, op: "in", value: "단일값" }, // scalar → wrapped
      ],
    });
    expect(s).toEqual({ match: "any", conditions: [{ ref: 2, op: "in", value: ["단일값"] }] });
  });

  it("returns undefined for non-objects and empty results", () => {
    expect(sanitizeShowIf(null)).toBeUndefined();
    expect(sanitizeShowIf("showIf")).toBeUndefined();
    expect(sanitizeShowIf({ conditions: [{ ref: -1, op: "eq", value: "x" }] })).toBeUndefined();
  });
});

describe("showIfToDisplayLogic", () => {
  const ids = ["id-1", "id-2", "id-3"];
  it("resolves refs to live question ids", () => {
    const logic = showIfToDisplayLogic(
      { match: "all", conditions: [{ ref: 1, op: "eq", value: "구독 중" }] },
      (ref) => ids[ref - 1],
    );
    expect(logic).toEqual({
      match: "all",
      conditions: [{ questionId: "id-1", op: "eq", value: "구독 중" }],
    });
  });

  it("drops out-of-range and self references; undefined when none survive", () => {
    const logic = showIfToDisplayLogic(
      { match: "all", conditions: [{ ref: 9, op: "eq", value: "x" }, { ref: 2, op: "eq", value: "y" }] },
      (ref) => ids[ref - 1],
      2, // self is ref 2
    );
    expect(logic).toBeUndefined();
  });
});

describe("displayLogicToShowIf", () => {
  it("round-trips stored logic into ref form and back", () => {
    const stored: DisplayLogic = {
      match: "any",
      conditions: [
        { questionId: "id-2", op: "in", value: ["할인", "무료배달"] },
        { questionId: "ghost", op: "eq", value: "x" }, // unknown → dropped
      ],
    };
    const refOf = (id: string) => (id === "id-2" ? 2 : undefined);
    const showIf = displayLogicToShowIf(stored, refOf);
    expect(showIf).toEqual({ match: "any", conditions: [{ ref: 2, op: "in", value: ["할인", "무료배달"] }] });
    const back = showIfToDisplayLogic(showIf!, (ref) => ["id-1", "id-2"][ref - 1]);
    expect(back).toEqual({ match: "any", conditions: [{ questionId: "id-2", op: "in", value: ["할인", "무료배달"] }] });
  });
});
