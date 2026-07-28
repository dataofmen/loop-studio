import { describe, test, expect } from "vitest";
import {
  displayOptions,
  hashSeed,
  normalizeMeta,
  normalizeOptions,
  normalizeProbe,
  optionLabel,
  optionIdFromLabel,
  promoteSpecialOptions,
  specialFromLabel,
  stampMetaOrigin,
  DEFAULT_MAX_PROBES,
  MAX_PROBES_CAP,
  META_FIELD_MAX,
  type OptionObject,
} from "./question-config";

describe("normalizeOptions", () => {
  test("converts legacy string[] to {id,label}[]", () => {
    const out = normalizeOptions(["매우 만족", "보통", "불만족"]);
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.label)).toEqual(["매우 만족", "보통", "불만족"]);
    for (const o of out) expect(o.id).toMatch(/^o_[0-9a-f]{8}/);
  });

  test("preserves explicit ids on object options", () => {
    const out = normalizeOptions([
      { id: "o_custom1", label: "A" },
      { id: "o_custom2", label: "B" },
    ]);
    expect(out).toEqual([
      { id: "o_custom1", label: "A" },
      { id: "o_custom2", label: "B" },
    ]);
  });

  test("id derived from label is stable across calls", () => {
    const a = normalizeOptions(["동일 라벨"]);
    const b = normalizeOptions(["동일 라벨"]);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).toBe(optionIdFromLabel("동일 라벨"));
  });

  test("duplicate labels get distinct ids", () => {
    const out = normalizeOptions(["기타", "기타", "기타"]);
    const ids = out.map((o) => o.id);
    expect(new Set(ids).size).toBe(3);
    // all labels preserved as-is
    expect(out.every((o) => o.label === "기타")).toBe(true);
    // first keeps the bare derived id
    expect(ids[0]).toBe(optionIdFromLabel("기타"));
    expect(ids[1]).toBe(`${optionIdFromLabel("기타")}_2`);
  });

  test("disambiguates explicit duplicate ids too", () => {
    const out = normalizeOptions([
      { id: "dup", label: "X" },
      { id: "dup", label: "Y" },
    ]);
    expect(out[0].id).toBe("dup");
    expect(out[1].id).toBe("dup_2");
  });

  test("handles mixed string/object input", () => {
    const out = normalizeOptions([
      "레거시",
      { id: "o_keep", label: "유지" },
      { label: "아이디없음" },
    ]);
    expect(out.map((o) => o.label)).toEqual(["레거시", "유지", "아이디없음"]);
    expect(out[1].id).toBe("o_keep");
    expect(out[0].id).toBe(optionIdFromLabel("레거시"));
    expect(out[2].id).toBe(optionIdFromLabel("아이디없음"));
  });

  test("non-array / null / junk yields []", () => {
    expect(normalizeOptions(undefined)).toEqual([]);
    expect(normalizeOptions(null)).toEqual([]);
    expect(normalizeOptions("nope")).toEqual([]);
    expect(normalizeOptions([null, 42, undefined])).toEqual([]);
  });
});

describe("normalizeOptions — special options", () => {
  test("preserves valid special flags, drops junk values", () => {
    const out = normalizeOptions([
      { id: "o_none", label: "없음", special: "none" },
      { id: "o_a", label: "A" },
      { id: "o_other", label: "기타", special: "other" },
      { id: "o_junk", label: "J", special: "middle" },
    ]);
    expect(out[0].special).toBe("none");
    expect(out[1].special).toBeUndefined();
    expect(out[2].special).toBe("other");
    expect("special" in out[3]).toBe(false);
  });
});

