import { describe, test, expect } from "vitest";
import {
  buildExportSchema,
  buildSpssSyntax,
  buildCodebook,
  flattenResponse,
  jsonlRecord,
  longRows,
  questionShown,
  toCsv,
  SEEN_UNANSWERED_CODE,
  type ExportQuestion,
} from "./export-core";

// A compact survey exercising every question type, display logic,
// carry-forward, an "other" option and probes.
const QUESTIONS: ExportQuestion[] = [
  {
    id: "q-status",
    type: "single",
    order: 1,
    prompt: "이용 상태를 선택해 주세요.",
    config: { options: ["현재 구독 중", "해지함"] },
  },
  {
    id: "q-reasons",
    type: "multi",
    order: 2,
    prompt: "해지 이유를 모두 선택해 주세요.",
    config: {
      options: ["가격", "품질", { label: "기타", special: "other" }],
      displayLogic: {
        match: "all",
        conditions: [{ questionId: "q-status", op: "eq", value: "해지함" }],
      },
    },
  },
  {
    id: "q-top",
    type: "single",
    order: 3,
    prompt: "가장 큰 이유 하나를 선택해 주세요.",
    config: { optionsFrom: { questionId: "q-reasons" } },
  },
  {
    id: "q-sat",
    type: "scale",
    order: 4,
    prompt: "만족도는 어느 정도였나요?",
    config: { scale: { min: 1, max: 5 } },
  },
  {
    id: "q-nps",
    type: "nps",
    order: 5,
    prompt: "추천 의향은?",
    config: {},
  },
  {
    id: "q-rank",
    type: "ranking",
    order: 6,
    prompt: "중요한 순서대로 2개를 골라주세요.",
    config: { options: ["가격", "맛", "배송"], limit: 2 },
  },
  {
    id: "q-matrix",
    type: "matrix",
    order: 7,
    prompt: "각 항목을 평가해 주세요.",
    config: { rows: ["가격", "배송"], columns: ["불만", "보통", "만족"] },
  },
  {
    id: "q-open",
    type: "open",
    order: 8,
    prompt: "자유롭게 적어주세요.",
    config: {},
  },
];

const CHURNED = {
  answers: {
    "q-status": "해지함",
    "q-reasons": ["가격", "기타"],
    "q-top": "가격",
    "q-sat": "2",
    "q-nps": "3",
    "q-rank": ["맛", "가격"],
    "q-matrix": { 가격: "불만", 배송: "보통" },
    "q-open": { answer: "너무 비쌌어요", probes: [{ q: "어떤 점이요?", a: "배송비요" }] },
  },
  otherTexts: { "q-reasons": "앱이 불편해서" },
};

// Active subscriber: display logic hides q-reasons, carry-forward source
// empty hides q-top; sat left unanswered (seen).
const ACTIVE = {
  answers: {
    "q-status": "현재 구독 중",
    "q-nps": "9",
    "q-rank": ["배송", "맛"],
    "q-matrix": { 가격: "만족", 배송: "만족" },
    "q-open": "만족합니다",
  },
  otherTexts: {},
};

describe("buildExportSchema", () => {
  test("codes+expand: variable names, one-hot, ranks, matrix rows, probes, other", () => {
    const schema = buildExportSchema(QUESTIONS, { values: "codes", multi: "expand" }, { "q-open": 1 });
    expect(schema.variables.map((v) => v.name)).toEqual([
      "q01",
      "q02_1", "q02_2", "q02_3", "q02_other",
      "q03",
      "q04",
      "q05",
      "q06_r1", "q06_r2",
      "q07_1", "q07_2",
      "q08", "q08_probe1_q", "q08_probe1_a",
    ]);
    const q01 = schema.variables.find((v) => v.name === "q01")!;
    expect(q01.varType).toBe("numeric");
    expect(q01.valueLabels).toEqual({ "1": "현재 구독 중", "2": "해지함" });
    // carry-forward question inherits SOURCE options for stable coding
    const q03 = schema.variables.find((v) => v.name === "q03")!;
    expect(q03.valueLabels).toEqual({ "1": "가격", "2": "품질", "3": "기타" });
  });

  test("labels+merge: multi collapses to one string variable", () => {
    const schema = buildExportSchema(QUESTIONS, { values: "labels", multi: "merge" });
    const names = schema.variables.map((v) => v.name);
    expect(names).toContain("q02");
    expect(names).not.toContain("q02_1");
    expect(schema.variables.find((v) => v.name === "q01")!.varType).toBe("string");
  });
});

