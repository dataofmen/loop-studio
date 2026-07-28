/**
 * US-601: standard Korean demographic preset questions — PURE module.
 *
 * Categories follow published Korean survey-industry standards so preset
 * questions line up with official statistics and poll crosstabs out of the
 * box (sources in tasks/prd-demographic-presets.md):
 * - age bands / education: 한국갤럽 데일리 오피니언 응답자 특성 구간
 * - occupation (8-way) / 8 regions: 전국지표조사(NBS) 배경문항
 * - 17 시도: 행정안전부 주민등록 인구통계 — EXACTLY the scope names of
 *   data/population.json (representativeQuotas), so a region preset can later
 *   drive population-proportional quota targets without any mapping layer.
 *
 * Every preset is a single-choice question stamped meta.source="validated";
 * they are ordinary questions once inserted (editable, deletable, usable as
 * quota dimensions).
 */

import { normalizeOptions, type OptionObject } from "@/lib/question-config";

export interface DemographicPreset {
  key: string;
  /** Picker display name. */
  name: string;
  /** Which standard the options follow (shown in the picker). */
  standard: string;
  prompt: string;
  options: string[];
  /** meta.construct for the knowledge/construct layer. */
  construct: string;
}

/** 행정안전부 17개 시도 — must equal population.ts scope names (tested). */
export const OFFICIAL_PROVINCES = [
  "서울특별시",
  "부산광역시",
  "대구광역시",
  "인천광역시",
  "광주광역시",
  "대전광역시",
  "울산광역시",
  "세종특별자치시",
  "경기도",
  "강원특별자치도",
  "충청북도",
  "충청남도",
  "전북특별자치도",
  "전라남도",
  "경상북도",
  "경상남도",
  "제주특별자치도",
] as const;

export const DEMOGRAPHIC_PRESETS: DemographicPreset[] = [
  {
    key: "sex",
    name: "성별",
    standard: "여론조사 표준",
    prompt: "성별이 어떻게 되십니까?",
    options: ["남성", "여성"],
    construct: "성별",
  },
  {
    key: "age_band",
    name: "연령대",
    standard: "한국갤럽·NBS 표준 구간",
    prompt: "연령대가 어떻게 되십니까?",
    options: ["만 18~29세", "30대", "40대", "50대", "60대", "70세 이상"],
    construct: "연령대",
  },
  {
    key: "region_province",
    name: "지역 (17개 시도)",
    standard: "행정안전부 공식 시도 — 인구통계 연동 가능",
    prompt: "현재 거주하고 계신 지역은 어디입니까?",
    options: [...OFFICIAL_PROVINCES],
    construct: "거주지역(시도)",
  },
  {
    key: "region_poll",
    name: "지역 (여론조사 8권역)",
    standard: "NBS·갤럽 권역 구분",
    prompt: "현재 거주하고 계신 지역은 어디입니까?",
    options: [
      "서울",
      "인천·경기",
      "대전·세종·충청",
      "광주·전라",
      "대구·경북",
      "부산·울산·경남",
      "강원",
      "제주",
    ],
    construct: "거주지역(권역)",
  },
  {
    key: "occupation",
    name: "직업",
    standard: "NBS 배경문항 8분류",
    prompt: "직업이 어떻게 되십니까?",
    options: [
      "농/임/어업",
      "자영업",
      "판매/영업/서비스직",
      "생산/기능/노무직",
      "사무/관리/전문직",
      "가정주부",
      "학생",
      "무직/기타",
    ],
    construct: "직업",
  },
  {
    key: "education",
    name: "학력",
    standard: "여론조사 표준 3구간",
    prompt: "최종 학력이 어떻게 되십니까?",
    options: ["중졸 이하", "고졸", "대학 재학 이상"],
    construct: "학력",
  },
  {
    key: "marital",
    name: "혼인 상태",
    standard: "통계청 사회조사 관행",
    prompt: "혼인 상태가 어떻게 되십니까?",
    options: ["미혼", "기혼", "기타(사별·이혼 등)"],
    construct: "혼인상태",
  },
  {
    key: "income",
    name: "월 가구소득",
    standard: "국내 조사 통상 구간",
    prompt: "월평균 가구소득(세전, 가구원 전체 합산)은 어느 정도입니까?",
    options: [
      "200만 원 미만",
      "200~300만 원 미만",
      "300~400만 원 미만",
      "400~500만 원 미만",
      "500~700만 원 미만",
      "700만 원 이상",
    ],
    construct: "가구소득",
  },
];

export function getDemographicPreset(key: string): DemographicPreset | undefined {
  return DEMOGRAPHIC_PRESETS.find((p) => p.key === key);
}

/**
 * The question row payload a preset inserts. Options are stored as canonical
 * {id, label} objects — the EDITOR consumes config.options raw (opt.id keys,
 * opt.label inputs), so plain strings would render as blank options there
 * (the respondent flow normalizes either shape, which hid the mismatch).
 */
export function presetQuestionPayload(preset: DemographicPreset): {
  type: "single";
  prompt: string;
  config: {
    options: OptionObject[];
    meta: { construct: string; source: "validated"; origin: "human" };
  };
} {
  return {
    type: "single",
    prompt: preset.prompt,
    config: {
      options: normalizeOptions(preset.options),
      meta: { construct: preset.construct, source: "validated", origin: "human" },
    },
  };
}
