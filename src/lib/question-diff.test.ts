import { describe, expect, it } from "vitest";
import {
  changeNotesOf,
  materializeShowIf,
  mergeProposal,
  changeSummaryOf,
  diffOptions,
  diffQuestionsDetailed,
  summarizeRevisions,
  type RevisionQuestion,
} from "./question-diff";

function q(quid: string, prompt: string, order: number): RevisionQuestion {
  return { quid, type: "open", order, prompt, config: {} };
}

describe("changeSummaryOf", () => {
  it("returns null for the baseline (no predecessor)", () => {
    expect(changeSummaryOf(null, [q("a", "Q1", 0)])).toBeNull();
  });

  it("counts added / deleted / changed / reordered by quid", () => {
    const prev = [q("a", "Q1", 0), q("b", "Q2", 1), q("c", "Q3", 2)];
    const next = [
      q("b", "Q2", 0), // reordered (moved 1 -> 0)
      { ...q("c", "Q3 edited", 1) }, // changed (prompt differs)
      q("d", "Q4 new", 2), // added
      // "a" deleted
    ];
    expect(changeSummaryOf(prev, next)).toEqual({ added: 1, deleted: 1, changed: 1, reordered: 1 });
  });

  it("reports all zeros when nothing changed", () => {
    const s = [q("a", "Q1", 0), q("b", "Q2", 1)];
    expect(changeSummaryOf(s, s)).toEqual({ added: 0, deleted: 0, changed: 0, reordered: 0 });
  });
});

describe("summarizeRevisions", () => {
  const d = new Date("2026-07-03T00:00:00Z");
  it("orders newest-first and gives the baseline a null summary", () => {
    const rows = [
      { version: 1, reason: "초기 버전", createdAt: d, questionsSnapshot: [q("a", "Q1", 0)] },
      { version: 2, reason: "AI 수정", createdAt: d, questionsSnapshot: [q("a", "Q1", 0), q("b", "Q2", 1)] },
      { version: 3, reason: "삭제", createdAt: d, questionsSnapshot: [q("b", "Q2", 0)] },
    ];
    const out = summarizeRevisions(rows);
    expect(out.map((r) => r.version)).toEqual([3, 2, 1]); // newest-first
    const byV = Object.fromEntries(out.map((r) => [r.version, r]));
    expect(byV[1].changeSummary).toBeNull(); // baseline
    expect(byV[2].changeSummary).toEqual({ added: 1, deleted: 0, changed: 0, reordered: 0 }); // +Q2
    expect(byV[3].changeSummary).toEqual({ added: 0, deleted: 1, changed: 0, reordered: 1 }); // -Q1, Q2 moved up
    expect(byV[3].questionCount).toBe(1);
  });
});

describe("diffOptions", () => {
  it("detects added / deleted / renamed / reordered by option id", () => {
    const oldOpts = [
      { id: "o1", label: "A" },
      { id: "o2", label: "B" },
      { id: "o3", label: "C" },
    ];
    const newOpts = [
      { id: "o2", label: "B" }, // reordered (1 -> 0)
      { id: "o1", label: "A renamed" }, // renamed
      { id: "o4", label: "D" }, // added
      // o3 deleted
    ];
    const changes = diffOptions(oldOpts, newOpts);
    expect(changes).toContainEqual({ kind: "added", id: "o4", label: "D" });
    expect(changes).toContainEqual({ kind: "deleted", id: "o3", label: "C" });
    expect(changes).toContainEqual({ kind: "renamed", id: "o1", from: "A", to: "A renamed" });
    expect(changes).toContainEqual({ kind: "reordered", id: "o2", label: "B", from: 2, to: 1 });
  });

  it("legacy string options: a rename degrades to delete + add (no stable id)", () => {
    const changes = diffOptions(["yes", "no"], ["yes", "nope"]);
    const kinds = changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["added", "deleted"]);
  });
});

