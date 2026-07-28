import { DEFAULT_MODEL, type AgentCliKind } from "@/lib/agent-cli-meta";

/**
 * Settings shape and bounds, shared by the server store and the settings form.
 *
 * Split from settings.ts because that module opens the database — a client
 * component importing a number range from it would drag PGlite into the
 * browser bundle.
 *
 * PURE MODULE — no IO.
 */

export type AgentSettings = {
  cli: AgentCliKind;
  model: string;
  cliPath: string | null;
  /** Concurrent CLI processes during simulation. */
  concurrency: number;
  /** Personas answered per CLI call. */
  batchSize: number;
};

export const CONCURRENCY_RANGE = { min: 1, max: 16 } as const;
export const BATCH_SIZE_RANGE = { min: 1, max: 20 } as const;

export const DEFAULT_SETTINGS: AgentSettings = {
  cli: "claude",
  model: DEFAULT_MODEL.claude,
  cliPath: null,
  concurrency: 4,
  batchSize: 5,
};

export function clampToRange(value: number, { min, max }: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Human-readable engine label, e.g. "claude · sonnet". Stored on sim jobs. */
export function engineLabel(s: Pick<AgentSettings, "cli" | "model">): string {
  return `${s.cli} · ${s.model}`;
}
