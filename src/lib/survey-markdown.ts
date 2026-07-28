/**
 * Loop Survey Markdown (LSM) — a survey rendered as one human-readable markdown
 * document. This module is the PURE, IO-free core: a line-based scanner that
 * turns markdown into a structured survey doc with line-accurate errors
 * (US-001), a serializer that renders a survey back to markdown (US-002), and
 * — a later story — an anchor→quid resolver (US-003).
 *
 * PURE MODULE — no DB / server / Node-only imports, so it runs on the client
 * (error preview) as well as the server (import). The parser only produces
 * "text → raw config"; normalization is DELEGATED to the existing pure modules
 * (normalizeOptions/promoteSpecialOptions/normalizeMeta/normalizeProbe/
 * sanitizeDisplayLogic/normalizeOptionsFrom) so every consumer contract in
 * qconfig-contract.ts is inherited unchanged.
 *
 * References (showIf conditions, optionsFrom) are parsed as ANCHOR TOKENS and
 * kept in `refs` verbatim — they are resolved to real quids by
 * resolveMarkdownRefs (US-003), never by the parser.
 */

import {
  normalizeMeta,
  normalizeOptions,
  normalizeProbe,
  optionIdFromLabel,
  promoteSpecialOptions,
  type OptionObject,
  type QMeta,
} from "@/lib/question-config";
import { remapConfigRefs } from "@/lib/template-refs";
import {
  DISPLAY_OPS,
  sanitizeDisplayLogic,
  type DisplayLogic,
  type DisplayOp,
} from "@/lib/display-logic";
import type { OptionsFrom } from "@/lib/carry-forward";
import type { QConfig, QuestionType } from "@/lib/question-diff";

const QUESTION_TYPES: readonly QuestionType[] = [
  "single",
  "multi",
  "scale",
  "open",
  "ranking",
  "matrix",
  "nps",
];

/** Types whose respondent choices come from `- ` option list items. */
const CHOICE_TYPES: readonly QuestionType[] = ["single", "multi", "ranking"];

/** Attribute keys accepted inside a question heading's `[...]` block. */
const KNOWN_ATTR_KEYS = new Set([
  "limit",
  "randomize",
  "min",
  "max",
  "minLabel",
  "maxLabel",
  "probe",
  "maxProbes",
  "guidance",
  "optionsFrom",
  "mode",
]);

const META_KEYS = new Set([
  "construct",
  "topic",
  "population",
  "source",
  "validatedScale",
  "notes",
]);

const FRONTMATTER_KEYS = new Set(["title", "researchGoal", "welcome", "closing"]);

export type ParseError = { line: number; message: string };

/** A question as parsed from markdown — references still anchor-token based. */
export type ParsedQuestion = {
  /** Human anchor token from the heading (e.g. "Q1"), used by references. */
  anchor: string;
  /** Stable id when the heading carried `{#q_...}` (export round-trip). */
  quid?: string;
  type: QuestionType;
  prompt: string;
  /** Normalized config WITHOUT displayLogic/optionsFrom (those live in refs). */
  config: QConfig;
  /**
   * Cross-question references, still pointing at ANCHOR TOKENS (not quids).
   * `displayLogic.conditions[].questionId` and `optionsFrom.questionId` hold the
   * anchor as written; resolveMarkdownRefs (US-003) rewrites them to quids.
   */
  refs: { displayLogic?: DisplayLogic; optionsFrom?: OptionsFrom };
  /** 1-based line of this question's `###` heading (for downstream errors). */
  line: number;
};

export type ParsedSurveyDoc = {
  title?: string;
  researchGoal: string;
  welcome?: string;
  closing?: string;
  questions: ParsedQuestion[];
};

export type ParseResult = { doc?: ParsedSurveyDoc; errors: ParseError[] };

// ---------------------------------------------------------------------------
// Small lexical helpers (quote/bracket aware) — kept local & pure.
// ---------------------------------------------------------------------------

/** Strip one layer of surrounding double quotes, unescaping `\"` and `\\`. */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return t;
}

