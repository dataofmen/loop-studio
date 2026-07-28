"use client";

import { callAction } from "@/lib/call-action";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  proposeRevisionAction,
  applyRevisionAction,
  compareRevisionsAction,
  nameRevisionAction,
  rejectProposalAction,
  reopenProposalAction,
  revertRevisionAction,
  saveNamedVersionAction,
  type CompareState,
  type ProposalState,
} from "./revision-actions";
import type { ChangeSummary, ProposalListItem, QuestionChangeDetail, RevisionRow } from "@/lib/revisions";
import { diffQuestionsDetailed, mergeProposal } from "@/lib/question-diff";
import type { FieldKey, OptionChange, ProposalAcceptance, RevisionQuestion } from "@/lib/question-diff";
import { fieldChangeView, questionSummaryLines, type PromptOf } from "@/lib/compare-text";
import { questionCode } from "@/lib/question-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Native <select> styled to match the shadcn Input aesthetic. */
const selectCls =
  "rounded-md border border-input bg-transparent text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const STATUS_STYLE: Record<QuestionChangeDetail["status"], { label: string; tone: string }> = {
  added: { label: "추가됨", tone: "border-emerald-200 bg-emerald-50 dark:border-emerald-400/30 dark:bg-emerald-950/40" },
  deleted: { label: "삭제됨", tone: "border-destructive/30 bg-destructive/5 line-through opacity-70" },
  changed: { label: "수정됨", tone: "border-amber-200 bg-amber-50 dark:border-amber-400/30 dark:bg-amber-950/40" },
  reordered: { label: "순서 변경", tone: "border-blue-200 bg-blue-50 dark:border-blue-400/30 dark:bg-blue-950/40" },
  unchanged: { label: "변경 없음", tone: "border-border bg-card" },
};

/** One option-level change as plain Korean text. */
function optionChangeText(c: OptionChange): string {
  switch (c.kind) {
    case "added":
      return `보기 추가: "${c.label}"`;
    case "deleted":
      return `보기 삭제: "${c.label}"`;
    case "renamed":
      return `보기 수정: "${c.from}" → "${c.to}"`;
    case "reordered":
      return `보기 순서: "${c.label}" (${c.from} → ${c.to})`;
  }
}

// ── Proposal change lines (author-visible; meta is internal and hidden) ─────

type ProposalLine =
  | { key: FieldKey; kind: "field"; view: { label: string; from: string; to: string } }
  | { key: "options"; kind: "options"; changes: OptionChange[] }
  | { key: "displayLogic"; kind: "showIf"; text: string }
  | { key: "optionsFrom"; kind: "carry"; text: string };

const SHOWIF_OP: Record<string, string> = { eq: "=", ne: "≠", gte: "≥", lte: "≤", gt: ">", lt: "<", contains: "포함" };

/** Ref-form proposal logic as a sentence (refs resolve inside the proposal). */
function showIfText(
  showIf: NonNullable<RevisionQuestion["showIf"]>,
  proposed: RevisionQuestion[],
): string {
  const parts = showIf.conditions.map((c) => {
    const t = proposed[c.ref - 1]?.prompt ?? "이전 문항";
    const name = `「${t.length > 20 ? `${t.slice(0, 20)}…` : t}」`;
    const val = Array.isArray(c.value) ? c.value.join(", ") : String(c.value);
    if (c.op === "in") return `${name}이(가) [${val}] 중 하나`;
    if (c.op === "not_in") return `${name}이(가) [${val}] 이외`;
    return `${name} ${SHOWIF_OP[c.op] ?? c.op} ${val}`;
  });
  return `${parts.join(showIf.match === "any" ? " 또는 " : " 그리고 ")}일 때 표시`;
}

/**
 * The selectable change lines of one changed question. Meta changes are
 * filtered out — the author curates questions/options/logic, not AI-managed
 * metadata (it rides along in the merge, human meta protected).
 */
