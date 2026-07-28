import Link from "next/link";
import { detectCli } from "@/lib/agent-cli";
import { getAgentSettings } from "@/lib/settings";
import { AGENT_CLI_LABELS } from "@/lib/agent-cli-meta";

const INSTALL_HINTS: Record<string, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  cursor: "curl https://cursor.com/install -fsS | bash",
};

/**
 * First-run guard rail: everything in this app — designing questions,
 * reviewing them, simulating answers — runs through a local agent CLI. If it
 * isn't reachable, say so here rather than letting the user discover it as a
 * failed action three screens later.
 */
export async function CliNotice() {
  const settings = await getAgentSettings();
  const status = await detectCli(settings.cli, settings.cliPath);
  if (status.available) return null;

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p className="font-semibold text-amber-900 dark:text-amber-200">
        {AGENT_CLI_LABELS[settings.cli]}를 찾을 수 없습니다
      </p>
      <p className="mt-1 text-amber-800 dark:text-amber-300">
        문항 설계·검토·시뮬레이션이 모두 이 CLI를 통해 실행됩니다. 설치한 뒤 로그인해 주세요:
      </p>
      <code className="mt-2 block rounded bg-amber-100 px-2 py-1 font-mono text-xs text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
        {INSTALL_HINTS[settings.cli]}
      </code>
      <p className="mt-2 text-amber-800 dark:text-amber-300">
        이미 설치했다면{" "}
        <Link href="/settings" className="font-medium underline underline-offset-4">
          설정
        </Link>
        에서 다른 도구를 고르거나 실행 파일 경로를 직접 지정할 수 있습니다.
      </p>
    </div>
  );
}
