"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  addDemographicPresets,
  addQuestion,
  backfillMetaAction,
  deleteQuestion,
  inferMetaAction,
  reorderQuestions,
  updateQuestion,
  updateSurveyTitle,
  updateSurveyMessages,
} from "./actions";
import {
  insertTemplateQuestionsAction,
  listInsertableTemplatesAction,
  saveQuestionsAsBlockAction,
  saveTemplateAction,
} from "../template-actions";
import { DEMOGRAPHIC_PRESETS } from "@/lib/demographic-presets";
import { DisplayLogicEditor, describeLogic } from "./display-logic-editor";
import { LogicMapPanel } from "./logic-map-panel";
import { scrollToQuestion } from "./scroll-to-question";
import { lintDisplayLogic } from "@/lib/logic-lint";
import type { LintWarning } from "@/lib/logic-lint";
import type { DisplayLogic } from "@/lib/display-logic";
import {
  DEFAULT_MAX_PROBES,
  MAX_PROBES_CAP,
  normalizeMeta,
  normalizeOptions,
  normalizeProbe,
  specialFromLabel,
  type OptionObject,
  type OptionSpecial,
  type ProbeConfig,
  type QMeta,
} from "@/lib/question-config";
import { questionCode } from "@/lib/question-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Native <select> styled to match the shadcn Input aesthetic. */
const selectCls =
  "rounded-md border border-input bg-transparent text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";
type Config = {
  options?: OptionObject[];
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  rows?: string[];
  columns?: string[];
  limit?: number;
  meta?: QMeta;
  displayLogic?: DisplayLogic;
  probe?: ProbeConfig;
  randomizeOptions?: boolean;
  optionsFrom?: { questionId: string; mode: "selected" };
};
type Q = {
  id: string;
  // Permanent quid (US-001); source of the stable display code (US-004).
  quid: string;
  type: QuestionType;
  order: number;
  prompt: string;
  config: Config;
};

const TYPES: { value: QuestionType; label: string }[] = [
  { value: "single", label: "단일 선택" },
  { value: "multi", label: "복수 선택" },
  { value: "scale", label: "척도" },
  { value: "ranking", label: "순위" },
  { value: "matrix", label: "행렬" },
  { value: "nps", label: "NPS (0–10)" },
  { value: "open", label: "주관식" },
];

