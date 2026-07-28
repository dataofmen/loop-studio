import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Official Korean resident population (data.go.kr 15097972), aggregated into
 * age-band × sex counts per region scope, used to build representative samples.
 * Cache produced by scripts/build_population.ts (`bun run population:build`).
 */
type PopulationData = {
  baseMonth: string;
  provinces: string[];
  scopes: Record<string, Record<string, number>>; // scope -> { "20대|남자": count }
};

const PATH = process.env.POPULATION_PATH || resolve(process.cwd(), "data/population.json");

let cache: PopulationData | null = null;

function load(): PopulationData | null {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(PATH, "utf8")) as PopulationData;
    return cache;
  } catch {
    return null;
  }
}

export function populationAvailable(): boolean {
  return load() !== null;
}

export function populationMeta(): { baseMonth: string; scopes: string[] } | null {
  const d = load();
  if (!d) return null;
  return { baseMonth: d.baseMonth, scopes: ["전국", ...d.provinces] };
}

/** Age bands excluded by default — the persona corpus only covers adults (19+). */
const CHILD_BANDS = new Set(["0대", "10대"]);

/**
 * Maps an official scope name (행정안전부 시도명, e.g. "서울특별시",
 * "전북특별자치도") to the corpus' province value ("서울", "전북") by stripping
 * the administrative suffix. The Nemotron corpus stores provinces in exactly
 * this suffix-less form ("서울", "경기", "경상남", "전북", …). Returns null for
 * 전국 (no region constraint).
 */
export function scopeToCorpusProvince(scope: string): string | null {
  if (scope === "전국") return null;
  const short = scope.replace(/(특별자치도|특별자치시|특별시|광역시|도)$/, "");
  return short || null;
}

/**
 * Raw age-band×sex counts for a scope ("전국" or a 시도), or null when the
 * cache is missing/unknown scope. Keys are "20대|남자" … "80대+|여자".
 */
export function populationCells(scope: string): Record<string, number> | null {
  return load()?.scopes[scope] ?? null;
}

/**
 * Largest-remainder allocation of n across age-band×sex cells, proportional to
 * official counts. By default restricts to adult bands (20대+) since survey
 * respondents — and the persona corpus — are adults; the distribution is then
 * renormalized over the adult population.
 */
export function representativeQuotas(
  scope: string,
  n: number,
  opts: { adultOnly?: boolean } = {},
): Record<string, number> | null {
  const d = load();
  const cells = d?.scopes[scope];
  if (!cells) return null;

  const adultOnly = opts.adultOnly ?? true;
  const entries = Object.entries(cells).filter(
    ([k]) => !adultOnly || !CHILD_BANDS.has(k.split("|")[0]),
  );
  const total = entries.reduce((s, [, c]) => s + c, 0);
  if (total === 0) return null;

  const raw = entries.map(([k, c]) => ({ k, q: (n * c) / total }));
  const quotas: Record<string, number> = {};
  for (const r of raw) quotas[r.k] = Math.floor(r.q);
  let rem = n - Object.values(quotas).reduce((s, q) => s + q, 0);
  raw.sort((a, b) => b.q - Math.floor(b.q) - (a.q - Math.floor(a.q)));
  for (let i = 0; i < rem; i++) quotas[raw[i % raw.length].k] += 1;
  return quotas;
}
