/**
 * Samples data-grounded synthetic personas from the local Nemotron-Personas-Korea
 * corpus (SQLite), using province×sex stratified sampling (largest-remainder) —
 * mirrors civilian7/korean-people-persona.
 *
 * Runs as a NODE subprocess: node:sqlite is built into Node but absent from
 * Bun, and keeping it out-of-process also keeps a native-ish module out of the
 * Next.js server bundle. Plain .mjs so it needs no transpilation.
 *
 * Usage: node scripts/sample-personas.mjs '<json {filters, n, quotas}>'
 * Output (stdout): JSON array of { sourceUuid, attributes, profile }.
 */
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const DB_PATH = process.env.PERSONA_DB_PATH || resolve(import.meta.dirname, "../data/personas.db");

const PROFILE_FIELDS = [
  ["persona", "한 줄 소개"],
  ["professional_persona", "직업"],
  ["family_persona", "가족"],
  ["culinary_persona", "식문화"],
  ["hobbies_and_interests", "취미·관심사"],
  ["career_goals_and_ambitions", "목표·포부"],
  ["sex", "성별"],
  ["age", "나이"],
  ["marital_status", "혼인상태"],
  ["family_type", "가구형태"],
  ["education_level", "학력"],
  ["occupation", "직종"],
  ["district", "지역(시군구)"],
  ["province", "지역(시도)"],
];

function buildWhere(f) {
  const cond = [];
  const params = [];
  if (f.sex) { cond.push("sex = ?"); params.push(f.sex); }
  if (f.age_min != null) { cond.push("CAST(age AS INTEGER) >= ?"); params.push(f.age_min); }
  if (f.age_max != null) { cond.push("CAST(age AS INTEGER) <= ?"); params.push(f.age_max); }
  if (f.provinces?.length) {
    cond.push(`(${f.provinces.map(() => "province LIKE ?").join(" OR ")})`);
    f.provinces.forEach((p) => params.push(`%${p}%`));
  }
  if (f.occupation_like) { cond.push("occupation LIKE ?"); params.push(`%${f.occupation_like}%`); }
  if (f.education_levels?.length) {
    cond.push(`(${f.education_levels.map(() => "education_level LIKE ?").join(" OR ")})`);
    f.education_levels.forEach((e) => params.push(`%${e}%`));
  }
  return { clause: cond.length ? "WHERE " + cond.join(" AND ") : "", params };
}

/** Largest-remainder quota allocation across cells. */
function allocate(cells, n) {
  const total = cells.reduce((s, c) => s + c.cnt, 0);
  if (total === 0) return new Map();
  const raw = cells.map((c) => ({ key: c.key, q: (n * c.cnt) / total }));
  const quotas = new Map(raw.map((r) => [r.key, Math.floor(r.q)]));
  let rem = n - [...quotas.values()].reduce((s, q) => s + q, 0);
  raw.sort((a, b) => b.q - Math.floor(b.q) - (a.q - Math.floor(a.q)));
  for (let i = 0; i < rem; i++) quotas.set(raw[i % raw.length].key, (quotas.get(raw[i % raw.length].key) ?? 0) + 1);
  return quotas;
}

function buildProfile(r) {
  return PROFILE_FIELDS.filter(([k]) => r[k]).map(([k, label]) => `- ${label}: ${r[k]}`).join("\n");
}

function toPersona(r) {
  return {
    sourceUuid: r.uuid,
    attributes: {
      sex: r.sex,
      age: Number(r.age),
      occupation: r.occupation,
      province: r.province,
      district: r.district,
      education_level: r.education_level,
      marital_status: r.marital_status,
      family_type: r.family_type,
    },
    profile: buildProfile(r),
  };
}

/** Parses an age band label ("20대", "80대+") into an inclusive [min,max] age range. */
function bandRange(band) {
  if (band.endsWith("+")) return [parseInt(band, 10), 200];
  const base = parseInt(band, 10);
  return [base, base + 9];
}

