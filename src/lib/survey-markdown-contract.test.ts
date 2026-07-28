/**
 * US-006: Loop Survey Markdown fidelity contract.
 *
 * One canonical fixture carries every markdown-representable QConfig field
 * (per the `markdown` group in qconfig-contract.ts) across all 7 question
 * types, and this file pins two invariants:
 *
 *  1. Stability — serialize → parse → resolve → serialize is a fixed point:
 *     the second output is STRING-identical to the first. This is what makes
 *     export → import → export safe for version control (no diff churn).
 *  2. Coverage — every field the `markdown` consumer group declares "handled"
 *     must actually appear in the canonical fixture. Adding a QConfig field
 *     first fails typecheck (QCONFIG_FIELDS/Record enforcement); declaring it
 *     "handled" without teaching the parser/serializer/fixture then fails HERE.
 *
 * 새 필드를 마크다운에 추가하는 체크리스트는 docs/survey-markdown.md 참조.
 */
import { describe, expect, it } from "vitest";
import {
  parseSurveyMarkdown,
  resolveMarkdownRefs,
  serializeSurveyMarkdown,
  type SerializeQuestion,
  type SerializeSurvey,
} from "@/lib/survey-markdown";
import { QCONFIG_CONSUMERS, QCONFIG_FIELDS, type QConfigField } from "@/lib/qconfig-contract";
import { optionIdFromLabel } from "@/lib/question-config";

/** Recursively key-sorted stringify (drops undefined) for config equivalence. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stable(val)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const opt = (label: string, special?: "other" | "none", noText?: boolean) => ({
  id: optionIdFromLabel(label),
  label,
  ...(special ? { special } : {}),
  ...(noText ? { noText } : {}),
});

const SURVEY: SerializeSurvey = {
  title: "정본 픽스처 설문",
  researchGoal: "마크다운 왕복 계약의 정본 픽스처",
  welcomeMessage: "안녕하세요!\n두 줄짜리 환영 문구입니다.",
  closingMessage: "감사합니다.",
};

/**
 * THE canonical fixture: all 7 types + every markdown-handled QConfig field.
 * When you teach the markdown format a new field, add it here — the coverage
 * test below fails until you do.
 */
const CANONICAL: SerializeQuestion[] = [
  {
    quid: "q_aaaa1111",
    type: "single",
    prompt: "어떤 경로로 저희를 알게 되셨나요?",
    config: {
      options: [
        opt("검색"),
        // Explicit non-label-derived id → must round-trip via `{#o_...}`.
        { id: "o_custom01", label: "지인 추천" },
        opt("기타", "other", true),
        opt("해당 없음", "none"),
      ],
      meta: {
        construct: "인지 경로",
        topic: "획득",
        population: "20대",
        validatedScale: "AAU-2",
        notes: "핵심 문항",
        source: "validated",
      },
    },
  },
  {
    quid: "q_bbbb2222",
    type: "scale",
    prompt: "전반적으로 만족하십니까?",
    config: { scale: { min: 1, max: 5, minLabel: "전혀 아니다", maxLabel: "매우 그렇다" } },
  },
  {
    quid: "q_cccc3333",
    type: "multi",
    prompt: "구매 이유를 모두 고르세요.",
    config: { options: [opt("가격"), opt("품질"), opt("배송")], limit: 2, randomizeOptions: true },
  },
  {
    quid: "q_dddd4444",
    type: "open",
    prompt: "개선점을 자유롭게 적어주세요.",
    config: { probe: { enabled: true, maxProbes: 3, guidance: "구체 사례를 물어라" } },
  },
  { quid: "q_eeee5555", type: "nps", prompt: "지인에게 추천할 의향은?", config: {} },
  {
    quid: "q_ffff6666",
    type: "ranking",
    prompt: "중요도 순으로 정렬하세요.",
    config: { options: [opt("A"), opt("B"), opt("C")], limit: 2 },
  },
  {
    quid: "q_1111aaaa",
    type: "matrix",
    prompt: "각 항목의 만족도를 평가해주세요.",
    config: { columns: ["불만족", "보통", "만족"], rows: ["배송 속도", "가격"] },
  },
  {
    quid: "q_2222bbbb",
    type: "single",
    prompt: "검색으로 오신 이유를 골라주세요.",
    config: {
      options: [opt("상단 노출"), opt("리뷰")],
      displayLogic: {
        match: "all",
        conditions: [
          { questionId: "q_aaaa1111", op: "eq", value: "검색" },
          { questionId: "q_bbbb2222", op: "gte", value: 4 },
          { questionId: "q_cccc3333", op: "in", value: ["가격", "품질"] },
        ],
      },
    },
  },
  {
    quid: "q_3333cccc",
    type: "single",
    prompt: "그 중 가장 결정적이었던 하나는?",
    config: { optionsFrom: { questionId: "q_cccc3333", mode: "selected" } },
  },
];

