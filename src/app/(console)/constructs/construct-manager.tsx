"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  ConstructBackfillSummary,
  ConstructListItem,
  ConstructQuestionRef,
  ReinferSummary,
} from "@/lib/constructs";
import { questionCode } from "@/lib/question-code";
import {
  listAliasesAction,
  backfillConstructsAction,
  constructQuestionsAction,
  createConstructTemplateAction,
  mergeConstructsAction,
  reinferConstructsAction,
  removeAliasAction,
  renameConstructAction,
} from "./actions";
import { ConstructResultsPanel } from "./construct-results";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Vocabulary curation UI (US-008): per-row rename (inline) and merge with an
 * explicit confirm step (merge is destructive — the source row is deleted).
 * Server actions revalidate /constructs, so the list refreshes on success.
 */
export function ConstructManager({ items }: { items: ConstructListItem[] }) {
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <BackfillButton onDone={setMessage} />
      <ReinferButton onDone={setMessage} />
      {message && (
        <p aria-live="polite" className="rounded-md bg-muted/50 px-3 py-2 text-sm text-foreground">
          {message}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          아직 사전에 등록된 construct가 없습니다. 설문을 생성하거나 위의 정규화를 실행하면
          자동으로 채워집니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <ConstructRow key={item.id} item={item} all={items} onResult={setMessage} />
          ))}
        </ul>
      )}
    </div>
  );
}

const HOW_LABEL: Record<string, string> = {
  created: "신설",
  embedding: "기존 매핑 (의미 유사)",
  exact: "기존 매핑 (표기 일치)",
};