/**
 * Representative quota mode: fill each age-band×sex cell from the corpus to match
 * official-population-derived quotas. Used for data-grounded representative samples.
 *
 * When the scope is a specific region, `provinces` constrains every cell to that
 * region's personas (the quotas themselves already reflect the region's official
 * age×sex distribution). If a region cell runs out of corpus rows, the remainder
 * is topped up nationwide for the SAME age×sex cell — the demographic shape is
 * preserved even when a small region exhausts, mirroring the graceful-relax
 * posture of the filtered path below.
 */
function sampleByQuotas(db, quotas, provinces) {
  const out = [];
  const provinceClause = provinces?.length
    ? ` AND (${provinces.map(() => "province = ?").join(" OR ")})`
    : "";
  for (const [key, q] of Object.entries(quotas)) {
    if (q <= 0) continue;
    const [band, sex] = key.split("|");
    const [lo, hi] = bandRange(band);
    const rows = db
      .prepare(
        `SELECT * FROM persona WHERE sex = ? AND CAST(age AS INTEGER) BETWEEN ? AND ?${provinceClause} ORDER BY random() LIMIT ?`,
      )
      .all(sex, lo, hi, ...(provinces ?? []), q);
    if (provinceClause && rows.length < q) {
      const picked = new Set(rows.map((r) => r.uuid));
      const fill = db
        .prepare(
          "SELECT * FROM persona WHERE sex = ? AND CAST(age AS INTEGER) BETWEEN ? AND ? ORDER BY random() LIMIT ?",
        )
        .all(sex, lo, hi, q);
      for (const r of fill) {
        if (rows.length >= q) break;
        if (!picked.has(r.uuid)) { rows.push(r); picked.add(r.uuid); }
      }
    }
    rows.forEach((r) => out.push(toPersona(r)));
  }
  return out;
}

function main() {
  const { filters = {}, n = 20, quotas } = JSON.parse(process.argv[2] || "{}");
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  // Representative mode: official age×sex quotas drive the sample; a province
  // filter (regional scope) constrains where those personas are drawn from.
  if (quotas && Object.keys(quotas).length > 0) {
    process.stdout.write(JSON.stringify(sampleByQuotas(db, quotas, filters.provinces).slice(0, n)));
    return;
  }

  const count = (where, params) =>
    db.prepare(`SELECT count(*) c FROM persona ${where}`).get(...params).c;

  // Graceful degradation: keep core demographics (age/sex) as long as possible.
  // Drop the least-essential constraints first if the filter matches nothing.
  const relaxOrder = [
    "occupation_like",
    "education_levels",
    "provinces",
    "sex",
    "age_min",
    "age_max",
  ];
  let active = { ...filters };
  let built = buildWhere(active);
  for (const key of relaxOrder) {
    if (count(built.clause, built.params) > 0) break;
    if (active[key] === undefined) continue;
    delete active[key];
    built = buildWhere(active);
  }
  let { clause, params } = built;
  if (count(clause, params) === 0) ({ clause, params } = { clause: "", params: [] });

  // province×sex cell counts under the filter
  const cells = db
    .prepare(`SELECT province, sex, count(*) c FROM persona ${clause} GROUP BY province, sex`)
    .all(...params);
  const cellQuotas = allocate(cells.map((c) => ({ key: `${c.province}|${c.sex}`, cnt: c.c })), n);

  const out = [];
  for (const cell of cells) {
    const q = cellQuotas.get(`${cell.province}|${cell.sex}`) ?? 0;
    if (q <= 0) continue;
    const rows = db
      .prepare(
        `SELECT * FROM persona ${clause ? clause + " AND" : "WHERE"} province = ? AND sex = ? ORDER BY random() LIMIT ?`,
      )
      .all(...params, cell.province, cell.sex, q);
    rows.forEach((r) => out.push(toPersona(r)));
  }
  // Trim/pad to exactly n.
  process.stdout.write(JSON.stringify(out.slice(0, n)));
}

main();
