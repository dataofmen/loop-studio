"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TemplateSummary } from "@/lib/template-summary";
import { collectTagValues, filterTemplateSummaries } from "@/lib/template-summary";
import {
  createSurveyFromTemplateAction,
  decomposeTemplateAction,
  generateTemplateSummaryAction,
  insertTemplateQuestionsAction,
} from "../surveys/[id]/template-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type KindFilter = "all" | "survey" | "block" | "question";

const KIND_TABS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "survey", label: "설문" },
  { key: "block", label: "문항 블록" },
  { key: "question", label: "개별 문항" },
];

const TYPE_LABEL: Record<string, string> = {
  single: "단일",
  multi: "복수",
  scale: "척도",
  nps: "NPS",
  ranking: "순위",
  matrix: "행렬",
  open: "주관식",
};

/** Per-type chip color so the composition reads as distinct categories, not one gray blur. */
const TYPE_CHIP: Record<string, string> = {
  single: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  multi: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  scale: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  nps: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  ranking: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  matrix: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  open: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

/** A small type badge (예: 단일 · NPS) used both in the composition row and per question. */
function TypeChip({ type }: { type: string }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
        TYPE_CHIP[type] ?? TYPE_CHIP.open
      }`}
    >
      {typeLabel(type)}
    </span>
  );
}

/** How many questions a card shows before the "펼치기" toggle (US-903 visibility). */
const PREVIEW_COLLAPSED = 4;

/** Browsable, searchable template library (US-009). Filtering is client-side & pure. */
export type InsertTarget = { id: string; title: string };

export function TemplateLibrary({
  templates,
  insertTargets = [],
  initialConstruct = "",
}: {
  templates: TemplateSummary[];
  insertTargets?: InsertTarget[];
  initialConstruct?: string;
}) {
  const [query, setQuery] = useState("");
  const [construct, setConstruct] = useState(initialConstruct);
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  // US-907: freshly generated AI summaries, overlaid until the next server load.
  const [aiOverrides, setAiOverrides] = useState<Record<string, string>>({});

  const { constructs, topics } = useMemo(() => collectTagValues(templates), [templates]);
  // Survey template ids that already have auto-derived block/question children
  // (US-908) — used to hide the retroactive "분해" action once decomposed.
  const derivedParents = useMemo(
    () => new Set(templates.map((t) => t.tags.derivedFrom).filter(Boolean) as string[]),
    [templates],
  );
  const kindCounts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: templates.length, survey: 0, block: 0, question: 0 };
    for (const t of templates) c[t.kind]++;
    return c;
  }, [templates]);
  const filtered = useMemo(() => {
    const byKind = kind === "all" ? templates : templates.filter((t) => t.kind === kind);
    return filterTemplateSummaries(byKind, { query, construct, topic });
  }, [templates, kind, query, construct, topic]);

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        아직 저장된 템플릿이 없습니다. 설문 설계 탭의 &ldquo;템플릿으로 저장&rdquo;에서 만들어 보세요.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1 border-b">
        {KIND_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setKind(tab.key)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors ${
              kind === tab.key
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            <span className="ml-1 text-xs text-muted-foreground/70">{kindCounts[tab.key]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름·설명·문항 검색"
          className="min-w-[200px] flex-1"
        />
        <select
          value={construct}
          onChange={(e) => setConstruct(e.target.value)}
          className={selectCls}
        >
          <option value="">모든 construct</option>
          {constructs.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className={selectCls}
        >
          <option value="">모든 topic</option>
          {topics.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <p className="text-xs text-muted-foreground">
        {filtered.length}개 템플릿
        {filtered.length !== templates.length && ` (전체 ${templates.length}개 중)`}
      </p>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">검색 조건에 맞는 템플릿이 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((t) => (
            <TemplateCard
              key={t.id}
              t={t}
              hasDerived={derivedParents.has(t.id)}
              insertTargets={insertTargets}
              aiOverride={aiOverrides[t.id]}
              onAiSummary={(s) => setAiOverrides((prev) => ({ ...prev, [t.id]: s }))}
            />
          ))}
        </ul>
      )}

      <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
        ← 대시보드로
      </Link>
    </div>
  );
}

/**
 * One template row in the library (US-903). Leads with the reuse unit + name,
 * then the composition, tags, and — the visibility fix — the full question list
 * with per-question type badges (collapsed past PREVIEW_COLLAPSED). A block's
 * make-up is now readable at a glance instead of three truncated prompts.
 */
function TemplateCard({
  t,
  hasDerived,
  insertTargets,
  aiOverride,
  onAiSummary,
}: {
  t: TemplateSummary;
  hasDerived: boolean;
  insertTargets: InsertTarget[];
  aiOverride?: string;
  onAiSummary: (summary: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? t.preview : t.preview.slice(0, PREVIEW_COLLAPSED);
  const hiddenPreview = t.preview.length - shown.length;
  // Snapshot may exceed the previewed cap; account for both sources of remainder.
  const beyondPreview = t.questionCount - t.preview.length;
  return (
    <li className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <KindBadge kind={t.kind} />
          {t.tags.derivedFrom && (
            <span
              className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              title="설문 템플릿 저장 시 자동으로 분해되어 생성된 템플릿입니다."
            >
              설문 분해
            </span>
          )}
          <h3 className="truncate font-semibold">{t.name}</h3>
        </div>
        <Badge variant="secondary" className="shrink-0">
          문항 {t.questionCount}개
        </Badge>
      </div>
      {/* description(사용자) > aiSummary(US-907) > 구조 요약 — 항상 구조 요약 병기 */}
      {(t.description || aiOverride || t.aiSummary) && (
        <p className="mt-1 text-sm text-muted-foreground">
          {t.description || aiOverride || t.aiSummary}
        </p>
      )}
      {t.structured.typeCounts.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {t.structured.typeCounts.map((c) => (
            <span key={c.type} className="flex items-center gap-1">
              <TypeChip type={c.type} />
              <span className="text-xs text-muted-foreground/80">{c.count}</span>
            </span>
          ))}
          {!t.description && (
            <AiSummaryButton templateId={t.id} onDone={onAiSummary} />
          )}
        </div>
      )}
      {(t.tags.construct || t.tags.topic) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {t.tags.construct && (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              construct: {t.tags.construct}
            </span>
          )}
          {t.tags.topic && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              topic: {t.tags.topic}
            </span>
          )}
        </div>
      )}
      {t.preview.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1 border-t pt-3">
          {shown.map((p, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 w-4 shrink-0 text-right tabular-nums text-muted-foreground/50">
                {i + 1}
              </span>
              <TypeChip type={p.type} />
              <span className="min-w-0 text-muted-foreground">{p.prompt}</span>
            </li>
          ))}
          {(hiddenPreview > 0 || (!expanded && beyondPreview > 0)) && (
            <li className="pl-6">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-xs font-medium text-primary hover:underline"
              >
                + 나머지 {hiddenPreview + (expanded ? 0 : beyondPreview)}개 문항 보기
              </button>
            </li>
          )}
          {expanded && hiddenPreview === 0 && t.preview.length > PREVIEW_COLLAPSED && (
            <li className="pl-6">
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="text-xs font-medium text-muted-foreground hover:underline"
              >
                접기
              </button>
            </li>
          )}
          {expanded && beyondPreview > 0 && (
            <li className="pl-6 text-xs text-muted-foreground/60">
              … 외 {beyondPreview}개 (미리보기 한도 초과)
            </li>
          )}
        </ol>
      )}
      <TemplateActions t={t} hasDerived={hasDerived} insertTargets={insertTargets} />
    </li>
  );
}

/** US-907: operator-triggered one-line AI summary for a template. */
function AiSummaryButton({
  templateId,
  onDone,
}: {
  templateId: string;
  onDone: (summary: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        className="text-xs text-primary hover:underline disabled:opacity-50"
        disabled={pending}
        onClick={() => {
          setErr(null);
          startTransition(async () => {
            const r = await generateTemplateSummaryAction(templateId);
            if (r.error) setErr(r.error);
            else if (r.summary) onDone(r.summary);
          });
        }}
      >
        {pending ? "생성 중…" : "설명 AI 생성"}
      </button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}

const KIND_META: Record<TemplateSummary["kind"], { label: string; cls: string }> = {
  survey: { label: "설문", cls: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  block: { label: "블록", cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" },
  question: { label: "문항", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
};

function KindBadge({ kind }: { kind: TemplateSummary["kind"] }) {
  const m = KIND_META[kind];
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}

/**
 * US-908 (retroactive): decomposes a survey template into block/question
 * sub-templates on demand — for templates saved before auto-decompose, or to
 * (re)generate the smaller units. Refreshes so the new rows appear in the list.
 */
function DecomposeButton({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end">
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => {
          setErr(null);
          setMsg(null);
          startTransition(async () => {
            const r = await decomposeTemplateAction(templateId);
            if (r.error) setErr(r.error);
            else {
              const d = r.derived!;
              setMsg(`블록 ${d.blocks}개·문항 ${d.questions}개 생성`);
              router.refresh();
            }
          });
        }}
        disabled={pending}
        title="이 설문 템플릿을 개념별 블록과 개별 문항 템플릿으로 분해합니다."
      >
        {pending ? "분해 중…" : "블록·문항으로 분해"}
      </Button>
      {err && <span className="mt-1 max-w-[220px] text-right text-xs text-destructive">{err}</span>}
      {msg && (
        <span className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">✓ {msg}</span>
      )}
    </div>
  );
}

/**
 * "이 템플릿을 어떻게 쓸까" 컨트롤 (재설계). 종류와 무관하게 두 가지 명확한
 * 활용 경로를 제공한다 — (1) 이 템플릿으로 새 설문 초안 만들기, (2) 기존 초안
 * 설문 끝에 문항 삽입. 강조는 종류에 맞춘다: 설문 템플릿은 "새 설문"이 먼저,
 * 블록·문항 템플릿은 "설문에 삽입"이 먼저. 기존의 종류별 단일 버튼 + 수동적인
 * "에디터에서 삽입" 안내를 대체한다.
 */
function TemplateActions({
  t,
  hasDerived,
  insertTargets,
}: {
  t: TemplateSummary;
  hasDerived: boolean;
  insertTargets: InsertTarget[];
}) {
  const isSurvey = t.kind === "survey";
  const unit = t.kind === "block" ? "블록" : t.kind === "question" ? "문항" : "설문";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
      {isSurvey ? (
        <>
          <CreateSurveyAction templateId={t.id} primary />
          <InsertAction templateId={t.id} unit={unit} targets={insertTargets} />
          {!hasDerived && <DecomposeButton templateId={t.id} />}
        </>
      ) : (
        <>
          <InsertAction templateId={t.id} unit={unit} targets={insertTargets} primary />
          <CreateSurveyAction templateId={t.id} />
        </>
      )}
    </div>
  );
}

/**
 * Seeds a NEW draft survey from a template's questions and opens it (US-010).
 * The label spells out the outcome (the old "새 설문" read ambiguously). When
 * seeding drops refs pointing outside the template, the notice is shown here
 * (with a link) INSTEAD of auto-navigating, so the loss is never silent.
 */
function CreateSurveyAction({ templateId, primary }: { templateId: string; primary?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [dropped, setDropped] = useState<{ id: string; notice: string } | null>(null);
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="xs"
        variant={primary ? "default" : "outline"}
        onClick={() => {
          setErr(null);
          setDropped(null);
          startTransition(async () => {
            const r = await createSurveyFromTemplateAction(templateId);
            if (r?.error) setErr(r.error);
            else if (r.id && r.droppedNotice) setDropped({ id: r.id, notice: r.droppedNotice });
            else if (r.id) router.push(`/surveys/${r.id}`);
          });
        }}
        disabled={pending}
        title="이 템플릿의 문항으로 새 설문 초안을 만들고 바로 엽니다."
      >
        {pending ? "생성 중…" : "새 설문 만들기"}
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
      {dropped && (
        <span className="max-w-[280px] text-xs text-amber-700 dark:text-amber-400">
          ⚠️ {dropped.notice}{" "}
          <Link href={`/surveys/${dropped.id}`} className="font-medium underline">
            새 설문 열기 →
          </Link>
        </span>
      )}
    </div>
  );
}

/**
 * Inserts a template's questions into an EXISTING draft survey (US-905/010),
 * chosen from an inline picker, then opens that survey's ① 설계 editor. Insert
 * targets are draft surveys only (page.tsx) — inserting into a live survey would
 * change its questions mid-collection. When there are none, the action guides
 * the user to create a survey first instead of dead-ending.
 */
function InsertAction({
  templateId,
  unit,
  targets,
  primary,
}: {
  templateId: string;
  unit: string;
  targets: InsertTarget[];
  primary?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [surveyId, setSurveyId] = useState(targets[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="xs"
        variant={primary ? "default" : "outline"}
        onClick={() => {
          setErr(null);
          setOpen((v) => !v);
        }}
        title={`이 ${unit}의 문항을 선택한 초안 설문 끝에 추가합니다.`}
      >
        설문에 삽입
      </Button>
      {open &&
        (targets.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            삽입할 초안 설문이 없습니다. 먼저 &ldquo;새 설문 만들기&rdquo;로 만드세요.
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={surveyId}
              onChange={(e) => setSurveyId(e.target.value)}
              className={selectCls}
              disabled={pending}
            >
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="xs"
              disabled={pending || !surveyId}
              onClick={() => {
                setErr(null);
                startTransition(async () => {
                  const r = await insertTemplateQuestionsAction(surveyId, templateId);
                  if (r.error) return setErr(r.error);
                  router.push(`/surveys/${surveyId}/edit`);
                });
              }}
            >
              {pending ? "삽입 중…" : "끝에 삽입 후 열기"}
            </Button>
          </div>
        ))}
      {err && <span className="max-w-[280px] text-xs text-destructive">{err}</span>}
    </div>
  );
}
