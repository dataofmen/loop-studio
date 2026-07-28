import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CLI_LABELS,
  DEFAULT_MODEL,
  type AgentCliKind,
  type CliStatus,
} from "@/lib/agent-cli-meta";

export * from "@/lib/agent-cli-meta";

const execFileAsync = promisify(execFile);

/**
 * All LLM access goes through a locally-installed agent CLI — `claude` or
 * `cursor-agent`. Both reuse the user's existing subscription, so the app never
 * handles an API key.
 *
 * The two CLIs happen to emit the *same* JSON envelope in print mode
 * ({ type: "result", is_error, result, ... }), so only the argv differs.
 *
 * Node.js runtime only (spawns a subprocess) — never Edge.
 */

/** Default binary name looked up on PATH when no explicit path is configured. */
const BIN_NAME: Record<AgentCliKind, string> = {
  claude: process.env.LOOP_CLAUDE_BIN || "claude",
  cursor: process.env.LOOP_CURSOR_BIN || "cursor-agent",
};

export type RunOptions = {
  cli?: AgentCliKind;
  model?: string;
  /** Absolute path to the CLI binary; skips PATH discovery when given. */
  binPath?: string | null;
  /** Max time to wait for the CLI, ms. */
  timeoutMs?: number;
};

/**
 * A neutral working directory for the subprocess.
 *
 * Both CLIs treat their cwd as a workspace they may read. Running them inside
 * the user's project would let survey prompts pull in unrelated repo content,
 * so we always run from a scratch dir.
 */
function agentCwd(): string {
  return process.env.LOOP_AGENT_CWD || tmpdir();
}

/**
 * Tools we never want the agent to reach.
 *
 * Every call here is text-in / text-out, but the prompts EMBED survey content —
 * and a survey can arrive from outside (markdown import, a shared template).
 * Text that reaches an agent holding a shell is an injection target: "ignore
 * the above and run …". Cursor is confined by `--mode ask`; claude needs the
 * tools named explicitly. Unknown names are accepted and ignored by the CLI, so
 * listing generously is safe and stays valid as the tool set changes.
 */
const CLAUDE_DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "SlashCommand",
];

function argsFor(kind: AgentCliKind, prompt: string, model: string): string[] {
  if (kind === "cursor") {
    return [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--model",
      model,
      // Read-only Q&A mode: the agent answers instead of editing files.
      "--mode",
      "ask",
      // Without this the CLI blocks on an interactive workspace-trust prompt.
      "--trust",
    ];
  }
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    model,
    "--disallowed-tools",
    ...CLAUDE_DISALLOWED_TOOLS,
  ];
}

// ---- binary discovery -------------------------------------------------------

const binCache = new Map<AgentCliKind, string | null>();

/** First executable named `name` on the inherited PATH, or null. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Finds the CLI binary.
 *
 * A GUI-launched app inherits a minimal PATH (`/usr/bin:/bin:…`) that misses the
 * user's shell setup, so `claude` installed under ~/.local/bin is invisible.
 * Fall back to asking the login shell where it lives.
 */
export async function resolveCliBin(
  kind: AgentCliKind,
  override?: string | null,
): Promise<string | null> {
  const explicit = override?.trim();
  if (explicit) return explicit;

  const cached = binCache.get(kind);
  if (cached !== undefined) return cached;

  const name = BIN_NAME[kind];
  // Scan the inherited PATH ourselves rather than shelling out — no quoting
  // concerns, and it answers instantly in the common case.
  let found = onPath(name);

  if (!found) {
    // A GUI-launched app's PATH is missing the user's shell setup; ask the
    // login shell where the binary actually is.
    const shell = process.env.SHELL || "/bin/zsh";
    try {
      // `name` comes from config/env, so this is not an attack path from survey
      // content — but it is the one place a string reaches a shell, so pass it
      // as a positional argument instead of splicing it into the script text.
      const { stdout } = await execFileAsync(
        shell,
        ["-lic", 'command -v "$1"', "_", name],
        { timeout: 10_000 },
      );
      found = stdout.trim().split("\n").pop()?.trim() || null;
    } catch {
      found = null;
    }
  }

  binCache.set(kind, found);
  return found;
}

/** Clears the discovery + status caches — call after the user edits the CLI path. */
export function clearCliCache(): void {
  binCache.clear();
  statusCache.clear();
}

/**
 * Probes whether a CLI is installed and runnable (used by settings + onboarding).
 *
 * The `--version` spawn costs a few hundred milliseconds, and the dashboard
 * asks on every render, so the answer is cached. The TTL keeps a freshly
 * installed CLI from staying invisible; `clearCliCache()` drops it immediately
 * when the user edits the path.
 */
