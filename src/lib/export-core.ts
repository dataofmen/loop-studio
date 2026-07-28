/**
 * Analysis-ready export core (US-401) — PURE module, no DB/IO imports.
 *
 * Single source of truth for variable naming, value coding, missing-value
 * conventions and row flattening shared by every export format (wide CSV,
 * long/tidy CSV, AI JSONL bundle, SPSS bundle). The DB-facing assembly lives
 * in src/lib/export.ts.
 *
 * Conventions (see tasks/prd-analysis-ready-export.md §4):
 * - Variables are `q01`, `q02`, … by question order; multi-select expands to
 *   `q05_1..k` binaries (Qualtrics/SurveyMonkey posture), ranking to
 *   `q06_r1..rk`, matrix to `q07_1..m` (one per row), probes to
 *   `q08_probe1_q/_a`, other-text to `q05_other`.
 * - codes mode: single options are coded 1..k in authored order; scale/nps
 *   keep their numeric answer; multi binaries are 1/0.
 * - Missing: NOT SHOWN (display logic) → empty cell everywhere.
 *   SEEN BUT UNANSWERED → -99 on numeric variables in codes mode (declared
 *   in the codebook / SPSS MISSING VALUES), empty otherwise.
 */

import { questionVisible, type DisplayLogic } from "@/lib/display-logic";
import { normalizeOptions } from "@/lib/question-config";
import { openAnswerProbes, openAnswerText } from "@/lib/open-answer";

export type ExportQuestionType =
  | "single"
  | "multi"
  | "scale"
  | "open"
  | "ranking"
  | "matrix"
  | "nps";

export interface ExportQuestion {
  id: string;
  type: ExportQuestionType;
  order: number;
  prompt: string;
  config: {
    options?: unknown;
    scale?: { min?: number; max?: number };
    rows?: string[];
    columns?: string[];
    limit?: number;
    displayLogic?: DisplayLogic;
    optionsFrom?: { questionId?: string } | null;
  } | null;
}

export interface ExportValueOptions {
  values: "labels" | "codes";
  multi: "expand" | "merge";
}

export type VariableRole =
  | "answer"
  | "option"
  | "other"
  | "rank"
  | "matrix_row"
  | "probe_q"
  | "probe_a";

export interface ExportVariable {
  /** Stable analysis name (q01, q05_2, q08_probe1_q, …). */
  name: string;
  questionId: string;
  /** 1-based question number (drives the q## prefix). */
  questionNumber: number;
  questionType: ExportQuestionType;
  role: VariableRole;
  /** Human variable label (prompt, suffixed for option/row/probe variables). */
  label: string;
  /** numeric → -99 missing convention applies in codes mode. */
  varType: "numeric" | "string";
  /** code (as string key) → option label; only for coded variables. */
  valueLabels?: Record<string, string>;
  /** option/row label this variable represents (option/rank/matrix_row). */
  itemLabel?: string;
}

export interface ExportSchema {
  variables: ExportVariable[];
  questions: ExportQuestion[];
  opts: ExportValueOptions;
}

export const SEEN_UNANSWERED_CODE = -99;

/** Question types answered with a choice from `config.options`. */
const CHOICE_TYPES: ExportQuestionType[] = ["single", "multi", "ranking"];

const PROMPT_LABEL_MAX = 160;

function clip(s: string, max = PROMPT_LABEL_MAX): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The effective option labels of a question. Carry-forward questions
 * (config.optionsFrom) inherit the SOURCE question's authored options so
 * value codes stay stable regardless of what each respondent carried.
 */
export function effectiveOptions(
  q: ExportQuestion,
  byId: Map<string, ExportQuestion>,
): string[] {
  const own = normalizeOptions(q.config?.options).map((o) => o.label);
  if (own.length > 0) return own;
  const srcId = q.config?.optionsFrom?.questionId;
  if (typeof srcId === "string") {
    const src = byId.get(srcId);
    if (src) return normalizeOptions(src.config?.options).map((o) => o.label);
  }
  return own;
}

