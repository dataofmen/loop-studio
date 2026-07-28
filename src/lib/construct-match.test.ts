import { describe, test, expect } from "vitest";
import {
  aliasesAfterMerge,
  aliasesAfterRename,
  aliasesWithVariant,
  bestEmbeddingMatch,
  canonicalConstructName,
  constructKey,
  cosineSimilarity,
  findExactConstruct,
  normalizeAliases,
  CONSTRUCT_SIMILARITY_THRESHOLD,
  type ConstructCandidate,
} from "./construct-match";

const cand = (over: Partial<ConstructCandidate> = {}): ConstructCandidate => ({
  id: "c1",
  name: "고객 만족도",
  aliases: [],
  embedding: null,
  ...over,
});

describe("canonicalConstructName / constructKey", () => {
  test("trims and collapses internal whitespace, preserving case", () => {
    expect(canonicalConstructName("  NPS   점수 ")).toBe("NPS 점수");
  });

  test("key is lowercased canonical form", () => {
    expect(constructKey(" NPS  점수 ")).toBe("nps 점수");
    expect(constructKey("nps 점수")).toBe(constructKey("NPS 점수"));
  });

  test("junk input yields empty string", () => {
    expect(canonicalConstructName(null)).toBe("");
    expect(canonicalConstructName(42)).toBe("");
    expect(canonicalConstructName("   ")).toBe("");
  });
});

describe("normalizeAliases", () => {
  test("keeps only non-blank strings", () => {
    expect(normalizeAliases(["만족", "", "  ", 3, null, "고객만족"])).toEqual([
      "만족",
      "고객만족",
    ]);
  });

  test("non-array junk yields []", () => {
    expect(normalizeAliases(null)).toEqual([]);
    expect(normalizeAliases("만족")).toEqual([]);
  });
});

describe("findExactConstruct", () => {
  const candidates = [
    cand(),
    cand({ id: "c2", name: "재구매 의도", aliases: ["재방문 의향"] }),
  ];

  test("matches canonical name modulo whitespace/case", () => {
    expect(findExactConstruct(candidates, "  고객  만족도 ")?.id).toBe("c1");
  });

  test("matches through aliases", () => {
    expect(findExactConstruct(candidates, "재방문  의향")?.id).toBe("c2");
  });

  test("no match / blank input → null", () => {
    expect(findExactConstruct(candidates, "배달 속도")).toBeNull();
    expect(findExactConstruct(candidates, "   ")).toBeNull();
  });
});

describe("cosineSimilarity", () => {
  test("identical direction → 1, orthogonal → 0", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("degrades to 0 on mismatched dims or zero norm (no throw)", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("bestEmbeddingMatch", () => {
  test("returns the highest similarity ≥ threshold; skips embedding-less rows", () => {
    const candidates = [
      cand({ id: "close", embedding: [0.9, 0.1] }),
      cand({ id: "closer", embedding: [1, 0] }),
      cand({ id: "noEmb", embedding: null }),
      cand({ id: "far", embedding: [0, 1] }),
    ];
    const m = bestEmbeddingMatch(candidates, [1, 0]);
    expect(m?.candidate.id).toBe("closer");
    expect(m?.similarity).toBeCloseTo(1);
  });

  test("null when nothing reaches the threshold", () => {
    // cos(45°) ≈ 0.707 < 0.85
    const candidates = [cand({ id: "diag", embedding: [1, 1] })];
    expect(bestEmbeddingMatch(candidates, [1, 0])).toBeNull();
    expect(CONSTRUCT_SIMILARITY_THRESHOLD).toBe(0.85);
  });
});

describe("aliasesAfterRename", () => {
  test("demotes the old name to an alias, keeping existing aliases", () => {
    expect(
      aliasesAfterRename({ name: "고객 만족도", aliases: ["고객만족"] }, "만족도"),
    ).toEqual(["고객만족", "고객 만족도"]);
  });

  test("drops aliases colliding with the new name; case-only rename demotes nothing", () => {
    expect(
      aliasesAfterRename({ name: "고객 만족도", aliases: ["nps 점수"] }, " NPS  점수"),
    ).toEqual(["고객 만족도"]);
    expect(aliasesAfterRename({ name: "nps", aliases: ["순추천지수"] }, "NPS")).toEqual([
      "순추천지수",
    ]);
  });

  test("dedupes aliases by key and skips junk entries", () => {
    expect(
      aliasesAfterRename({ name: "만족도", aliases: ["고객만족", " 고객만족 ", "  "] }, "CSAT"),
    ).toEqual(["고객만족", "만족도"]);
  });
});

describe("aliasesAfterMerge", () => {
  test("absorbs source name + aliases into target aliases", () => {
    expect(
      aliasesAfterMerge(
        { name: "고객 만족도", aliases: ["고객만족"] },
        { name: "만족도", aliases: ["CSAT"] },
      ),
    ).toEqual(["고객만족", "만족도", "CSAT"]);
  });

  test("never contains the target name; dedupes across both sides by key", () => {
    expect(
      aliasesAfterMerge(
        { name: "NPS", aliases: ["순추천지수"] },
        { name: "nps", aliases: ["순추천지수", " NPS  점수"] },
      ),
    ).toEqual(["순추천지수", "NPS 점수"]);
  });
});

describe("aliasesWithVariant", () => {
  test("appends the canonical variant", () => {
    expect(aliasesWithVariant(cand(), "고객  만족 ")).toEqual(["고객 만족"]);
  });

  test("null when variant already covered by name or aliases (modulo key)", () => {
    expect(aliasesWithVariant(cand(), "고객  만족도")).toBeNull();
    expect(aliasesWithVariant(cand({ aliases: ["고객 만족"] }), " 고객 만족")).toBeNull();
    expect(aliasesWithVariant(cand(), "  ")).toBeNull();
  });
});