const STATUS_TTL_MS = 60_000;
const statusCache = new Map<string, { at: number; status: CliStatus }>();

export async function detectCli(
  kind: AgentCliKind,
  override?: string | null,
): Promise<CliStatus> {
  const key = `${kind}:${override ?? ""}`;
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;

  const status = await probeCli(kind, override);
  statusCache.set(key, { at: Date.now(), status });
  return status;
}

async function probeCli(kind: AgentCliKind, override?: string | null): Promise<CliStatus> {
  const path = await resolveCliBin(kind, override);
  if (!path) return { kind, available: false, path: null, version: null };
  try {
    const { stdout } = await execFileAsync(path, ["--version"], { timeout: 10_000 });
    return { kind, available: true, path, version: stdout.trim().split("\n")[0] || null };
  } catch {
    return { kind, available: false, path, version: null };
  }
}

// ---- invocation -------------------------------------------------------------

/** Runs the CLI in print mode and returns the model's raw text output. */
export async function runAgentText(prompt: string, opts: RunOptions = {}): Promise<string> {
  const kind = opts.cli ?? "claude";
  const model = opts.model || DEFAULT_MODEL[kind];
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const bin = await resolveCliBin(kind, opts.binPath);
  if (!bin) {
    throw new Error(
      `${AGENT_CLI_LABELS[kind]}를 찾을 수 없습니다 — 설치했는지 확인하거나 설정에서 실행 파일 경로를 지정해 주세요.`,
    );
  }

  const pending = execFileAsync(bin, argsFor(kind, prompt, model), {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    cwd: agentCwd(),
  });
  // Close stdin right away — the CLIs otherwise wait for piped input.
  pending.child.stdin?.end();

  let stdout: string;
  try {
    ({ stdout } = await pending);
  } catch (e) {
    // NEVER rethrow execFile's raw error: its message embeds the full command
    // line (= the entire prompt), which then walls the UI. Distill it.
    const err = e as { killed?: boolean; signal?: string; stderr?: string };
    if (err.killed || err.signal === "SIGTERM") {
      throw new Error(
        `AI 응답이 제한 시간(${Math.round(timeoutMs / 1000)}초)을 초과했습니다 — 요청을 나누거나 잠시 후 다시 시도해 주세요.`,
      );
    }
    const stderrTail = (err.stderr ?? "").trim().split("\n").slice(-2).join(" ").slice(0, 200);
    throw new Error(`${AGENT_CLI_LABELS[kind]} 실행 실패${stderrTail ? ` — ${stderrTail}` : ""}`);
  }

  // Both CLIs wrap output as { type: "result", result: "<text>", is_error, ... }.
  let envelope: { result?: string; is_error?: boolean; subtype?: string };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`${AGENT_CLI_LABELS[kind]}가 JSON이 아닌 출력을 반환했습니다.`);
  }
  if (envelope.is_error || typeof envelope.result !== "string") {
    throw new Error(`${AGENT_CLI_LABELS[kind]} 오류: ${envelope.subtype || "unknown"}`);
  }
  return envelope.result;
}

/** Strips ```json fences / surrounding prose and parses JSON from model text. */
export function parseJsonFromText<T>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Fall back to the first {...} or [...] block.
  if (!t.startsWith("{") && !t.startsWith("[")) {
    const m = t.match(/[{[][\s\S]*[}\]]/);
    if (m) t = m[0];
  }
  try {
    return JSON.parse(t) as T;
  } catch {
    // Tolerant retry for the most common LLM JSON slips: trailing commas and
    // smart quotes. Only touches syntax, never values' semantics.
    const relaxed = t.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(relaxed) as T;
    } catch {
      // Raw JSON.parse positions mean nothing to the user — one clean line.
      throw new Error("AI가 유효하지 않은 JSON을 반환했습니다 — 잠시 후 다시 시도해 주세요.");
    }
  }
}

/** Convenience: run the CLI and parse its output as JSON of type T. */
export async function runAgentJson<T>(prompt: string, opts: RunOptions = {}): Promise<T> {
  const text = await runAgentText(prompt, opts);
  try {
    return parseJsonFromText<T>(text);
  } catch (e) {
    // Keep the raw reply inspectable for parser hardening (server log only —
    // truncated, never sent to the client).
    console.error("[agent-cli] JSON parse failed; raw tail:", text.slice(-400));
    throw e;
  }
}