describe("diffQuestionsDetailed", () => {
  function opt(quid: string, prompt: string, order: number, options: { id: string; label: string }[]): RevisionQuestion {
    return { quid, type: "single", order, prompt, config: { options } };
  }

  it("reports per-question field and option changes", () => {
    const oldQs = [
      opt("a", "Fruit?", 0, [
        { id: "o1", label: "Apple" },
        { id: "o2", label: "Banana" },
      ]),
      q("b", "Comments?", 1),
      q("c", "Old one", 2),
    ];
    const newQs = [
      opt("a", "Favorite fruit?", 0, [
        { id: "o1", label: "Apple" },
        { id: "o2", label: "Banana!" }, // renamed
        { id: "o3", label: "Cherry" }, // added
      ]),
      q("b", "Comments?", 1), // unchanged
      q("d", "Brand new", 2), // added ("c" deleted)
    ];
    const details = diffQuestionsDetailed(oldQs, newQs);
    const byQuid = Object.fromEntries(details.map((d) => [d.quid, d]));

    // "a" changed: prompt field + one rename + one added option
    expect(byQuid.a.status).toBe("changed");
    expect(byQuid.a.fieldChanges).toContainEqual({ field: "prompt", from: "Fruit?", to: "Favorite fruit?" });
    expect(byQuid.a.optionChanges).toContainEqual({ kind: "renamed", id: "o2", from: "Banana", to: "Banana!" });
    expect(byQuid.a.optionChanges).toContainEqual({ kind: "added", id: "o3", label: "Cherry" });

    expect(byQuid.b.status).toBe("unchanged");
    expect(byQuid.d.status).toBe("added");
    expect(byQuid.c.status).toBe("deleted");
  });

  it("flags a pure move as reordered (no field/option changes)", () => {
    const oldQs = [q("a", "Q1", 0), q("b", "Q2", 1)];
    const newQs = [q("b", "Q2", 0), q("a", "Q1", 1)];
    const details = diffQuestionsDetailed(oldQs, newQs);
    const byQuid = Object.fromEntries(details.map((d) => [d.quid, d]));
    expect(byQuid.a.status).toBe("reordered");
    expect(byQuid.a.fromOrder).toBe(1);
    expect(byQuid.a.toOrder).toBe(2);
  });
});

describe("changeNotesOf", () => {
  it("baseline (no predecessor) yields no notes", () => {
    expect(changeNotesOf(null, [q("a", "Q1", 0)])).toEqual([]);
  });

  it("describes add / delete / move / field+option edits in plain Korean", () => {
    const prev: RevisionQuestion[] = [
      { quid: "a", type: "single", order: 0, prompt: "가격 만족도", config: { options: [{ id: "o1", label: "높다" }, { id: "o2", label: "낮다" }] } },
      q("b", "삭제될 문항", 1),
      q("c", "이동할 문항", 2),
    ];
    const next: RevisionQuestion[] = [
      q("c", "이동할 문항", 0),
      { quid: "a", type: "single", order: 1, prompt: "가격 만족도", config: { options: [{ id: "o1", label: "높다" }, { id: "o3", label: "적당하다" }] } },
      q("d", "새 문항", 2),
    ];
    const notes = changeNotesOf(prev, next);
    expect(notes).toContain('문항 이동: "이동할 문항" 3→1번');
    expect(notes).toContain('문항 추가: "새 문항"');
    expect(notes).toContain('문항 삭제: "삭제될 문항"');
    expect(notes).toContain('"가격 만족도" 보기(추가 1·삭제 1)');
  });

  it("caps at max lines with a trailing 외 N건", () => {
    const prev = [q("a", "Q1", 0)];
    const next = [q("a", "Q1", 0), q("b", "B", 1), q("c", "C", 2), q("d", "D", 3), q("e", "E", 4), q("f", "F", 5)];
    const notes = changeNotesOf(prev, next, 3);
    expect(notes).toHaveLength(4);
    expect(notes[3]).toBe("외 2건");
  });

  it("long prompts are shortened with an ellipsis", () => {
    const long = "아주 아주 아주 아주 길고 긴 문항 프롬프트입니다";
    const notes = changeNotesOf([], [{ ...q("a", long, 0) }]);
    expect(notes[0]).toContain("…");
    expect(notes[0].length).toBeLessThan(long.length + 12);
  });
});