/** One-shot legacy meta canonicalization (US-007 backfill, wired here). */
function BackfillButton({ onDone }: { onDone: (msg: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [report, setReport] = useState<ConstructBackfillSummary | null>(null);
  const groups = report
    ? (["created", "embedding", "exact"] as const)
        .map((how) => ({ how, rows: report.mappings.filter((m) => m.how === how) }))
        .filter((g) => g.rows.length > 0)
    : [];
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">기존 문항 정규화</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            사전에 연결되지 않은 자유 텍스트 construct를 일괄 canonical화합니다.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() =>
            startTransition(async () => {
              const s = await backfillConstructsAction();
              setReport(s);
              onDone(
                `정규화 완료 — 대상 ${s.scanned}건 중 ${s.updated}건 갱신` +
                  (s.failed > 0 ? `, ${s.failed}건 실패` : ""),
              );
            })
          }
          disabled={pending}
        >
          {pending ? "정규화 중…" : "정규화 실행"}
        </Button>
      </div>
      {report && report.mappings.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          {groups.map((g) => (
            <div key={g.how}>
              <p className="text-xs font-medium text-muted-foreground">
                {HOW_LABEL[g.how]} ({g.rows.length})
              </p>
              <ul className="mt-0.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
                {g.rows.map((m, i) => (
                  <li key={`${m.quid}${i}`} className="truncate">
                    <span className="font-mono text-[10px] text-muted-foreground/70">{questionCode(m.quid)}</span>{" "}
                    &ldquo;{m.prompt.length > 30 ? `${m.prompt.slice(0, 30)}…` : m.prompt}&rdquo;{" "}
                    {m.from === m.to ? (
                      <span className="text-muted-foreground">→ &ldquo;{m.to}&rdquo;</span>
                    ) : (
                      <span className="text-muted-foreground">
                        &ldquo;{m.from}&rdquo; → &ldquo;{m.to}&rdquo;
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {report.updated > report.mappings.length && (
            <p className="text-[11px] text-muted-foreground/70">
              … 외 {report.updated - report.mappings.length}건 (표시 상한 초과)
            </p>
          )}
          <p className="text-[11px] text-muted-foreground/70">
            의도와 다르게 묶인 항목이 있으면 아래 목록에서 해당 construct를 펼쳐 문항을 확인하고
            이름 변경·병합으로 바로잡으세요.
          </p>
        </div>
      )}
      {report && report.scanned > 0 && report.mappings.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground/70">갱신된 문항이 없습니다.</p>
      )}
    </div>
  );
}

/**
 * Construct re-review: re-run inference (improved prompt) over the workspace's
 * empty/AI-origin question meta. Overwrites AI-assigned constructs, so it takes
 * an explicit confirm; human meta is protected and existing topics are kept.
 * Shows a before→after report of the constructs that changed.
 */
function ReinferButton({ onDone }: { onDone: (msg: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [report, setReport] = useState<ReinferSummary | null>(null);
  const changed = report ? report.mappings.filter((m) => m.changed) : [];
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">AI construct 재추론 (개선된 프롬프트)</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            AI가 붙인 construct를 개선된 프롬프트로 다시 추론해 바로잡습니다. 추론한 이름을 그대로
            저장하고(유사 사전 항목으로 강제 흡수하지 않음), 직접 입력한 meta·기존 topic은 보존합니다.
            새 개념이 늘 수 있으니 필요하면 아래 목록에서 병합하세요. 문항당 한 번씩 호출해 시간이 걸립니다.
          </p>
        </div>
        {!confirming ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setConfirming(true)}
            disabled={pending}
          >
            재추론…
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                startTransition(async () => {
                  const s = await reinferConstructsAction();
                  setReport(s);
                  setConfirming(false);
                  onDone(
                    `재추론 완료 — 대상 ${s.scanned}건 중 변경 ${s.updated}건, 유지 ${s.unchanged}건` +
                      (s.failed > 0 ? `, 실패 ${s.failed}건` : "") +
                      ` (보호됨 ${s.skipped}건)`,
                  );
                })
              }
              disabled={pending}
            >
              {pending ? "재추론 중…" : "실행"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={pending}>
              취소
            </Button>
          </div>
        )}
      </div>
      {report && changed.length > 0 && (
        <div className="mt-3 flex flex-col gap-1 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">변경된 construct ({changed.length})</p>
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {changed.map((m, i) => (
              <li key={`${m.quid}${i}`} className="truncate">
                <span className="font-mono text-[10px] text-muted-foreground/70">{questionCode(m.quid)}</span>{" "}
                &ldquo;{m.prompt.length > 26 ? `${m.prompt.slice(0, 26)}…` : m.prompt}&rdquo;{" "}
                <span className="text-muted-foreground">
                  &ldquo;{m.from || "(없음)"}&rdquo; → &ldquo;{m.to}&rdquo;
                </span>
              </li>
            ))}
          </ul>
          {report.updated > changed.length && (
            <p className="text-[11px] text-muted-foreground/70">
              … 외 {report.updated - changed.length}건 (표시 상한 초과)
            </p>
          )}
          <p className="text-[11px] text-muted-foreground/70">
            이미 저장된 설문 템플릿 스냅샷은 그대로입니다 — 필요하면 해당 설문에서 다시 저장하세요.
          </p>
        </div>
      )}
      {report && report.scanned > 0 && changed.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground/70">변경된 construct가 없습니다.</p>
      )}
    </div>
  );
}

/**
 * Lazy-loaded member questions of one construct (evidence for curation).
 * Each question is checkbox-selectable so a hand-picked subset can be saved
 * as a question-bank template for this concept (US-004).
 */
function ConstructQuestions({ constructId }: { constructId: string }) {
  const [rows, setRows] = useState<ConstructQuestionRef[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tplName, setTplName] = useState("");
  const [naming, setNaming] = useState(false);
  const [done, setDone] = useState<{ name: string; construct: string; notice?: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    let alive = true;
    constructQuestionsAction(constructId).then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, [constructId]);
  if (rows === null) return <p className="mt-2 text-xs text-muted-foreground/70">문항 불러오는 중…</p>;
  if (rows.length === 0)
    return <p className="mt-2 text-xs text-muted-foreground/70">이 construct를 참조하는 문항이 없습니다.</p>;
  const bySurvey = new Map<string, ConstructQuestionRef[]>();
  for (const r of rows) {
    const arr = bySurvey.get(r.surveyId) ?? [];
    arr.push(r);
    bySurvey.set(r.surveyId, arr);
  }
  const toggle = (questionId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  const create = () =>
    startTransition(async () => {
      setError(null);
      const r = await createConstructTemplateAction(constructId, [...selected], tplName);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone({ name: tplName.trim(), construct: r.construct, notice: r.droppedNotice });
      setSelected(new Set());
      setTplName("");
      setNaming(false);
    });
  return (
    <div className="mt-2 flex flex-col gap-2 border-t pt-2">
      {[...bySurvey.values()].map((qs) => (
        <div key={qs[0].surveyId}>
          <Link
            href={`/surveys/${qs[0].surveyId}/edit`}
            className="text-xs font-medium text-muted-foreground hover:underline"
          >
            {qs[0].surveyTitle} ↗
          </Link>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {qs.map((q) => (
              <li key={q.questionId} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={selected.has(q.questionId)}
                  onChange={() => toggle(q.questionId)}
                  className="mt-0.5 shrink-0"
                  aria-label={`문항 선택: ${q.prompt}`}
                />
                <span className="min-w-0 truncate">
                  <span className="font-mono text-[10px] text-muted-foreground/70">{questionCode(q.quid)}</span>{" "}
                  {q.prompt}
                  {q.origin && (
                    <span
                      className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                        q.origin === "human"
                          ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {q.origin === "human" ? "직접 입력" : "AI 추정"}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 border-t pt-2">
        {!naming ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              setDone(null);
              setNaming(true);
            }}
            disabled={selected.size === 0}
            title="체크한 문항들을 이 개념의 재사용 문항 뱅크(템플릿)로 저장합니다"
          >
            선택 문항으로 템플릿 만들기 ({selected.size})
          </Button>
        ) : (
          <>
            <Input
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
              className="min-w-[200px] flex-1"
              placeholder="템플릿 이름"
              autoFocus
            />
            <Button
              type="button"
              size="xs"
              onClick={create}
              disabled={pending || !tplName.trim() || selected.size === 0}
            >
              {pending ? "저장 중…" : `문항 ${selected.size}개 저장`}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setNaming(false);
                setError(null);
              }}
              disabled={pending}
            >
              취소
            </Button>
          </>
        )}
        {done && (
          <p className="w-full text-xs text-emerald-600 dark:text-emerald-400">
            템플릿 &ldquo;{done.name}&rdquo; 생성됨 —{" "}
            <Link
              href={`/templates?construct=${encodeURIComponent(done.construct)}`}
              className="font-medium underline"
            >
              템플릿 라이브러리에서 보기 ↗
            </Link>
            {done.notice && <span className="block text-amber-700 dark:text-amber-400">⚠️ {done.notice}</span>}
          </p>
        )}
        {error && <p className="w-full text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Alias panel (construct re-review): lists the spellings absorbed into this
 * construct so a mis-absorbed one is visible and removable. Removing an alias
 * only stops FUTURE questions from resolving here — it can't move
 * already-classified questions (their original spelling isn't stored), which
 * the note states.
 */
function AliasPanel({
  constructId,
  canonical,
  onResult,
}: {
  constructId: string;
  canonical: string;
  onResult: (msg: string) => void;
}) {
  const router = useRouter();
  const [aliases, setAliases] = useState<string[] | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listAliasesAction(constructId).then((r) => {
      if (alive) setAliases(r.aliases);
    });
    return () => {
      alive = false;
    };
  }, [constructId]);

  if (aliases === null) return <p className="mt-2 text-xs text-muted-foreground/70">별칭 불러오는 중…</p>;
  if (aliases.length === 0)
    return <p className="mt-2 text-xs text-muted-foreground/70">이 개념에는 별칭이 없습니다.</p>;

  const remove = (alias: string) =>
    startTransition(async () => {
      setBusy(alias);
      const r = await removeAliasAction(constructId, alias);
      setBusy(null);
      if (!r.ok) {
        onResult(r.error);
        return;
      }
      setAliases((prev) => (prev ? prev.filter((a) => a !== alias) : prev));
      onResult(`별칭 "${alias}" 제거 — 향후 이 표기는 다시 분류됩니다.`);
      router.refresh();
    });

  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
      <p className="text-xs font-medium text-muted-foreground">
        &ldquo;{canonical}&rdquo;에 흡수된 표기
      </p>
      <ul className="flex flex-col gap-1">
        {aliases.map((alias) => (
          <li key={alias} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{alias}</span>
            <button
              type="button"
              onClick={() => remove(alias)}
              disabled={pending}
              className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/50 disabled:opacity-50"
              title="이 별칭을 제거합니다. 향후 같은 표기는 이 개념으로 자동 매핑되지 않습니다."
            >
              {busy === alias ? "제거 중…" : "제거"}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground/70">
        별칭 제거는 <strong>향후 자동 매핑만</strong> 막습니다 — 이미 이 개념으로 분류된 문항은 원 표기가
        저장되지 않아 자동으로 옮길 수 없으니, 필요하면 에디터에서 해당 문항의 construct를 직접 수정하세요.
      </p>
    </div>
  );
}

function ConstructRow({
  item,
  all,
  onResult,
}: {
  item: ConstructListItem;
  all: ConstructListItem[];
  onResult: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "merge">("view");
  const [newName, setNewName] = useState(item.name);
  const [targetId, setTargetId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const others = all.filter((c) => c.id !== item.id);
  const target = others.find((c) => c.id === targetId);

  const reset = (m: "view" | "rename" | "merge" = "view") => {
    setMode(m);
    setNewName(item.name);
    setTargetId("");
    setConfirming(false);
    setError(null);
  };

  const runRename = () =>
    startTransition(async () => {
      const r = await renameConstructAction(item.id, newName);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onResult(`"${item.name}" → "${newName.trim()}" 이름 변경 — 문항 ${r.updatedQuestions}개 갱신`);
      reset();
    });

  const runMerge = () =>
    startTransition(async () => {
      if (!target) return;
      const r = await mergeConstructsAction(item.id, target.id);
      if (!r.ok) {
        setError(r.error);
        setConfirming(false);
        return;
      }
      onResult(`"${item.name}" → "${target.name}" 병합 — 문항 ${r.updatedQuestions}개 재지정`);
      reset();
    });

  return (
    <li className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">{item.name}</h3>
          {item.aliases.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {item.aliases.map((a) => (
                <span key={a} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {a}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50"
            title="이 개념을 구성하는 문항 보기"
          >
            문항 {item.usageCount}개 {expanded ? "▴" : "▾"}
          </button>
          {item.aliases.length > 0 && (
            <button
              onClick={() => setAliasOpen((v) => !v)}
              className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50"
              title="별칭이 이 개념에 얼마나 잘 맞는지(의미 유사도) 확인하고 오흡수를 정리"
            >
              별칭 근거 {item.aliases.length} {aliasOpen ? "▴" : "▾"}
            </button>
          )}
          <button
            onClick={() => setResultsOpen((v) => !v)}
            className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50"
            title="이 개념의 설문 간 통합 결과 보기 (실제 응답 기준)"
          >
            결과 보기 {resultsOpen ? "▴" : "▾"}
          </button>
          <Link
            href={`/templates?construct=${encodeURIComponent(item.name)}`}
            className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50"
            title="템플릿 라이브러리에서 이 개념을 측정하는 기존 템플릿을 필터해 보여줍니다 (저장 아님)"
          >
            템플릿 찾기 ↗
          </Link>
          {mode === "view" && (
            <>
              <Button type="button" variant="outline" size="xs" onClick={() => reset("rename")}>
                이름 변경
              </Button>
              {others.length > 0 && (
                <Button type="button" variant="outline" size="xs" onClick={() => reset("merge")}>
                  병합
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {aliasOpen && (
        <AliasPanel constructId={item.id} canonical={item.name} onResult={onResult} />
      )}
      {expanded && <ConstructQuestions constructId={item.id} />}
      {resultsOpen && <ConstructResultsPanel constructId={item.id} />}

      {mode === "rename" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="min-w-[200px] flex-1"
            placeholder="새 canonical 이름"
            autoFocus
          />
          <Button
            type="button"
            size="xs"
            onClick={runRename}
            disabled={pending || !newName.trim() || newName.trim() === item.name}
          >
            {pending ? "변경 중…" : "저장"}
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={() => reset()} disabled={pending}>
            취소
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            기존 이름은 별칭으로 남고, 이 construct를 쓰는 문항 {item.usageCount}개의 표기도
            함께 바뀝니다.
          </p>
        </div>
      )}

      {mode === "merge" && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setConfirming(false);
              }}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="">병합 대상 선택…</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (문항 {c.usageCount}개)
                </option>
              ))}
            </select>
            {!confirming && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setConfirming(true)}
                disabled={!target}
              >
                병합…
              </Button>
            )}
            <Button type="button" variant="outline" size="xs" onClick={() => reset()} disabled={pending}>
              취소
            </Button>
          </div>
          {confirming && target && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              <p>
                <strong>&ldquo;{item.name}&rdquo;</strong>을(를){" "}
                <strong>&ldquo;{target.name}&rdquo;</strong>(으)로 병합합니다. 이름·별칭은{" "}
                {target.name}의 별칭이 되고, 문항 {item.usageCount}개가 재지정되며, 이 행은
                삭제됩니다. 되돌릴 수 없습니다.
              </p>
              <Button
                type="button"
                variant="destructive"
                size="xs"
                onClick={runMerge}
                disabled={pending}
                className="mt-2"
              >
                {pending ? "병합 중…" : "병합 실행"}
              </Button>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </li>
  );
}
