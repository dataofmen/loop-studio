"use client";

/**
 * US-406: analysis-ready export menu. Builds a GET URL against
 * /api/surveys/:id/export — the route streams a real download with
 * Content-Disposition, so this component only assembles options.
 */

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const FORMATS = [
  {
    value: "wide",
    name: "분석용 CSV (wide)",
    desc: "1응답 1행 · 안정 변수명(q01…) · 원핫/코드 옵션 · SPSS·R·Python용",
  },
  {
    value: "long",
    name: "Tidy CSV (long)",
    desc: "응답×문항 1행 · 코드+라벨 병기 · R tidyverse/pandas 집계용",
  },
  {
    value: "ai",
    name: "AI 분석 번들 (zip)",
    desc: "dataset.jsonl + codebook.json + README — Claude/ChatGPT에 바로 업로드",
  },
  {
    value: "spss",
    name: "SPSS 번들 (zip)",
    desc: "data.csv + import.sps — 신택스 실행으로 라벨·결측 자동 세팅",
  },
  {
    value: "simple",
    name: "간단 CSV (기존)",
    desc: "문항 텍스트 헤더 · 훑어보기용",
  },
] as const;

export function ExportMenu({ surveyId }: { surveyId: string }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<string>("wide");
  const [values, setValues] = useState<"codes" | "labels">("codes");
  const [multi, setMulti] = useState<"expand" | "merge">("expand");
  const ref = useRef<HTMLDivElement>(null);

  const optionsApply = format === "wide";

  function download() {
    const p = new URLSearchParams({ format });
    if (optionsApply) {
      p.set("values", values);
      p.set("multi", multi);
    }
    window.location.href = `/api/surveys/${surveyId}/export?${p.toString()}`;
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
        내보내기
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg border bg-card p-3 text-card-foreground shadow-lg">
          <p className="mb-2 text-xs font-semibold">포맷</p>
          <div className="flex flex-col gap-1.5">
            {FORMATS.map((f) => (
              <label
                key={f.value}
                className={`cursor-pointer rounded-md border p-2 text-xs ${
                  format === f.value ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <input
                  type="radio"
                  name="export-format"
                  className="mr-1.5"
                  checked={format === f.value}
                  onChange={() => setFormat(f.value)}
                />
                <span className="font-medium">{f.name}</span>
                <span className="mt-0.5 block pl-5 text-muted-foreground">{f.desc}</span>
              </label>
            ))}
          </div>

          {optionsApply && (
            <div className="mt-2 flex gap-2">
              <select
                className="flex-1 rounded-md border p-1 text-xs"
                value={values}
                onChange={(e) => setValues(e.target.value as "codes" | "labels")}
              >
                <option value="codes">값: 숫자 코드</option>
                <option value="labels">값: 선택지 텍스트</option>
              </select>
              <select
                className="flex-1 rounded-md border p-1 text-xs"
                value={multi}
                onChange={(e) => setMulti(e.target.value as "expand" | "merge")}
              >
                <option value="expand">다중선택: 선택지별 컬럼</option>
                <option value="merge">다중선택: 한 컬럼 병합</option>
              </select>
            </div>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              닫기
            </Button>
            <Button size="sm" onClick={download}>
              다운로드
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