describe("mergeProposal (partial apply)", () => {
  const cur = [q("a", "Q1", 0), q("b", "Q2", 1), q("c", "Q3", 2)];
  const prop: RevisionQuestion[] = [
    { ...q("a", "Q1 수정됨", 0) }, // changed
    // "b" deleted
    { ...q("c", "Q3", 1) }, // unchanged
    { ...q("d", "Q4 신규", 2), showIf: { match: "all", conditions: [{ ref: 1, op: "eq", value: "x" }] } }, // added, gated on proposal #1 (=a)
  ];

  it("all accepted equals the proposal (orders normalized)", () => {
    const out = mergeProposal(cur, prop, new Set(["a", "b", "d"]));
    expect(out.map((x) => x.quid)).toEqual(["a", "c", "d"]);
    expect(out[0].prompt).toBe("Q1 수정됨");
    expect(out.map((x) => x.order)).toEqual([0, 1, 2]);
  });

  it("unaccepted edit keeps current content at the proposal position", () => {
    const out = mergeProposal(cur, prop, new Set(["b", "d"]));
    expect(out.find((x) => x.quid === "a")?.prompt).toBe("Q1");
  });

  it("unaccepted addition is dropped and its showIf conditions vanish with it", () => {
    const out = mergeProposal(cur, prop, new Set(["a", "b"]));
    expect(out.some((x) => x.quid === "d")).toBe(false);
  });

  it("unaccepted deletion is re-inserted after its surviving predecessor", () => {
    const out = mergeProposal(cur, prop, new Set(["a", "d"]));
    expect(out.map((x) => x.quid)).toEqual(["a", "b", "c", "d"]);
    expect(out.find((x) => x.quid === "b")?.prompt).toBe("Q2");
  });

  it("showIf refs are remapped when re-insertions shift positions", () => {
    // deletion of b rejected → b re-inserted at index 1, shifting c/d down.
    const out = mergeProposal(cur, prop, new Set(["a", "d"]));
    const d = out.find((x) => x.quid === "d");
    // d's condition referenced proposal #1 (quid a) — still merged position 1.
    expect(d?.showIf?.conditions[0].ref).toBe(1);
    // now gate d on proposal #2 (quid c) instead and reject b's deletion:
    const prop2 = prop.map((p) =>
      p.quid === "d" ? { ...p, showIf: { match: "all" as const, conditions: [{ ref: 2, op: "eq" as const, value: "y" }] } } : p,
    );
    const out2 = mergeProposal(cur, prop2, new Set(["a", "d"]));
    const d2 = out2.find((x) => x.quid === "d");
    // c sits at merged position 3 (a, b, c, d) — ref must follow it there.
    expect(d2?.showIf?.conditions[0].ref).toBe(3);
  });
});

describe("mergeProposal — field-level acceptance", () => {
  const cur: RevisionQuestion = {
    quid: "a",
    type: "single",
    order: 0,
    prompt: "혜택을 선택해 주세요",
    config: {
      options: [{ id: "o1", label: "할인" }],
      displayLogic: { match: "all", conditions: [{ questionId: "live-1", op: "eq", value: "구독 중" }] },
      meta: { construct: "혜택 이용", origin: "ai" },
    },
  };
  const prop: RevisionQuestion = {
    quid: "a",
    type: "single",
    order: 0,
    prompt: "이용해 보신 혜택을 모두 선택해 주세요",
    config: {
      options: [{ id: "o1", label: "할인" }, { id: "o2", label: "이용한 혜택 없음" }],
      meta: { construct: "혜택 이용 경험", origin: "ai" },
    },
    showIf: { match: "all", conditions: [{ ref: 1, op: "eq", value: "예" }] },
  };

  it("options-only accept: new options, current prompt/logic kept, no showIf", () => {
    const out = mergeProposal([cur], [prop], { a: ["options"] });
    const q = out[0];
    expect(q.prompt).toBe("혜택을 선택해 주세요");
    expect((q.config.options as { label: string }[]).map((o) => o.label)).toContain("이용한 혜택 없음");
    expect(q.config.displayLogic).toEqual(cur.config.displayLogic);
    expect(q.showIf).toBeUndefined();
  });

  it("displayLogic-only accept: current options kept, proposed showIf carried", () => {
    const out = mergeProposal([cur], [prop], { a: ["displayLogic"] });
    const q = out[0];
    expect((q.config.options as unknown[]).length).toBe(1);
    expect(q.config.displayLogic).toBeUndefined(); // proposal has no config logic — replaced by showIf
    expect(q.showIf?.conditions[0].value).toBe("예");
  });

  it("meta rides along silently (AI-origin) even when the question is skipped", () => {
    const out = mergeProposal([cur], [prop], {});
    expect(out[0].config.meta?.construct).toBe("혜택 이용 경험");
    expect(out[0].prompt).toBe(cur.prompt);
  });

  it("human-entered meta is never overwritten", () => {
    const humanCur = { ...cur, config: { ...cur.config, meta: { construct: "내가 정한 개념", origin: "human" as const } } };
    const out = mergeProposal([humanCur], [prop], { a: true });
    expect(out[0].config.meta?.construct).toBe("내가 정한 개념");
    expect(out[0].prompt).toBe(prop.prompt); // rest of the proposal still applies
  });

  it("type change is all-or-nothing: selecting type takes the proposed structure", () => {
    const typeProp: RevisionQuestion = {
      quid: "a", type: "scale", order: 0, prompt: "혜택 만족도",
      config: { scale: { min: 1, max: 5 }, meta: { construct: "혜택 만족", origin: "ai" } },
    };
    const out = mergeProposal([cur], [typeProp], { a: ["type"] });
    expect(out[0].type).toBe("scale");
    expect(out[0].config.scale).toEqual({ min: 1, max: 5 });
    expect(out[0].config.options).toBeUndefined();
  });
});