function proposalLines(
  det: QuestionChangeDetail,
  q: RevisionQuestion,
  proposed: RevisionQuestion[],
  promptOf: PromptOf,
): ProposalLine[] {
  const lines: ProposalLine[] = [];
  for (const f of det.fieldChanges) {
    if (f.field === "meta") continue;
    const view = fieldChangeView(f, promptOf);
    if (f.field === "optionsFrom" && f.to === undefined) {
      const srcRef = q.optionsFromRef?.ref;
      const src = srcRef ? proposed[srcRef - 1]?.prompt : undefined;
      view.to = src
        ? `「${src.length > 20 ? `${src.slice(0, 20)}…` : src}」에서 선택한 항목만`
        : "유지됨 (제안이 변경하지 않음 — 적용 시 현재 설정 유지)";
    }
    if (f.field === "displayLogic" && f.to === undefined) {
      // The proposal's logic lives in ref-form showIf (unresolvable pre-apply
      // when it cites a NEW question) — or the model didn't mention it at all,
      // in which case apply PRESERVES the current condition. Never say "없음".
      view.to = q.showIf
        ? showIfText(q.showIf, proposed)
        : "유지됨 (제안이 변경하지 않음 — 적용 시 현재 조건 유지)";
    }
    lines.push({ key: f.field as FieldKey, kind: "field", view });
  }
  if (det.optionChanges.length) lines.push({ key: "options", kind: "options", changes: det.optionChanges });
  if (q.showIf && !lines.some((l) => l.key === "displayLogic"))
    lines.push({ key: "displayLogic", kind: "showIf", text: showIfText(q.showIf, proposed) });
  if (q.optionsFromRef && !lines.some((l) => l.key === "optionsFrom")) {
    const src = proposed[q.optionsFromRef.ref - 1]?.prompt ?? "이전 문항";
    lines.push({
      key: "optionsFrom",
      kind: "carry",
      text: `「${src.length > 20 ? `${src.slice(0, 20)}…` : src}」에서 선택한 항목만 보기로 표시`,
    });
  }
  return lines;
}

/** Body of one change line (checkbox is rendered by the caller). */
function LineBody({ line }: { line: ProposalLine }) {
  if (line.kind === "options")
    return (
      <div className="min-w-0 flex-1">
        <span className="font-medium text-muted-foreground">보기 변경</span>
        <ul className="mt-0.5 flex flex-col gap-0.5">
          {line.changes.map((o, i) => (
            <li key={i}>· {optionChangeText(o)}</li>
          ))}
        </ul>
      </div>
    );
  if (line.kind === "showIf")
    return (
      <div className="min-w-0 flex-1">
        <span className="font-medium text-muted-foreground">표시 조건</span>{" "}
        <span className="text-muted-foreground">{line.text}</span>
      </div>
    );
  if (line.kind === "carry")
    return (
      <div className="min-w-0 flex-1">
        <span className="font-medium text-muted-foreground">보기 가져오기</span>{" "}
        <span className="text-muted-foreground">{line.text}</span>
      </div>
    );
  const v = line.view;
  if (v.label === "문항 내용")
    return (
      <div className="min-w-0 flex-1">
        <span className="font-medium text-muted-foreground">{v.label}</span>
        <span className="mt-0.5 block rounded bg-destructive/10 px-1.5 py-0.5 text-destructive line-through">{v.from}</span>
        <span className="mt-0.5 block rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">{v.to}</span>
      </div>
    );
  return (
    <div className="min-w-0 flex-1">
      <span className="font-medium text-muted-foreground">{v.label}</span>{" "}
      <span className="text-destructive line-through decoration-destructive/40">{v.from}</span>
      <span className="mx-1 text-muted-foreground/70">→</span>
      <span className="text-emerald-700 dark:text-emerald-400">{v.to}</span>
    </div>
  );
}

/** One field change as label + before/after (prompt gets stacked 전/후 lines). */
function FieldChangeRow({ view }: { view: { label: string; from: string; to: string } }) {
  if (view.label === "문항 내용") {
    return (
      <li>
        <span className="font-medium text-muted-foreground">{view.label}</span>
        <span className="mt-0.5 block rounded bg-destructive/10 px-1.5 py-0.5 text-destructive line-through">
          {view.from}
        </span>
        <span className="mt-0.5 block rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {view.to}
        </span>
      </li>
    );
  }
  return (
    <li>
      <span className="font-medium text-muted-foreground">{view.label}</span>{" "}
      <span className="text-destructive line-through decoration-destructive/40">{view.from}</span>
      <span className="mx-1 text-muted-foreground/70">→</span>
      <span className="text-emerald-700 dark:text-emerald-400">{view.to}</span>
    </li>
  );
}

/** Full content lines of an added/deleted question. */
function QuestionContent({ q, promptOf }: { q: RevisionQuestion | undefined; promptOf: PromptOf }) {
  if (!q) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5 pl-2 text-[11px] text-muted-foreground">
      {questionSummaryLines(q, promptOf).map((line, i) => (
        <li key={i}>· {line}</li>
      ))}
    </ul>
  );
}

