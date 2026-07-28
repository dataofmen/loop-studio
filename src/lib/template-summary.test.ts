import { describe, expect, it } from "vitest";
import type { QMeta } from "./question-config";
import type { RevisionQuestion } from "./question-diff";
import {
  collectTagValues,
  deriveMetaTags,
  filterTemplateSummaries,
  planDecomposition,
  structuredSummary,
  summarizeTemplate,
  type TemplateRow,
  type TemplateSummary,
} from "./template-summary";

const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: "t1",
  name: "NPS + 이탈",
  description: "고객 충성도",
  questionsSnapshot: [
    { quid: "q2", type: "single", order: 1, prompt: "두 번째", config: {} },
    { quid: "q1", type: "nps", order: 0, prompt: "첫 번째", config: {} },
    { quid: "q3", type: "open", order: 2, prompt: "세 번째", config: {} },
    { quid: "q4", type: "open", order: 3, prompt: "네 번째", config: {} },
  ],
  metaTags: { construct: "loyalty", topic: "retention" },
  createdAt: new Date("2026-07-03T00:00:00Z"),
  ...over,
});

const sum = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: "x",
  name: "N",
  description: null,
  kind: "survey",
  aiSummary: null,
  tags: {},
  questionCount: 0,
  preview: [],
  structured: { questionCount: 0, typeCounts: [], scales: [], constructs: [], topics: [] },
  createdAt: new Date(0),
  ...over,
});

const mq = (meta: QMeta | undefined, i: number): RevisionQuestion => ({
  quid: `q${i}`,
  type: "single",
  order: i,
  prompt: `문항 ${i}`,
  config: meta ? { meta } : {},
});

describe("deriveMetaTags", () => {
  it("picks the dominant construct/topic and returns {} when none", () => {
    const tags = deriveMetaTags([
      mq({ construct: "만족도", topic: "제품" }, 0),
      mq({ construct: "만족도", topic: "가격" }, 1),
      mq({ construct: "충성도", topic: "제품" }, 2),
    ]);
    expect(tags).toEqual({ construct: "만족도", topic: "제품" });
    expect(deriveMetaTags([mq(undefined, 0)])).toEqual({});
  });

  it("groups spelling variants of one concept by normalized key", () => {
    // 2 variants of one concept beat 1 mention of another (old exact-string
    // counting would have split them into 1+1 and lost to nothing).
    const tags = deriveMetaTags([
      mq({ construct: "NPS 점수" }, 0),
      mq({ construct: " nps  점수 " }, 1),
      mq({ construct: "이탈 의향" }, 2),
    ]);
    expect(tags.construct).toBe("NPS 점수");
  });

  it("lets a dictionary-resolved member win display form + expose constructId", () => {
    const tags = deriveMetaTags([
      mq({ construct: "고객  만족도" }, 0), // legacy free text, seen first
      mq({ construct: "고객 만족도", constructId: "c-1" }, 1),
    ]);
    expect(tags).toEqual({ construct: "고객 만족도", constructId: "c-1" });
  });

  it("keeps free-text-only metas as-is (backward compatible)", () => {
    expect(deriveMetaTags([mq({ construct: "브랜드 인지도" }, 0)])).toEqual({
      construct: "브랜드 인지도",
    });
  });
});

describe("summarizeTemplate", () => {
  it("counts questions and previews them (with type) in order", () => {
    const s = summarizeTemplate(row());
    expect(s.questionCount).toBe(4);
    expect(s.preview.map((p) => p.prompt)).toEqual(["첫 번째", "두 번째", "세 번째", "네 번째"]); // sorted by order
    expect(s.preview[0].type).toBe("nps"); // type rides along for the composition preview
    expect(s.tags).toEqual({ construct: "loyalty", topic: "retention" });
  });

  it("caps the preview at previewCount", () => {
    const s = summarizeTemplate(row(), 2);
    expect(s.preview.map((p) => p.prompt)).toEqual(["첫 번째", "두 번째"]);
    expect(s.questionCount).toBe(4); // count is the full snapshot, not the cap
  });

  it("tolerates non-array snapshot and non-string tags", () => {
    const s = summarizeTemplate(row({ questionsSnapshot: null, metaTags: { construct: 5 } }));
    expect(s.questionCount).toBe(0);
    expect(s.preview).toEqual([]);
    expect(s.tags).toEqual({});
  });
});