describe("materializeShowIf (proposal diff parity)", () => {
  it("echoed condition materializes to config.displayLogic → no false change", () => {
    const cur: RevisionQuestion[] = [
      { quid: "gate", type: "single", order: 0, prompt: "상태?", config: { options: [{ id: "o1", label: "이용 중" }] } },
      { quid: "dep", type: "scale", order: 1, prompt: "만족도?", config: { scale: { min: 1, max: 5 }, displayLogic: { match: "all", conditions: [{ questionId: "live-gate", op: "eq", value: "이용 중" }] } } },
    ];
    const proposed: RevisionQuestion[] = [
      { quid: "gate", type: "single", order: 0, prompt: "상태?", config: { options: [{ id: "o1", label: "이용 중" }] } },
      { quid: "dep", type: "scale", order: 1, prompt: "만족도?", config: { scale: { min: 1, max: 5 } }, showIf: { match: "all", conditions: [{ ref: 1, op: "eq", value: "이용 중" }] } },
    ];
    const out = materializeShowIf(proposed, new Map([["gate", "live-gate"], ["dep", "live-dep"]]));
    expect(out[1].config.displayLogic).toEqual(cur[1].config.displayLogic);
    const details = diffQuestionsDetailed(cur, out);
    expect(details.find((d) => d.quid === "dep")?.status).toBe("unchanged");
  });

  it("condition citing a NEW question stays ref-form (not materialized)", () => {
    const proposed: RevisionQuestion[] = [
      { quid: "newq", type: "single", order: 0, prompt: "새 스크리닝", config: { options: [{ id: "o1", label: "예" }] } },
      { quid: "dep", type: "scale", order: 1, prompt: "만족도?", config: { scale: { min: 1, max: 5 } }, showIf: { match: "all", conditions: [{ ref: 1, op: "eq", value: "예" }] } },
    ];
    const out = materializeShowIf(proposed, new Map([["dep", "live-dep"]])); // newq has no live id
    expect(out[1].config.displayLogic).toBeUndefined();
    expect(out[1].showIf).toBeDefined();
  });
});

describe("stable config comparison (jsonb key-order parity)", () => {
  it("same content with different key order is NOT a change", () => {
    const a: RevisionQuestion = {
      quid: "q", type: "scale", order: 0, prompt: "만족도",
      config: {
        displayLogic: { match: "all", conditions: [{ questionId: "x", op: "eq", value: "이용 중" }] },
        scale: { min: 1, max: 5 },
        meta: { construct: "고객 만족도", topic: "만족", origin: "ai" },
      },
    };
    // jsonb-style: keys sorted differently at every level
    const b: RevisionQuestion = {
      quid: "q", type: "scale", order: 0, prompt: "만족도",
      config: JSON.parse(
        '{"meta":{"origin":"ai","topic":"만족","construct":"고객 만족도"},"scale":{"max":5,"min":1},"displayLogic":{"conditions":[{"value":"이용 중","questionId":"x","op":"eq"}],"match":"all"}}',
      ),
    };
    const details = diffQuestionsDetailed([a], [b]);
    expect(details[0].status).toBe("unchanged");
  });
});

describe("materializeShowIf — optionsFromRef", () => {
  it("carry-forward ref to an existing question materializes to config.optionsFrom", () => {
    const proposed: RevisionQuestion[] = [
      { quid: "src", type: "multi", order: 0, prompt: "이유 모두", config: { options: [{ id: "o1", label: "A" }] } },
      { quid: "dep", type: "single", order: 1, prompt: "가장 큰 이유", config: {}, optionsFromRef: { ref: 1, mode: "selected" } },
    ];
    const out = materializeShowIf(proposed, new Map([["src", "live-src"], ["dep", "live-dep"]]));
    expect(out[1].config.optionsFrom).toEqual({ questionId: "live-src", mode: "selected" });
  });
});
