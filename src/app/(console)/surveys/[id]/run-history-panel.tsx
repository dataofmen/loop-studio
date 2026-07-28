"use client";

import { useState } from "react";
import type { SimulationRun } from "./sim-actions";
import type { Distribution } from "@/lib/quality";

function Bars({ d }: { d: Distribution }) {
  if (d.type === "open") return <p className="text-xs text-muted-foreground">주관식 · 응답 {d.answered}건</p>;
  return (
    <div className="flex flex-col gap-1">
      {d.counts.map((c) => (
        <div key={c.label} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 truncate text-muted-foreground" title={c.label}>{c.label}</span>
          <div className="h-2.5 flex-1 overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary" style={{ width: `${c.pct}%` }} />
          </div>
          <span className="w-9 shrink-0 text-right text-muted-foreground">{c.pct}%</span>
        </div>
      ))}
      {d.mean != null && <p className="text-xs text-muted-foreground/70">평균 {d.mean}</p>}
      {d.npsScore != null && (
        <p className="text-xs font-medium text-muted-foreground">NPS {d.npsScore > 0 ? "+" : ""}{d.npsScore}</p>
      )}
      {d.avgRanks && d.avgRanks.length > 0 && (
        <p className="text-xs text-muted-foreground/70">평균 순위: {d.avgRanks.map((r) => `${r.label} ${r.avg}`).join(" · ")}</p>
      )}
    </div>
  );
}

export function RunHistoryPanel({ runs }: { runs: SimulationRun[] }) {
  const [open, setOpen] = useState<string | null>(runs[0]?.id ?? null);
  if (runs.length === 0) return null;

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="mb-1 text-lg font-semibold">시뮬레이션 이력</h2>
      <p className="mb-3 text-xs text-muted-foreground">지난 합성 시뮬레이션 결과를 다시 조회합니다 (최근 20회).</p>
      <ul className="flex flex-col gap-2">
        {runs.map((r) => {
          const expanded = open === r.id;
          const when = new Date(r.createdAt).toLocaleString("ko-KR", {
            month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
          });
          return (
            <li key={r.id} className="rounded-lg border">
              <button
                onClick={() => setOpen(expanded ? null : r.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{when}</span>{" "}
                  <span className="text-muted-foreground">
                    · {r.model} · {r.completed.toLocaleString()}명
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground/70">{expanded ? "▲" : "▼"}</span>
              </button>
              {expanded && (
                <div className="border-t p-3">
                  {r.warning && (
                    <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                      ⚠️ {r.warning}
                    </p>
                  )}
                  {r.summary && r.summary.length > 0 ? (
                    <ol className="flex flex-col gap-3">
                      {r.summary.map((d, i) => (
                        <li key={d.questionId}>
                          <p className="mb-1 text-sm font-medium">
                            {i + 1}. {d.prompt}{" "}
                            <span className="text-xs font-normal text-muted-foreground/70">(n={d.n})</span>
                          </p>
                          <Bars d={d} />
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-muted-foreground">이 회차에는 저장된 분포 요약이 없습니다.</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