/** Plain-Korean detailed diff between two picked versions. */
function VersionCompareResult({ result }: { result: CompareState }) {
  if (result.error) return <p className="mt-2 text-sm text-destructive">{result.error}</p>;
  if (!result.details) return null;
  const changed = result.details.filter((d) => d.status !== "unchanged");
  const promptOf: PromptOf = (id) => result.questionPrompts?.[id];
  const toByQuid = new Map((result.toSnapshot ?? []).map((q) => [q.quid, q]));
  const fromByQuid = new Map((result.fromSnapshot ?? []).map((q) => [q.quid, q]));
  return (
    <div className="mt-2 rounded-lg border bg-muted/50 p-3 text-xs">
      <p className="mb-2 font-medium text-muted-foreground">
        v{result.from} → v{result.to} 변경 내역
        {changed.length === 0 && " — 변경 없음"}
      </p>
      <ol className="flex flex-col gap-1.5">
        {changed.map((d) => {
          const s = STATUS_STYLE[d.status];
          return (
            <li key={d.quid} className={`rounded border p-1.5 ${s.tone}`}>
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  {d.quid && <span className="mr-1 font-mono text-[10px] text-muted-foreground/70">{questionCode(d.quid)}</span>}
                  {d.prompt}
                </span>
                <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                  {s.label}
                  {d.status === "reordered" && ` (${d.fromOrder} → ${d.toOrder})`}
                </span>
              </span>
              {d.status === "added" && <QuestionContent q={toByQuid.get(d.quid)} promptOf={promptOf} />}
              {d.status === "deleted" && <QuestionContent q={fromByQuid.get(d.quid)} promptOf={promptOf} />}
              {(d.fieldChanges.length > 0 || d.optionChanges.length > 0) && (
                <ul className="mt-1 flex flex-col gap-1 pl-2 text-[11px] text-muted-foreground">
                  {d.fieldChanges.map((f, i) => (
                    <FieldChangeRow key={`f${i}`} view={fieldChangeView(f, promptOf)} />
                  ))}
                  {d.optionChanges.map((o, i) => (
                    <li key={`o${i}`}>· {optionChangeText(o)}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Per-version change counts (added/deleted/changed/reordered) as colored pills. */
function ChangeSummaryBadges({ summary }: { summary: ChangeSummary | null }) {
  if (!summary) return null; // baseline version — nothing earlier to compare
  const total = summary.added + summary.deleted + summary.changed + summary.reordered;
  return (
    <span className="mt-1 flex flex-wrap gap-1 text-[10px]">
      {summary.added > 0 && (
        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">추가 {summary.added}</span>
      )}
      {summary.deleted > 0 && (
        <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-destructive">삭제 {summary.deleted}</span>
      )}
      {summary.changed > 0 && (
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-950 dark:text-amber-300">수정 {summary.changed}</span>
      )}
      {summary.reordered > 0 && (
        <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-950 dark:text-blue-300">순서변경 {summary.reordered}</span>
      )}
      {total === 0 && <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">변경 없음</span>}
    </span>
  );
}

const PROPOSAL_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "대기", tone: "bg-muted text-muted-foreground" },
  applied: { label: "적용됨", tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  partial: { label: "부분 적용", tone: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  rejected: { label: "거부됨", tone: "bg-destructive/10 text-destructive" },
};

export function RevisionPanel({
  surveyId,
  initialRevisions,
  initialFeedback,
  initialProposals = [],
}: {
  surveyId: string;
  initialRevisions: RevisionRow[];
  /** Prefill from the pre-publish review's "수정 제안으로 보내기" deep link (US-008). */
  initialFeedback?: string;
  /** Persisted proposals ("지난 제안") — reopenable, nothing is lost. */
  initialProposals?: ProposalListItem[];
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState(initialFeedback ?? "");
  // Arrived via the pre-publish review's "수정 제안으로 보내기" deep link:
  // scroll the panel into view and flag where the issue landed — without this
  // the navigation looks like a no-op (the panel sits below the fold).
  const fromReview = Boolean(initialFeedback);
  const sectionRef = useRef<HTMLElement | null>(null);
  const autoProposed = useRef(false);
  useEffect(() => {
    if (!fromReview) return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Kick off the AI proposal immediately — the review issues ARE the
    // feedback, so making the user re-read and press the button again was a
    // dead step. The apply/reject gate (before/after diff) stays.
    if (!autoProposed.current && initialFeedback) {
      autoProposed.current = true;
      startTransition(async () => {
        const r = await callAction(() => proposeRevisionAction(surveyId, initialFeedback));
        setProposal(r);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromReview]);
  const [proposal, setProposal] = useState<ProposalState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Named checkpoints (user-pinned versions) vs auto "직접 수정" versions.
  const [checkpointName, setCheckpointName] = useState("");
  const [showAutos, setShowAutos] = useState(false);
  const [nameEditing, setNameEditing] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  // Version comparison (US-006): default to older→newer of the two latest.
  const [cmpFrom, setCmpFrom] = useState<number>(initialRevisions[1]?.version ?? initialRevisions[0]?.version ?? 0);
  const [cmpTo, setCmpTo] = useState<number>(initialRevisions[0]?.version ?? 0);
  const [compare, setCompare] = useState<CompareState | null>(null);
  // Per-question / per-field acceptance for partial apply. Default: everything.
  const [sel, setSel] = useState<ProposalAcceptance>({});
  const detailed = useMemo(
    () =>
      proposal?.current && proposal?.proposed
        ? diffQuestionsDetailed(proposal.current, proposal.proposed)
        : [],
    [proposal],
  );
  const detailByQuid = useMemo(() => new Map(detailed.map((d) => [d.quid, d])), [detailed]);
  const noPromptOf: PromptOf = (id) => proposal?.questionPrompts?.[id];
  // Author-visible change lines per changed question (meta-only edits vanish).
  const linesByQuid = useMemo(() => {
    const map = new Map<string, ProposalLine[]>();
    if (!proposal?.proposed) return map;
    for (const q of proposal.proposed) {
      const det = detailByQuid.get(q.quid);
      if (det?.status !== "changed") continue;
      map.set(q.quid, proposalLines(det, q, proposal.proposed, noPromptOf));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, detailByQuid]);
  // Type changes re-shape the question — those stay whole-question toggles.
  const typeChangedQuids = useMemo(
    () =>
      new Set(
        detailed
          .filter((d) => d.fieldChanges.some((f) => f.field === "type"))
          .map((d) => d.quid),
      ),
    [detailed],
  );
  const changeQuids = useMemo(
    () =>
      detailed
        .filter(
          (d) =>
            d.status === "added" ||
            d.status === "deleted" ||
            (d.status === "changed" && (linesByQuid.get(d.quid)?.length ?? 0) > 0),
        )
        .map((d) => d.quid),
    [detailed, linesByQuid],
  );
  useEffect(() => {
    const next: ProposalAcceptance = {};
    for (const d of detailed) {
      if (d.status === "added" || d.status === "deleted") next[d.quid] = true;
      else if (d.status === "changed") {
        const lines = linesByQuid.get(d.quid) ?? [];
        if (!lines.length) continue; // meta-only — invisible, rides along
        next[d.quid] = typeChangedQuids.has(d.quid) ? true : lines.map((l) => l.key);
      }
    }
    setSel(next);
  }, [detailed, linesByQuid, typeChangedQuids]);
  const lineSelected = (quid: string, key: FieldKey) => {
    const a = sel[quid];
    return a === true || (Array.isArray(a) && a.includes(key));
  };
  const questionAccepted = (quid: string) => {
    const a = sel[quid];
    return a === true || (Array.isArray(a) && a.length > 0);
  };
  const toggleWhole = (quid: string) =>
    setSel((p) => ({ ...p, [quid]: p[quid] === true ? false : true }));
  const toggleLine = (quid: string, key: FieldKey, allKeys: FieldKey[]) =>
    setSel((p) => {
      const a = p[quid];
      const arr = a === true ? [...allKeys] : Array.isArray(a) ? [...a] : [];
      const next = arr.includes(key) ? arr.filter((k) => k !== key) : [...arr, key];
      return { ...p, [quid]: next };
    });
  // Line-level totals drive the apply button label / partial detection.
  const totals = useMemo(() => {
    let total = 0;
    let selected = 0;
    for (const d of detailed) {
      if (!changeQuids.includes(d.quid)) continue;
      if (d.status === "changed" && !typeChangedQuids.has(d.quid)) {
        const lines = linesByQuid.get(d.quid) ?? [];
        total += lines.length;
        for (const l of lines) if (lineSelected(d.quid, l.key)) selected += 1;
      } else {
        total += 1;
        if (sel[d.quid] === true) selected += 1;
      }
    }
    return { total, selected };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailed, changeQuids, linesByQuid, typeChangedQuids, sel]);

  function onCompare() {
    setCompare(null);
    startTransition(async () => {
      const r = await callAction(() => compareRevisionsAction(surveyId, cmpFrom, cmpTo));
      setCompare(r);
    });
  }

  function onPropose() {
    setMsg(null);
    startTransition(async () => {
      const r = await callAction(() => proposeRevisionAction(surveyId, feedback));
      setProposal(r);
    });
  }

  function onApply() {
    if (!proposal?.proposed || !proposal.current) return;
    if (totals.total > 0 && totals.selected === 0) {
      setMsg("적용할 변경을 하나 이상 선택해 주세요.");
      return;
    }
    const partial = totals.selected < totals.total;
    // Always merge (never raw proposal): the merge is where human-entered
    // metadata is protected from being overwritten by the AI's echo.
    const finalSet = mergeProposal(proposal.current, proposal.proposed, sel);
    const decisions = Object.fromEntries(
      changeQuids.map((q) => [q, questionAccepted(q) ? ("applied" as const) : ("skipped" as const)]),
    );
    startTransition(async () => {
      const r = await callAction(() => applyRevisionAction(surveyId, finalSet, proposal.feedback ?? feedback, {
        proposalId: proposal.proposalId,
        decisions,
        partial,
      }));
      if (r.error) setMsg(`적용 실패: ${r.error}`);
      else {
        setMsg(
          partial
            ? `v${r.version}로 변경 ${totals.selected}/${totals.total}건 적용 ✓ — 미적용 항목은 '지난 제안'에서 다시 열 수 있습니다`
            : `v${r.version}로 적용되었습니다 ✓`,
        );
        setProposal(null);
        setFeedback("");
        router.refresh();
      }
    });
  }

  function onReject() {
    const pid = proposal?.proposalId;
    setProposal(null);
    if (!pid) return;
    startTransition(async () => {
      const r = await callAction(() => rejectProposalAction(surveyId, pid));
      if (!r.error) {
        setMsg("제안을 거부했습니다 — '지난 제안'에서 언제든 다시 열 수 있습니다.");
        router.refresh();
      }
    });
  }

  function onReopen(proposalId: string) {
    setMsg(null);
    startTransition(async () => {
      const r = await callAction(() => reopenProposalAction(surveyId, proposalId));
      if (r.error) setMsg(`다시 열기 실패: ${r.error}`);
      else {
        setProposal(r);
        sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  function onRevert(v: number) {
    startTransition(async () => {
      const r = await callAction(() => revertRevisionAction(surveyId, v));
      setMsg(r.error ? `되돌리기 실패: ${r.error}` : `v${v} 내용으로 되돌렸습니다 (v${r.version}) ✓`);
      if (!r.error) router.refresh();
    });
  }

  function onSaveCheckpoint() {
    startTransition(async () => {
      const r = await callAction(() => saveNamedVersionAction(surveyId, checkpointName));
      if (r.error) setMsg(`버전 저장 실패: ${r.error}`);
      else {
        setMsg(`"${checkpointName.trim()}" 버전(v${r.version})으로 저장되었습니다 ✓`);
        setCheckpointName("");
        router.refresh();
      }
    });
  }

  function onSaveName(version: number) {
    startTransition(async () => {
      const r = await callAction(() => nameRevisionAction(surveyId, version, nameDraft.trim() || null));
      if (r.error) setMsg(`이름 저장 실패: ${r.error}`);
      else {
        setNameEditing(null);
        setNameDraft("");
        router.refresh();
      }
    });
  }

  return (
    <section
      ref={sectionRef}
      className={`rounded-xl border bg-card p-4 text-card-foreground shadow-sm ${fromReview ? "ring-2 ring-primary/40" : ""}`}
    >
      <h2 className="mb-1 text-lg font-semibold">AI 수정 제안 &amp; 버전</h2>
      {fromReview && (
        <p className="mb-2 rounded-lg border border-primary/30 bg-primary/5 p-2 text-xs text-primary">
          AI 검토에서 넘어온 이슈로 수정안을 생성하고 있습니다 — 잠시 후 전/후 비교가
          나타나면 검토 후 적용하세요. 검토 결과는 개요 탭에 그대로 남아 있습니다.
        </p>
      )}
      <p className="mb-3 text-xs text-muted-foreground">
        AI 결과(문항)에 피드백을 주면 AI가 수정안을 제안합니다. 검토 후 적용하면 버전으로 기록됩니다.
        문항 추가·삭제·보기 변경 등 직접 수정한 내용도 자동으로 버전에 남고, 중요한 시점은 이름을 붙여 고정할 수 있습니다.
      </p>

      <div className="flex flex-col gap-2">
        <Textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
          placeholder="예: 5번 문항이 해지를 전제하는 유도질문이에요. 중립적으로 바꿔주세요."
          className="min-h-0 px-3 py-2"
        />
        <Button
          type="button"
          variant="outline"
          onClick={onPropose}
          disabled={pending || feedback.trim().length < 3}
          className="self-start"
        >
          {pending && !proposal ? "AI 제안 생성 중…" : "AI 수정 제안 받기"}
        </Button>
      </div>

      {proposal?.error && <p className="mt-2 text-sm text-destructive">{proposal.error}</p>}

      {proposal?.proposed && (
        <div className="mt-3 rounded-lg border bg-muted/50 p-3">
          <p className="mb-2 text-sm">
            <span className="font-medium">제안 요약:</span> {proposal.rationale}
          </p>
          {proposal.diff && (
            <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
              {proposal.diff.added.length > 0 && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  추가 {proposal.diff.added.length}
                </span>
              )}
              {proposal.diff.deleted.length > 0 && (
                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                  삭제 {proposal.diff.deleted.length}
                </span>
              )}
              {proposal.diff.changed.length > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  수정 {proposal.diff.changed.length}
                </span>
              )}
              {proposal.diff.reordered.length > 0 && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                  순서변경 {proposal.diff.reordered.length}
                </span>
              )}
              {proposal.diff.added.length === 0 &&
                proposal.diff.deleted.length === 0 &&
                proposal.diff.changed.length === 0 &&
                proposal.diff.reordered.length === 0 && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">변경 없음</span>
                )}
            </div>
          )}
          {(proposal.lintWarnings?.length ?? 0) > 0 && (
            <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-300">
              <p className="font-medium">⚠️ 이 제안에는 표시 조건 오류가 있습니다 — 해당 변경의 체크를 해제하고 적용하거나, 거부 후 다시 생성하세요.</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {proposal.lintWarnings!.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="mb-1 font-medium text-muted-foreground">현재</p>
              <ol className="flex flex-col gap-1">
                {proposal.current?.map((q, i) => {
                  const deleted = proposal.diff?.deleted.some((d) => d.quid === q.quid);
                  return (
                    <li
                      key={q.quid ?? i}
                      className={`rounded border bg-card p-1.5 ${deleted ? "border-destructive/30 bg-destructive/5" : ""}`}
                    >
                      <span className={`flex items-start gap-1.5 ${deleted ? "line-through opacity-70" : ""}`}>
                        {deleted && (
                          <input
                            type="checkbox"
                            checked={sel[q.quid] === true}
                            onChange={() => toggleWhole(q.quid)}
                            className="mt-0.5 shrink-0"
                            title="체크하면 이 문항 삭제를 수용합니다"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          {q.quid && <span className="mr-1 font-mono text-[10px] text-muted-foreground/70">{questionCode(q.quid)}</span>}
                          {i + 1}. {q.prompt}
                        </span>
                        {deleted && <span className="shrink-0 text-[10px] font-medium text-destructive">삭제</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <div>
              <p className="mb-1 font-medium text-primary">제안</p>
              <ol className="flex flex-col gap-1">
                {proposal.proposed.map((q, i) => {
                  const det = detailByQuid.get(q.quid);
                  const lines = linesByQuid.get(q.quid) ?? [];
                  const added = det?.status === "added";
                  // Meta-only edits are internal — present them as unchanged.
                  const changed = det?.status === "changed" && lines.length > 0;
                  const reordered = det?.status === "reordered";
                  const typeChange = typeChangedQuids.has(q.quid);
                  const tag = added ? "추가" : changed ? "수정" : reordered ? "순서" : null;
                  const wholeToggle = added || (changed && typeChange);
                  const tone = added
                    ? "border-emerald-200 bg-emerald-50 dark:border-emerald-400/30 dark:bg-emerald-950/40"
                    : changed
                      ? "border-amber-200 bg-amber-50 dark:border-amber-400/30 dark:bg-amber-950/40"
                      : reordered
                        ? "border-blue-200 bg-blue-50 dark:border-blue-400/30 dark:bg-blue-950/40"
                        : "border-blue-200 bg-card dark:border-blue-400/30";
                  const dimmed = (added || changed) && !questionAccepted(q.quid);
                  return (
                    <li key={q.quid ?? i} className={`rounded border p-1.5 ${tone} ${dimmed ? "opacity-50" : ""}`}>
                      <span className="flex items-start gap-1.5">
                        {wholeToggle && (
                          <input
                            type="checkbox"
                            checked={sel[q.quid] === true}
                            onChange={() => toggleWhole(q.quid)}
                            className="mt-0.5 shrink-0"
                            title={typeChange ? "유형 변경은 일괄로만 적용됩니다" : "체크 해제하면 이 문항은 추가되지 않습니다"}
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          {q.quid && <span className="mr-1 font-mono text-[10px] text-muted-foreground/70">{questionCode(q.quid)}</span>}
                          {i + 1}. {q.prompt}
                        </span>
                        {q.showIf && (
                          <span
                            className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary"
                            title="이 문항에 표시 조건이 설정됩니다"
                          >
                            조건
                          </span>
                        )}
                        {tag && <span className="shrink-0 text-[10px] font-medium text-muted-foreground">{tag}</span>}
                      </span>
                      {changed && !typeChange && (
                        <ul className="mt-1 flex flex-col gap-1 pl-5 text-[11px] text-muted-foreground">
                          {lines.map((line) => (
                            <li key={line.key} className="flex items-start gap-1.5">
                              <input
                                type="checkbox"
                                checked={lineSelected(q.quid, line.key)}
                                onChange={() => toggleLine(q.quid, line.key, lines.map((l) => l.key))}
                                className="mt-0.5 shrink-0"
                                title="체크 해제하면 이 변경만 제외하고 적용합니다"
                              />
                              <span className={lineSelected(q.quid, line.key) ? "min-w-0 flex-1" : "min-w-0 flex-1 opacity-50"}>
                                <LineBody line={line} />
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {changed && typeChange && (
                        <ul className="mt-1 flex flex-col gap-1 pl-5 text-[11px] text-muted-foreground">
                          {lines.map((line) => (
                            <li key={line.key}>
                              <LineBody line={line} />
                            </li>
                          ))}
                        </ul>
                      )}
                      {added && <QuestionContent q={q} promptOf={noPromptOf} />}
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={onApply}
              disabled={pending || (totals.total > 0 && totals.selected === 0)}
            >
              {totals.total > 0 && totals.selected < totals.total
                ? `선택 변경 ${totals.selected}/${totals.total}건 적용`
                : "적용"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReject}
              disabled={pending}
            >
              거부
            </Button>
            {totals.total > 0 && totals.selected < totals.total && (
              <span className="text-xs text-muted-foreground/70">
                체크 해제한 변경은 적용되지 않고 &lsquo;지난 제안&rsquo;에 남습니다
              </span>
            )}
          </div>
        </div>
      )}

      {msg && <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}

      {initialProposals.length > 0 && (
        <details className="mt-3 rounded-lg border p-2 text-xs">
          <summary className="cursor-pointer font-medium text-muted-foreground">
            지난 제안 {initialProposals.length}개 — 미적용 항목 포함, 언제든 다시 열기
          </summary>
          <ul className="mt-2 flex flex-col divide-y">
            {initialProposals.map((pr) => {
              const st = PROPOSAL_STATUS[pr.status] ?? PROPOSAL_STATUS.pending;
              return (
                <li key={pr.id} className="flex items-start justify-between gap-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className={`mr-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${st.tone}`}>
                      {st.label}
                    </span>
                    <span className="text-muted-foreground/70">
                      {new Date(pr.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                    {pr.skippedCount > 0 && (
                      <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                        미적용 {pr.skippedCount}건
                      </span>
                    )}
                    <span className="mt-0.5 block truncate text-muted-foreground" title={pr.feedback}>
                      {pr.rationale || pr.feedback}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => onReopen(pr.id)}
                    disabled={pending}
                    className="text-[11px]"
                  >
                    다시 열기
                  </Button>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {initialRevisions.length === 0 && (
        <p className="mt-4 text-xs text-muted-foreground/70">
          아직 기록된 버전이 없습니다 — 문항을 수정하거나 AI 제안을 적용하면 버전 이력이 여기에 쌓입니다.
        </p>
      )}

      {initialRevisions.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-sm font-medium">버전 이력</p>
            <span className="flex items-center gap-1">
              <Input
                value={checkpointName}
                onChange={(e) => setCheckpointName(e.target.value)}
                placeholder="예: 발송 전 최종본"
                className="h-7 w-36 px-2 text-xs md:text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onSaveCheckpoint}
                disabled={pending || checkpointName.trim().length < 2}
                title="현재 문항 상태를 이름 붙인 버전으로 고정합니다"
              >
                버전으로 저장
              </Button>
            </span>
          </div>
          {(() => {
            const isMajor = (r: RevisionRow) => r.label != null || r.reason !== "직접 수정";
            const autoCount = initialRevisions.filter((r) => !isMajor(r)).length;
            const visible = showAutos ? initialRevisions : initialRevisions.filter(isMajor);
            return (
              <>
                <ul className="flex flex-col divide-y text-sm">
                  {visible.map((r) => (
                    <li key={r.version} className="flex items-start justify-between gap-2 py-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          <span className="font-mono text-xs text-muted-foreground/70">v{r.version}</span>{" "}
                          {r.label ? (
                            <>
                              <span className="font-medium">{r.label}</span>{" "}
                              <span className="text-xs text-muted-foreground/70">· {r.reason}</span>
                            </>
                          ) : (
                            <span className={isMajor(r) ? "" : "text-muted-foreground"}>{r.reason}</span>
                          )}{" "}
                          <span className="text-xs text-muted-foreground/70">({r.questionCount}문항)</span>
                        </span>
                        <ChangeSummaryBadges summary={r.changeSummary} />
                        {r.changeNotes.length > 0 && (
                          <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground/70">
                            {r.changeNotes.join(" · ")}
                          </span>
                        )}
                        {nameEditing === r.version && (
                          <span className="mt-1 flex items-center gap-1">
                            <Input
                              value={nameDraft}
                              onChange={(e) => setNameDraft(e.target.value)}
                              placeholder="버전 이름 (비우면 이름 제거)"
                              className="h-6 w-40 px-2 text-xs md:text-xs"
                              autoFocus
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={() => onSaveName(r.version)}
                              disabled={pending}
                              className="h-5 px-1.5 text-[10px]"
                            >
                              저장
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={() => setNameEditing(null)}
                              className="h-5 px-1.5 text-[10px]"
                            >
                              취소
                            </Button>
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => {
                            setNameEditing(r.version);
                            setNameDraft(r.label ?? "");
                          }}
                          disabled={pending}
                          className="text-muted-foreground"
                          title="버전에 이름 붙이기"
                        >
                          이름
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => onRevert(r.version)}
                          disabled={pending}
                        >
                          되돌리기
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
                {autoCount > 0 && (
                  <Button
                    type="button"
                    variant="link"
                    onClick={() => setShowAutos((s) => !s)}
                    className="mt-1 h-auto self-start p-0 text-xs font-normal text-muted-foreground/70 hover:text-muted-foreground"
                  >
                    {showAutos ? "직접 수정 버전 접기" : `직접 수정 버전 ${autoCount}개 보기`}
                  </Button>
                )}
              </>
            );
          })()}

          {initialRevisions.length >= 2 && (
            <div className="mt-3 border-t pt-3">
              <p className="mb-1 text-sm font-medium">두 버전 비교</p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <select
                  value={cmpFrom}
                  onChange={(e) => setCmpFrom(Number(e.target.value))}
                  className={cn(selectCls, "h-7 px-2 text-xs")}
                >
                  {initialRevisions.map((r) => (
                    <option key={r.version} value={r.version}>
                      v{r.version}{r.label ? ` — ${r.label}` : ""}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground/70">↔</span>
                <select
                  value={cmpTo}
                  onChange={(e) => setCmpTo(Number(e.target.value))}
                  className={cn(selectCls, "h-7 px-2 text-xs")}
                >
                  {initialRevisions.map((r) => (
                    <option key={r.version} value={r.version}>
                      v{r.version}{r.label ? ` — ${r.label}` : ""}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onCompare}
                  disabled={pending || cmpFrom === cmpTo}
                >
                  비교
                </Button>
              </div>
              {compare && <VersionCompareResult result={compare} />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