describe("questionShown", () => {
  test("display logic hides q-reasons for active subscriber", () => {
    expect(questionShown(QUESTIONS[1], ACTIVE.answers)).toBe(false);
    expect(questionShown(QUESTIONS[1], CHURNED.answers)).toBe(true);
  });
  test("carry-forward with unanswered source is not shown", () => {
    expect(questionShown(QUESTIONS[2], ACTIVE.answers)).toBe(false);
    expect(questionShown(QUESTIONS[2], CHURNED.answers)).toBe(true);
  });
});

describe("flattenResponse (codes + expand)", () => {
  const schema = buildExportSchema(QUESTIONS, { values: "codes", multi: "expand" }, { "q-open": 1 });

  test("churned respondent: full coding", () => {
    const flat = flattenResponse(schema, CHURNED);
    expect(flat.q01).toBe(2); // 해지함
    expect(flat.q02_1).toBe(1); // 가격 selected
    expect(flat.q02_2).toBe(0); // 품질 not selected
    expect(flat.q02_3).toBe(1); // 기타 selected
    expect(flat.q02_other).toBe("앱이 불편해서");
    expect(flat.q03).toBe(1); // 가격 = source option 1
    expect(flat.q04).toBe(2);
    expect(flat.q05).toBe(3);
    expect(flat.q06_r1).toBe(2); // 맛 first
    expect(flat.q06_r2).toBe(1); // 가격 second
    expect(flat.q07_1).toBe(1); // 가격 → 불만
    expect(flat.q07_2).toBe(2); // 배송 → 보통
    expect(flat.q08).toBe("너무 비쌌어요");
    expect(flat.q08_probe1_q).toBe("어떤 점이요?");
    expect(flat.q08_probe1_a).toBe("배송비요");
  });

  test("active respondent: not-shown blank vs seen-unanswered -99", () => {
    const flat = flattenResponse(schema, ACTIVE);
    // not shown (display logic / empty carry-forward) → blank
    expect(flat.q02_1).toBe("");
    expect(flat.q03).toBe("");
    // seen but unanswered numeric → -99
    expect(flat.q04).toBe(SEEN_UNANSWERED_CODE);
    expect(flat.q05).toBe(9);
  });

  test("labels mode keeps option text", () => {
    const labelSchema = buildExportSchema(QUESTIONS, { values: "labels", multi: "merge" });
    const flat = flattenResponse(labelSchema, CHURNED);
    expect(flat.q01).toBe("해지함");
    expect(flat.q02).toBe("가격; 기타");
    expect(flat.q07_1).toBe("불만");
  });
});

describe("longRows", () => {
  const schema = buildExportSchema(QUESTIONS, { values: "codes", multi: "expand" }, { "q-open": 1 });
  const meta = {
    responseId: "r-1",
    personaId: "p-1",
    createdAt: "2026-07-10T00:00:00.000Z",
  };

  test("one row per value; multi expands; not-shown emits nothing", () => {
    const rows = longRows(schema, meta, ACTIVE);
    const vars = rows.map((r) => r[3]);
    expect(vars).not.toContain("q02"); // not shown → no rows
    expect(vars).not.toContain("q03");
    // seen-unanswered scale → single -99 row
    const satRow = rows.find((r) => r[3] === "q04")!;
    expect(satRow[6]).toBe(SEEN_UNANSWERED_CODE);
  });

  test("multi and probes become separate rows with code+label", () => {
    const rows = longRows(schema, meta, CHURNED);
    const multiRows = rows.filter((r) => r[3] === "q02");
    expect(multiRows.map((r) => [r[6], r[7]])).toEqual([
      [1, "가격"],
      [3, "기타"],
    ]);
    expect(rows.some((r) => r[3] === "q08_probe1_q" && r[7] === "어떤 점이요?")).toBe(true);
    // other free text mirrors the wide qNN_other column as its own row
    expect(rows.some((r) => r[3] === "q02_other" && r[7] === "앱이 불편해서")).toBe(true);
  });
});