describe("displayOptions", () => {
  const opts: OptionObject[] = [
    { id: "o_other", label: "기타", special: "other" },
    { id: "o_a", label: "A" },
    { id: "o_b", label: "B" },
    { id: "o_c", label: "C" },
    { id: "o_none", label: "없음", special: "none" },
  ];

  test("no randomize: none first, other last, middle in authoring order", () => {
    const out = displayOptions(opts, false, hashSeed("s"));
    expect(out.map((o) => o.id)).toEqual(["o_none", "o_a", "o_b", "o_c", "o_other"]);
  });

  test("randomize keeps specials anchored and preserves the option set", () => {
    const out = displayOptions(opts, true, hashSeed("session:q1"));
    expect(out[0].id).toBe("o_none");
    expect(out[out.length - 1].id).toBe("o_other");
    expect([...out].map((o) => o.id).sort()).toEqual([...opts].map((o) => o.id).sort());
  });

  test("same seed → same order; different seeds can differ", () => {
    const a = displayOptions(opts, true, hashSeed("seed-1"));
    const b = displayOptions(opts, true, hashSeed("seed-1"));
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id));
    // With 3 shuffleable options there are 6 permutations; probe a few seeds
    // and expect at least one to differ from the authoring order.
    const orders = new Set(
      Array.from({ length: 8 }, (_, i) =>
        displayOptions(opts, true, hashSeed(`seed-${i}`)).map((o) => o.id).join(","),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  test("does not mutate the input array", () => {
    const before = opts.map((o) => o.id);
    displayOptions(opts, true, hashSeed("x"));
    expect(opts.map((o) => o.id)).toEqual(before);
  });

  test("single middle option / empty input are stable", () => {
    expect(displayOptions([], true, 1)).toEqual([]);
    const one: OptionObject[] = [{ id: "o_a", label: "A" }];
    expect(displayOptions(one, true, 123).map((o) => o.id)).toEqual(["o_a"]);
  });
});

describe("optionLabel", () => {
  test("reads label from any shape", () => {
    expect(optionLabel("문자열")).toBe("문자열");
    expect(optionLabel({ id: "x", label: "객체" })).toBe("객체");
    expect(optionLabel({ label: null })).toBe("");
    expect(optionLabel(null)).toBe("");
    expect(optionLabel(undefined)).toBe("");
  });
});

describe("normalizeProbe (US-011)", () => {
  test("absent / junk yields undefined", () => {
    expect(normalizeProbe(undefined)).toBeUndefined();
    expect(normalizeProbe(null)).toBeUndefined();
    expect(normalizeProbe("on")).toBeUndefined();
    expect(normalizeProbe(42)).toBeUndefined();
    expect(normalizeProbe([true])).toBeUndefined();
  });

  test("defaults: enabled only when strictly true, maxProbes defaults to 2", () => {
    expect(normalizeProbe({})).toEqual({ enabled: false, maxProbes: DEFAULT_MAX_PROBES });
    expect(normalizeProbe({ enabled: true })).toEqual({ enabled: true, maxProbes: 2 });
    expect(normalizeProbe({ enabled: "yes" })!.enabled).toBe(false);
  });

  test("maxProbes clamps to 1..cap and floors non-integers", () => {
    expect(normalizeProbe({ enabled: true, maxProbes: 0 })!.maxProbes).toBe(1);
    expect(normalizeProbe({ enabled: true, maxProbes: 99 })!.maxProbes).toBe(MAX_PROBES_CAP);
    expect(normalizeProbe({ enabled: true, maxProbes: 2.9 })!.maxProbes).toBe(2);
    expect(normalizeProbe({ enabled: true, maxProbes: "3" })!.maxProbes).toBe(3);
    expect(normalizeProbe({ enabled: true, maxProbes: NaN })!.maxProbes).toBe(DEFAULT_MAX_PROBES);
  });

  test("guidance kept only when a non-blank string", () => {
    expect(normalizeProbe({ enabled: true, guidance: "사례를 물어보세요" })!.guidance).toBe(
      "사례를 물어보세요",
    );
    expect(normalizeProbe({ enabled: true, guidance: "   " })!.guidance).toBeUndefined();
    expect(normalizeProbe({ enabled: true, guidance: 7 })!.guidance).toBeUndefined();
    expect("guidance" in normalizeProbe({ enabled: true })!).toBe(false);
  });
});

describe("normalizeMeta (question-meta US-001)", () => {
  test("absent / junk yields undefined", () => {
    expect(normalizeMeta(undefined)).toBeUndefined();
    expect(normalizeMeta(null)).toBeUndefined();
    expect(normalizeMeta("meta")).toBeUndefined();
    expect(normalizeMeta(42)).toBeUndefined();
    expect(normalizeMeta(["construct"])).toBeUndefined();
    expect(normalizeMeta({})).toBeUndefined();
  });

  test("trims free-text fields and drops blank / non-string values", () => {
    expect(
      normalizeMeta({ construct: "  만족도  ", topic: "   ", notes: 7, population: null }),
    ).toEqual({ construct: "만족도" });
  });

  test("caps free-text field length", () => {
    const long = "가".repeat(META_FIELD_MAX + 100);
    expect(normalizeMeta({ construct: long })!.construct).toHaveLength(META_FIELD_MAX);
  });

  test("origin admits only human | ai", () => {
    expect(normalizeMeta({ construct: "x", origin: "human" })!.origin).toBe("human");
    expect(normalizeMeta({ construct: "x", origin: "ai" })!.origin).toBe("ai");
    expect(normalizeMeta({ construct: "x", origin: "robot" })!.origin).toBeUndefined();
    expect(normalizeMeta({ construct: "x", origin: 1 })!.origin).toBeUndefined();
    // origin alone still counts as content (human deliberately emptied fields)
    expect(normalizeMeta({ origin: "human" })).toEqual({ origin: "human" });
  });

  test("source admits only custom | validated | adapted", () => {
    expect(normalizeMeta({ source: "validated" })).toEqual({ source: "validated" });
    expect(normalizeMeta({ source: "unknown" })).toBeUndefined();
  });

  test("unknown junk keys are stripped", () => {
    expect(normalizeMeta({ construct: "x", evil: "y", __proto__: { a: 1 } })).toEqual({
      construct: "x",
    });
  });

  test("constructId kept only as non-blank string alongside construct (US-006)", () => {
    expect(normalizeMeta({ construct: "x", constructId: " id-1 " })).toEqual({
      construct: "x",
      constructId: "id-1",
    });
    // pointer without its construct text is meaningless → dropped
    expect(normalizeMeta({ constructId: "id-1", topic: "t" })).toEqual({ topic: "t" });
    expect(normalizeMeta({ construct: "x", constructId: 42 })).toEqual({ construct: "x" });
    expect(normalizeMeta({ construct: "x", constructId: "  " })).toEqual({ construct: "x" });
  });
});

describe("stampMetaOrigin (question-meta US-003)", () => {
  test("absent / junk meta stays undefined (no origin-only fabrication)", () => {
    expect(stampMetaOrigin(undefined, "ai")).toBeUndefined();
    expect(stampMetaOrigin(null, "ai", { force: true })).toBeUndefined();
    expect(stampMetaOrigin({ construct: "   " }, "ai")).toBeUndefined();
  });

  test("fallback mode stamps missing origin but preserves human", () => {
    expect(stampMetaOrigin({ construct: "만족도" }, "ai")).toEqual({
      construct: "만족도",
      origin: "ai",
    });
    expect(stampMetaOrigin({ construct: "만족도", origin: "human" }, "ai")).toEqual({
      construct: "만족도",
      origin: "human",
    });
    // invalid origin is dropped by normalizeMeta, then defaulted
    expect(stampMetaOrigin({ construct: "x", origin: "robot" }, "ai")!.origin).toBe("ai");
  });

  test("force mode overrides a claimed human origin", () => {
    expect(stampMetaOrigin({ construct: "x", origin: "human" }, "ai", { force: true })).toEqual({
      construct: "x",
      origin: "ai",
    });
  });

  test("normalizes fields while stamping (trim + cap)", () => {
    const out = stampMetaOrigin({ construct: "  이용 기간  ", topic: "가".repeat(META_FIELD_MAX + 5) }, "ai")!;
    expect(out.construct).toBe("이용 기간");
    expect(out.topic).toHaveLength(META_FIELD_MAX);
    expect(out.origin).toBe("ai");
  });
});

describe("specialFromLabel / promoteSpecialOptions (기타·없음 자동 감지)", () => {
  test("detects other-style labels", () => {
    expect(specialFromLabel("기타")).toBe("other");
    expect(specialFromLabel("기타(직접 입력)")).toBe("other");
    expect(specialFromLabel("기타 (직접입력)")).toBe("other");
    expect(specialFromLabel("기타: 직접 입력")).toBe("other");
    expect(specialFromLabel("직접 입력")).toBe("other");
  });

  test("detects none-style labels", () => {
    expect(specialFromLabel("없음")).toBe("none");
    expect(specialFromLabel("해당 없음")).toBe("none");
    expect(specialFromLabel("해당사항 없음")).toBe("none");
  });

  test("plain labels stay plain; conservative mode skips bare 기타 (guitar)", () => {
    expect(specialFromLabel("가격")).toBeUndefined();
    expect(specialFromLabel("기타 브랜드")).toBeUndefined();
    expect(specialFromLabel("기타", { conservative: true })).toBeUndefined();
    expect(specialFromLabel("기타(직접 입력)", { conservative: true })).toBe("other");
  });

  test("promoteSpecialOptions: promotes at most one of each, existing specials win", () => {
    const out = promoteSpecialOptions(
      normalizeOptions(["가격", "기타(직접 입력)", "해당 없음", "기타"]),
    );
    expect(out.map((o) => o.special ?? "")).toEqual(["", "other", "none", ""]);

    const withExplicit = promoteSpecialOptions(
      normalizeOptions([{ label: "기타", special: "other" }, "기타(직접 입력)"]),
    );
    // explicit other already present → the plain 기타(직접 입력) stays plain
    expect(withExplicit.map((o) => o.special ?? "")).toEqual(["other", ""]);
  });

  test("promotion keeps ids and order", () => {
    const src = normalizeOptions(["기타(직접 입력)", "가격"]);
    const out = promoteSpecialOptions(src);
    expect(out.map((o) => o.id)).toEqual(src.map((o) => o.id));
    expect(out[0].special).toBe("other");
  });
});