/**
 * Split on top-level whitespace while keeping `"..."` strings and `[...]`
 * arrays as single tokens. Used for heading attrs, brace meta, and conditions.
 */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let inQ = false;
  for (const ch of s) {
    if (inQ) {
      cur += ch;
      if (ch === '"') inQ = false;
      continue;
    }
    if (ch === '"') {
      inQ = true;
      cur += ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * First balanced `open…close` group in `s`, quote-aware. Returns the inner
 * text plus the text before/after the group, or null when absent.
 */
function extractGroup(
  s: string,
  open: string,
  close: string,
): { inner: string; before: string; after: string } | null {
  let start = -1;
  let depth = 0;
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') inQ = false;
      continue;
    }
    if (ch === '"') {
      inQ = true;
      continue;
    }
    if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close && depth > 0) {
      depth--;
      if (depth === 0) {
        return { inner: s.slice(start + 1, i), before: s.slice(0, start), after: s.slice(i + 1) };
      }
    }
  }
  return null;
}

/** Split a `key=value` token; value keeps its quotes/brackets for later parsing. */
function splitKv(tok: string): { key: string; value?: string } {
  const eq = tok.indexOf("=");
  if (eq < 0) return { key: tok };
  return { key: tok.slice(0, eq), value: tok.slice(eq + 1) };
}

// ---------------------------------------------------------------------------
// Frontmatter (lightweight YAML subset: scalars + `key: |` block scalars).
// ---------------------------------------------------------------------------

type Frontmatter = { title?: string; researchGoal?: string; welcome?: string; closing?: string };

/** Remove the least common leading indent from a set of block-scalar lines. */
function dedent(lines: string[]): string {
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => (l.match(/^(\s*)/)?.[1].length ?? 0));
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n").trim();
}

function parseFrontmatter(lines: string[]): {
  fm: Frontmatter;
  bodyStart: number;
  errors: ParseError[];
} {
  const errors: ParseError[] = [];
  const fm: Frontmatter = {};
  // Frontmatter must be the very first non-empty content, delimited by `---`.
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  if (first >= lines.length || lines[first].trim() !== "---") {
    return { fm, bodyStart: 0, errors };
  }
  let i = first + 1;
  let closed = false;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "---") {
      closed = true;
      i++;
      break;
    }
    if (raw.trim() === "") {
      i++;
      continue;
    }
    const m = raw.match(/^([A-Za-z][A-Za-z0-9_]*):(.*)$/);
    if (!m) {
      errors.push({ line: i + 1, message: `frontmatter 형식 오류: '${raw.trim()}'` });
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();
    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      // Block scalar: subsequent indented (or blank) lines until a col-0 line.
      const block: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "---" && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
        block.push(lines[i]);
        i++;
      }
      if (FRONTMATTER_KEYS.has(key)) (fm as Record<string, string>)[key] = dedent(block);
      continue;
    }
    if (FRONTMATTER_KEYS.has(key)) (fm as Record<string, string>)[key] = unquote(rest);
    i++;
  }
  if (!closed) {
    errors.push({ line: first + 1, message: "frontmatter가 '---'로 닫히지 않았습니다" });
  }
  return { fm, bodyStart: i, errors };
}

// ---------------------------------------------------------------------------
// Condition / option / matrix line parsing.
// ---------------------------------------------------------------------------

/** Parse a showIf condition value: array `[...]`, quoted string, number, bare. */
function parseCondValue(raw: string): string | number | string[] {
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map(String);
    } catch {
      /* fall through to scalar */
    }
    return [];
  }
  if (t.startsWith('"')) return unquote(t);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

type RawOption = { label: string; id?: string; special?: "other" | "none"; noText?: boolean };