describe("jsonlRecord", () => {
  const schema = buildExportSchema(QUESTIONS, { values: "codes", multi: "expand" }, { "q-open": 1 });
  const meta = {
    responseId: "r-1",
    personaId: "p-1",
    createdAt: "2026-07-10T00:00:00.000Z",
    surveyVersion: 2,
  };

  test("structured answers with codes, labels, probes and not_shown list", () => {
    const rec = jsonlRecord(schema, meta, CHURNED) as {
      answers: Record<string, unknown>;
      not_shown?: string[];
    };
    expect(rec.answers.q01).toEqual({ type: "single", code: 2, label: "해지함" });
    expect(rec.answers.q02).toEqual({
      type: "multi",
      selected: [
        { code: 1, label: "가격" },
        { code: 3, label: "기타" },
      ],
      other_text: "앱이 불편해서",
    });
    expect(rec.answers.q08).toEqual({
      type: "open",
      text: "너무 비쌌어요",
      probes: [{ q: "어떤 점이요?", a: "배송비요" }],
    });
    expect(rec.not_shown).toBeUndefined();

    const rec2 = jsonlRecord(schema, meta, ACTIVE) as { answers: Record<string, unknown>; not_shown?: string[] };
    expect(rec2.not_shown).toEqual(["q02", "q03"]);
    expect(rec2.answers.q04).toBeNull(); // seen but unanswered
  });
});

describe("buildSpssSyntax", () => {
  test("declares variables, labels, value labels and -99 missing", () => {
    const schema = buildExportSchema(QUESTIONS, { values: "codes", multi: "expand" });
    const sps = buildSpssSyntax(schema);
    expect(sps).toContain("GET DATA");
    expect(sps).toContain("/FIRSTCASE=2");
    expect(sps).toContain("  q01 F8.0");
    expect(sps).toContain("  q08 A2000");
    expect(sps).toContain('VARIABLE LABELS');
    expect(sps).toContain('  q01 "이용 상태를 선택해 주세요."');
    expect(sps).toContain('    1 "현재 구독 중"');
    expect(sps).toMatch(/MISSING VALUES .*q01.* \(-99\)\./);
    expect(sps.trim().endsWith("EXECUTE.")).toBe(true);
  });

  test("escapes double quotes in labels", () => {
    const qs: ExportQuestion[] = [
      { id: "a", type: "single", order: 1, prompt: '별칭 "루프" 사용', config: { options: ['좋음 "최고"'] } },
    ];
    const sps = buildSpssSyntax(buildExportSchema(qs, { values: "codes", multi: "expand" }));
    expect(sps).toContain('"별칭 ""루프"" 사용"');
    expect(sps).toContain('"좋음 ""최고"""');
  });
});

describe("buildCodebook + toCsv", () => {
  test("codebook carries conventions, questions and variables", () => {
    const schema = buildExportSchema(QUESTIONS, { values: "codes", multi: "expand" });
    const cb = buildCodebook(schema, {
      surveyId: "s-1",
      title: "테스트",
      goal: "목표",
      exportedAt: "2026-07-10T00:00:00.000Z",
      realCount: 2,
      syntheticCount: 0,
      options: { values: "codes", multi: "expand", includeSynthetic: false, includeRejected: false },
    });
    expect(cb.questions).toHaveLength(8);
    expect(cb.questions[1].display_logic).toBeTruthy();
    expect(cb.variables.find((v) => v.name === "q01")!.value_labels).toEqual({
      "1": "현재 구독 중",
      "2": "해지함",
    });
    expect(cb.conventions.missing_seen_unanswered).toContain("-99");
  });

  test("toCsv escapes commas, quotes and newlines", () => {
    expect(toCsv([["a,b", 'say "hi"', "line\nbreak"]])).toBe('"a,b","say ""hi""","line\nbreak"');
  });
});
