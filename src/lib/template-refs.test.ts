import { describe, expect, it } from "vitest";
import type { QConfig, RevisionQuestion } from "@/lib/question-diff";
import { describeDroppedRefs, remapConfigRefs, remapSnapshotRefs } from "@/lib/template-refs";

const opts = (labels: string[]) => labels.map((label, i) => ({ id: `o${i}`, label }));

describe("remapConfigRefs", () => {
  it("rewrites displayLogic condition refs through the map", () => {
    const config: QConfig = {
      options: opts(["예", "아니오"]),
      displayLogic: {
        match: "all",
        conditions: [{ questionId: "live-1", op: "eq", value: "예" }],
      },
    };
    const { config: out, droppedKinds } = remapConfigRefs(
      config,
      new Map([["live-1", "q_abc12345"]]),
      { dropUnmapped: true },
    );
    expect(out.displayLogic?.conditions[0].questionId).toBe("q_abc12345");
    expect(droppedKinds).toEqual([]);
    // input untouched
    expect(config.displayLogic?.conditions[0].questionId).toBe("live-1");
  });

  it("drops unmapped conditions when dropUnmapped=true and reports the drop", () => {
    const config: QConfig = {
      displayLogic: {
        match: "all",
        conditions: [
          { questionId: "in-snap", op: "eq", value: "예" },
          { questionId: "outside", op: "eq", value: "아니오" },
        ],
      },
    };
    const { config: out, droppedKinds } = remapConfigRefs(config, new Map([["in-snap", "q_new"]]), {
      dropUnmapped: true,
    });
    expect(out.displayLogic?.conditions).toHaveLength(1);
    expect(out.displayLogic?.conditions[0].questionId).toBe("q_new");
    expect(droppedKinds).toEqual(["displayLogic"]);
  });

  it("removes displayLogic entirely when every condition drops", () => {
    const config: QConfig = {
      displayLogic: { match: "any", conditions: [{ questionId: "gone", op: "eq", value: "x" }] },
    };
    const { config: out, droppedKinds } = remapConfigRefs(config, new Map(), {
      dropUnmapped: true,
    });
    expect(out.displayLogic).toBeUndefined();
    expect(droppedKinds).toEqual(["displayLogic"]);
  });

  it("keeps unmapped refs verbatim when dropUnmapped=false (save-time whole-survey path)", () => {
    const config: QConfig = {
      displayLogic: { match: "all", conditions: [{ questionId: "stale", op: "eq", value: "x" }] },
      optionsFrom: { questionId: "stale2", mode: "selected" },
    };
    const { config: out, droppedKinds } = remapConfigRefs(config, new Map(), {
      dropUnmapped: false,
    });
    expect(out.displayLogic?.conditions[0].questionId).toBe("stale");
    expect(out.optionsFrom?.questionId).toBe("stale2");
    expect(droppedKinds).toEqual([]);
  });

  it("rewrites optionsFrom and drops it when unmapped", () => {
    const mapped = remapConfigRefs(
      { optionsFrom: { questionId: "live-2", mode: "selected" } },
      new Map([["live-2", "q_src"]]),
      { dropUnmapped: true },
    );
    expect(mapped.config.optionsFrom).toEqual({ questionId: "q_src", mode: "selected" });
    expect(mapped.droppedKinds).toEqual([]);

    const droppedOut = remapConfigRefs(
      { optionsFrom: { questionId: "outside", mode: "selected" } },
      new Map(),
      { dropUnmapped: true },
    );
    expect(droppedOut.config.optionsFrom).toBeUndefined();
    expect(droppedOut.droppedKinds).toEqual(["optionsFrom"]);
  });

  it("passes through configs without refs unchanged", () => {
    const config: QConfig = { options: opts(["a", "b"]), randomizeOptions: true };
    const { config: out, droppedKinds } = remapConfigRefs(config, new Map(), {
      dropUnmapped: true,
    });
    expect(out).toEqual(config);
    expect(droppedKinds).toEqual([]);
  });
});

describe("remapSnapshotRefs", () => {
  const snapshot: RevisionQuestion[] = [
    { quid: "q_a", type: "multi", order: 0, prompt: "사용 이유", config: { options: opts(["가격", "품질"]) } },
    {
      quid: "q_b",
      type: "single",
      order: 1,
      prompt: "결정적 이유",
      config: {
        optionsFrom: { questionId: "id-a", mode: "selected" },
        displayLogic: { match: "all", conditions: [{ questionId: "id-x", op: "eq", value: "y" }] },
      },
    },
  ];

  it("collects per-question drops with prompts (subset path)", () => {
    const idMap = new Map([["id-a", "q_a"]]); // id-x is outside the selection
    const { questions, dropped } = remapSnapshotRefs(snapshot, idMap, { dropUnmapped: true });
    expect(questions[1].config.optionsFrom).toEqual({ questionId: "q_a", mode: "selected" });
    expect(questions[1].config.displayLogic).toBeUndefined();
    expect(dropped).toEqual([{ prompt: "결정적 이유", kind: "displayLogic" }]);
  });
});

describe("describeDroppedRefs", () => {
  it("returns null when nothing dropped", () => {
    expect(describeDroppedRefs([])).toBeNull();
  });

  it("names the question and the dropped feature in Korean", () => {
    const msg = describeDroppedRefs([
      { prompt: "결정적 이유는 무엇인가요? (아주 긴 문항 텍스트)", kind: "optionsFrom" },
      { prompt: "추가 의견", kind: "displayLogic" },
    ]);
    expect(msg).toContain("보기 가져오기");
    expect(msg).toContain("표시 조건");
    expect(msg).toContain("추가 의견");
    // prompt truncated to keep the notice compact
    expect(msg).not.toContain("아주 긴 문항 텍스트");
  });
});
