import { describe, expect, it } from "vitest";
import {
  parseSurveyMarkdown,
  resolveMarkdownRefs,
  serializeSurveyMarkdown,
  type ParsedQuestion,
  type SerializeQuestion,
  type SerializeSurvey,
} from "@/lib/survey-markdown";
import type { QConfig } from "@/lib/question-diff";
import { optionIdFromLabel } from "@/lib/question-config";

const fm = (extra = "") =>
  `---\ntitle: 테스트 설문\nresearchGoal: 재구매 의향 파악\n${extra}---\n`;

describe("parseSurveyMarkdown — frontmatter", () => {
  it("parses title/researchGoal and optional welcome/closing block scalars", () => {
    const md = `---
title: 고객 만족도
researchGoal: 핵심 동인 파악
welcome: |
  안녕하세요! 3분이면 끝납니다.
closing: |
  감사합니다.
---
### Q1 [open]
자유롭게 적어주세요.
`;
    const { doc, errors } = parseSurveyMarkdown(md);
    expect(errors).toEqual([]);
    expect(doc?.title).toBe("고객 만족도");
    expect(doc?.researchGoal).toBe("핵심 동인 파악");
    expect(doc?.welcome).toBe("안녕하세요! 3분이면 끝납니다.");
    expect(doc?.closing).toBe("감사합니다.");
  });

  it("errors (no doc) when researchGoal is missing, at line 1", () => {
    const md = `---\ntitle: no goal\n---\n### Q1 [open]\n프롬프트\n`;
    const { doc, errors } = parseSurveyMarkdown(md);
    expect(doc).toBeUndefined();
    expect(errors.some((e) => e.line === 1 && /researchGoal/.test(e.message))).toBe(true);
  });
});

