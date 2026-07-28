/**
 * Fetches official Korean resident population by administrative dong / age / sex
 * from data.go.kr (행정안전부_지역별(행정동) 성별 연령별 주민등록 인구수, dataset 15097972)
 * and aggregates it into representative age-band × sex quotas per region scope.
 *
 * Requires DATA_GO_KR_SERVICE_KEY (data.go.kr 활용신청 인증키) in env or .env.
 * Usage: bun run population:build
 * Output: data/population.json  (used by src/lib/population.ts for representative sampling)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENDPOINT =
  "https://api.odcloud.kr/api/15097972/v1/uddi:59bf4bd0-a476-4acf-a416-d007b32860a1";
const OUT = resolve(import.meta.dirname, "../data/population.json");

function serviceKey(): string {
  if (process.env.DATA_GO_KR_SERVICE_KEY) return process.env.DATA_GO_KR_SERVICE_KEY;
  try {
    const line = readFileSync(resolve(import.meta.dirname, "../.env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("DATA_GO_KR_SERVICE_KEY="));
    if (line) return line.replace(/^DATA_GO_KR_SERVICE_KEY=/, "").trim().replace(/^"|"$/g, "");
  } catch {}
  throw new Error("DATA_GO_KR_SERVICE_KEY not set (env or .env)");
}

function ageBand(age: number): string {
  return age >= 80 ? "80대+" : `${Math.floor(age / 10) * 10}대`;
}

type Scope = Record<string, number>; // "20대|남자" -> count

function addTo(scopes: Record<string, Scope>, name: string, band: string, sex: string, n: number) {
  if (!n) return;
  (scopes[name] ??= {});
  const key = `${band}|${sex}`;
  scopes[name][key] = (scopes[name][key] ?? 0) + n;
}

const AGE_COL = /^(\d+)세(남자|여자)$/;
const AGE_PLUS_COL = /^110세이상\s*(남자|여자)$/;

async function main() {
  const key = serviceKey();
  const scopes: Record<string, Scope> = {};
  let baseMonth = "";
  let page = 1;
  const perPage = 1000;

  for (;;) {
    const url = `${ENDPOINT}?page=${page}&perPage=${perPage}&returnType=JSON&serviceKey=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data?: Record<string, unknown>[]; totalCount?: number };
    const rows = json.data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const sido = String(row["시도명"] ?? "").trim();
      const sigungu = String(row["시군구명"] ?? "").trim();
      baseMonth ||= String(row["기준연월"] ?? "");
      if (!sido) continue;
      const scopeNames = ["전국", sido, `${sido} ${sigungu}`.trim()];

      for (const [col, val] of Object.entries(row)) {
        let age: number | null = null;
        let sex: string | null = null;
        const m = AGE_COL.exec(col);
        if (m) { age = Number(m[1]); sex = m[2]; }
        else { const mp = AGE_PLUS_COL.exec(col); if (mp) { age = 110; sex = mp[1]; } }
        if (age == null || !sex) continue;
        const n = Number(String(val).replace(/,/g, "")) || 0;
        const band = ageBand(age);
        for (const name of scopeNames) addTo(scopes, name, band, sex, n);
      }
    }
    process.stderr.write(`page ${page}: ${rows.length} rows\n`);
    if (rows.length < perPage) break;
    page++;
  }

  const provinces = Object.keys(scopes).filter((k) => k !== "전국" && !k.includes(" ")).sort();
  writeFileSync(OUT, JSON.stringify({ baseMonth, provinces, scopes }, null, 0));
  process.stderr.write(`saved ${OUT} | baseMonth=${baseMonth} | scopes=${Object.keys(scopes).length}\n`);
}

main();