/** Parse one `- 라벨 [other noText] {#o_..}` option list item. */
function parseOptionLine(text: string, lineNo: number, errors: ParseError[]): RawOption | null {
  let rest = text;
  let id: string | undefined;
  const brace = extractGroup(rest, "{", "}");
  if (brace) {
    const t = brace.inner.trim();
    if (t.startsWith("#o_")) id = t.slice(1);
    rest = brace.before + brace.after;
  }
  let special: "other" | "none" | undefined;
  let noText = false;
  const tag = extractGroup(rest, "[", "]");
  if (tag) {
    for (const p of tag.inner.trim().split(/\s+/).filter(Boolean)) {
      if (p === "other" || p === "none") special = p;
      else if (p === "noText") noText = true;
      else errors.push({ line: lineNo, message: `알 수 없는 보기 태그: '${p}'` });
    }
    rest = tag.before + tag.after;
  }
  const label = rest.trim();
  return { label, ...(id ? { id } : {}), ...(special ? { special } : {}), ...(noText ? { noText } : {}) };
}

/** Split a markdown table row into trimmed cells, honoring `\|` escapes. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** A markdown-table separator row like `|----|:--:|`. */
function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-/.test(line);
}

// ---------------------------------------------------------------------------
// Heading + question body parsing.
// ---------------------------------------------------------------------------

type Heading = {
  anchor: string;
  quid?: string;
  type?: QuestionType;
  attrs: Map<string, string | true>;
  meta: Record<string, string>;
};

function parseHeading(content: string, lineNo: number, errors: ParseError[]): Heading | null {
  let anchorPart = content;
  const attrs = new Map<string, string | true>();
  const meta: Record<string, string> = {};
  let quid: string | undefined;
  let type: QuestionType | undefined;

  const brace = extractGroup(content, "{", "}");
  if (brace) {
    anchorPart = brace.before + brace.after;
    for (const tok of tokenize(brace.inner)) {
      if (tok.startsWith("#q_")) {
        quid = tok.slice(1);
        continue;
      }
      const { key, value } = splitKv(tok);
      if (META_KEYS.has(key) && value !== undefined) meta[key] = unquote(value);
      // Unknown meta keys are ignored (normalizeMeta would drop them anyway).
    }
  }

  const bracket = extractGroup(anchorPart, "[", "]");
  if (!bracket) {
    errors.push({ line: lineNo, message: "문항 타입([...]) 이 없습니다" });
    return null;
  }
  anchorPart = bracket.before + bracket.after;
  const attrToks = tokenize(bracket.inner);
  if (attrToks.length === 0) {
    errors.push({ line: lineNo, message: "문항 타입이 비어 있습니다" });
    return null;
  }
  const typeTok = attrToks[0];
  if ((QUESTION_TYPES as readonly string[]).includes(typeTok)) {
    type = typeTok as QuestionType;
  } else {
    errors.push({ line: lineNo, message: `알 수 없는 문항 타입: '${typeTok}'` });
  }
  for (const tok of attrToks.slice(1)) {
    const { key, value } = splitKv(tok);
    if (!KNOWN_ATTR_KEYS.has(key)) {
      errors.push({ line: lineNo, message: `알 수 없는 속성: '${key}'` });
      continue;
    }
    attrs.set(key, value === undefined ? true : unquote(value));
  }

  let anchor = anchorPart.trim();
  if (!anchor && quid) anchor = "#" + quid;
  if (!anchor) {
    errors.push({ line: lineNo, message: "문항 앵커가 없습니다" });
    return null;
  }
  return { anchor, quid, type, attrs, meta };
}

/** Numeric attribute value, or undefined when absent/non-numeric (with error). */
function numAttr(
  attrs: Map<string, string | true>,
  key: string,
  lineNo: number,
  errors: ParseError[],
): number | undefined {
  if (!attrs.has(key)) return undefined;
  const v = attrs.get(key);
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    errors.push({ line: lineNo, message: `속성 '${key}' 값이 숫자가 아닙니다: '${String(v)}'` });
    return undefined;
  }
  return n;
}