function optionValueLabels(labels: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  labels.forEach((label, i) => {
    out[String(i + 1)] = label;
  });
  return out;
}

function hasOtherText(q: ExportQuestion): boolean {
  return normalizeOptions(q.config?.options).some((o) => o.special === "other" && !o.noText);
}

/**
 * Builds the variable schema for a survey. `maxProbes` (questionId → highest
 * probe count observed in the exported responses) sizes the probe columns —
 * wide formats need a fixed column set.
 */
export function buildExportSchema(
  questions: ExportQuestion[],
  opts: ExportValueOptions,
  maxProbes: Record<string, number> = {},
): ExportSchema {
  const sorted = [...questions].sort((a, b) => a.order - b.order);
  const byId = new Map(sorted.map((q) => [q.id, q]));
  const variables: ExportVariable[] = [];

  sorted.forEach((q, idx) => {
    const num = idx + 1;
    const base = `q${String(num).padStart(2, "0")}`;
    const prompt = clip(q.prompt);
    const options = CHOICE_TYPES.includes(q.type) ? effectiveOptions(q, byId) : [];

    if (q.type === "single") {
      variables.push({
        name: base,
        questionId: q.id,
        questionNumber: num,
        questionType: q.type,
        role: "answer",
        label: prompt,
        varType: opts.values === "codes" ? "numeric" : "string",
        valueLabels: optionValueLabels(options),
      });
    } else if (q.type === "multi") {
      if (opts.multi === "expand") {
        options.forEach((label, i) => {
          variables.push({
            name: `${base}_${i + 1}`,
            questionId: q.id,
            questionNumber: num,
            questionType: q.type,
            role: "option",
            label: `${prompt} — ${clip(label, 60)}`,
            varType: "numeric",
            valueLabels: { "0": "미선택", "1": "선택" },
            itemLabel: label,
          });
        });
      } else {
        variables.push({
          name: base,
          questionId: q.id,
          questionNumber: num,
          questionType: q.type,
          role: "answer",
          label: prompt,
          varType: "string",
          valueLabels: optionValueLabels(options),
        });
      }
    } else if (q.type === "scale" || q.type === "nps") {
      variables.push({
        name: base,
        questionId: q.id,
        questionNumber: num,
        questionType: q.type,
        role: "answer",
        label: prompt,
        varType: "numeric",
      });
    } else if (q.type === "ranking") {
      const limit = q.config?.limit && q.config.limit > 0
        ? Math.min(q.config.limit, options.length)
        : options.length;
      for (let r = 1; r <= limit; r++) {
        variables.push({
          name: `${base}_r${r}`,
          questionId: q.id,
          questionNumber: num,
          questionType: q.type,
          role: "rank",
          label: `${prompt} — ${r}순위`,
          varType: opts.values === "codes" ? "numeric" : "string",
          valueLabels: optionValueLabels(options),
          itemLabel: String(r),
        });
      }
    } else if (q.type === "matrix") {
      const rows = Array.isArray(q.config?.rows) ? q.config.rows : [];
      const columns = Array.isArray(q.config?.columns) ? q.config.columns : [];
      rows.forEach((row, i) => {
        variables.push({
          name: `${base}_${i + 1}`,
          questionId: q.id,
          questionNumber: num,
          questionType: q.type,
          role: "matrix_row",
          label: `${prompt} — ${clip(row, 60)}`,
          varType: opts.values === "codes" ? "numeric" : "string",
          valueLabels: optionValueLabels(columns),
          itemLabel: row,
        });
      });
    } else {
      // open
      variables.push({
        name: base,
        questionId: q.id,
        questionNumber: num,
        questionType: q.type,
        role: "answer",
        label: prompt,
        varType: "string",
      });
      const probes = maxProbes[q.id] ?? 0;
      for (let p = 1; p <= probes; p++) {
        variables.push(
          {
            name: `${base}_probe${p}_q`,
            questionId: q.id,
            questionNumber: num,
            questionType: q.type,
            role: "probe_q",
            label: `${prompt} — AI 추가 질문 ${p}`,
            varType: "string",
          },
          {
            name: `${base}_probe${p}_a`,
            questionId: q.id,
            questionNumber: num,
            questionType: q.type,
            role: "probe_a",
            label: `${prompt} — AI 추가 질문 ${p} 답변`,
            varType: "string",
          },
        );
      }
    }

    if (hasOtherText(q)) {
      variables.push({
        name: `${base}_other`,
        questionId: q.id,
        questionNumber: num,
        questionType: q.type,
        role: "other",
        label: `${prompt} — 기타 입력`,
        varType: "string",
      });
    }
  });

  return { variables, questions: sorted, opts };
}

