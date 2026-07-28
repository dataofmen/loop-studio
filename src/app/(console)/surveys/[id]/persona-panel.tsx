"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { generatePersonasAction, type PersonaState } from "./persona-actions";

const PRESETS = [100, 500, 1000, 2000, 5000, 10000];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "페르소나 생성 중…" : "합성 페르소나 생성"}
    </Button>
  );
}

export function PersonaPanel({
  surveyId,
  existingCount,
  scopes,
  baseMonth,
  corpusInstalled,
}: {
  surveyId: string;
  existingCount: number;
  scopes: string[];
  baseMonth: string | null;
  /** Whether the Nemotron corpus is present — representative mode needs it. */
  corpusInstalled: boolean;
}) {
  const action = generatePersonasAction.bind(null, surveyId);
  const [state, formAction] = useActionState<PersonaState, FormData>(action, {});
  const [n, setN] = useState(1000);

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="mb-1 text-lg font-semibold">합성 페르소나</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {corpusInstalled
          ? "NVIDIA Nemotron-Personas-Korea(실제 인구통계 분포) 코퍼스에서 타겟 모집단을 표본 추출합니다."
          : "코퍼스가 설치되지 않아 AI가 설명에 맞는 페르소나를 만들어냅니다 — 그럴듯하지만 실제 인구 분포를 따르지는 않습니다."}
        {existingCount > 0 && ` 현재 ${existingCount}명 정의됨.`}
      </p>
      <form action={formAction} className="flex flex-col gap-3">
        {corpusInstalled && scopes.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">대표성 표본 (공식 인구통계 기준)</label>
            <select name="scope" defaultValue="" className={selectCls}>
              <option value="">— 사용 안 함 (설명 기반 표본)</option>
              {scopes.map((s) => (
                <option key={s} value={s}>
                  {s} 인구 분포로 대표성 보정
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground/70">
              선택 시 행정안전부 주민등록 인구통계{baseMonth ? ` (${baseMonth})` : ""}의 연령대×성별 분포에 비례해 표본을 구성합니다.
            </p>
          </div>
        )}
        {!corpusInstalled && (
          <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            공식 인구통계에 비례하는 <strong>대표성 표본</strong>은 코퍼스가 있어야 합니다. 설치 방법은
            README의 &ldquo;페르소나 코퍼스&rdquo; 항목을 참고하세요.
          </p>
        )}
        <Textarea
          name="description"
          rows={2}
          placeholder="타겟 모집단 설명 (예: 수도권에 사는 20~30대 직장인). 대표성 표본 선택 시 생략 가능."
          className="min-h-0"
        />
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm text-muted-foreground">표본 수</label>
            <Input
              type="number"
              name="n"
              value={n}
              onChange={(e) => setN(Math.min(10000, Math.max(10, Number(e.target.value) || 0)))}
              min={10}
              max={10000}
              step={10}
              className="w-28 px-2"
            />
            <span className="text-xs text-muted-foreground/70">10 ~ 10,000</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setN(p)}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  n === p
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground"
                }`}
              >
                {p.toLocaleString()}
              </button>
            ))}
          </div>
          <GenerateButton />
        </div>
        {state.error && <p className="text-sm text-destructive">{state.error}</p>}
        {state.count != null && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">{state.count}명의 페르소나를 생성했습니다 ✓</p>
        )}
      </form>
    </section>
  );
}
