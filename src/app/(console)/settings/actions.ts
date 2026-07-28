"use server";

import { revalidatePath } from "next/cache";
import { clearCliCache, detectCli, runAgentJson } from "@/lib/agent-cli";
import { AGENT_CLI_KINDS, isAgentCliKind, type AgentCliKind, type CliStatus } from "@/lib/agent-cli-meta";
import { getAgentSettings, saveAgentSettings } from "@/lib/settings";

export type SaveState = { ok?: boolean; error?: string };

function parseCli(value: FormDataEntryValue | null): AgentCliKind | null {
  const v = String(value || "");
  return isAgentCliKind(v) ? v : null;
}

export async function saveSettingsAction(
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const cli = parseCli(formData.get("cli"));
  if (!cli) return { error: "알 수 없는 AI 도구입니다." };

  await saveAgentSettings({
    cli,
    model: String(formData.get("model") || ""),
    cliPath: String(formData.get("cliPath") || ""),
    concurrency: Number(formData.get("concurrency") || 4),
    batchSize: Number(formData.get("batchSize") || 5),
  });
  // A changed path must not keep resolving to the previously discovered binary.
  clearCliCache();
  revalidatePath("/settings");
  return { ok: true };
}

/** Probes both CLIs so the settings page can show what's actually installed. */
export async function detectClisAction(): Promise<CliStatus[]> {
  const settings = await getAgentSettings();
  return Promise.all(
    AGENT_CLI_KINDS.map((kind) =>
      detectCli(kind, kind === settings.cli ? settings.cliPath : null),
    ),
  );
}

/** End-to-end check: can the configured CLI actually answer with JSON? */
export async function testCliAction(): Promise<{ ok: boolean; error?: string }> {
  try {
    const s = await getAgentSettings();
    const out = await runAgentJson<{ ok?: unknown }>(
      'Reply with only this JSON object and nothing else: {"ok":true}',
      { cli: s.cli, model: s.model, binPath: s.cliPath, timeoutMs: 90_000 },
    );
    if (out?.ok !== true) return { ok: false, error: "예상과 다른 응답을 반환했습니다." };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "연결 실패" };
  }
}

// ---- data folder -----------------------------------------------------------

/** Where the embedded database lives, for display and for "open in Finder". */
export async function dataDirAction(): Promise<{ path: string; sizeMb: number | null }> {
  const { dataDir } = await import("@/db");
  const { statSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");

  const path = dataDir();
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else bytes += statSync(p).size;
    }
  };
  try {
    walk(path);
  } catch {
    return { path, sizeMb: null }; // not created yet
  }
  return { path, sizeMb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
}

/** Reveals the data folder in the OS file manager. */
export async function revealDataDirAction(): Promise<{ ok: boolean; error?: string }> {
  const { dataDir } = await import("@/db");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    await run(opener, [dataDir()], { timeout: 5_000 });
    return { ok: true };
  } catch {
    return { ok: false, error: "폴더를 열지 못했습니다 — 위 경로를 직접 여세요." };
  }
}