describe("structuredSummary (US-902)", () => {
  const snapshot: RevisionQuestion[] = [
    { quid: "q0", type: "single", order: 0, prompt: "성별", config: { meta: { construct: "성별", topic: "인구통계" } } },
    { quid: "q1", type: "scale", order: 1, prompt: "만족도", config: { scale: { min: 1, max: 5 }, meta: { construct: "만족도" } } },
    { quid: "q2", type: "scale", order: 2, prompt: "재이용", config: { scale: { min: 1, max: 5 }, meta: { construct: "만족도" } } },
    { quid: "q3", type: "nps", order: 3, prompt: "추천", config: { scale: { min: 0, max: 10 } } },
    { quid: "q4", type: "open", order: 4, prompt: "의견", config: { meta: { topic: "인구통계" } } },
  ];

  it("counts questions per type in canonical order", () => {
    const s = structuredSummary(snapshot);
    expect(s.questionCount).toBe(5);
    expect(s.typeCounts).toEqual([
      { type: "single", count: 1 },
      { type: "scale", count: 2 },
      { type: "nps", count: 1 },
      { type: "open", count: 1 },
    ]);
  });

  it("collects distinct scale ranges (scale + nps), deduped and sorted", () => {
    expect(structuredSummary(snapshot).scales).toEqual([
      { min: 0, max: 10 },
      { min: 1, max: 5 },
    ]);
  });

  it("collects constructs/topics deduped, most frequent first", () => {
    const s = structuredSummary(snapshot);
    expect(s.constructs).toEqual(["만족도", "성별"]);
    expect(s.topics).toEqual(["인구통계"]);
  });

  it("handles an empty snapshot", () => {
    expect(structuredSummary([])).toEqual({
      questionCount: 0,
      typeCounts: [],
      scales: [],
      constructs: [],
      topics: [],
    });
  });
});

describe("summarizeTemplate structured/kind/aiSummary (US-901/902)", () => {
  it("defaults kind to survey, aiSummary null, includes structured", () => {
    const s = summarizeTemplate(row());
    expect(s.kind).toBe("survey");
    expect(s.aiSummary).toBeNull();
    expect(s.structured.typeCounts).toEqual([
      { type: "single", count: 1 },
      { type: "nps", count: 1 },
      { type: "open", count: 2 },
    ]);
  });

  it("passes through block kind + aiSummary", () => {
    const s = summarizeTemplate(row({ kind: "block", aiSummary: "인구통계 3문항" }));
    expect(s.kind).toBe("block");
    expect(s.aiSummary).toBe("인구통계 3문항");
  });
});

describe("planDecomposition (US-908)", () => {
  const q = (
    quid: string,
    order: number,
    prompt: string,
    meta?: QMeta,
  ): RevisionQuestion => ({
    quid,
    type: "single",
    order,
    prompt,
    config: meta ? { meta } : {},
  });

  it("groups a ≥2 construct into a block, everything else into question units", () => {
    const units = planDecomposition([
      q("a", 0, "성별", { construct: "성별" }),
      q("b", 1, "만족도1", { construct: "만족도" }),
      q("c", 2, "만족도2", { construct: "만족도" }),
      q("d", 3, "자유 의견"),
    ]);
    expect(units).toEqual([
      { kind: "question", name: "성별", quids: ["a"] },
      { kind: "block", name: "만족도", quids: ["b", "c"], construct: "만족도", constructId: undefined },
      { kind: "question", name: "자유 의견", quids: ["d"] },
    ]);
  });

  it("partitions every question into exactly one unit, ordered by first appearance", () => {
    const snapshot = [
      q("x", 2, "만족도B", { construct: "만족도" }),
      q("y", 0, "만족도A", { construct: "만족도" }),
      q("z", 1, "나이", { construct: "나이" }),
    ];
    const units = planDecomposition(snapshot);
    // 만족도 block sorts to first (its earliest member is order 0), then 나이 singleton.
    expect(units).toEqual([
      { kind: "block", name: "만족도", quids: ["y", "x"], construct: "만족도", constructId: undefined },
      { kind: "question", name: "나이", quids: ["z"] },
    ]);
    const allQuids = units.flatMap((u) => u.quids).sort();
    expect(allQuids).toEqual(["x", "y", "z"]);
  });

  it("pins constructId when a member carries one", () => {
    const units = planDecomposition([
      q("a", 0, "충성도1", { construct: "loyalty", constructId: "C1" }),
      q("b", 1, "충성도2", { construct: "loyalty" }),
    ]);
    expect(units).toEqual([
      { kind: "block", name: "loyalty", quids: ["a", "b"], construct: "loyalty", constructId: "C1" },
    ]);
  });

  it("names question units from a truncated prompt", () => {
    const long = "a".repeat(80);
    const units = planDecomposition([q("a", 0, long)]);
    expect(units[0].name).toHaveLength(40);
  });
});

