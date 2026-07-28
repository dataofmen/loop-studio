"use client";

import { callAction } from "@/lib/call-action";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  generateReportAction,
  listReportsAction,
  exportReportMarkdownAction,
} from "./report-actions";
import type { StudyReportRow } from "@/lib/reports";

const MIN_RESPONSES = 5;

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportPanel({
  surveyId,
  responseCount,
  initial,
}: {
  surveyId: string;
  responseCount: number;
  initial: StudyReportRow[];
}) {
  const [reports, setReports] = useState<StudyReportRow[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = reports.find((r) => r.id === selectedId) ?? reports[0] ?? null;
  const canGenerate = responseCount >= MIN_RESPONSES;

  function generate() {
    setError(null);
    startTransition(async () => {
      const res = await callAction(() => generateReportAction(surveyId));
      if (res.error) {
        setError(res.error);
        return;
      }
      const list = await listReportsAction(surveyId);
      if (list.data) {
        setReports(list.data);
        setSelectedId(res.data?.id ?? list.data[0]?.id ?? null);
      }
    });
  }

  function exportMd() {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      const res = await callAction(() => exportReportMarkdownAction(surveyId, selected.id));
      if (res.error) setError(res.error);
      else if (res.data) downloadText(res.data.filename, res.data.markdown);
    });
  }

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">AI 스터디 리포트</h2>
        <div className="flex items-center gap-2">
          {reports.length > 0 && (
            <select
              className="rounded-md border p-1 text-xs"
              value={selected?.id ?? ""}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.createdAt).toLocaleString()} ({r.responseCount}건)
                </option>
              ))}
            </select>
          )}
          {selected && (
            <Button variant="outline" size="sm" onClick={exportMd} disabled={pending}>
              Markdown 내보내기
            </Button>
          )}
          {(
          <Button size="sm" onClick={generate} disabled={pending || !canGenerate}>
            {pending ? "생성 중…" : reports.length ? "새 리포트 생성" : "리포트 생성"}
          </Button>
          )}
        </div>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        실제 응답만으로 근거가 연결된 리포트를 생성합니다. 생성 시점 스냅샷으로 저장되어 언제든 다시
        볼 수 있습니다.
      </p>

      {!canGenerate && (
        <p className="text-sm text-muted-foreground">
          리포트 생성에는 시뮬 응답이 최소 {MIN_RESPONSES}건 필요합니다 (현재 {responseCount}건).
        </p>
      )}

      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

      {selected && (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold">{selected.report.title}</h3>
            <p className="text-xs text-muted-foreground">
              시뮬 응답 {selected.report.responseCount}건 · {new Date(selected.createdAt).toLocaleString()}
            </p>
            {selected.report.overview && (
              <p className="mt-2 text-sm leading-relaxed">{selected.report.overview}</p>
            )}
          </div>

          {selected.report.findings.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold">핵심 발견 &amp; 권장 액션</h4>
              <ol className="flex flex-col gap-2">
                {selected.report.findings.map((f, i) => (
                  <li key={i} className="rounded-lg border p-3">
                    <p className="text-sm font-medium">
                      {i + 1}. {f.finding}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      근거 문항: {f.questionPrompt}
                      {typeof f.questionN === "number" && f.questionN > 0 && (
                        <> (n={f.questionN})</>
                      )}
                      {typeof f.questionN === "number" && f.questionN > 0 && f.questionN < 30 && (
                        <span className="ml-1 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          표본 작음
                        </span>
                      )}
                    </p>
                    {f.action && (
                      <p className="mt-1.5 rounded-md bg-primary/5 px-2.5 py-1.5 text-sm text-foreground/90">
                        <span className="mr-1.5 font-semibold text-primary">권장 액션</span>
                        {f.action}
                      </p>
                    )}
                    {f.evidence.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs font-medium text-primary">
                          근거 응답 보기 ({f.evidence.length})
                        </summary>
                        <ul className="mt-1.5 flex flex-col gap-1">
                          {f.evidence.map((e) => (
                            <li
                              key={e.responseId}
                              className="rounded-md bg-muted/40 px-2.5 py-1.5 text-sm break-words"
                            >
                              {e.text}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {selected.report.themes.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold">주관식 테마</h4>
              <ul className="flex flex-col gap-1">
                {selected.report.themes.map((t, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-muted-foreground"> ({t.count}건) — {t.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {selected.report.segmentNotes.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold">세그먼트 차이</h4>
              <ul className="list-inside list-disc text-sm">
                {selected.report.segmentNotes.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h4 className="mb-2 text-sm font-semibold">주의사항</h4>
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {selected.report.caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