// ---------------------------------------------------------------------------
// Response flattening
// ---------------------------------------------------------------------------

export interface FlatResponseInput {
  answers: Record<string, unknown>;
  otherTexts?: Record<string, unknown> | null;
}

export type FlatCell = string | number;

/**
 * Whether a question was SHOWN to this respondent: display logic must pass
 * and a carry-forward source must have selections (respond-form/widget skip
 * the question otherwise).
 */
export function questionShown(
  q: ExportQuestion,
  answers: Record<string, unknown>,
): boolean {
  if (!questionVisible(q.config?.displayLogic, answers as never)) return false;
  const srcId = q.config?.optionsFrom?.questionId;
  if (typeof srcId === "string" && srcId) {
    const src = answers[srcId];
    const picked = typeof src === "string" ? src !== "" : Array.isArray(src) && src.length > 0;
    if (!picked) return false;
  }
  return true;
}

function codeOf(label: string, options: string[]): number | null {
  const i = options.indexOf(label);
  return i >= 0 ? i + 1 : null;
}

/**
 * Flattens one response into `variable name → cell` under the schema's
 * conventions. Missing rules: not shown → "" everywhere; seen-but-unanswered
 * → -99 on numeric vars in codes mode, "" otherwise.
 */
export function flattenResponse(
  schema: ExportSchema,
  input: FlatResponseInput,
): Record<string, FlatCell> {
  const { opts } = schema;
  const byId = new Map(schema.questions.map((q) => [q.id, q]));
  const answers = input.answers ?? {};
  const others = (input.otherTexts ?? {}) as Record<string, unknown>;
  const out: Record<string, FlatCell> = {};

  const missing = (v: ExportVariable, shown: boolean): FlatCell => {
    if (!shown) return "";
    return opts.values === "codes" && v.varType === "numeric" ? SEEN_UNANSWERED_CODE : "";
  };

  for (const v of schema.variables) {
    const q = byId.get(v.questionId)!;
    const shown = questionShown(q, answers);
    const raw = answers[q.id];
    const options = CHOICE_TYPES.includes(q.type) ? effectiveOptions(q, byId) : [];

    if (v.role === "other") {
      const t = others[q.id];
      out[v.name] = typeof t === "string" ? t : "";
      continue;
    }

    if (q.type === "single") {
      if (typeof raw !== "string" || raw === "") {
        out[v.name] = missing(v, shown);
      } else if (opts.values === "codes") {
        out[v.name] = codeOf(raw, options) ?? SEEN_UNANSWERED_CODE;
      } else {
        out[v.name] = raw;
      }
    } else if (q.type === "multi") {
      const selected = Array.isArray(raw) ? raw.map(String) : [];
      if (v.role === "option") {
        if (!shown) out[v.name] = "";
        else if (selected.length === 0) out[v.name] = opts.values === "codes" ? SEEN_UNANSWERED_CODE : "";
        else out[v.name] = selected.includes(v.itemLabel ?? "") ? 1 : 0;
      } else {
        // merged
        if (selected.length === 0) out[v.name] = missing(v, shown);
        else if (opts.values === "codes")
          out[v.name] = selected.map((s) => codeOf(s, options) ?? "?").join(";");
        else out[v.name] = selected.join("; ");
      }
    } else if (q.type === "scale" || q.type === "nps") {
      const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
      out[v.name] = Number.isFinite(n) ? n : missing(v, shown);
    } else if (q.type === "ranking") {
      const ranked = Array.isArray(raw) ? raw.map(String) : [];
      const idx = Number(v.itemLabel) - 1;
      const label = ranked[idx];
      if (label === undefined) out[v.name] = missing(v, shown);
      else if (opts.values === "codes") out[v.name] = codeOf(label, options) ?? SEEN_UNANSWERED_CODE;
      else out[v.name] = label;
    } else if (q.type === "matrix") {
      const obj = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
      const col = obj[v.itemLabel ?? ""];
      const columns = Array.isArray(q.config?.columns) ? q.config.columns : [];
      if (typeof col !== "string" || col === "") out[v.name] = missing(v, shown);
      else if (opts.values === "codes") out[v.name] = codeOf(col, columns) ?? SEEN_UNANSWERED_CODE;
      else out[v.name] = col;
    } else {
      // open + probes
      const text = openAnswerText(raw).trim();
      const probes = openAnswerProbes(raw);
      if (v.role === "answer") out[v.name] = text !== "" ? text : "";
      else {
        const m = /_probe(\d+)_(q|a)$/.exec(v.name);
        const i = m ? Number(m[1]) - 1 : -1;
        const qa = i >= 0 ? probes[i] : undefined;
        out[v.name] = qa ? (m![2] === "q" ? qa.q : qa.a) : "";
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// CSV rendering
// ---------------------------------------------------------------------------

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: FlatCell[][]): string {
  return rows.map((r) => r.map((c) => csvEscape(String(c))).join(",")).join("\r\n");
}

/** UTF-8 BOM so Korean text opens correctly in Excel. */
export const CSV_BOM = "\uFEFF";

// ---------------------------------------------------------------------------
// Long (tidy) rows
// ---------------------------------------------------------------------------

export interface LongRowMeta {
  responseId: string;
  personaId: string;
  createdAt: string;
}

export const LONG_HEADER = [
  "response_id",
  "persona_id",
  "created_at",
  "variable",
  "question_id",
  "question_type",
  "value_code",
  "value_label",
] as const;

/**
 * Tidy rows for one response: one row per answered value (multi → one row per
 * selected option; probes → one row per probe q/a; matrix → one row per
 * matrix row). Not-shown questions produce NO rows; seen-but-unanswered
 * produce a single -99 row per question.
 */
export function longRows(
  schema: ExportSchema,
  meta: LongRowMeta,
  input: FlatResponseInput,
): FlatCell[][] {
  const byId = new Map(schema.questions.map((q) => [q.id, q]));
  const answers = input.answers ?? {};
  const others = (input.otherTexts ?? {}) as Record<string, unknown>;
  const rows: FlatCell[][] = [];
  const base = [meta.responseId, meta.personaId, meta.createdAt];
  const push = (
    variable: string,
    q: ExportQuestion,
    code: FlatCell,
    label: string,
  ) => rows.push([...base, variable, q.id, q.type, code, label]);

  schema.questions.forEach((q, idx) => {
    const num = `q${String(idx + 1).padStart(2, "0")}`;
    if (!questionShown(q, answers)) return;
    const raw = answers[q.id];
    const options = CHOICE_TYPES.includes(q.type) ? effectiveOptions(q, byId) : [];
    const unanswered = () => push(num, q, SEEN_UNANSWERED_CODE, "");

    if (q.type === "single") {
      if (typeof raw !== "string" || raw === "") unanswered();
      else push(num, q, codeOf(raw, options) ?? "", raw);
    } else if (q.type === "multi") {
      const selected = Array.isArray(raw) ? raw.map(String) : [];
      if (selected.length === 0) unanswered();
      else selected.forEach((s) => push(num, q, codeOf(s, options) ?? "", s));
    } else if (q.type === "scale" || q.type === "nps") {
      const n = Number(raw);
      if (!Number.isFinite(n)) unanswered();
      else push(num, q, n, String(n));
    } else if (q.type === "ranking") {
      const ranked = Array.isArray(raw) ? raw.map(String) : [];
      if (ranked.length === 0) unanswered();
      else ranked.forEach((label, i) =>
        push(`${num}_r${i + 1}`, q, codeOf(label, options) ?? "", label),
      );
    } else if (q.type === "matrix") {
      const obj = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
      const columns = Array.isArray(q.config?.columns) ? q.config.columns : [];
      const rowsCfg = Array.isArray(q.config?.rows) ? q.config.rows : [];
      const answeredRows = rowsCfg.filter((r) => typeof obj[r] === "string" && obj[r] !== "");
      if (answeredRows.length === 0) unanswered();
      else rowsCfg.forEach((r, i) => {
        const col = obj[r];
        if (typeof col !== "string" || col === "") return;
        push(`${num}_${i + 1}`, q, codeOf(col, columns) ?? "", col);
      });
    } else {
      const text = openAnswerText(raw).trim();
      const probes = openAnswerProbes(raw);
      if (text === "" && probes.length === 0) unanswered();
      if (text !== "") push(num, q, "", text);
      probes.forEach((qa, i) => {
        push(`${num}_probe${i + 1}_q`, q, "", qa.q);
        push(`${num}_probe${i + 1}_a`, q, "", qa.a);
      });
    }

    // "other" free text travels as its own row (mirrors the qNN_other column)
    const otherText = others[q.id];
    if (typeof otherText === "string" && otherText.trim() !== "") {
      push(`${num}_other`, q, "", otherText.trim());
    }
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Codebook
// ---------------------------------------------------------------------------

export interface CodebookMeta {
  surveyId: string;
  title: string;
  goal?: string | null;
  exportedAt: string;
  responseCount: number;
  options: ExportValueOptions;
}

export function buildCodebook(schema: ExportSchema, meta: CodebookMeta) {
  return {
    survey: {
      id: meta.surveyId,
      title: meta.title,
      goal: meta.goal ?? null,
      exported_at: meta.exportedAt,
      synthetic_responses: meta.responseCount,
    },
    export_options: {
      values: meta.options.values,
      multi_select: meta.options.multi,
    },
    conventions: {
      missing_not_shown: "표시 로직으로 노출되지 않은 문항은 빈 값",
      missing_seen_unanswered: `노출됐지만 무응답인 숫자 변수는 ${SEEN_UNANSWERED_CODE}`,
      provenance: "모든 응답은 AI 합성(페르소나 시뮬레이션)입니다 — 실제 응답이 아닙니다",
      single_coding: "선택지 순서대로 1..k",
      multi_expand: "선택지별 이진 변수(1=선택, 0=미선택)",
    },
    questions: schema.questions.map((q, i) => ({
      number: i + 1,
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      display_logic: q.config?.displayLogic?.conditions?.length
        ? "조건부 노출 (미노출 응답자는 빈 값)"
        : null,
    })),
    variables: schema.variables.map((v) => ({
      name: v.name,
      question_id: v.questionId,
      question_number: v.questionNumber,
      question_type: v.questionType,
      role: v.role,
      label: v.label,
      var_type: v.varType,
      value_labels: v.valueLabels ?? null,
      // Option/row label this variable represents (multi option, ranking item,
      // matrix row) — lets a bundle round-trip rebuild the exact option/row set.
      item_label: v.itemLabel ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// SPSS syntax (.sps) — expss write_labelled_spss pattern
// ---------------------------------------------------------------------------

const SPSS_META_VARS: { name: string; spec: string; label: string }[] = [
  { name: "response_id", spec: "A40", label: "응답 ID" },
  { name: "persona_id", spec: "A40", label: "페르소나 ID" },
  { name: "survey_version", spec: "F4.0", label: "설문 버전" },
  { name: "created_at", spec: "A24", label: "생성 시각 (ISO8601)" },
];

function spsQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * SPSS syntax that loads data.csv (codes mode, single header row) and applies
 * variable labels, value labels and the -99 missing declaration.
 */
export function buildSpssSyntax(schema: ExportSchema, csvFilename = "data.csv"): string {
  const varSpecs = [
    ...SPSS_META_VARS.map((m) => `  ${m.name} ${m.spec}`),
    ...schema.variables.map(
      (v) => `  ${v.name} ${v.varType === "numeric" ? "F8.0" : "A2000"}`,
    ),
  ].join("\n");

  const varLabels = [
    ...SPSS_META_VARS.map((m) => `  ${m.name} ${spsQuote(m.label)}`),
    ...schema.variables.map((v) => `  ${v.name} ${spsQuote(v.label)}`),
  ].join("\n");

  const valueLabelBlocks = schema.variables
    .filter((v) => v.varType === "numeric" && v.valueLabels && Object.keys(v.valueLabels).length)
    .map((v) => {
      const pairs = Object.entries(v.valueLabels!)
        .map(([code, label]) => `    ${code} ${spsQuote(label)}`)
        .join("\n");
      return `  /${v.name}\n${pairs}`;
    });

  const numericVars = schema.variables.filter((v) => v.varType === "numeric").map((v) => v.name);

  const parts = [
    "* Loop 설문 응답 가져오기 — 이 파일을 SPSS에서 실행하세요 (File > Open > Syntax).",
    `* data.csv는 이 신택스와 같은 폴더에 있어야 합니다.`,
    "",
    "GET DATA",
    "  /TYPE=TXT",
    `  /FILE=${spsQuote(csvFilename)}`,
    '  /ENCODING="UTF8"',
    '  /DELIMITERS=","',
    "  /QUALIFIER='\"'",
    "  /ARRANGEMENT=DELIMITED",
    "  /FIRSTCASE=2",
    "  /VARIABLES=",
    varSpecs + ".",
    "",
    "VARIABLE LABELS",
    varLabels + ".",
    "",
  ];
  if (valueLabelBlocks.length) {
    parts.push("VALUE LABELS", valueLabelBlocks.join("\n") + ".", "");
  }
  if (numericVars.length) {
    parts.push(`MISSING VALUES ${numericVars.join(" ")} (${SEEN_UNANSWERED_CODE}).`, "");
  }
  parts.push("EXECUTE.", "");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// AI bundle README
// ---------------------------------------------------------------------------

export function buildAiReadme(meta: CodebookMeta, schemaVarCount: number): string {
  return `# ${meta.title} — 응답 데이터셋

Loop 설문 플랫폼에서 ${meta.exportedAt}에 내보낸 분석용 데이터입니다.

## 파일 구성

- \`dataset.jsonl\` — 1행 = 1응답. 각 행은 메타데이터와 \`answers\`(변수명 → 값 구조) 를 담습니다.
- \`codebook.json\` — 변수 정의(총 ${schemaVarCount}개), 문항 원문, 값 코드(숫자 → 라벨), 결측 규칙.

## 반드시 알아야 할 규칙

1. **합성 vs 실제**: \`is_synthetic: true\`는 AI 페르소나 시뮬레이션 응답입니다. 통계적 결론은
   \`is_synthetic: false\`(실제 응답)만으로 내리세요. 합성 응답은 예상 분포 참고용입니다.
2. **무결성**: \`integrity_verdict\`가 \`reject\`인 응답은 봇/불성실 의심으로 분석에서 제외를 권장합니다.
3. **결측 구분**: 문항이 응답자에게 노출되지 않은 경우(표시 로직) 해당 변수는 \`answers\`에 없습니다.
   노출됐지만 무응답이면 값이 \`null\`입니다.
4. **주관식 후속 질문**: open 문항의 \`probes\`는 AI가 실시간으로 던진 추가 질문과 답변 쌍입니다.

## 분석 시작 예시 프롬프트

- "codebook.json을 읽고 dataset.jsonl의 문항별 분포를 요약해줘."
- "q05 선택 이유별로 주관식(q08) 답변의 공통 주제를 뽑아줘."

- 합성 응답 ${meta.responseCount}건 (시뮬레이션 — 실제 응답 아님)
- 설문 목표: ${meta.goal ?? "(미지정)"}
`;
}

// ---------------------------------------------------------------------------
// JSONL record
// ---------------------------------------------------------------------------

export interface JsonlMeta extends LongRowMeta {
  surveyVersion: number | null;
}

/** One dataset.jsonl record: lean, self-describing values (codes + labels). */
export function jsonlRecord(
  schema: ExportSchema,
  meta: JsonlMeta,
  input: FlatResponseInput,
): Record<string, unknown> {
  const byId = new Map(schema.questions.map((q) => [q.id, q]));
  const answers = input.answers ?? {};
  const others = (input.otherTexts ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const notShown: string[] = [];

  schema.questions.forEach((q, idx) => {
    const name = `q${String(idx + 1).padStart(2, "0")}`;
    if (!questionShown(q, answers)) {
      notShown.push(name);
      return;
    }
    const raw = answers[q.id];
    const options = CHOICE_TYPES.includes(q.type) ? effectiveOptions(q, byId) : [];
    const otherText = typeof others[q.id] === "string" ? (others[q.id] as string) : undefined;

    if (q.type === "single") {
      const label = typeof raw === "string" && raw !== "" ? raw : null;
      out[name] = label === null
        ? null
        : { type: q.type, code: codeOf(label, options), label, ...(otherText ? { other_text: otherText } : {}) };
    } else if (q.type === "multi") {
      const selected = Array.isArray(raw) ? raw.map(String) : [];
      out[name] = selected.length === 0
        ? null
        : {
            type: q.type,
            selected: selected.map((label) => ({ code: codeOf(label, options), label })),
            ...(otherText ? { other_text: otherText } : {}),
          };
    } else if (q.type === "scale" || q.type === "nps") {
      const n = Number(raw);
      out[name] = Number.isFinite(n) ? { type: q.type, value: n } : null;
    } else if (q.type === "ranking") {
      const ranked = Array.isArray(raw) ? raw.map(String) : [];
      out[name] = ranked.length === 0
        ? null
        : { type: q.type, ranked: ranked.map((label) => ({ code: codeOf(label, options), label })) };
    } else if (q.type === "matrix") {
      const obj = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
      const columns = Array.isArray(q.config?.columns) ? q.config.columns : [];
      const rows = Object.entries(obj)
        .filter(([, v]) => typeof v === "string" && v !== "")
        .map(([row, col]) => ({ row, code: codeOf(String(col), columns), label: String(col) }));
      out[name] = rows.length === 0 ? null : { type: q.type, rows };
    } else {
      const text = openAnswerText(raw).trim();
      const probes = openAnswerProbes(raw);
      out[name] = text === "" && probes.length === 0
        ? null
        : { type: q.type, text, ...(probes.length ? { probes } : {}) };
    }
  });

  return {
    response_id: meta.responseId,
    persona_id: meta.personaId,
    survey_version: meta.surveyVersion,
    created_at: meta.createdAt,
    answers: out,
    ...(notShown.length ? { not_shown: notShown } : {}),
  };
}