function parseQuestion(
  lines: string[],
  start: number,
  end: number,
  errors: ParseError[],
): ParsedQuestion | null {
  const headingLine = start + 1;
  const content = lines[start].replace(/^###\s+/, "").trim();
  const head = parseHeading(content, headingLine, errors);
  if (!head || !head.type) return null;
  const type = head.type;

  // ── classify body lines ────────────────────────────────────────────────
  const promptLines: string[] = [];
  const rawOptions: RawOption[] = [];
  const tableLines: { line: string; no: number }[] = [];
  let displayLogic: DisplayLogic | undefined;
  let inShowIf = false;
  let showIfMatch: "all" | "any" = "all";
  const conditions: DisplayLogic["conditions"] = [];
  let sawShowIf = false;

  for (let i = start + 1; i < end; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const no = i + 1;
    if (t === "") {
      inShowIf = false;
      continue;
    }
    const showIfMatchLine = t.match(/^showIf:\s*(all|any)\s*$/i);
    if (showIfMatchLine) {
      inShowIf = true;
      sawShowIf = true;
      showIfMatch = showIfMatchLine[1].toLowerCase() === "any" ? "any" : "all";
      continue;
    }
    if (t.startsWith("-")) {
      const itemText = t.replace(/^-\s*/, "");
      if (inShowIf) {
        // Condition line: `<anchor> <op> <value>`.
        const toks = tokenize(itemText);
        if (toks.length < 3) {
          errors.push({ line: no, message: `showIf 조건 형식 오류: '${itemText}'` });
          continue;
        }
        const [anchor, op] = toks;
        if (!(DISPLAY_OPS as string[]).includes(op)) {
          errors.push({ line: no, message: `알 수 없는 조건 연산자: '${op}'` });
          continue;
        }
        const value = parseCondValue(toks.slice(2).join(" "));
        conditions.push({ questionId: anchor, op: op as DisplayOp, value });
        continue;
      }
      const opt = parseOptionLine(itemText, no, errors);
      if (opt) rawOptions.push(opt);
      continue;
    }
    if (t.startsWith("|")) {
      inShowIf = false;
      tableLines.push({ line: raw, no });
      continue;
    }
    // Plain prompt text.
    inShowIf = false;
    promptLines.push(t);
  }

  // ── prompt ──────────────────────────────────────────────────────────────
  const prompt = promptLines.join("\n").trim();
  if (!prompt) errors.push({ line: headingLine, message: "문항 프롬프트가 비어 있습니다" });

  // ── build config (delegating normalization to the pure modules) ──────────
  const config: QConfig = {};

  // options (choice types only)
  if (rawOptions.length > 0) {
    if (!(CHOICE_TYPES as readonly string[]).includes(type)) {
      errors.push({ line: headingLine, message: `'${type}' 타입은 보기 목록을 가질 수 없습니다` });
    } else {
      const normalized = promoteSpecialOptions(
        normalizeOptions(rawOptions as unknown[]),
        { conservative: true },
      );
      config.options = normalized as OptionObject[];
    }
  }

  // scale
  if (type === "scale") {
    const min = numAttr(head.attrs, "min", headingLine, errors);
    const max = numAttr(head.attrs, "max", headingLine, errors);
    if (min === undefined || max === undefined) {
      errors.push({ line: headingLine, message: "scale 문항에는 min/max 가 필요합니다" });
    } else {
      const minLabel = head.attrs.get("minLabel");
      const maxLabel = head.attrs.get("maxLabel");
      config.scale = {
        min,
        max,
        ...(typeof minLabel === "string" && minLabel ? { minLabel } : {}),
        ...(typeof maxLabel === "string" && maxLabel ? { maxLabel } : {}),
      };
    }
  }

  // matrix rows/columns from the table
  if (type === "matrix") {
    if (tableLines.length < 2) {
      errors.push({ line: headingLine, message: "matrix 문항에는 행/열 표가 필요합니다" });
    } else {
      const header = splitTableRow(tableLines[0].line);
      // Header first cell is the empty corner; the rest are the columns.
      const columns = header.slice(1).filter((c) => c !== "");
      const bodyRows = tableLines.slice(1).filter((r) => !isSeparatorRow(r.line));
      const rows = bodyRows.map((r) => splitTableRow(r.line)[0]).filter((c) => c !== "");
      if (columns.length) config.columns = columns;
      if (rows.length) config.rows = rows;
      if (!columns.length || !rows.length) {
        errors.push({ line: tableLines[0].no, message: "matrix 표의 행 또는 열을 읽지 못했습니다" });
      }
    }
  } else if (tableLines.length > 0) {
    errors.push({ line: tableLines[0].no, message: `'${type}' 타입은 표(matrix 전용)를 가질 수 없습니다` });
  }

  // limit
  const limit = numAttr(head.attrs, "limit", headingLine, errors);
  if (limit !== undefined) config.limit = limit;

  // randomize
  if (head.attrs.get("randomize") === true || head.attrs.get("randomize") === "true") {
    config.randomizeOptions = true;
  }

  // probe (open only; harmless flag elsewhere but keep it type-scoped)
  if (head.attrs.has("probe")) {
    const maxProbes = numAttr(head.attrs, "maxProbes", headingLine, errors);
    const guidance = head.attrs.get("guidance");
    const probe = normalizeProbe({
      enabled: true,
      ...(maxProbes !== undefined ? { maxProbes } : {}),
      ...(typeof guidance === "string" ? { guidance } : {}),
    });
    if (probe) config.probe = probe;
  }

  // meta
  const meta = normalizeMeta(head.meta);
  if (meta) config.meta = meta;

  // ── references (kept as anchor tokens) ───────────────────────────────────
  if (sawShowIf) {
    if (conditions.length === 0) {
      errors.push({ line: headingLine, message: "showIf 블록에 유효한 조건이 없습니다" });
    } else {
      displayLogic = sanitizeDisplayLogic({ match: showIfMatch, conditions }) ?? {
        match: showIfMatch,
        conditions,
      };
    }
  }

  let optionsFrom: OptionsFrom | undefined;
  const from = head.attrs.get("optionsFrom");
  if (typeof from === "string" && from) {
    const mode = head.attrs.get("mode");
    if (mode !== undefined && mode !== "selected") {
      errors.push({ line: headingLine, message: `optionsFrom mode 는 'selected' 만 지원합니다: '${String(mode)}'` });
    }
    // questionId holds the ANCHOR token; resolveMarkdownRefs turns it into a quid.
    optionsFrom = { questionId: from, mode: "selected" };
  }

  return {
    anchor: head.anchor,
    ...(head.quid ? { quid: head.quid } : {}),
    type,
    prompt,
    config,
    refs: {
      ...(displayLogic ? { displayLogic } : {}),
      ...(optionsFrom ? { optionsFrom } : {}),
    },
    line: headingLine,
  };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Parse Loop Survey Markdown into a structured doc + collected errors. Never
 * throws: malformed input yields errors (line + reason). `doc` is present when
 * frontmatter + at least the structural shape parsed (individual question
 * errors still populate `errors`); it is omitted only when researchGoal is
 * missing (no valid survey can be created).
 */
export function parseSurveyMarkdown(md: string): ParseResult {
  const errors: ParseError[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");

  const { fm, bodyStart, errors: fmErrors } = parseFrontmatter(lines);
  errors.push(...fmErrors);

  const researchGoal = (fm.researchGoal ?? "").trim();
  if (!researchGoal) {
    errors.push({ line: 1, message: "frontmatter 에 researchGoal 이 필요합니다" });
  }

  // Locate question headings (### ...).
  const headingIdxs: number[] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    if (/^###\s+/.test(lines[i])) headingIdxs.push(i);
  }

  const questions: ParsedQuestion[] = [];
  for (let h = 0; h < headingIdxs.length; h++) {
    const start = headingIdxs[h];
    const end = h + 1 < headingIdxs.length ? headingIdxs[h + 1] : lines.length;
    const q = parseQuestion(lines, start, end, errors);
    if (q) questions.push(q);
  }

  if (!researchGoal) return { errors };

  const doc: ParsedSurveyDoc = {
    ...(fm.title?.trim() ? { title: fm.title.trim() } : {}),
    researchGoal,
    ...(fm.welcome?.trim() ? { welcome: fm.welcome.trim() } : {}),
    ...(fm.closing?.trim() ? { closing: fm.closing.trim() } : {}),
    questions,
  };
  return { doc, errors };
}

// ---------------------------------------------------------------------------
// Serialization (US-002): survey + questions → Loop Survey Markdown.
//
// The exact inverse of parseSurveyMarkdown. Every cross-question reference is
// emitted as a `#q_<quid>` token and each heading carries `{#q_<quid>}`, so an
// export round-trips losslessly (references re-resolve to the same quids). The
// visible anchor is a human-friendly `Q<n>` (position-stable); references never
// use it — they always use the `#q_<quid>` stable token.
//
// NOT represented (see PRD non-goals): `meta.origin` (trust tier, re-stamped on
// import) and `meta.constructId` (workspace dictionary pointer, re-resolved by
// the existing pipeline). `sourceQuid` (template provenance) is likewise not a
// markdown concept. Everything else in QCONFIG_FIELDS round-trips.
// ---------------------------------------------------------------------------

/** Survey header fields the serializer reads (matches the DB survey row). */
export type SerializeSurvey = {
  title?: string | null;
  researchGoal: string;
  welcomeMessage?: string | null;
  closingMessage?: string | null;
};

/** Minimal question shape the serializer reads (matches a live/questions row). */
export type SerializeQuestion = {
  quid: string;
  type: QuestionType;
  prompt: string;
  config: QConfig;
};

/** Double-quote a value, escaping `\` and `"` (inverse of `unquote`). */
function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A stable reference token for a quid (`q_ab12` → `#q_ab12`). */
function refToken(quid: string): string {
  return `#${quid}`;
}

/**
 * Emit one frontmatter field. Multi-line values use a `|` block scalar (indent
 * 2, matching `dedent`); single-line values are written bare unless they could
 * be misread as a block indicator / opening quote, in which case they're quoted.
 */
function emitFrontmatterField(key: string, value: string): string {
  if (value.includes("\n")) {
    const body = value
      .split("\n")
      .map((l) => (l ? "  " + l : ""))
      .join("\n");
    return `${key}: |\n${body}\n`;
  }
  const needsQuote = value === "" || value !== value.trim() || /^["|>]/.test(value);
  return `${key}: ${needsQuote ? quote(value) : value}\n`;
}

/** Escape a markdown-table cell (pipe → `\|`), matching `splitTableRow`. */
function escCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Serialize a showIf condition value (array / number / quoted string). */
function serializeCondValue(v: string | number | string[]): string {
  if (Array.isArray(v)) return JSON.stringify(v.map(String));
  if (typeof v === "number") return String(v);
  return quote(v);
}

/** Type + type-scoped inline attributes for the `[...]` heading block. */
function headingAttrs(type: QuestionType, config: QConfig): string[] {
  const attrs: string[] = [type];
  if (type === "scale" && config.scale) {
    attrs.push(`min=${config.scale.min}`, `max=${config.scale.max}`);
    if (config.scale.minLabel) attrs.push(`minLabel=${quote(config.scale.minLabel)}`);
    if (config.scale.maxLabel) attrs.push(`maxLabel=${quote(config.scale.maxLabel)}`);
  }
  if (typeof config.limit === "number") attrs.push(`limit=${config.limit}`);
  if (config.randomizeOptions) attrs.push("randomize");
  if (config.probe?.enabled) {
    attrs.push("probe", `maxProbes=${config.probe.maxProbes}`);
    if (config.probe.guidance) attrs.push(`guidance=${quote(config.probe.guidance)}`);
  }
  if (config.optionsFrom) {
    attrs.push(`optionsFrom=${refToken(config.optionsFrom.questionId)}`, `mode=${config.optionsFrom.mode}`);
  }
  return attrs;
}

/** Meta key=value tokens for the heading `{...}` block (origin/constructId dropped). */
function metaTokens(meta: QMeta | undefined): string[] {
  if (!meta) return [];
  const out: string[] = [];
  for (const f of ["construct", "topic", "population", "validatedScale", "notes"] as const) {
    const v = meta[f];
    if (typeof v === "string" && v) out.push(`${f}=${quote(v)}`);
  }
  if (meta.source) out.push(`source=${meta.source}`);
  return out;
}

/** One `- 라벨 [tags] {#o_id}` option list item. */
function serializeOption(o: OptionObject): string {
  const tags: string[] = [];
  if (o.special === "other") {
    tags.push("other");
    if (o.noText) tags.push("noText");
  } else if (o.special === "none") {
    tags.push("none");
  }
  let line = `- ${o.label}`;
  if (tags.length) line += ` [${tags.join(" ")}]`;
  // Emit an explicit id only when it isn't the label-derived one (custom id or
  // duplicate-label disambiguation); the `#o_` prefix is what the parser reads.
  if (o.id && o.id.startsWith("o_") && o.id !== optionIdFromLabel(o.label)) line += ` {#${o.id}}`;
  return line;
}

/** Render a single question (heading + optional showIf + prompt + body). */
function serializeQuestion(q: SerializeQuestion, index: number): string {
  const lines: string[] = [];
  const anchor = `Q${index + 1}`;
  const attrs = headingAttrs(q.type, q.config);
  const brace = [refToken(q.quid), ...metaTokens(normalizeMeta(q.config.meta))].join(" ");
  lines.push(`### ${anchor} [${attrs.join(" ")}] {${brace}}`);

  // showIf must sit directly under the heading, before the prompt, with no
  // blank line separating its condition list (a blank line ends the block).
  const dl = sanitizeDisplayLogic(q.config.displayLogic);
  if (dl) {
    lines.push(`showIf: ${dl.match}`);
    for (const c of dl.conditions) {
      lines.push(`- ${refToken(c.questionId)} ${c.op} ${serializeCondValue(c.value)}`);
    }
  }

  for (const l of q.prompt.split("\n")) lines.push(l);

  if (q.type === "matrix" && ((q.config.rows?.length ?? 0) > 0 || (q.config.columns?.length ?? 0) > 0)) {
    const cols = q.config.columns ?? [];
    const rows = q.config.rows ?? [];
    lines.push("");
    lines.push("| " + ["", ...cols].map(escCell).join(" | ") + " |");
    lines.push("| " + Array(cols.length + 1).fill("---").join(" | ") + " |");
    for (const r of rows) {
      lines.push("| " + [r, ...cols.map(() => "")].map(escCell).join(" | ") + " |");
    }
  } else if (!q.config.optionsFrom) {
    // Carry-forward questions draw their options from the source, so their list
    // stays empty; every other choice type emits its options.
    for (const o of normalizeOptions(q.config.options)) lines.push(serializeOption(o));
  }

  return lines.join("\n");
}

/**
 * Render a survey + its questions (in order) to Loop Survey Markdown. Pure
 * (no IO). The output parses back via parseSurveyMarkdown, and — after anchor
 * refs resolve (US-003) — reconstructs the same question set (config-equivalent
 * modulo the non-represented fields documented above).
 */
export function serializeSurveyMarkdown(
  survey: SerializeSurvey,
  questions: SerializeQuestion[],
): string {
  let head = "---\n";
  if (survey.title?.trim()) head += emitFrontmatterField("title", survey.title.trim());
  head += emitFrontmatterField("researchGoal", survey.researchGoal.trim());
  if (survey.welcomeMessage?.trim()) head += emitFrontmatterField("welcome", survey.welcomeMessage.trim());
  if (survey.closingMessage?.trim()) head += emitFrontmatterField("closing", survey.closingMessage.trim());
  head += "---\n";

  const body = questions.map((q, i) => serializeQuestion(q, i)).join("\n\n");
  return body ? `${head}\n${body}\n` : head;
}

// ---------------------------------------------------------------------------
// Reference resolution (US-003): anchor tokens → quids, two-stage.
//
// Stage 1 builds the anchor→quid map (every question gets a quid — the one
// captured from `{#q_...}` when present, a fresh one otherwise). Stage 2
// substitutes via the hardening remap helper (template-refs.ts remapConfigRefs)
// so the rewrite rules stay in one place. Unlike template seeding, an
// unresolvable reference here is an ERROR (line + target token), never a
// silent drop — import rejects the whole document (strict policy). Conditions
// and carry-forward may only point at EARLIER questions (the logic-lint
// forward_ref / carry_forward_ref contract), so self/forward references are
// errors too.
// ---------------------------------------------------------------------------

export type RefError = { line: number; message: string };

/** A question with references resolved to quids — consumer-shape config. */
export type ResolvedQuestion = {
  anchor: string;
  quid: string;
  type: QuestionType;
  prompt: string;
  /**
   * Full config including displayLogic/optionsFrom, whose questionIds are now
   * quids — the exact shapes display-logic / carry-forward normalize to.
   */
  config: QConfig;
  /** 1-based heading line (for downstream error reporting). */
  line: number;
};

export type ResolveResult = { resolved: ResolvedQuestion[]; errors: RefError[] };

/** Fresh quid in the schema's `q_` + 8-hex format, without a DB import. */
function freshQuid(used: Set<string>): string {
  for (;;) {
    let hex = "";
    while (hex.length < 8) hex += Math.floor(Math.random() * 16).toString(16);
    const quid = "q_" + hex.slice(0, 8);
    if (!used.has(quid)) return quid;
  }
}

/**
 * Resolve every parsed question's anchor-token references to quids. Reference
 * tokens may be visible anchors ("Q3") or stable `#q_<quid>` tokens (export
 * output); both resolve through the same map. Erroneous references are removed
 * from the resolved config (it stays consumer-shaped) AND reported — callers
 * enforcing the strict policy must reject when `errors` is non-empty.
 */
export function resolveMarkdownRefs(questions: ParsedQuestion[]): ResolveResult {
  const errors: RefError[] = [];

  // ── stage 1: assign quids + build token → question-index map ────────────
  const usedQuids = new Set<string>();
  for (const q of questions) if (q.quid) usedQuids.add(q.quid);

  const quids: string[] = [];
  const tokenToIndex = new Map<string, number>();
  const register = (token: string, index: number, label: string, line: number) => {
    const prev = tokenToIndex.get(token);
    if (prev !== undefined && prev !== index) {
      errors.push({ line, message: `중복 ${label}입니다: '${token}'` });
      return;
    }
    tokenToIndex.set(token, index);
  };

  questions.forEach((q, i) => {
    let quid = q.quid;
    if (quid && quids.includes(quid)) {
      // Same {#q_...} on two headings — references would be ambiguous.
      errors.push({ line: q.line, message: `중복 문항 ID입니다: '#${quid}'` });
      quid = undefined;
    }
    if (!quid) quid = freshQuid(usedQuids);
    usedQuids.add(quid);
    quids.push(quid);
    register(q.anchor, i, "앵커", q.line);
    register("#" + quid, i, "문항 ID", q.line);
    register(quid, i, "문항 ID", q.line);
  });

  // ── stage 2: validate + substitute each question's references ───────────
  const resolved = questions.map((q, i) => {
    // A per-question map holding ONLY this question's valid targets, so the
    // shared remap helper substitutes those and drops the ones we errored on.
    const localMap = new Map<string, string>();
    const check = (token: string, kind: string) => {
      const target = tokenToIndex.get(token);
      if (target === undefined) {
        errors.push({ line: q.line, message: `${kind}이(가) 정의되지 않은 문항을 참조합니다: '${token}'` });
        return;
      }
      if (target === i) {
        errors.push({ line: q.line, message: `${kind}이(가) 자기 자신을 참조합니다: '${token}'` });
        return;
      }
      if (target > i) {
        errors.push({
          line: q.line,
          message: `${kind}이(가) 뒤 문항을 참조합니다: '${token}'. 앞 문항만 참조할 수 있습니다.`,
        });
        return;
      }
      localMap.set(token, quids[target]);
    };

    const merged: QConfig = { ...q.config };
    if (q.refs.displayLogic) {
      merged.displayLogic = q.refs.displayLogic;
      for (const c of q.refs.displayLogic.conditions) check(c.questionId, "showIf 조건");
    }
    if (q.refs.optionsFrom) {
      merged.optionsFrom = q.refs.optionsFrom;
      check(q.refs.optionsFrom.questionId, "optionsFrom");
    }

    const { config } = remapConfigRefs(merged, localMap, { dropUnmapped: true });
    return {
      anchor: q.anchor,
      quid: quids[i],
      type: q.type,
      prompt: q.prompt,
      config,
      line: q.line,
    };
  });

  return { resolved, errors };
}