describe("filterTemplateSummaries", () => {
  const list = [
    sum({ id: "a", name: "NPS 설문", tags: { construct: "loyalty", topic: "retention" }, preview: [{ type: "nps", prompt: "추천 의향" }] }),
    sum({ id: "b", name: "만족도", tags: { construct: "satisfaction", topic: "product" } }),
    sum({ id: "c", name: "이탈 원인", description: "왜 떠났나", tags: { topic: "retention" } }),
  ];

  it("matches free text across name/description/tags/preview", () => {
    expect(filterTemplateSummaries(list, { query: "추천" }).map((t) => t.id)).toEqual(["a"]);
    expect(filterTemplateSummaries(list, { query: "떠났" }).map((t) => t.id)).toEqual(["c"]);
    expect(filterTemplateSummaries(list, { query: "loyalty" }).map((t) => t.id)).toEqual(["a"]);
  });

  it("filters by exact construct/topic and combines with query", () => {
    expect(filterTemplateSummaries(list, { topic: "retention" }).map((t) => t.id)).toEqual(["a", "c"]);
    expect(filterTemplateSummaries(list, { construct: "satisfaction" }).map((t) => t.id)).toEqual(["b"]);
    expect(
      filterTemplateSummaries(list, { topic: "retention", query: "이탈" }).map((t) => t.id),
    ).toEqual(["c"]);
  });

  it("returns all when filter is empty", () => {
    expect(filterTemplateSummaries(list, {})).toHaveLength(3);
  });

  it("matches construct/topic by normalized key (legacy spelling variants)", () => {
    const legacy = [
      sum({ id: "l1", tags: { construct: "nps  점수" } }),
      sum({ id: "l2", tags: { construct: "이탈 의향" } }),
    ];
    expect(filterTemplateSummaries(legacy, { construct: "NPS 점수" }).map((t) => t.id)).toEqual([
      "l1",
    ]);
  });
});

describe("collectTagValues", () => {
  it("returns distinct sorted construct/topic values", () => {
    const list = [
      sum({ tags: { construct: "loyalty", topic: "retention" } }),
      sum({ tags: { construct: "satisfaction", topic: "retention" } }),
      sum({ tags: { topic: "product" } }),
    ];
    expect(collectTagValues(list)).toEqual({
      constructs: ["loyalty", "satisfaction"],
      topics: ["product", "retention"],
    });
  });

  it("dedupes by normalized key; a resolved tag wins the display form", () => {
    const list = [
      sum({ tags: { construct: "고객  만족도", topic: "제품  경험" } }), // legacy variant first
      sum({ tags: { construct: "고객 만족도", constructId: "c-1" } }),
      sum({ tags: { topic: "제품 경험" } }),
    ];
    expect(collectTagValues(list)).toEqual({
      constructs: ["고객 만족도"], // one entry per concept, canonical display
      topics: ["제품  경험"], // topics keep first-seen display (no dictionary)
    });
  });
});
