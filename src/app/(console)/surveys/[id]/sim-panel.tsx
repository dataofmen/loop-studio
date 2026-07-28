"use client";

import { callAction } from "@/lib/call-action";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  startSimulationAction,
  getSimulationStatus,
  type SimStatus,
} from "./sim-actions";

export function SimulationPanel({
  surveyId,
  personaCount,
  initialStatus,
  simModel,
}: {
  surveyId: string;
  personaCount: number;
  initialStatus: SimStatus;
  simModel: string;
}) {
  const [status, setStatus] = useState<SimStatus>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function poll() {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const s = await getSimulationStatus(surveyId);
      setStatus(s);
      if (s.status !== "running" && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 2000);
  }

  useEffect(() => {
    if (initialStatus.status === "running") poll();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onStart() {
    setError(null);
    startTransition(async () => {
      const res = await callAction(() => startSimulationAction(surveyId, {}));
      if (res.error) {
        setError(res.error);
        return;
      }
      setStatus({ status: "running", total: personaCount, completed: 0 });
      poll();
    });
  }

  const pct =
    status.total > 0 ? Math.round((status.completed / status.total) * 100) : 0;

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="mb-1 text-lg font-semibold">합성 시뮬레이션</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {simModel}로 각 페르소나가 설문에 응답합니다. 발송 전 예상 결과를 미리 봅니다.
      </p>

      {status.status === "running" ? (
        <div>
          <div className="mb-1 flex justify-between text-sm">
            <span>시뮬레이션 진행 중…</span>
            <span>
              {status.completed} / {status.total} ({pct}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button
            onClick={onStart}
            disabled={pending || personaCount === 0}
            className="self-start"
          >
            {pending ? "시작 중…" : `시뮬레이션 실행 (${personaCount.toLocaleString()}명)`}
          </Button>
          {personaCount === 0 && (
            <p className="text-sm text-muted-foreground">먼저 합성 페르소나를 생성하세요.</p>
          )}
          {status.status === "completed" && !status.error && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              지난 실행: {status.completed.toLocaleString()}명의 합성 응답 생성됨 ✓
            </p>
          )}
          {/* Completed but with skipped personas (provider errors mid-run) —
              a "clean" green line here once hid a 998/1000 failure. */}
          {status.status === "completed" && status.error && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              일부 페르소나가 응답 생성에 실패했습니다: {status.error}
            </p>
          )}
          {/* Stale: persona set changed since the last run */}
          {status.status === "completed" && status.total !== personaCount && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              현재 표본은 {personaCount.toLocaleString()}명인데 지난 시뮬레이션은 {status.total.toLocaleString()}명 기준입니다.
              표본이 바뀌었으니 다시 실행하세요.
            </p>
          )}
          {status.status === "failed" && (
            <p className="text-sm text-destructive">실패: {status.error}</p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}
