/**
 * Agent-CLI facts that both the server adapter and client components need.
 *
 * Split from agent-cli.ts because that module spawns subprocesses
 * (node:child_process) and therefore cannot be pulled into a client bundle —
 * importing a label from it would drag the whole runtime along.
 *
 * PURE MODULE — no IO.
 */

export type AgentCliKind = "claude" | "cursor";

export const AGENT_CLI_KINDS: readonly AgentCliKind[] = ["claude", "cursor"];

export const AGENT_CLI_LABELS: Record<AgentCliKind, string> = {
  claude: "Claude Code (claude)",
  cursor: "Cursor Agent (cursor-agent)",
};

export const DEFAULT_MODEL: Record<AgentCliKind, string> = {
  claude: "sonnet",
  cursor: "sonnet-4.5",
};

/** Result of probing whether a CLI is installed and runnable. */
export type CliStatus = {
  kind: AgentCliKind;
  available: boolean;
  path: string | null;
  version: string | null;
};

export function isAgentCliKind(value: unknown): value is AgentCliKind {
  return typeof value === "string" && (AGENT_CLI_KINDS as readonly string[]).includes(value);
}