describe("parseSurveyMarkdown — question types", () => {
  it("parses single with options + special other/none + noText", () => {
    const md =
      fm() +
      `### Q1 [single]
어떤 경로로 오셨나요?
- 검색
- 지인 추천
- 기타 [other]
- 해당 없음 [none noText]
`;
    const { doc, errors } = parseSurveyMarkdown(md);
    expect(errors).toEqual([]);
    const q = doc!.questions[0];
    expect(q.type).toBe("single");
    expect(q.anchor).toBe("Q1");
    const opts = q.config.options as { label: string; special?: string; noText?: boolean }[];
    expect(opts.map((o) => o.label)).toEqual(["검색", "지인 추천", "기타", "해당 없음"]);
    expect(opts.find((o) => o.label === "기타")?.special).toBe("other");
    expect(opts.find((o) => o.label === "해당 없음")?.special).toBe("none");
  });

  it("parses multi with limit + randomize", () => {
    const md = fm() + `### Q2 [multi limit=3 randomize]\n좋아하는 색을 고르세요.\n- 빨강\n- 파랑\n- 초록\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.type).toBe("multi");
    expect(q.config.limit).toBe(3);
    expect(q.config.randomizeOptions).toBe(true);
  });

  it("parses scale with min/max/labels", () => {
    const md =
      fm() + `### Q3 [scale min=1 max=5 minLabel="전혀 아니다" maxLabel="매우 그렇다"]\n만족하십니까?\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.config.scale).toEqual({ min: 1, max: 5, minLabel: "전혀 아니다", maxLabel: "매우 그렇다" });
  });

  it("parses nps (no scale field)", () => {
    const md = fm() + `### Q4 [nps]\n추천 의향은?\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.type).toBe("nps");
    expect(q.config.scale).toBeUndefined();
  });

  it("parses open with probe (enabled/maxProbes/guidance)", () => {
    const md = fm() + `### Q5 [open probe maxProbes=3 guidance="사례를 물어라"]\n의견을 적어주세요.\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.config.probe).toEqual({ enabled: true, maxProbes: 3, guidance: "사례를 물어라" });
  });

  it("parses ranking", () => {
    const md = fm() + `### Q6 [ranking limit=2]\n중요도 순으로.\n- A\n- B\n- C\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.type).toBe("ranking");
    expect((q.config.options as unknown[]).length).toBe(3);
    expect(q.config.limit).toBe(2);
  });

  it("parses matrix table into rows/columns (drops corner cell)", () => {
    const md =
      fm() +
      `### Q7 [matrix]
각 항목의 만족도.

|          | 불만족 | 보통 | 만족 |
|----------|--------|------|------|
| 배송 속도 |        |      |      |
| 가격      |        |      |      |
`;
    const { doc, errors } = parseSurveyMarkdown(md);
    expect(errors).toEqual([]);
    const q = doc!.questions[0];
    expect(q.config.columns).toEqual(["불만족", "보통", "만족"]);
    expect(q.config.rows).toEqual(["배송 속도", "가격"]);
  });

  it("parses meta from heading braces", () => {
    const md =
      fm() + `### Q8 [single] {construct="만족도" topic="CS" source=validated population="20대"}\n질문?\n- 예\n- 아니오\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.config.meta).toMatchObject({ construct: "만족도", topic: "CS", source: "validated", population: "20대" });
  });

  it("captures quid from {#q_...} in heading", () => {
    const md = fm() + `### Q9 [open] {#q_ab12cd34}\n프롬프트\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.quid).toBe("q_ab12cd34");
  });
});

describe("parseSurveyMarkdown — references (anchor tokens, unresolved)", () => {
  it("parses showIf block into refs.displayLogic with anchor questionIds", () => {
    const md =
      fm() +
      `### Q10 [single]
showIf: all
- Q1 eq "검색"
- Q3 gte 7
검색으로 오신 이유는?
- 상단 노출
- 리뷰
`;
    const { doc, errors } = parseSurveyMarkdown(md);
    expect(errors).toEqual([]);
    const q = doc!.questions[0];
    expect(q.refs.displayLogic).toEqual({
      match: "all",
      conditions: [
        { questionId: "Q1", op: "eq", value: "검색" },
        { questionId: "Q3", op: "gte", value: 7 },
      ],
    });
    // prompt + options still parsed after the showIf block
    expect(q.prompt).toBe("검색으로 오신 이유는?");
    expect((q.config.options as unknown[]).length).toBe(2);
  });

  it("parses array condition value for in/not_in", () => {
    const md =
      fm() + `### Q11 [single]\nshowIf: any\n- Q1 in ["검색","광고"]\n프롬프트\n- 예\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.refs.displayLogic).toEqual({
      match: "any",
      conditions: [{ questionId: "Q1", op: "in", value: ["검색", "광고"] }],
    });
  });

  it("parses optionsFrom into refs (anchor token, mode selected)", () => {
    const md = fm() + `### Q12 [single optionsFrom=Q5 mode=selected]\n가장 중요한 하나는?\n`;
    const q = parseSurveyMarkdown(md).doc!.questions[0];
    expect(q.refs.optionsFrom).toEqual({ questionId: "Q5", mode: "selected" });
  });
});

describe("parseSurveyMarkdown — error collection (line + reason)", () => {
  it("reports unknown question type at the heading line", () => {
    const md = fm() + `### Q1 [dropdown]\n프롬프트\n`;
    const { errors } = parseSurveyMarkdown(md);
    // frontmatter is 4 lines (---,title,researchGoal,---), heading at line 5
    expect(errors.some((e) => e.line === 5 && /알 수 없는 문항 타입/.test(e.message))).toBe(true);
  });

  it("reports unknown attribute", () => {
    const md = fm() + `### Q1 [single foo=bar]\n프롬프트\n- 예\n`;
    const { errors } = parseSurveyMarkdown(md);
    expect(errors.some((e) => /알 수 없는 속성.*foo/.test(e.message))).toBe(true);
  });

  it("reports bad condition operator", () => {
    const md = fm() + `### Q1 [single]\nshowIf: all\n- Q0 wat "x"\n프롬프트\n- 예\n`;
    const { errors } = parseSurveyMarkdown(md);
    expect(errors.some((e) => /알 수 없는 조건 연산자.*wat/.test(e.message))).toBe(true);
  });

  it("reports empty prompt at heading line", () => {
    const md = fm() + `### Q1 [single]\n- 예\n- 아니오\n`;
    const { errors } = parseSurveyMarkdown(md);
    expect(errors.some((e) => e.line === 5 && /프롬프트가 비어/.test(e.message))).toBe(true);
  });

  it("reports scale without min/max", () => {
    const md = fm() + `### Q1 [scale]\n만족도?\n`;
    const { errors } = parseSurveyMarkdown(md);
    expect(errors.some((e) => /min\/max/.test(e.message))).toBe(true);
  });

  it("reports matrix without a table", () => {
    const md = fm() + `### Q1 [matrix]\n평가해주세요.\n`;
    const { errors } = parseSurveyMarkdown(md);
    expect(errors.some((e) => /행\/열 표가 필요/.test(e.message))).toBe(true);
  });

  it("reports options on a non-choice type", () => {
    const md = fm() + `### Q1 [scale min=1 max=5]\n만족도?\n- 잘못된 보기\n`;
    const { errors } = parseSurveyMarkdown(md);
    expect(errors.some((e) => /보기 목록을 가질 수 없/.test(e.message))).toBe(true);
  });
});

