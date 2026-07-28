import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { personas, responses } from "@/db/schema";
import { sampleOcean } from "@/lib/ocean";
import { runLlmJson } from "@/lib/llm";
import { representativeQuotas, scopeToCorpusProvince } from "@/lib/population";
import {
  corpusAvailable,
  sampleFromCorpus,
  type PersonaFilters,
  type SampledPersona,
} from "@/lib/persona-corpus";

export type { PersonaFilters, SampledPersona };

/** Personas invented per agent-CLI call when no corpus is installed. */
const FALLBACK_BATCH = 20;

/** Uses the agent CLI to translate a free-text target population into demographic filters. */
export async function mapDescriptionToFilters(
  description: string,
): Promise<PersonaFilters> {
  const prompt = `Translate this target-population description into demographic filters for sampling Korean personas.

Description: "${description}"

Return ONLY a JSON object (no prose) with any of these optional keys:
{
  "sex": "남자" | "여자",                         // omit if not specified
  "age_min": <int>, "age_max": <int>,            // age range if implied
  "provinces": ["서울","경기", ...],              // Korean province short names, omit if nationwide
  "occupation_like": "<keyword>",                // a single occupation keyword if implied
  "education_levels": ["대학교","고등학교", ...]   // if implied
}
Only include keys that are clearly implied by the description. If nothing is implied, return {}.`;

  try {
    return await runLlmJson<PersonaFilters>(prompt);
  } catch {
    return {}; // fall back to unfiltered sampling
  }
}

/**
 * Invents personas with the agent CLI. The fallback for when no corpus is
 * installed: profiles read plausibly and follow the requested description, but
 * they are NOT drawn from a real demographic distribution — a representative
 * sample needs the corpus.
 */
async function generatePersonasWithLlm(
  description: string,
  n: number,
): Promise<SampledPersona[]> {
  const out: SampledPersona[] = [];
  while (out.length < n) {
    const want = Math.min(FALLBACK_BATCH, n - out.length);
    const prompt = `한국의 설문 응답자 페르소나 ${want}명을 만들어 주세요.

대상 집단: "${description || "대한민국 성인 일반"}"

규칙:
- 서로 뚜렷하게 다른 사람들로. 나이·성별·거주지·직업·생활방식을 실제 표본처럼 분산시킬 것.
- 이미 만든 사람과 겹치지 않게. 현재까지 ${out.length}명을 만들었습니다.
- 거주지는 실제 시도명(서울, 경기, 부산 …)으로.
- profile은 그 사람의 생활·가치관이 드러나는 3~4줄.

다른 텍스트 없이 아래 JSON만 반환하세요:
{"personas": [{"sex": "남자|여자", "age": <정수>, "province": "...", "occupation": "...", "education_level": "...", "profile": "- 한 줄 소개: ...\n- 직업: ...\n- 생활: ..."}]}`;

    const parsed = await runLlmJson<{
      personas?: {
        sex?: unknown;
        age?: unknown;
        province?: unknown;
        occupation?: unknown;
        education_level?: unknown;
        profile?: unknown;
      }[];
    }>(prompt, { timeoutMs: 180_000 });

    const batch = (parsed.personas ?? []).filter((p) => typeof p.profile === "string" && p.profile.trim());
    if (batch.length === 0) break; // model produced nothing usable — stop rather than spin
    for (const p of batch) {
      if (out.length >= n) break;
      out.push({
        // No corpus row backs this persona, so there is no source id to cite.
        sourceUuid: null,
        attributes: {
          sex: p.sex === "남자" || p.sex === "여자" ? p.sex : undefined,
          age: Number.isFinite(Number(p.age)) ? Number(p.age) : undefined,
          province: typeof p.province === "string" ? p.province : undefined,
          occupation: typeof p.occupation === "string" ? p.occupation : undefined,
          education_level: typeof p.education_level === "string" ? p.education_level : undefined,
          generated: true,
        },
        profile: String(p.profile).trim(),
      });
    }
  }
  return out;
}

/**
 * Generates a fresh set of N personas for a survey: maps the description to
 * filters, samples grounded personas, and replaces any existing personas.
 * Caller must have asserted workspace ownership of the survey.
 */
export async function generatePersonas(
  workspaceId: string,
  surveyId: string,
  description: string,
  n: number,
  opts: { representativeScope?: string } = {},
): Promise<number> {
  let sampled: SampledPersona[];
  if (opts.representativeScope) {
    // Data-grounded representative mode: official population age×sex quotas.
    // A regional scope also constrains WHERE personas come from — quotas shape
    // the demographics, the province filter keeps them residents of the region.
    // This mode is corpus-only: inventing people cannot be representative.
    if (!corpusAvailable()) {
      throw new Error(
        "대표성 표본에는 페르소나 코퍼스가 필요합니다 — 설치하지 않았다면 '설명으로 생성'을 사용하세요.",
      );
    }
    const quotas = representativeQuotas(opts.representativeScope, n);
    if (!quotas) throw new Error("인구통계 데이터가 없습니다. population:build를 먼저 실행하세요.");
    const province = scopeToCorpusProvince(opts.representativeScope);
    sampled = await sampleFromCorpus(province ? { provinces: [province] } : {}, n, quotas);
  } else if (corpusAvailable()) {
    const filters = await mapDescriptionToFilters(description);
    sampled = await sampleFromCorpus(filters, n);
  } else {
    // No corpus installed — the app still works, just without the real
    // demographic distribution behind each profile.
    sampled = await generatePersonasWithLlm(description, n);
  }
  if (sampled.length === 0) throw new Error("표본을 추출하지 못했습니다.");

  // Replace any prior persona set for this survey. The previous synthetic
  // responses belonged to the old persona set, so clear them too — they're
  // stale relative to the new sample (re-run the simulation to regenerate).
  await db.delete(personas).where(eq(personas.surveyId, surveyId));
  await db
    .delete(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true)));

  const rows = sampled.map((p) => ({
    workspaceId,
    surveyId,
    sourceUuid: p.sourceUuid,
    // Deterministic Big-Five disposition. Corpus personas key off their stable
    // source id so the same person always gets the same traits; invented ones
    // have no such id, so key off the profile text instead.
    attributes: { ...p.attributes, ocean: sampleOcean(p.sourceUuid ?? p.profile) },
    profile: p.profile,
  }));
  // Chunk inserts: each row is ~5 params, and Postgres caps a statement at
  // 65535 bind params — so large representative sets (up to 10k) must batch.
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(personas).values(rows.slice(i, i + BATCH));
  }
  return sampled.length;
}
