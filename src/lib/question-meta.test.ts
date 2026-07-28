import { describe, expect, it } from "vitest";
import {
  buildInferMetaPrompt,
  parseInferredMeta,
  MAX_CANDIDATE_CONSTRUCTS,
  MAX_OPTION_LABELS,
  MAX_PROMPT_CHARS,
} from "@/lib/question-meta";
import { META_FIELD_MAX } from "@/lib/question-config";

describe("parseInferredMeta", () => {
  it("returns null for junk shapes", () => {
    expect(parseInferredMeta(undefined)).toBeNull();
    expect(parseInferredMeta(null)).toBeNull();
    expect(parseInferredMeta("construct")).toBeNull();
    expect(parseInferredMeta(42)).toBeNull();
    expect(parseInferredMeta([{ construct: "a", topic: "b" }])).toBeNull();
  });

  it("returns null when construct or topic is missing, blank, or non-string", () => {
    expect(parseInferredMeta({})).toBeNull();
    expect(parseInferredMeta({ construct: "고객 만족도" })).toBeNull();
    expect(parseInferredMeta({ topic: "배달 품질" })).toBeNull();
    expect(parseInferredMeta({ construct: "   ", topic: "배달 품질" })).toBeNull();
    expect(parseInferredMeta({ construct: "고객 만족도", topic: "" })).toBeNull();
    expect(parseInferredMeta({ construct: 3, topic: "배달 품질" })).toBeNull();
    expect(parseInferredMeta({ construct: "고객 만족도", topic: { t: "x" } })).toBeNull();
  });

  it("trims valid fields and ignores extra keys", () => {
    const out = parseInferredMeta({
      construct: "  고객 만족도  ",
      topic: "  배달 품질  ",
      notes: "should be ignored",
    });
    expect(out).toEqual({ construct: "고객 만족도", topic: "배달 품질" });
  });

  it("caps runaway field lengths to META_FIELD_MAX", () => {
    const long = "가".repeat(META_FIELD_MAX + 200);
    const out = parseInferredMeta({ construct: long, topic: long });
    expect(out?.construct).toHaveLength(META_FIELD_MAX);
    expect(out?.topic).toHaveLength(META_FIELD_MAX);
  });
});

describe("buildInferMetaPrompt", () => {
  const base = {
    researchGoal: "배달앱 재구매 요인 파악",
    prompt: "배달 속도에 얼마나 만족하시나요?",
    type: "scale",
  };

  it("includes goal, type, prompt, and the JSON output contract", () => {
    const p = buildInferMetaPrompt(base);
    expect(p).toContain("배달앱 재구매 요인 파악");
    expect(p).toContain('"scale"');
    expect(p).toContain("배달 속도에 얼마나 만족하시나요?");
    expect(p).toContain('{"construct"');
  });

  it("lists existing constructs as reuse candidates, deduped", () => {
    const p = buildInferMetaPrompt({
      ...base,
      existingConstructs: [" 고객 만족도 ", "재구매 의도", "고객 만족도", "", 3 as unknown as string],
    });
    expect(p).toContain("이미 존재하는 construct 목록");
    expect(p).toContain("- 고객 만족도");
    expect(p).toContain("- 재구매 의도");
    expect(p.match(/- 고객 만족도/g)).toHaveLength(1);
  });

  it("omits the candidate block when no constructs exist", () => {
    expect(buildInferMetaPrompt(base)).not.toContain("이미 존재하는 construct 목록");
    expect(buildInferMetaPrompt({ ...base, existingConstructs: [] })).not.toContain(
      "이미 존재하는 construct 목록",
    );
  });

  it("caps candidate count to MAX_CANDIDATE_CONSTRUCTS", () => {
    const many = Array.from({ length: MAX_CANDIDATE_CONSTRUCTS + 10 }, (_, i) => `개념${i}`);
    const p = buildInferMetaPrompt({ ...base, existingConstructs: many });
    expect(p).toContain(`- 개념${MAX_CANDIDATE_CONSTRUCTS - 1}`);
    expect(p).not.toContain(`- 개념${MAX_CANDIDATE_CONSTRUCTS}`);
  });

  it("includes option labels when present and caps their count", () => {
    const labels = Array.from({ length: MAX_OPTION_LABELS + 5 }, (_, i) => `옵션${i}`);
    const p = buildInferMetaPrompt({ ...base, type: "single", optionLabels: labels });
    expect(p).toContain(`"옵션${MAX_OPTION_LABELS - 1}"`);
    expect(p).not.toContain(`"옵션${MAX_OPTION_LABELS}"`);
    expect(buildInferMetaPrompt(base)).not.toContain("선택지:");
  });

  it("caps a runaway question prompt and tolerates non-string junk inputs", () => {
    const long = "문".repeat(MAX_PROMPT_CHARS + 300);
    const p = buildInferMetaPrompt({ ...base, prompt: long });
    expect(p).toContain("문".repeat(MAX_PROMPT_CHARS));
    expect(p).not.toContain("문".repeat(MAX_PROMPT_CHARS + 1));
    // junk shapes must not throw
    expect(() =>
      buildInferMetaPrompt({
        researchGoal: null as unknown as string,
        prompt: undefined as unknown as string,
        type: 7 as unknown as string,
        optionLabels: [null] as unknown as string[],
      }),
    ).not.toThrow();
  });
});
