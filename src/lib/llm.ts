import {
  runAgentJson,
  runAgentText,
  parseJsonFromText,
  type RunOptions,
} from "@/lib/agent-cli";
import { getAgentSettings } from "@/lib/settings";

/**
 * Operator-side LLM calls (question design, review, analysis, themes, reports).
 *
 * Thin layer over the agent CLI adapter that fills in the user's configured CLI,
 * model and binary path. Callers that already hold an AgentSettings should pass
 * `resolved` to avoid re-reading the settings row per call — the simulation
 * engine does this for every batch.
 */

export type LlmOptions = Omit<RunOptions, "cli" | "model" | "binPath"> & {
  /** Pre-resolved settings; skips the settings lookup. */
  resolved?: { cli: RunOptions["cli"]; model: string; cliPath: string | null };
};

async function toRunOptions(opts: LlmOptions): Promise<RunOptions> {
  const { resolved, ...rest } = opts;
  const s = resolved ?? (await getAgentSettings());
  return { ...rest, cli: s.cli, model: s.model, binPath: s.cliPath };
}

export async function runLlmText(prompt: string, opts: LlmOptions = {}): Promise<string> {
  return runAgentText(prompt, await toRunOptions(opts));
}

export async function runLlmJson<T>(prompt: string, opts: LlmOptions = {}): Promise<T> {
  return runAgentJson<T>(prompt, await toRunOptions(opts));
}

export { parseJsonFromText };