// ── US-002: serializeSurveyMarkdown + round-trip ────────────────────────────

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

/** Stand-in for US-003 resolve: `#q_<quid>` token → the bare quid. */
const resolveRef = (token: string) => (token.startsWith("#") ? token.slice(1) : token);

/** Merge a parsed question's anchor-token refs (resolved) back into its config. */
function mergedConfig(p: ParsedQuestion): QConfig {
  const config: QConfig = { ...p.config };
  if (p.refs.displayLogic) {
    config.displayLogic = {
      match: p.refs.displayLogic.match,
      conditions: p.refs.displayLogic.conditions.map((c) => ({ ...c, questionId: resolveRef(c.questionId) })),
    };
  }
  if (p.refs.optionsFrom) {
    config.optionsFrom = { ...p.refs.optionsFrom, questionId: resolveRef(p.refs.optionsFrom.questionId) };
  }
  return config;
}

const opt = (label: string, special?: "other" | "none", noText?: boolean) => ({
  id: optionIdFromLabel(label),
  label,
  ...(special ? { special } : {}),
  ...(noText ? { noText } : {}),
});

const SURVEY: SerializeSurvey = {
  title: "고객 만족도",
  researchGoal: "재구매 의향의 핵심 동인을 파악한다",
  welcomeMessage: "안녕하세요! 3분이면 끝납니다.\n부담 없이 답해주세요.",
  closingMessage: "참여해주셔서 감사합니다.",
};