/** A fresh, stable per-option id for a newly-added option (survives renames). */
function freshOptionId(): string {
  return "o_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Returns config with `options` coerced to the canonical {id,label}[] shape. */
function normalizeConfig(config: Config): Config {
  if (!Array.isArray(config.options)) return config;
  return { ...config, options: normalizeOptions(config.options) };
}

function defaultConfigFor(type: QuestionType, prev: Config): Config {
  if (type === "single" || type === "multi" || type === "ranking") {
    const kept = normalizeOptions(prev.options);
    return { options: kept.length ? kept : normalizeOptions(["옵션 1", "옵션 2"]) };
  }
  if (type === "scale") {
    return { scale: prev.scale ?? { min: 1, max: 5 } };
  }
  if (type === "matrix") {
    return {
      rows: prev.rows?.length ? prev.rows : ["항목 1", "항목 2"],
      columns: prev.columns?.length ? prev.columns : ["매우 불만족", "보통", "매우 만족"],
    };
  }
  return {};
}

export function Editor({
  surveyId,
  initialTitle,
  initialQuestions,
  initialWelcome,
  initialClosing,
}: {
  surveyId: string;
  initialTitle: string;
  initialQuestions: Q[];
  initialWelcome: string;
  initialClosing: string;
}) {
  // Coerce legacy string options to the canonical {id,label}[] on ingest so all
  // in-editor state (and every save) carries stable per-option ids.
  const normalizedInitial = useMemo(
    () => initialQuestions.map((q) => ({ ...q, config: normalizeConfig(q.config) })),
    [initialQuestions],
  );
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [welcome, setWelcome] = useState(initialWelcome);
  const [closing, setClosing] = useState(initialClosing);
  const [questions, setQuestions] = useState<Q[]>(normalizedInitial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [, startTransition] = useTransition();
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Mirror of `questions` kept in sync synchronously by patchLocal, so a
  // (possibly debounced) save always persists the LATEST config — never a stale
  // captured snapshot that could resurrect a just-deleted displayLogic.
  const questionsRef = useRef<Q[]>(normalizedInitial);
  const cfgOf = (id: string) => questionsRef.current.find((q) => q.id === id)?.config ?? {};
  const dragId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Insertion slot (0..n) where a drop would place the dragged question.
  const [dropIndicator, setDropIndicator] = useState<number | null>(null);
  // Option drag (within one question): dragstart on the handle must
  // stopPropagation or the question card's own draggable would take over.
  const optDrag = useRef<{ qid: string; idx: number } | null>(null);
  const [optDropSlot, setOptDropSlot] = useState<{ qid: string; slot: number } | null>(null);
  // Save-as-template flow. `selecting` = the save bar is open; `saveUnit` picks
  // the reuse granularity explicitly (설문 전체 → kind='survey' | 선택 블록 →
  // kind='block'). Checkboxes only matter for the block unit.
  const [selecting, setSelecting] = useState(false);
  const [saveUnit, setSaveUnit] = useState<"survey" | "block">("survey");
  const [selectedQuids, setSelectedQuids] = useState<Set<string>>(new Set());
  function toggleSelected(quid: string) {
    setSelectedQuids((prev) => {
      const next = new Set(prev);
      if (next.has(quid)) next.delete(quid);
      else next.add(quid);
      return next;
    });
  }

  // Live display-logic warnings, derived purely from the local `questions` state
  // (no server round-trip) so they refresh on add/delete/reorder/condition edits.
  // Use array index as `order` so forward_ref matches live position after a drag
  // reorder (the stored `order` field can be stale until the reorder save lands).
  const warnings = useMemo(
    () => lintDisplayLogic(questions.map((q, i) => ({ ...q, order: i }))),
    [questions],
  );
  const warningsByQ = useMemo(() => {
    const map: Record<string, LintWarning[]> = {};
    for (const w of warnings) (map[w.questionId] ??= []).push(w);
    return map;
  }, [warnings]);
  const errorCount = warnings.filter((w) => w.severity === "error").length;
  const warningCount = warnings.filter((w) => w.severity === "warning").length;
  // 1-based question position by id, for labeling each warning in the banner.
  const qNumById = useMemo(() => {
    const map: Record<string, number> = {};
    questions.forEach((q, i) => (map[q.id] = i + 1));
    return map;
  }, [questions]);

  function save(fn: () => Promise<unknown>) {
    setStatus("saving");
    startTransition(async () => {
      try {
        await fn();
        setStatus("saved");
      } catch {
        setStatus("idle");
      }
    });
  }

  /** Debounced save keyed by a string (e.g. questionId:field). */
  function debouncedSave(key: string, fn: () => Promise<unknown>) {
    clearTimeout(timers.current[key]);
    setStatus("saving");
    timers.current[key] = setTimeout(() => save(fn), 700);
  }

  /** Single path for all question-list state changes; keeps questionsRef in sync. */
  function commit(updater: (qs: Q[]) => Q[]) {
    const next = updater(questionsRef.current);
    questionsRef.current = next;
    setQuestions(next);
  }

  function patchLocal(id: string, patch: Partial<Q>) {
    commit((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }

  function onChangeType(q: Q, type: QuestionType) {
    const config = defaultConfigFor(type, q.config);
    patchLocal(q.id, { type, config });
    save(() => updateQuestion(q.id, { type, config: cfgOf(q.id) }));
  }

  function onChangePrompt(q: Q, prompt: string) {
    patchLocal(q.id, { prompt });
    debouncedSave(`${q.id}:prompt`, async () => {
      await updateQuestion(q.id, { prompt });
      // Fire-and-forget: infer meta in the background once the prompt landed.
      maybeInferMeta(q.id);
    });
  }

  function onChangeOption(q: Q, idx: number, value: string) {
    const options = [...(q.config.options ?? [])];
    // Rename only the label — the option keeps its stable id (identity survives).
    if (options[idx]) options[idx] = { ...options[idx], label: value };
    const config = { ...q.config, options };
    patchLocal(q.id, { config });
    debouncedSave(`${q.id}:opt${idx}`, () => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  function addOption(q: Q) {
    const options = [
      ...(q.config.options ?? []),
      { id: freshOptionId(), label: `옵션 ${(q.config.options?.length ?? 0) + 1}` },
    ];
    const config = { ...q.config, options };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  function removeOption(q: Q, idx: number) {
    const options = (q.config.options ?? []).filter((_, i) => i !== idx);
    const config = { ...q.config, options };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  /** Swaps a (non-special) option with its nearest non-special neighbor. */
  function moveOption(q: Q, idx: number, dir: -1 | 1) {
    const options = [...(q.config.options ?? [])];
    const movable = options.map((o, i) => (o.special ? -1 : i)).filter((i) => i >= 0);
    const pos = movable.indexOf(idx);
    const target = movable[pos + dir];
    if (pos < 0 || target === undefined) return;
    [options[idx], options[target]] = [options[target], options[idx]];
    const config = { ...q.config, options };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  /**
   * Drops the dragged (non-special) option at insertion slot `slot` (0..n,
   * "before array index slot"). The slot is clamped to the movable range so a
   * drop can never land before a "none" or after an "other" anchor.
   */
  function moveOptionToSlot(q: Q, fromIdx: number, slot: number) {
    const options = [...(q.config.options ?? [])];
    if (!options[fromIdx] || options[fromIdx].special) return;
    const movable = options.map((o, i) => (o.special ? -1 : i)).filter((i) => i >= 0);
    if (movable.length < 2) return;
    let target = Math.max(movable[0], Math.min(slot, movable[movable.length - 1] + 1));
    const [moved] = options.splice(fromIdx, 1);
    if (fromIdx < target) target -= 1;
    if (target === fromIdx) {
      // No-op drop back onto its own slot: skip the save round-trip.
      return;
    }
    options.splice(target, 0, moved);
    const config = { ...q.config, options };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  /** Adds the pinned 없음(first) / 기타(last) option once per question. */
  function addSpecialOption(q: Q, special: OptionSpecial) {
    const existing = q.config.options ?? [];
    if (existing.some((o) => o.special === special)) return;
    const opt: OptionObject = {
      id: freshOptionId(),
      label: special === "other" ? "기타" : "없음",
      special,
    };
    const options = special === "none" ? [opt, ...existing] : [...existing, opt];
    const config = { ...q.config, options };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  /**
   * On blur of a plain option label: a manually typed catch-all ("기타(직접
   * 입력)", "해당 없음" 등) is promoted to its special option automatically.
   * Conservative matching — a bare "기타" is NOT promoted (could be guitar);
   * the "+ 기타" button stays the explicit path for that.
   */
  function maybePromoteSpecial(q: Q, idx: number) {
    const options = [...(q.config.options ?? [])];
    const opt = options[idx];
    if (!opt || opt.special) return;
    const s = specialFromLabel(opt.label, { conservative: true });
    if (!s || options.some((o) => o.special === s)) return;
    // Move to the anchor slot so the editor mirrors the respondent view.
    options.splice(idx, 1);
    const promoted = { ...opt, special: s };
    const next = s === "none" ? [promoted, ...options] : [...options, promoted];
    const config = { ...q.config, options: next };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  /** Toggles the free-text input of the special "other" option (noText flag). */
  function toggleOtherText(q: Q, idx: number, textOn: boolean) {
    const options = [...(q.config.options ?? [])];
    const opt = options[idx];
    if (!opt || opt.special !== "other") return;
    const { noText: _drop, ...rest } = opt;
    options[idx] = textOn ? rest : { ...rest, noText: true };
    const config = { ...q.config, options };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  /** Sets/clears the carry-forward source ("보기 가져오기") for a choice question. */
  function onChangeOptionsFrom(q: Q, sourceId: string) {
    const { optionsFrom: _drop, ...rest } = q.config;
    const config: Config = sourceId
      ? { ...rest, optionsFrom: { questionId: sourceId, mode: "selected" } }
      : rest;
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  function toggleRandomizeOptions(q: Q, on: boolean) {
    const { randomizeOptions: _drop, ...rest } = q.config;
    const config: Config = on ? { ...rest, randomizeOptions: true } : rest;
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  // Generic list editors for matrix rows/columns.
  function onChangeListItem(q: Q, field: "rows" | "columns", idx: number, value: string) {
    const list = [...(q.config[field] ?? [])];
    list[idx] = value;
    const config = { ...q.config, [field]: list };
    patchLocal(q.id, { config });
    debouncedSave(`${q.id}:${field}${idx}`, () => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }
  function addListItem(q: Q, field: "rows" | "columns", label: string) {
    const list = [...(q.config[field] ?? []), `${label} ${(q.config[field]?.length ?? 0) + 1}`];
    const config = { ...q.config, [field]: list };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }
  function removeListItem(q: Q, field: "rows" | "columns", idx: number) {
    const list = (q.config[field] ?? []).filter((_, i) => i !== idx);
    const config = { ...q.config, [field]: list };
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  function onChangeLimit(q: Q, value: string) {
    const n = value === "" ? undefined : Math.max(1, Math.floor(Number(value)));
    const config = { ...q.config, limit: n && Number.isFinite(n) ? n : undefined };
    patchLocal(q.id, { config });
    debouncedSave(`${q.id}:limit`, () => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  function onChangeDisplayLogic(q: Q, logic: DisplayLogic | undefined, src?: string) {
    const config = { ...q.config, displayLogic: logic };
    if (!logic) delete config.displayLogic;
    patchLocal(q.id, { config });
    save(() => updateQuestion(q.id, { config: cfgOf(q.id) }, `DL:${src ?? "?"}`));
  }

  /** Merge a partial probe patch into the open question's probe config (US-011). */
  function onChangeProbe(q: Q, patch: Partial<ProbeConfig>, debounce = false) {
    const prev = normalizeProbe(q.config.probe) ?? { enabled: false, maxProbes: DEFAULT_MAX_PROBES };
    const probe = normalizeProbe({ ...prev, ...patch })!;
    const config = { ...q.config, probe };
    patchLocal(q.id, { config });
    if (debounce) debouncedSave(`${q.id}:probe`, () => updateQuestion(q.id, { config: cfgOf(q.id) }));
    else save(() => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  // Background meta inference (US-004). Fired after a prompt save flush when
  // meta is still empty; per-question in-flight guard so one question never
  // stacks CLI calls. Entirely silent — failures leave the editor untouched.
  const inferring = useRef<Set<string>>(new Set());
  const [backfill, setBackfill] = useState<{ running: boolean; msg: string }>({
    running: false,
    msg: "",
  });

  /** Apply a server-inferred meta to local state unless the author has since
   *  entered their own (human/unknown origin always wins). */
  function applyInferredMeta(id: string, meta: QMeta) {
    const cur = questionsRef.current.find((x) => x.id === id);
    if (!cur) return;
    const curMeta = normalizeMeta(cur.config.meta);
    if (curMeta && curMeta.origin !== "ai") return;
    patchLocal(id, { config: { ...cur.config, meta } });
  }

  function maybeInferMeta(id: string) {
    const q = questionsRef.current.find((x) => x.id === id);
    if (!q || normalizeMeta(q.config.meta) || inferring.current.has(id)) return;
    inferring.current.add(id);
    inferMetaAction(id)
      .then((res) => {
        if (res.status === "saved") applyInferredMeta(id, res.meta);
      })
      .catch(() => {})
      .finally(() => inferring.current.delete(id));
  }

  function runBackfill() {
    const targets = questionsRef.current.filter((q) => !normalizeMeta(q.config.meta));
    if (targets.length === 0) {
      setBackfill({ running: false, msg: "메타데이터가 빈 문항이 없습니다." });
      return;
    }
    setBackfill({
      running: true,
      msg: `대상 ${targets.length}개 문항 추론 중… (문항당 수 초~수십 초)`,
    });
    backfillMetaAction(surveyId)
      .then((res) => {
        for (const [qid, meta] of Object.entries(res.metas)) applyInferredMeta(qid, meta);
        const skipped = res.total - res.filled - res.failed;
        setBackfill({
          running: false,
          msg:
            `완료: ${res.filled}개 채움` +
            (res.failed ? ` · ${res.failed}개 실패` : "") +
            (skipped ? ` · ${skipped}개 건너뜀` : ""),
        });
      })
      .catch(() => setBackfill({ running: false, msg: "자동 채우기에 실패했습니다." }));
  }

  function onChangeMeta(q: Q, field: keyof Omit<QMeta, "origin" | "constructId">, value: string) {
    // Any manual edit stamps origin:"human" — the trust tier that blocks
    // background AI inference from ever overwriting author-entered metadata.
    const meta = { ...(q.config.meta ?? {}), [field]: value || undefined, origin: "human" as const };
    // Rewritten construct text no longer matches its dictionary row (US-006).
    if (field === "construct") delete meta.constructId;
    const config = { ...q.config, meta };
    patchLocal(q.id, { config });
    debouncedSave(`${q.id}:meta:${field}`, () => updateQuestion(q.id, { config: cfgOf(q.id) }));
  }

  /** Inserts a new question at position `index` (0..n), persisting the order. */
  function onAddAt(index: number) {
    setStatus("saving");
    startTransition(async () => {
      try {
        const created = (await addQuestion(surveyId)) as Q;
        const arr = [...questionsRef.current];
        const at = Math.max(0, Math.min(index, arr.length));
        arr.splice(at, 0, { ...created, config: created.config ?? {} });
        commit(() => arr);
        await reorderQuestions(surveyId, arr.map((q) => q.id));
        setStatus("saved");
      } catch {
        setStatus("idle");
      }
    });
  }

  function onDelete(id: string) {
    commit((qs) => qs.filter((q) => q.id !== id));
    save(() => deleteQuestion(id));
  }

  /** Moves the dragged question to insertion slot `index` (0..n) — before item
   *  `index`. Commits only on drop (no swap-on-hover), matching a clear
   *  insertion-line UX. */
  function moveTo(index: number) {
    const from = dragId.current;
    setDropIndicator(null);
    setDraggingId(null);
    dragId.current = null;
    if (!from) return;
    commit((qs) => {
      const fromIdx = qs.findIndex((q) => q.id === from);
      if (fromIdx < 0) return qs;
      const arr = [...qs];
      const [moved] = arr.splice(fromIdx, 1);
      // Removing an earlier item shifts later insertion slots left by one.
      const target = Math.max(0, Math.min(fromIdx < index ? index - 1 : index, arr.length));
      arr.splice(target, 0, moved);
      const ordered = arr.map((q) => q.id);
      save(() => reorderQuestions(surveyId, ordered));
      return arr;
    });
  }

  // Insertion zone between/around question cards: shows a drop line while
  // dragging (drop commits here) and a hover-revealed "+ 질문 추가" otherwise.
  // Written as a render helper (not a nested component) so it inlines into the
  // parent render instead of remounting on every keystroke.
  function insertZone(index: number) {
    const active = dropIndicator === index;
    const dragging = draggingId !== null;
    return (
      <div
        onDragOver={dragging ? (e) => { e.preventDefault(); setDropIndicator(index); } : undefined}
        onDrop={dragging ? (e) => { e.preventDefault(); moveTo(index); } : undefined}
        className="group relative flex h-6 items-center justify-center"
      >
        <div
          className={`pointer-events-none absolute inset-x-0 h-0.5 rounded transition-colors ${
            active ? "bg-primary" : "bg-transparent"
          }`}
        />
        {active && (
          <span className="pointer-events-none absolute left-0 h-2 w-2 -translate-x-1/2 rounded-full bg-primary" />
        )}
        {!dragging && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onAddAt(index)}
            className="z-10 rounded-full border-dashed border-input text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:border-primary/50 hover:text-primary"
            title="여기에 질문 추가"
          >
            + 질문 추가
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <Link href={`/surveys/${surveyId}`} className="text-sm text-muted-foreground hover:underline">
          ← 미리보기
        </Link>
        <span className="text-xs text-muted-foreground/70" aria-live="polite">
          {status === "saving" ? "저장 중…" : status === "saved" ? "저장됨 ✓" : ""}
        </span>
      </div>

      <Input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          debouncedSave("title", () => updateSurveyTitle(surveyId, e.target.value));
        }}
        className="h-auto px-3 py-2 text-xl font-bold md:text-xl"
        placeholder="설문 제목"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted-foreground">환영 메시지 (시작 화면)</span>
          <Textarea
            value={welcome}
            onChange={(e) => {
              setWelcome(e.target.value);
              debouncedSave("welcome", () =>
                updateSurveyMessages(surveyId, { welcomeMessage: e.target.value }),
              );
            }}
            rows={2}
            placeholder="예: 잠깐의 시간을 내어 응답해 주세요. 익명으로 처리됩니다."
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted-foreground">종료 메시지 (완료 화면)</span>
          <Textarea
            value={closing}
            onChange={(e) => {
              setClosing(e.target.value);
              debouncedSave("closing", () =>
                updateSurveyMessages(surveyId, { closingMessage: e.target.value }),
              );
            }}
            rows={2}
            placeholder="예: 소중한 의견 감사합니다! 결과는 추후 공유드릴게요."
          />
        </label>
      </div>

      {/* Lint summary banner — total error/warning counts across all conditions. */}
      <div
        className={`rounded-lg border px-3 py-2 text-sm ${
          errorCount > 0
            ? "border-destructive/30 bg-destructive/5 text-destructive"
            : warningCount > 0
              ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-400"
              : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-950/40 dark:text-emerald-400"
        }`}
      >
        {errorCount + warningCount === 0 ? (
          <span>조건 이상 없음 ✓</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span>
              표시 조건 점검:{" "}
              {errorCount > 0 && <b>오류 {errorCount}</b>}
              {errorCount > 0 && warningCount > 0 && " · "}
              {warningCount > 0 && <b>경고 {warningCount}</b>}
              <span className="ml-1 text-xs font-normal opacity-70">
                (클릭하면 해당 문항으로 이동)
              </span>
            </span>
            <ul className="flex flex-col gap-1">
              {warnings.map((w, i) => (
                <li key={`${w.questionId}-${w.code}-${i}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => scrollToQuestion(w.questionId)}
                    className="h-auto w-full justify-start px-1.5 py-0.5 text-left font-normal whitespace-normal hover:bg-background/60 hover:text-current"
                    title="문항으로 이동"
                  >
                    {w.severity === "error" ? "⛔" : "⚠️"}{" "}
                    <b>Q{qNumById[w.questionId] ?? "?"}</b> — {w.message}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <LogicMapPanel questions={questions} warnings={warnings} />

      {/* Survey-level meta backfill (US-004): fill every empty meta via AI. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2">
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {backfill.msg ||
            "메타데이터가 빈 문항을 AI가 한 번에 채웁니다 (직접 입력한 값은 건드리지 않음)"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={runBackfill}
          disabled={backfill.running}
          className="shrink-0 text-violet-700 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-400"
        >
          {backfill.running ? "채우는 중…" : "메타데이터 자동 채우기"}
        </Button>
      </div>

      <div className="flex flex-col">
        {questions.map((q, i) => (
          <div key={q.id}>
            {insertZone(i)}
            <li
              id={`q-${q.id}`}
              onDragOver={(e) => {
                if (!draggingId) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDropIndicator(e.clientY > r.top + r.height / 2 ? i + 1 : i);
              }}
              onDrop={(e) => {
                if (!draggingId) return;
                e.preventDefault();
                moveTo(dropIndicator ?? i);
              }}
              className={`list-none rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition ${
                draggingId === q.id ? "opacity-40" : ""
              }`}
            >
            <div className="mb-2 flex items-center gap-2">
              {selecting && saveUnit === "block" && (
                <input
                  type="checkbox"
                  className="size-4"
                  checked={selectedQuids.has(q.quid)}
                  onChange={() => toggleSelected(q.quid)}
                  title="블록에 포함"
                />
              )}
              <span
                draggable
                onDragStart={(e) => {
                  dragId.current = q.id;
                  setDraggingId(q.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDropIndicator(null);
                  dragId.current = null;
                }}
                className="cursor-grab select-none px-1 text-muted-foreground/70 hover:text-muted-foreground active:cursor-grabbing"
                title="드래그하여 순서 변경"
              >
                ⠿
              </span>
              <span className="text-sm text-muted-foreground/70">{i + 1}</span>
              <Badge
                variant="secondary"
                className="font-mono text-muted-foreground"
                title="문항 고유 코드 — 순서가 바뀌어도 유지됩니다"
              >
                {questionCode(q.quid)}
              </Badge>
              <select
                value={q.type}
                onChange={(e) => onChangeType(q, e.target.value as QuestionType)}
                className={cn(selectCls, "ml-auto h-8 px-2")}
              >
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              {!selecting && <SaveQuestionButton surveyId={surveyId} question={q} />}
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onDelete(q.id)}
                title="질문 삭제"
              >
                삭제
              </Button>
            </div>

            <Input
              value={q.prompt}
              onChange={(e) => onChangePrompt(q, e.target.value)}
              className="mb-2 h-9 px-3"
              placeholder="질문 내용"
            />

            {(q.type === "single" || q.type === "multi" || q.type === "ranking") && (
              <div className="ml-2 flex flex-col gap-2">
                {q.type === "ranking" && (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-muted-foreground/70">
                      응답자가 보기를 선호 순서대로 하나씩 선택합니다(사전 정렬 없음).
                    </p>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      선택할 순위 개수
                      <Input
                        type="number"
                        min={1}
                        max={q.config.options?.length || undefined}
                        value={q.config.limit ?? ""}
                        onChange={(e) => onChangeLimit(q, e.target.value)}
                        placeholder="전체"
                        className="h-7 w-20 px-2"
                      />
                      <span className="text-muted-foreground/70">비우면 전체 순위 (예: 3 → 3순위까지)</span>
                    </label>
                  </div>
                )}
                {(q.config.options ?? []).map((opt, j) => (
                  <div
                    key={opt.id}
                    onDragOver={(e) => {
                      // optDrag is a ref (dragstart doesn't re-render), so the
                      // handler is always attached and gates itself here.
                      if (optDrag.current?.qid !== q.id || opt.special) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      const slot = e.clientY < r.top + r.height / 2 ? j : j + 1;
                      setOptDropSlot((s) =>
                        s?.qid === q.id && s.slot === slot ? s : { qid: q.id, slot },
                      );
                    }}
                    onDrop={(e) => {
                      const from = optDrag.current;
                      if (from?.qid !== q.id || opt.special) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const slot = optDropSlot?.qid === q.id ? optDropSlot.slot : j;
                      optDrag.current = null;
                      setOptDropSlot(null);
                      moveOptionToSlot(q, from.idx, slot);
                    }}
                    className={`flex items-center gap-2 ${
                      optDropSlot?.qid === q.id && optDropSlot.slot === j
                        ? "border-t-2 border-primary"
                        : optDropSlot?.qid === q.id &&
                            optDropSlot.slot === j + 1 &&
                            j === (q.config.options?.length ?? 0) - 1
                          ? "border-b-2 border-primary"
                          : "border-y-2 border-transparent"
                    }`}
                  >
                    {opt.special ? (
                      <span className="text-muted-foreground/70">•</span>
                    ) : (
                      <span
                        draggable
                        onDragStart={(e) => {
                          // Keep the question card's drag from hijacking this one.
                          e.stopPropagation();
                          e.dataTransfer.effectAllowed = "move";
                          optDrag.current = { qid: q.id, idx: j };
                        }}
                        onDragEnd={() => {
                          optDrag.current = null;
                          setOptDropSlot(null);
                        }}
                        title="드래그로 순서 변경"
                        className="cursor-grab select-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
                      >
                        ⠿
                      </span>
                    )}
                    <Input
                      value={opt.label}
                      onChange={(e) => onChangeOption(q, j, e.target.value)}
                      onBlur={() => maybePromoteSpecial(q, j)}
                      className="h-7 flex-1 px-2"
                    />
                    {opt.special ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        {opt.special === "other" && (
                          <label
                            className="flex items-center gap-1 text-[10px] text-muted-foreground"
                            title="켜면 응답자가 기타를 고를 때 내용을 직접 입력합니다"
                          >
                            <input
                              type="checkbox"
                              checked={opt.noText !== true}
                              onChange={(e) => toggleOtherText(q, j, e.target.checked)}
                            />
                            자유 입력
                          </label>
                        )}
                        <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                          {opt.special === "none" ? "처음 고정" : "마지막 고정"}
                        </Badge>
                      </span>
                    ) : (
                      <span className="flex shrink-0 gap-0.5">
                        <Button
                          variant="outline"
                          size="icon-xs"
                          onClick={() => moveOption(q, j, -1)}
                          aria-label="보기 위로"
                          className="text-muted-foreground/70"
                        >
                          ↑
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-xs"
                          onClick={() => moveOption(q, j, 1)}
                          aria-label="보기 아래로"
                          className="text-muted-foreground/70"
                        >
                          ↓
                        </Button>
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => removeOption(q, j)}
                      className="text-muted-foreground/70 hover:text-destructive"
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => addOption(q)}
                    className="h-auto p-0"
                  >
                    + 보기 추가
                  </Button>
                  {/* "없음" contradicts ranking (you can't rank "none of these");
                      "기타" is fine there — anchored last, free text on pick. */}
                  {q.type !== "ranking" && (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => addSpecialOption(q, "none")}
                      disabled={(q.config.options ?? []).some((o) => o.special === "none")}
                      className="h-auto p-0"
                    >
                      + 없음 (처음 고정)
                    </Button>
                  )}
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => addSpecialOption(q, "other")}
                    disabled={(q.config.options ?? []).some((o) => o.special === "other")}
                    className="h-auto p-0"
                  >
                    + 기타 (마지막 고정)
                  </Button>
                </div>
                {(() => {
                  const qIdx = questions.findIndex((x) => x.id === q.id);
                  const sources = questions.filter(
                    (x, xi) =>
                      xi < qIdx && (x.type === "single" || x.type === "multi" || x.type === "ranking"),
                  );
                  if (sources.length === 0 && !q.config.optionsFrom) return null;
                  return (
                    <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      보기 가져오기
                      <select
                        value={q.config.optionsFrom?.questionId ?? ""}
                        onChange={(e) => onChangeOptionsFrom(q, e.target.value)}
                        className={cn(selectCls, "h-7 px-2 text-xs")}
                      >
                        <option value="">사용 안 함 (아래 보기 목록 사용)</option>
                        {sources.map((x) => (
                          <option key={x.id} value={x.id}>
                            {questions.findIndex((y) => y.id === x.id) + 1}. {x.prompt.slice(0, 24)}
                            에서 선택한 항목만
                          </option>
                        ))}
                      </select>
                      {q.config.optionsFrom && (
                        <span className="text-muted-foreground/70">
                          응답자가 위 문항에서 고른 보기만 표시됩니다 (아무것도 안 골랐으면 이 문항은 건너뜀)
                        </span>
                      )}
                    </label>
                  );
                })()}
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={q.config.randomizeOptions ?? false}
                    onChange={(e) => toggleRandomizeOptions(q, e.target.checked)}
                    disabled={Boolean(q.config.optionsFrom)}
                  />
                  보기 순서 무작위로 표시
                  <span className="text-muted-foreground/70">
                    {q.config.optionsFrom
                      ? "(보기 가져오기 사용 중 — 원본 순서 유지)"
                      : "(응답자마다 섞임 · 고정 보기 제외)"}
                  </span>
                </label>
              </div>
            )}

            {q.type === "matrix" && (
              <div className="ml-2 flex flex-col gap-3">
                {(["rows", "columns"] as const).map((field) => (
                  <div key={field} className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {field === "rows" ? "행 (평가 항목)" : "열 (응답 척도)"}
                    </span>
                    {(q.config[field] ?? []).map((item, j) => (
                      <div key={j} className="flex items-center gap-2">
                        <span className="text-muted-foreground/70">{field === "rows" ? "▸" : "·"}</span>
                        <Input
                          value={item}
                          onChange={(e) => onChangeListItem(q, field, j, e.target.value)}
                          className="h-7 flex-1 px-2"
                        />
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeListItem(q, field, j)}
                          className="text-muted-foreground/70 hover:text-destructive"
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => addListItem(q, field, field === "rows" ? "항목" : "선택지")}
                      className="h-auto self-start p-0"
                    >
                      + {field === "rows" ? "행 추가" : "열 추가"}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {q.type === "scale" && (
              <p className="text-sm text-muted-foreground">
                척도 {q.config.scale?.min ?? 1} – {q.config.scale?.max ?? 5}
              </p>
            )}

            {q.type === "nps" && (
              <p className="text-sm text-muted-foreground">NPS — 0~10 추천 의향 척도 (고정)</p>
            )}

            {q.type === "open" && (
              <div className="ml-2 flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={q.config.probe?.enabled ?? false}
                    onChange={(e) => onChangeProbe(q, { enabled: e.target.checked })}
                  />
                  <span className="font-medium">AI 심층 질문</span>
                  <span className="text-xs text-muted-foreground/70">
                    답변 후 AI가 이유를 파고드는 후속 질문을 던집니다
                  </span>
                </label>
                {q.config.probe?.enabled && (
                  <div className="ml-6 flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      최대 후속 질문 수
                      <Input
                        type="number"
                        min={1}
                        max={MAX_PROBES_CAP}
                        value={q.config.probe?.maxProbes ?? DEFAULT_MAX_PROBES}
                        onChange={(e) =>
                          onChangeProbe(q, { maxProbes: Number(e.target.value) }, true)
                        }
                        className="h-7 w-16 px-2"
                      />
                      <span className="text-muted-foreground/70">기본 {DEFAULT_MAX_PROBES}회</span>
                    </label>
                    <Textarea
                      value={q.config.probe?.guidance ?? ""}
                      onChange={(e) => onChangeProbe(q, { guidance: e.target.value }, true)}
                      rows={2}
                      placeholder="후속 질문 지침 (선택) — 예: 구체적인 사례와 그때의 감정을 물어보세요"
                      className="min-h-0 px-2 py-1 text-xs md:text-xs"
                    />
                  </div>
                )}
              </div>
            )}

            <details className="mt-3 text-sm">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground/70 hover:text-muted-foreground">
                메타데이터 (선택) — AI가 문항 의도를 이해해 더 정교하게 개선합니다
                {q.config.meta?.origin === "ai" && (
                  <Badge
                    variant="secondary"
                    className="ml-1.5 bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                    title="AI가 추정한 메타데이터 — 필드를 수정하면 '직접 입력'으로 전환됩니다"
                  >
                    AI 추정
                  </Badge>
                )}
                {q.config.meta?.origin === "human" && (
                  <Badge
                    variant="secondary"
                    className="ml-1.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    title="작성자가 직접 입력한 메타데이터 — AI가 덮어쓰지 않습니다"
                  >
                    직접 입력
                  </Badge>
                )}
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Input
                  value={q.config.meta?.construct ?? ""}
                  onChange={(e) => onChangeMeta(q, "construct", e.target.value)}
                  placeholder="구성 개념 (예: service_satisfaction)"
                  className="h-7 px-2 text-xs md:text-xs"
                />
                <Input
                  value={q.config.meta?.topic ?? ""}
                  onChange={(e) => onChangeMeta(q, "topic", e.target.value)}
                  placeholder="주제 태그 (예: delivery_experience)"
                  className="h-7 px-2 text-xs md:text-xs"
                />
                <select
                  value={q.config.meta?.source ?? "custom"}
                  onChange={(e) => onChangeMeta(q, "source", e.target.value)}
                  className={cn(selectCls, "h-7 px-2 text-xs")}
                >
                  <option value="custom">자체 제작 (custom)</option>
                  <option value="validated">검증 척도 원문 (validated)</option>
                  <option value="adapted">검증 척도 번안 (adapted)</option>
                </select>
                <Input
                  value={q.config.meta?.validatedScale ?? ""}
                  onChange={(e) => onChangeMeta(q, "validatedScale", e.target.value)}
                  placeholder="기반 검증 척도 (예: SERVQUAL)"
                  className="h-7 px-2 text-xs md:text-xs"
                />
                <Input
                  value={q.config.meta?.population ?? ""}
                  onChange={(e) => onChangeMeta(q, "population", e.target.value)}
                  placeholder="응답 대상 조건 (비우면 전체)"
                  className="h-7 px-2 text-xs sm:col-span-2 md:text-xs"
                />
                <Textarea
                  value={q.config.meta?.notes ?? ""}
                  onChange={(e) => onChangeMeta(q, "notes", e.target.value)}
                  rows={2}
                  placeholder="연구자 메모 — AI 개선 프롬프트에 전달됩니다"
                  className="min-h-0 px-2 py-1 text-xs sm:col-span-2 md:text-xs"
                />
              </div>
            </details>

            <details className="mt-2 text-sm">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground/70 hover:text-muted-foreground">
                표시 조건 (선택) — 특정 응답일 때만 이 문항을 노출
                {q.config.displayLogic && q.config.displayLogic.conditions.length > 0 && (
                  <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                    조건부: {describeLogic(q.config.displayLogic, questions.slice(0, i))}
                  </span>
                )}
              </summary>
              <div className="mt-2">
                <DisplayLogicEditor
                  surveyId={surveyId}
                  question={q}
                  priorQuestions={questions.slice(0, i)}
                  warnings={warningsByQ[q.id] ?? []}
                  onChange={(logic, src) => onChangeDisplayLogic(q, logic, src)}
                />
              </div>
            </details>
            </li>
          </div>
        ))}
        {insertZone(questions.length)}
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <Button
          variant="outline"
          onClick={() => onAddAt(questions.length)}
          className="self-start"
        >
          + 질문 추가
        </Button>
        <PresetPicker
          existingPrompts={questions.map((q) => q.prompt)}
          pending={status === "saving"}
          onAdd={(keys) => {
            setStatus("saving");
            startTransition(async () => {
              try {
                const created = (await addDemographicPresets(surveyId, keys)) as Q[];
                commit((qs) => [...qs, ...created.map((q) => ({ ...q, config: q.config ?? {} }))]);
                setStatus("saved");
              } catch {
                setStatus("idle");
              }
            });
          }}
        />
        {/* US-905: insert questions from a block/question template */}
        {!selecting && (
          <BlockInsertPicker
            surveyId={surveyId}
            atIndex={questions.length}
            onInserted={() => router.refresh()}
          />
        )}
        {/* Enter the save-as-template flow (unit chosen explicitly in the bar). */}
        {questions.length > 0 && !selecting && (
          <Button
            variant="outline"
            onClick={() => {
              setSaveUnit("survey");
              setSelecting(true);
            }}
          >
            템플릿으로 저장
          </Button>
        )}
      </div>

      {selecting && (
        <SaveTemplateBar
          surveyId={surveyId}
          unit={saveUnit}
          onUnitChange={setSaveUnit}
          totalCount={questions.length}
          selectedQuids={[...selectedQuids]}
          onCancel={() => {
            setSelecting(false);
            setSelectedQuids(new Set());
          }}
          onSaved={() => {
            setSelecting(false);
            setSelectedQuids(new Set());
          }}
        />
      )}
    </div>
  );
}

/**
 * Save-as-template bar. The reuse granularity is an explicit choice (US-904 +
 * feedback): 설문 전체 saves every question as a `survey` template, 선택 블록
 * saves the checked questions as a `block`. This replaces the old block-only
 * bar so a full survey no longer lands as a block by accident.
 *
 * 설문 전체 delegates to saveTemplateAction (whole-survey snapshot from the DB);
 * 선택 블록 to saveQuestionsAsBlockAction, which surfaces dropped-ref notices
 * (refs to unselected questions) instead of losing them silently.
 */
function SaveTemplateBar({
  surveyId,
  unit,
  onUnitChange,
  totalCount,
  selectedQuids,
  onCancel,
  onSaved,
}: {
  surveyId: string;
  unit: "survey" | "block";
  onUnitChange: (u: "survey" | "block") => void;
  totalCount: number;
  selectedQuids: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const isBlock = unit === "block";
  const count = isBlock ? selectedQuids.length : totalCount;
  const canSave =
    !pending && name.trim().length >= 2 && (isBlock ? selectedQuids.length > 0 : totalCount > 0);

  function onSave() {
    setError(null);
    setNotice(null);
    setSaved(null);
    startTransition(async () => {
      if (isBlock) {
        const r = await saveQuestionsAsBlockAction(surveyId, selectedQuids, name, {
          description,
          kind: "block",
        });
        if (r.error) return setError(r.error);
        if (r.droppedNotice) return setNotice(r.droppedNotice); // keep bar so notice is seen
        return onSaved();
      }
      const r = await saveTemplateAction(surveyId, name, description);
      if (r.error) return setError(r.error);
      const d = r.derived;
      if (d && d.blocks + d.questions > 0) {
        // Keep the bar so the auto-decompose result is seen, then let the user
        // dismiss (mirrors the block-save notice pattern, but as a success).
        return setSaved(
          `설문 템플릿 저장 완료 — 블록 ${d.blocks}개·문항 ${d.questions}개도 자동 생성되었습니다.`,
        );
      }
      onSaved();
    });
  }

  return (
    <div className="sticky bottom-2 z-10 flex flex-col gap-2 rounded-xl border bg-card p-3 text-card-foreground shadow-lg">
      {/* Explicit unit segmented control. */}
      <div className="inline-flex w-fit rounded-lg border bg-muted/40 p-0.5 text-sm">
        {(["survey", "block"] as const).map((u) => (
          <button
            key={u}
            type="button"
            onClick={() => onUnitChange(u)}
            disabled={pending}
            className={`rounded-md px-3 py-1 transition-colors ${
              unit === u
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {u === "survey" ? "설문 전체" : "선택 블록"}
          </button>
        ))}
      </div>
      <p className="text-sm font-medium">
        {isBlock
          ? `블록으로 저장 — 선택한 문항 ${count}개`
          : `설문 전체를 템플릿으로 저장 — 문항 ${count}개`}
      </p>
      <p className="text-xs text-muted-foreground/70">
        {isBlock
          ? "체크박스로 고른 문항만 재사용 블록으로 저장합니다. 다른 설문에 삽입해 씁니다."
          : "설문의 모든 문항을 통째로 저장합니다. 이 템플릿에서 새 설문을 바로 만들 수 있습니다."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isBlock ? "블록 이름 (예: 만족도 척도 세트)" : "템플릿 이름 (예: NPS + 이탈 사유)"}
          className="min-w-[200px] flex-1"
        />
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="설명 (선택)"
          className="min-w-[200px] flex-1"
        />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          취소
        </Button>
        <Button size="sm" disabled={!canSave} onClick={onSave}>
          {pending ? "저장 중…" : isBlock ? "블록 저장" : "설문 저장"}
        </Button>
      </div>
      {isBlock && selectedQuids.length === 0 && (
        <p className="text-xs text-muted-foreground/70">문항 체크박스로 저장할 문항을 선택하세요.</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {notice && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          ⚠️ {notice} · 저장은 완료되었습니다.{" "}
          <button type="button" className="font-medium underline" onClick={onSaved}>
            닫기
          </button>
        </p>
      )}
      {saved && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          ✓ {saved}{" "}
          <button type="button" className="font-medium underline" onClick={onSaved}>
            닫기
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * US-906: save a single question as a reusable question template (kind='question').
 * Default name = prompt abbreviation, editable inline before saving.
 */
function SaveQuestionButton({ surveyId, question }: { surveyId: string; question: Q }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function openForm() {
    setName(question.prompt.slice(0, 40));
    setError(null);
    setSaved(false);
    setOpen((v) => !v);
  }

  return (
    <div className="relative">
      <Button variant="outline" size="sm" onClick={openForm} title="이 문항을 재사용 문항으로 저장">
        문항 저장
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 rounded-lg border bg-card p-3 text-card-foreground shadow-lg">
          {saved ? (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              저장했습니다. 라이브러리 &ldquo;개별 문항&rdquo; 탭에서 확인하세요.
            </p>
          ) : (
            <>
              <p className="mb-1.5 text-xs text-muted-foreground">재사용 문항 이름</p>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="mb-2 h-8" />
              {error && <p className="mb-1 text-xs text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  취소
                </Button>
                <Button
                  size="sm"
                  disabled={pending || name.trim().length < 2}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const r = await saveQuestionsAsBlockAction(surveyId, [question.quid], name, {
                        kind: "question",
                      });
                      if (r.error) setError(r.error);
                      else setSaved(true);
                    });
                  }}
                >
                  {pending ? "저장 중…" : "저장"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type InsertableTemplate = {
  id: string;
  name: string;
  kind: string;
  questions: { quid: string; type: string; prompt: string }[];
};

const KIND_LABEL: Record<string, string> = { survey: "설문", block: "블록", question: "문항" };

/**
 * US-905: insert questions from a saved block/question template. Lists
 * templates, previews their questions, and inserts only the checked ones at
 * the end of the survey. Reuses the preset-picker popover pattern.
 */
function BlockInsertPicker({
  surveyId,
  atIndex,
  onInserted,
}: {
  surveyId: string;
  atIndex: number;
  onInserted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [templates, setTemplates] = useState<InsertableTemplate[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const active = templates.find((t) => t.id === activeId) ?? null;

  function openPicker() {
    setOpen((v) => !v);
    if (!loaded) {
      startTransition(async () => {
        const list = await listInsertableTemplatesAction();
        setTemplates(list);
        setLoaded(true);
      });
    }
  }

  function selectTemplate(t: InsertableTemplate) {
    setActiveId(t.id);
    setPicked(new Set(t.questions.map((q) => q.quid))); // default: all
    setNotice(null);
    setError(null);
  }

  function toggle(quid: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(quid)) next.delete(quid);
      else next.add(quid);
      return next;
    });
  }

  return (
    <div className="relative">
      <Button variant="outline" onClick={openPicker}>
        + 문항 블록
      </Button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-[28rem] rounded-lg border bg-card p-3 text-card-foreground shadow-lg">
          {!active ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                저장된 블록·문항에서 필요한 문항만 골라 삽입합니다.
              </p>
              {!loaded ? (
                <p className="text-sm text-muted-foreground">불러오는 중…</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  저장된 템플릿이 없습니다. 문항을 골라 &ldquo;블록으로 저장&rdquo;해 보세요.
                </p>
              ) : (
                <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                  {templates.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 rounded-md border p-2 text-left text-xs hover:bg-muted/50"
                        onClick={() => selectTemplate(t)}
                      >
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          {KIND_LABEL[t.kind] ?? t.kind}
                        </span>
                        <span className="font-medium">{t.name}</span>
                        <span className="ml-auto text-muted-foreground">{t.questions.length}문항</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:underline"
                  onClick={() => setActiveId(null)}
                >
                  ← 목록
                </button>
                <span className="truncate text-sm font-medium">{active.name}</span>
              </div>
              <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                {active.questions.map((q) => (
                  <li key={q.quid}>
                    <label className="flex cursor-pointer items-start gap-1.5 rounded-md border p-2 text-xs hover:bg-muted/50">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={picked.has(q.quid)}
                        onChange={() => toggle(q.quid)}
                      />
                      <span className="min-w-0">{q.prompt}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
              {notice && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">⚠️ {notice}</p>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  닫기
                </Button>
                <Button
                  size="sm"
                  disabled={picked.size === 0 || pending}
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    startTransition(async () => {
                      const r = await insertTemplateQuestionsAction(
                        surveyId,
                        active.id,
                        atIndex,
                        [...picked],
                      );
                      if (r.error) {
                        setError(r.error);
                        return;
                      }
                      if (r.droppedNotice) setNotice(r.droppedNotice);
                      setOpen(false);
                      setActiveId(null);
                      onInserted();
                    });
                  }}
                >
                  {picked.size ? `${picked.size}개 문항 삽입` : "문항 삽입"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * US-602: demographic preset picker — standard Korean survey background
 * questions (갤럽/NBS/행안부 categories; sources in the preset module).
 */
function PresetPicker({
  existingPrompts,
  pending,
  onAdd,
}: {
  existingPrompts: string[];
  pending: boolean;
  onAdd: (keys: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const prompts = new Set(existingPrompts);

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="relative">
      <Button variant="outline" onClick={() => setOpen((v) => !v)}>
        + 데모그래픽 프리셋
      </Button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-96 rounded-lg border bg-card p-3 text-card-foreground shadow-lg">
          <p className="mb-2 text-xs text-muted-foreground">
            한국 여론조사·공식 인구통계 표준 보기를 그대로 사용하는 배경 문항입니다. 층화(응답
            쿼터) 기준으로 쓰려면 설문 앞쪽으로 옮기세요.
          </p>
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {DEMOGRAPHIC_PRESETS.map((p) => {
              // Advisory only (prompt match) — the two region presets share a
              // prompt, and edits can drift it; duplicates are still allowed.
              const added = prompts.has(p.prompt);
              return (
                <li key={p.key}>
                  <label
                    className={cn(
                      "flex cursor-pointer flex-col rounded-md border p-2 text-xs",
                      picked.has(p.key) ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={picked.has(p.key)}
                        onChange={() => toggle(p.key)}
                      />
                      <span className="font-medium">{p.name}</span>
                      <span className="text-muted-foreground">· {p.standard}</span>
                      {added && (
                        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          추가됨
                        </span>
                      )}
                    </span>
                    <span className="mt-1 truncate pl-5 text-muted-foreground">
                      {p.options.join(" / ")}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              닫기
            </Button>
            <Button
              size="sm"
              disabled={picked.size === 0 || pending}
              onClick={() => {
                onAdd([...picked]);
                setPicked(new Set());
                setOpen(false);
              }}
            >
              {picked.size ? `${picked.size}개 문항 추가` : "문항 추가"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