describe("Loop Survey Markdown contract (US-006)", () => {
  it("canonical fixture covers all 7 question types", () => {
    const types = new Set(CANONICAL.map((q) => q.type));
    expect([...types].sort()).toEqual(
      ["matrix", "multi", "nps", "open", "ranking", "scale", "single"],
    );
  });

  it("serialize → parse → resolve → serialize is string-stable", () => {
    const first = serializeSurveyMarkdown(SURVEY, CANONICAL);

    const { doc, errors: parseErrors } = parseSurveyMarkdown(first);
    expect(parseErrors).toEqual([]);
    expect(doc).toBeDefined();

    const { resolved, errors: refErrors } = resolveMarkdownRefs(doc!.questions);
    expect(refErrors).toEqual([]);

    const second = serializeSurveyMarkdown(
      {
        title: doc!.title,
        researchGoal: doc!.researchGoal,
        welcomeMessage: doc!.welcome,
        closingMessage: doc!.closing,
      },
      resolved,
    );
    expect(second).toBe(first);
  });

  it("parse + resolve reproduces the canonical fixture (deep-equal configs)", () => {
    const md = serializeSurveyMarkdown(SURVEY, CANONICAL);
    const { doc, errors: parseErrors } = parseSurveyMarkdown(md);
    expect(parseErrors).toEqual([]);
    const { resolved, errors: refErrors } = resolveMarkdownRefs(doc!.questions);
    expect(refErrors).toEqual([]);

    expect(resolved.length).toBe(CANONICAL.length);
    resolved.forEach((r, i) => {
      const original = CANONICAL[i];
      expect(r.quid, `Q${i + 1} quid`).toBe(original.quid);
      expect(r.type, `Q${i + 1} type`).toBe(original.type);
      expect(r.prompt, `Q${i + 1} prompt`).toBe(original.prompt);
      expect(stable(r.config), `Q${i + 1} config`).toBe(stable(original.config));
    });
  });

  it("every markdown-handled QConfig field appears in the canonical fixture", () => {
    // qconfig-contract's `markdown` group is the declaration of record for
    // "is this field representable in Loop Survey Markdown". A field declared
    // handled must be exercised by the fixture (so the round-trip tests above
    // actually prove it); a new field declared handled without fixture support
    // fails right here with its name.
    const exercised = new Set<QConfigField>();
    for (const q of CANONICAL) {
      for (const field of QCONFIG_FIELDS) {
        if (q.config[field] !== undefined) exercised.add(field);
      }
    }
    const missing = QCONFIG_FIELDS.filter(
      (f) => QCONFIG_CONSUMERS.markdown[f].status === "handled" && !exercised.has(f),
    );
    expect(missing, "markdown-handled fields absent from the canonical fixture").toEqual([]);
  });

  it("fields not representable in markdown are declared n/a with a reason", () => {
    for (const field of QCONFIG_FIELDS) {
      const d = QCONFIG_CONSUMERS.markdown[field];
      if (d.status === "n/a") {
        expect(d.reason.trim().length, `markdown.${field} n/a reason`).toBeGreaterThan(4);
      }
    }
    // The current format intentionally leaves exactly sourceQuid out (template
    // provenance — PRD non-goal). Changing that set is a conscious decision:
    // update this expectation together with the parser/serializer/docs.
    const na = QCONFIG_FIELDS.filter((f) => QCONFIG_CONSUMERS.markdown[f].status === "n/a");
    expect(na).toEqual(["sourceQuid"]);
  });
});
