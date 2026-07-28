/**
 * Plain-Korean rendering of version-compare values (US-006 detail view).
 * PURE MODULE — no DB / IO — so every formatter is unit-testable and usable
 * from the client-side compare panel.
 */

import type { DisplayLogic } from "@/lib/display-logic";
import { normalizeProbe, optionLabels } from "@/lib/question-config";
import type { FieldChange, RevisionQuestion } from "@/lib/question-diff";

export const TYPE_LABELS: Record<string, string> = {
  single: "단일 선택",
  multi: "복수 선택",
  scale: "척도",
  open: "주관식",
  ranking: "순위",
  matrix: "행렬",
  nps: "NPS",
};

/** Looks up the prompt of a referenced question ("이전 문항" when unknown). */
export type PromptOf = (questionId: string) => string | undefined;

const shorten = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** "「구독 상태」 = 구독 중일 때 표시" — display logic as one sentence. */
export function fmtDisplayLogic(raw: unknown, promptOf: PromptOf): string {
  const logic = raw as DisplayLogic | null | undefined;
  if (!logic || !Array.isArray(logic.conditions) || logic.conditions.length === 0) return "없음";
  const parts = logic.conditions.map((c) => {
    const name = `「${shorten(promptOf(c.questionId) ?? "이전 문항")}」`;
    const val = Array.isArray(c.value) ? c.value.join(", ") : String(c.value);
    switch (c.op) {
      case "eq":
        return `${name} = ${val}`;
      case "ne":
        return `${name} ≠ ${val}`;
      case "in":
        return `${name}이(가) [${val}] 중 하나`;
      case "not_in":
        return `${name}이(가) [${val}] 이외`;
      case "gte":
        return `${name} ≥ ${val}`;
      case "lte":
        return `${name} ≤ ${val}`;
      case "gt":
        return `${name} > ${val}`;
      case "lt":
        return `${name} < ${val}`;
      case "contains":
        return `${name}에 ${val} 포함`;
      default:
        return `${name} ${c.op} ${val}`;
    }
  });
  return `${parts.join(logic.match === "any" ? " 또는 " : " 그리고 ")}일 때 표시`;
}

function fmtScale(raw: unknown): string {
  const s = raw as { min?: number; max?: number; minLabel?: string; maxLabel?: string } | null | undefined;
  if (!s || typeof s !== "object") return "없음";
  const base = `${s.min ?? 1}–${s.max ?? 5}`;
  const labels = [s.minLabel, s.maxLabel].filter(Boolean).join(" ~ ");
  return labels ? `${base} (${labels})` : base;
}

function fmtList(raw: unknown): string {
  return Array.isArray(raw) && raw.length > 0 ? raw.map(String).join(", ") : "없음";
}

function fmtLimit(raw: unknown): string {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? `상위 ${n}개` : "전체 순위";
}

function fmtProbe(raw: unknown): string {
  const p = normalizeProbe(raw);
  if (!p?.enabled) return "꺼짐";
  return `켜짐 (최대 ${p.maxProbes}회${p.guidance ? `, 지침: ${p.guidance}` : ""})`;
}

const META_LABELS: Record<string, string> = {
  construct: "구성 개념",
  topic: "주제",
  population: "대상",
  source: "출처",
  validatedScale: "검증 척도",
  notes: "노트",
  origin: "입력 방식",
};

const META_ORIGIN_LABELS: Record<string, string> = {
  human: "직접 입력",
  ai: "AI 추정",
};

function fmtMeta(raw: unknown): string {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return "없음";
  // constructId is an internal dictionary pointer (US-006) — never shown.
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([k, v]) => k !== "constructId" && v != null && v !== "",
  );
  if (!entries.length) return "없음";
  return entries
    .map(([k, v]) => {
      const val = k === "origin" ? (META_ORIGIN_LABELS[String(v)] ?? String(v)) : String(v);
      return `${META_LABELS[k] ?? k}: ${val}`;
    })
    .join(" · ");
}

const onOff = (v: unknown) => (v ? "켜짐" : "꺼짐");

function fmtOptionsFrom(raw: unknown, promptOf: PromptOf): string {
  const o = raw as { questionId?: string } | null | undefined;
  if (!o || typeof o !== "object" || !o.questionId) return "없음";
  return `「${shorten(promptOf(o.questionId) ?? "이전 문항")}」에서 선택한 항목만`;
}

export type FieldChangeView = { label: string; from: string; to: string };

/** A field change as label + rendered before/after values. */
export function fieldChangeView(f: FieldChange, promptOf: PromptOf): FieldChangeView {
  switch (f.field) {
    case "prompt":
      return { label: "문항 내용", from: String(f.from ?? ""), to: String(f.to ?? "") };
    case "type":
      return {
        label: "문항 유형",
        from: TYPE_LABELS[String(f.from)] ?? String(f.from ?? "없음"),
        to: TYPE_LABELS[String(f.to)] ?? String(f.to ?? "없음"),
      };
    case "scale":
      return { label: "척도", from: fmtScale(f.from), to: fmtScale(f.to) };
    case "rows":
      return { label: "행 (평가 항목)", from: fmtList(f.from), to: fmtList(f.to) };
    case "columns":
      return { label: "열 (응답 척도)", from: fmtList(f.from), to: fmtList(f.to) };
    case "limit":
      return { label: "선택 제한", from: fmtLimit(f.from), to: fmtLimit(f.to) };
    case "displayLogic":
      return {
        label: "표시 조건",
        from: fmtDisplayLogic(f.from, promptOf),
        to: fmtDisplayLogic(f.to, promptOf),
      };
    case "probe":
      return { label: "AI 심층 질문", from: fmtProbe(f.from), to: fmtProbe(f.to) };
    case "randomizeOptions":
      return { label: "보기 무작위 표시", from: onOff(f.from), to: onOff(f.to) };
    case "meta":
      return { label: "메타데이터", from: fmtMeta(f.from), to: fmtMeta(f.to) };
    case "optionsFrom":
      return { label: "보기 가져오기", from: fmtOptionsFrom(f.from, promptOf), to: fmtOptionsFrom(f.to, promptOf) };
    default:
      return { label: String(f.field), from: String(f.from ?? "없음"), to: String(f.to ?? "없음") };
  }
}

/**
 * Full content of a question as short lines — what an added/deleted question
 * actually contained, so the compare view shows more than its prompt.
 */
export function questionSummaryLines(q: RevisionQuestion, promptOf: PromptOf): string[] {
  const lines: string[] = [`유형: ${TYPE_LABELS[q.type] ?? q.type}`];
  const opts = optionLabels(q.config.options);
  if (opts.length) lines.push(`보기: ${opts.join(", ")}`);
  if (q.config.scale) lines.push(`척도: ${fmtScale(q.config.scale)}`);
  if (q.config.rows?.length) lines.push(`행: ${fmtList(q.config.rows)}`);
  if (q.config.columns?.length) lines.push(`열: ${fmtList(q.config.columns)}`);
  if (q.config.limit) lines.push(`선택 제한: ${fmtLimit(q.config.limit)}`);
  if (q.config.displayLogic) lines.push(`표시 조건: ${fmtDisplayLogic(q.config.displayLogic, promptOf)}`);
  if (q.config.optionsFrom) lines.push(`보기 가져오기: ${fmtOptionsFrom(q.config.optionsFrom, promptOf)}`);
  if (normalizeProbe(q.config.probe)?.enabled) lines.push(`AI 심층 질문: ${fmtProbe(q.config.probe)}`);
  if (q.config.randomizeOptions) lines.push("보기 무작위 표시: 켜짐");
  return lines;
}