// Full-fidelity fixture: every type + every representable config field.
const FIXTURE: SerializeQuestion[] = [
  {
    quid: "q_aaaa1111",
    type: "single",
    prompt: "어떤 경로로 저희를 알게 되셨나요?",
    config: {
      options: [opt("검색"), opt("지인 추천"), opt("기타", "other", true), opt("해당 없음", "none")],
      meta: { construct: "인지 경로", topic: "획득", population: "20대", source: "custom", notes: "핵심" },
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
    config: { options: [opt("A"), opt("B"), opt("C")] },
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

describe("serializeSurveyMarkdown — field output", () => {
  it("emits frontmatter (title/researchGoal + block-scalar welcome/closing)", () => {
    const md = serializeSurveyMarkdown(SURVEY, []);
    expect(md).toContain("title: 고객 만족도");
    expect(md).toContain("researchGoal: 재구매 의향의 핵심 동인을 파악한다");
    expect(md).toContain("welcome: |\n  안녕하세요! 3분이면 끝납니다.\n  부담 없이 답해주세요.");
    expect(md).toContain("closing: 참여해주셔서 감사합니다.");
  });

  it("emits single options with [other]/[none noText] and a #q_ anchor", () => {
    const md = serializeSurveyMarkdown(SURVEY, [FIXTURE[0]]);
    expect(md).toContain("### Q1 [single] {#q_aaaa1111");
    expect(md).toContain("- 검색");
    expect(md).toContain("- 기타 [other noText]");
    expect(md).toContain("- 해당 없음 [none]");
  });

  it("emits scale attrs with quoted labels", () => {
    const md = serializeSurveyMarkdown(SURVEY, [FIXTURE[1]]);
    expect(md).toContain('[scale min=1 max=5 minLabel="전혀 아니다" maxLabel="매우 그렇다"]');
  });

  it("emits multi limit + randomize flag", () => {
    const md = serializeSurveyMarkdown(SURVEY, [FIXTURE[2]]);
    expect(md).toContain("[multi limit=2 randomize]");
  });

  it("emits open probe attrs", () => {
    const md = serializeSurveyMarkdown(SURVEY, [FIXTURE[3]]);
    expect(md).toContain('[open probe maxProbes=3 guidance="구체 사례를 물어라"]');
  });

  it("emits a matrix table (empty corner + column header + row cells)", () => {
    const md = serializeSurveyMarkdown(SURVEY, [FIXTURE[6]]);
    expect(md).toContain("|  | 불만족 | 보통 | 만족 |");
    expect(md).toContain("| 배송 속도 |  |  |");
  });

  it("emits a showIf block with #q_ reference tokens before the prompt", () => {
    const md = serializeSurveyMarkdown(SURVEY, [FIXTURE[7]]);
    expect(md).toContain("showIf: all\n- #q_aaaa1111 eq \"검색\"\n- #q_bbbb2222 gte 4");
  });

  it("emits optionsFrom as a #q_ token and no option list", () => {
    const md = serializeSurveyMarkdown(SURVEY, [FIXTURE[8]]);
    expect(md).toContain("[single optionsFrom=#q_cccc3333 mode=selected]");
    expect(md).not.toContain("\n- ");
  });

  it("emits heading meta braces", () => {
    const md = serializeSurveyMarkdown(SURVEY, [FIXTURE[0]]);
    expect(md).toMatch(/\{#q_aaaa1111 construct="인지 경로" topic="획득" population="20대" notes="핵심" source=custom\}/);
  });
});

// ── US-003: resolveMarkdownRefs (anchor → quid, two-stage) ──────────────────

/** Parse markdown (asserting no parse errors) and return its questions. */
function parsed(md: string): ParsedQuestion[] {
  const { doc, errors } = parseSurveyMarkdown(md);
  expect(errors).toEqual([]);
  return doc!.questions;
}

describe("resolveMarkdownRefs", () => {
  it("remaps showIf + optionsFrom anchors to the referenced questions' quids", () => {
    const md =
      fm() +
      `### Q1 [multi]
구매 이유를 모두 고르세요.
- 가격
- 품질

### Q2 [scale min=0 max=10]
만족도는?

### Q3 [single optionsFrom=Q1 mode=selected]
showIf: all
- Q1 contains "가격"
- Q2 gte 7
가장 결정적이었던 하나는?
`;
    const { resolved, errors } = resolveMarkdownRefs(parsed(md));
    expect(errors).toEqual([]);
    expect(resolved.length).toBe(3);
    const [q1, q2, q3] = resolved;
    expect(q3.config.displayLogic).toEqual({
      match: "all",
      conditions: [
        { questionId: q1.quid, op: "contains", value: "가격" },
        { questionId: q2.quid, op: "gte", value: 7 },
      ],
    });
    expect(q3.config.optionsFrom).toEqual({ questionId: q1.quid, mode: "selected" });
  });

  it("preserves {#q_...} quids and generates schema-format quids otherwise", () => {
    const md = fm() + `### Q1 [open] {#q_ab12cd34}\n프롬프트\n\n### Q2 [open]\n프롬프트\n`;
    const { resolved, errors } = resolveMarkdownRefs(parsed(md));
    expect(errors).toEqual([]);
    expect(resolved[0].quid).toBe("q_ab12cd34");
    expect(resolved[1].quid).toMatch(/^q_[0-9a-f]{8}$/);
    expect(resolved[1].quid).not.toBe(resolved[0].quid);
  });

  it("resolves stable #q_ tokens (export output) through the same map", () => {
    const md =
      fm() +
      `### Q1 [single] {#q_aaaa1111}\n프롬프트\n- 예\n- 아니오\n\n### Q2 [open] {#q_bbbb2222}\nshowIf: all\n- #q_aaaa1111 eq "예"\n왜 그렇게 생각하세요?\n`;
    const { resolved, errors } = resolveMarkdownRefs(parsed(md));
    expect(errors).toEqual([]);
    expect(resolved[1].config.displayLogic?.conditions[0].questionId).toBe("q_aaaa1111");
  });

  it("collects a RefError (line + target token) for a dangling anchor and drops the ref", () => {
    const md = fm() + `### Q1 [single]\nshowIf: all\n- Q9 eq "예"\n프롬프트\n- 예\n`;
    const qs = parsed(md);
    const { resolved, errors } = resolveMarkdownRefs(qs);
    expect(errors).toEqual([
      { line: qs[0].line, message: expect.stringMatching(/정의되지 않은 문항.*'Q9'/) },
    ]);
    // Strict policy rejects the doc, but resolved stays consumer-shaped.
    expect(resolved[0].config.displayLogic).toBeUndefined();
  });

  it("rejects a dangling optionsFrom anchor", () => {
    const md = fm() + `### Q1 [single optionsFrom=Q7]\n가장 중요한 것은?\n`;
    const { resolved, errors } = resolveMarkdownRefs(parsed(md));
    expect(errors.some((e) => /optionsFrom.*정의되지 않은 문항.*'Q7'/.test(e.message))).toBe(true);
    expect(resolved[0].config.optionsFrom).toBeUndefined();
  });

  it("rejects a self reference", () => {
    const md = fm() + `### Q1 [single]\nshowIf: all\n- Q1 eq "예"\n프롬프트\n- 예\n`;
    const { errors } = resolveMarkdownRefs(parsed(md));
    expect(errors.some((e) => /자기 자신을 참조.*'Q1'/.test(e.message))).toBe(true);
  });

  it("rejects a forward reference (conditions may only point at earlier questions)", () => {
    const md =
      fm() +
      `### Q1 [single]\nshowIf: all\n- Q2 eq "예"\n프롬프트\n- 예\n\n### Q2 [single]\n프롬프트\n- 예\n- 아니오\n`;
    const qs = parsed(md);
    const { errors } = resolveMarkdownRefs(qs);
    expect(errors).toEqual([
      { line: qs[0].line, message: expect.stringMatching(/뒤 문항을 참조.*'Q2'/) },
    ]);
  });

  it("rejects duplicate anchors (ambiguous reference targets)", () => {
    const md = fm() + `### Q1 [open]\n프롬프트\n\n### Q1 [open]\n프롬프트\n`;
    const qs = parsed(md);
    const { errors } = resolveMarkdownRefs(qs);
    expect(errors.some((e) => e.line === qs[1].line && /중복 앵커.*'Q1'/.test(e.message))).toBe(true);
  });

  it("rejects duplicate {#q_...} ids", () => {
    const md = fm() + `### Q1 [open] {#q_aaaa1111}\n프롬프트\n\n### Q2 [open] {#q_aaaa1111}\n프롬프트\n`;
    const qs = parsed(md);
    const { errors } = resolveMarkdownRefs(qs);
    expect(errors.some((e) => e.line === qs[1].line && /중복 문항 ID.*'#q_aaaa1111'/.test(e.message))).toBe(true);
  });

  it("full-fixture round-trip: serialize → parse → resolve reproduces every config", () => {
    const md = serializeSurveyMarkdown(SURVEY, FIXTURE);
    const { resolved, errors } = resolveMarkdownRefs(parsed(md));
    expect(errors).toEqual([]);
    resolved.forEach((r, i) => {
      expect(r.quid).toBe(FIXTURE[i].quid);
      expect(r.type).toBe(FIXTURE[i].type);
      expect(r.prompt).toBe(FIXTURE[i].prompt);
      expect(stable(r.config)).toBe(stable(FIXTURE[i].config));
    });
  });
});

describe("serializeSurveyMarkdown — lossless round-trip", () => {
  it("serialize → parse → resolve reconstructs the full fixture", () => {
    const md = serializeSurveyMarkdown(SURVEY, FIXTURE);
    const { doc, errors } = parseSurveyMarkdown(md);
    expect(errors).toEqual([]);
    expect(doc).toBeDefined();
    expect(doc!.title).toBe(SURVEY.title);
    expect(doc!.researchGoal).toBe(SURVEY.researchGoal);
    expect(doc!.welcome).toBe(SURVEY.welcomeMessage!.trim());
    expect(doc!.closing).toBe(SURVEY.closingMessage);

    expect(doc!.questions.length).toBe(FIXTURE.length);
    doc!.questions.forEach((p, i) => {
      const original = FIXTURE[i];
      expect(p.type).toBe(original.type);
      expect(p.prompt).toBe(original.prompt);
      expect(p.quid).toBe(original.quid);
      expect(stable(mergedConfig(p))).toBe(stable(original.config));
    });
  });
});
