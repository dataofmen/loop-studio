/**
 * US-307: Big-Five (OCEAN) personality profiles for synthetic personas.
 *
 * Pure module. Traits are sampled DETERMINISTICALLY from the persona's
 * sourceUuid — the same Nemotron persona always carries the same
 * disposition, so re-sampling a persona set or re-running a simulation
 * never silently changes personalities.
 */

export type OceanLevel = "low" | "mid" | "high";

export interface OceanProfile {
  openness: OceanLevel;
  conscientiousness: OceanLevel;
  extraversion: OceanLevel;
  agreeableness: OceanLevel;
  neuroticism: OceanLevel;
}

const TRAITS: (keyof OceanProfile)[] = [
  "openness",
  "conscientiousness",
  "extraversion",
  "agreeableness",
  "neuroticism",
];

/** djb2 over the uuid + trait name → stable level per trait. */
function levelFor(uuid: string, trait: string): OceanLevel {
  const s = `${uuid}:${trait}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const r = (h >>> 0) % 100;
  // 25/50/25 — most people sit mid on any given trait.
  return r < 25 ? "low" : r < 75 ? "mid" : "high";
}

export function sampleOcean(sourceUuid: string): OceanProfile {
  const out = {} as OceanProfile;
  for (const t of TRAITS) out[t] = levelFor(sourceUuid, t);
  return out;
}

/** Validate untrusted jsonb back into an OceanProfile (or null). */
export function normalizeOcean(raw: unknown): OceanProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out = {} as OceanProfile;
  for (const t of TRAITS) {
    const v = o[t];
    if (v !== "low" && v !== "mid" && v !== "high") return null;
    out[t] = v;
  }
  return out;
}

const BEHAVIOR: Record<keyof OceanProfile, { low: string; high: string }> = {
  openness: {
    low: "익숙한 것을 선호하고 새로운 기능·변화에 회의적",
    high: "새로운 기능·서비스를 적극적으로 시도하고 변화에 호의적",
  },
  conscientiousness: {
    low: "즉흥적이고 꼼꼼히 따지기보다 대충 답하는 편",
    high: "조건·약관을 꼼꼼히 비교하고 신중하게 판단",
  },
  extraversion: {
    low: "짧고 절제된 표현을 쓰는 편",
    high: "적극적으로 의견을 표현하고 구체적인 사례를 곁들임",
  },
  agreeableness: {
    low: "비판적이고 불만을 직설적으로 표현",
    high: "긍정적 측면을 먼저 보고 온화하게 표현",
  },
  neuroticism: {
    low: "안정적이고 걱정을 잘 드러내지 않음",
    high: "불안·걱정·불만을 자주 언급하고 위험에 민감",
  },
};

const KO: Record<keyof OceanProfile, string> = {
  openness: "개방성",
  conscientiousness: "성실성",
  extraversion: "외향성",
  agreeableness: "친화성",
  neuroticism: "신경증",
};

/** One Korean instruction line for the simulation system prompt.
 * mid traits are omitted — only distinctive dispositions steer answers. */
export function oceanPromptLine(ocean: OceanProfile): string {
  const parts: string[] = [];
  for (const t of TRAITS) {
    const level = ocean[t];
    if (level === "mid") continue;
    parts.push(BEHAVIOR[t][level]);
  }
  if (parts.length === 0) return "";
  return `성격 성향: ${parts.join("; ")}.`;
}

/** Compact UI label, e.g. "개방성↑ 신경증↓" (mid omitted). */
export function oceanLabel(ocean: OceanProfile): string {
  const parts: string[] = [];
  for (const t of TRAITS) {
    if (ocean[t] === "mid") continue;
    parts.push(`${KO[t]}${ocean[t] === "high" ? "↑" : "↓"}`);
  }
  return parts.join(" ");
}
