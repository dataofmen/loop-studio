"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import {
  AGENT_CLI_KINDS,
  AGENT_CLI_LABELS,
  DEFAULT_MODEL,
  type AgentCliKind,
  type CliStatus,
} from "@/lib/agent-cli-meta";
import { BATCH_SIZE_RANGE, CONCURRENCY_RANGE, type AgentSettings } from "@/lib/settings-meta";
import { detectClisAction, saveSettingsAction, testCliAction, type SaveState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MODEL_HINTS: Record<AgentCliKind, string> = {
  claude: "예: sonnet, opus, haiku",
  cursor: "예: sonnet-4.5, gpt-5 — `cursor-agent models`로 확인",
};

const INSTALL_HINTS: Record<AgentCliKind, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  cursor: "curl https://cursor.com/install -fsS | bash",
};

export function SettingsForm({
  initial,
  initialStatuses,
}: {
  initial: AgentSettings;
  initialStatuses: CliStatus[];
}) {
  const [state, formAction, pending] = useActionState<SaveState, FormData>(saveSettingsAction, {});
  const [cli, setCli] = useState<AgentCliKind>(initial.cli);
  const [statuses, setStatuses] = useState(initialStatuses);
  const [test, setTest] = useState<{ ok: boolean; error?: string } | null>(null);
  const [checking, startCheck] = useTransition();

  // A successful save can change which binary is used — re-probe.
  useEffect(() => {
    if (state.ok) {
      setTest(null);
      startCheck(async () => setStatuses(await detectClisAction()));
    }
  }, [state.ok]);

  const status = statuses.find((s) => s.kind === cli);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">AI 도구</legend>
        {AGENT_CLI_KINDS.map((kind) => {
          const s = statuses.find((x) => x.kind === kind);
          return (
            <label
              key={kind}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-foreground"
            >
              <input
                type="radio"
                name="cli"
                value={kind}
                checked={cli === kind}
                onChange={() => setCli(kind)}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{AGENT_CLI_LABELS[kind]}</span>
                {s?.available ? (
                  <span className="text-sm text-emerald-600 dark:text-emerald-400">
                    설치됨{s.version ? ` — ${s.version}` : ""}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    찾을 수 없음 — 설치: <code className="font-mono">{INSTALL_HINTS[kind]}</code>
                  </span>
                )}
                {s?.path && <span className="font-mono text-xs text-muted-foreground">{s.path}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="model">모델</Label>
        <Input id="model" name="model" defaultValue={initial.model} placeholder={DEFAULT_MODEL[cli]} />
        <p className="text-sm text-muted-foreground">{MODEL_HINTS[cli]}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cliPath">실행 파일 경로 (선택)</Label>
        <Input
          id="cliPath"
          name="cliPath"
          defaultValue={initial.cliPath ?? ""}
          placeholder={status?.path ?? "비워두면 자동으로 찾습니다"}
        />
        <p className="text-sm text-muted-foreground">
          자동 탐색이 실패할 때만 절대 경로를 지정하세요.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="concurrency">동시 실행 수</Label>
          <Input
            id="concurrency"
            name="concurrency"
            type="number"
            min={CONCURRENCY_RANGE.min}
            max={CONCURRENCY_RANGE.max}
            defaultValue={initial.concurrency}
          />
          <p className="text-sm text-muted-foreground">동시에 띄우는 CLI 프로세스 수.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="batchSize">호출당 페르소나 수</Label>
          <Input
            id="batchSize"
            name="batchSize"
            type="number"
            min={BATCH_SIZE_RANGE.min}
            max={BATCH_SIZE_RANGE.max}
            defaultValue={initial.batchSize}
          />
          <p className="text-sm text-muted-foreground">
            클수록 빠르고 저렴하지만, 한 응답이 다른 응답을 닮아갈 수 있습니다. 1이면 완전히 독립.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "저장 중…" : "저장"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={checking}
          onClick={() => startCheck(async () => setTest(await testCliAction()))}
        >
          {checking ? "확인 중…" : "연결 테스트"}
        </Button>
        {state.ok && <span className="text-sm text-emerald-600 dark:text-emerald-400">저장했습니다.</span>}
        {state.error && <span className="text-sm text-destructive">{state.error}</span>}
        {test?.ok && <span className="text-sm text-emerald-600 dark:text-emerald-400">정상 응답을 받았습니다.</span>}
        {test && !test.ok && <span className="text-sm text-destructive">{test.error}</span>}
      </div>
    </form>
  );
}
