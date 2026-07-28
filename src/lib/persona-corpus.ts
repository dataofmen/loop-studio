import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Access to the Nemotron-Personas-Korea corpus — the source of data-grounded
 * personas.
 *
 * The corpus is a SQLite file, and sampling runs in a NODE subprocess:
 * `node:sqlite` is built into Node but missing from Bun (which runs the dev
 * server), and keeping it out-of-process also keeps it out of the Next bundle.
 *
 * The corpus is OPTIONAL. Without it the app still works — persona generation
 * falls back to the agent CLI (see personas.ts) — it just loses the real
 * demographic distribution behind each profile.
 */

export type PersonaFilters = {
  sex?: "남자" | "여자";
  age_min?: number;
  age_max?: number;
  provinces?: string[];
  occupation_like?: string;
  education_levels?: string[];
};

export type SampledPersona = {
  sourceUuid: string | null;
  attributes: Record<string, unknown>;
  profile: string;
};

export function corpusPath(): string {
  return process.env.PERSONA_DB_PATH || resolve(process.cwd(), "data/personas.db");
}

export function corpusAvailable(): boolean {
  return existsSync(corpusPath());
}

/**
 * The Node binary to run the sampler with.
 *
 * In production the desktop shell passes its bundled Node; in development the
 * server itself may be running under Bun, whose `process.execPath` would be the
 * wrong interpreter, so fall back to whatever `node` is on PATH.
 */
function nodeBin(): string {
  if (process.env.LOOP_NODE_BIN) return process.env.LOOP_NODE_BIN;
  return process.versions.bun ? "node" : process.execPath;
}

function samplerScript(): string {
  return process.env.LOOP_SAMPLER_SCRIPT || resolve(process.cwd(), "scripts/sample-personas.mjs");
}

/** Samples N data-grounded personas from the corpus. Throws if it is absent. */
export async function sampleFromCorpus(
  filters: PersonaFilters,
  n: number,
  quotas?: Record<string, number>,
): Promise<SampledPersona[]> {
  if (!corpusAvailable()) {
    throw new Error(`페르소나 코퍼스를 찾을 수 없습니다: ${corpusPath()}`);
  }
  const { stdout } = await execFileAsync(
    nodeBin(),
    [samplerScript(), JSON.stringify({ filters, n, quotas })],
    { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as SampledPersona[];
}
