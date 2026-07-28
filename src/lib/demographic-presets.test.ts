import { describe, test, expect } from "vitest";
import {
  DEMOGRAPHIC_PRESETS,
  OFFICIAL_PROVINCES,
  getDemographicPreset,
  presetQuestionPayload,
} from "./demographic-presets";
import { scopeToCorpusProvince } from "./population";

describe("DEMOGRAPHIC_PRESETS", () => {
  test("every preset is a well-formed single-choice question", () => {
    expect(DEMOGRAPHIC_PRESETS.length).toBe(8);
    for (const p of DEMOGRAPHIC_PRESETS) {
      expect(p.key).toMatch(/^[a-z_]+$/);
      expect(p.prompt.length).toBeGreaterThan(5);
      expect(p.options.length).toBeGreaterThanOrEqual(2);
      // no duplicate options within a preset
      expect(new Set(p.options).size).toBe(p.options.length);
    }
    // no duplicate keys
    expect(new Set(DEMOGRAPHIC_PRESETS.map((p) => p.key)).size).toBe(DEMOGRAPHIC_PRESETS.length);
  });

  test("17개 시도 preset matches official population scope names exactly", () => {
    const preset = getDemographicPreset("region_province")!;
    expect(preset.options).toEqual([...OFFICIAL_PROVINCES]);
    expect(preset.options).toHaveLength(17);
    // Each scope name must resolve to a corpus province (the same contract
    // representativeQuotas + persona sampling rely on) — keeps the preset
    // usable for population-proportional quota targets later.
    for (const scope of preset.options) {
      expect(scopeToCorpusProvince(scope)).toBeTruthy();
    }
  });

  test("NBS 8-way occupation and 8 poll regions", () => {
    expect(getDemographicPreset("occupation")!.options).toHaveLength(8);
    expect(getDemographicPreset("region_poll")!.options).toHaveLength(8);
    expect(getDemographicPreset("age_band")!.options[0]).toBe("만 18~29세");
  });

  test("presetQuestionPayload stamps validated human meta", () => {
    const payload = presetQuestionPayload(getDemographicPreset("sex")!);
    expect(payload.type).toBe("single");
    expect(payload.config.meta).toEqual({
      construct: "성별",
      source: "validated",
      origin: "human",
    });
    // payload options are a copy, not the shared array
    payload.config.options.push({ id: "x", label: "x" });
    expect(getDemographicPreset("sex")!.options).toHaveLength(2);
  });

  test("payload options are {id,label} objects — the editor's raw contract", () => {
    // The editor consumes config.options WITHOUT normalizing (opt.id keys,
    // opt.label inputs); plain strings rendered as blank options there.
    for (const p of DEMOGRAPHIC_PRESETS) {
      const { options } = presetQuestionPayload(p).config;
      expect(options).toHaveLength(p.options.length);
      for (let i = 0; i < options.length; i++) {
        expect(typeof options[i].id).toBe("string");
        expect(options[i].id.length).toBeGreaterThan(0);
        expect(options[i].label).toBe(p.options[i]);
      }
      // ids unique within a question
      expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
    }
  });
});
