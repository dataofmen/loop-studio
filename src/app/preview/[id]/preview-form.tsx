"use client";

import { useEffect, useRef, useState } from "react";
import { questionVisible, type DisplayLogic } from "@/lib/display-logic";
import {
  displayOptions,
  hashSeed,
  normalizeOptions,
  normalizeProbe,
  type ConfigOption,
} from "@/lib/question-config";
import { carriedOptionLabels, normalizeOptionsFrom } from "@/lib/carry-forward";
import { OTHER_TEXT_MAX } from "@/lib/other-text";
import { toggleMultiExclusive } from "@/lib/none-exclusive";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";
type Config = {
  options?: ConfigOption[];
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  rows?: string[];
  columns?: string[];
  // ranking: how many options to rank (top-N). Absent/0 = rank all options.
  limit?: number;
  // conditional display: show this question only when the condition holds
  displayLogic?: DisplayLogic;
  // open questions: AI follow-up probing (US-011..013); raw jsonb, normalizeProbe() reads it
  probe?: unknown;
  // shuffle non-special options per respondent (specials stay anchored)
  randomizeOptions?: boolean;
  // carry-forward: options = the ones selected in an earlier question
  optionsFrom?: unknown;
};

/** Effective number of ranks to collect for a ranking question. */
function rankLimit(config: Config): number {
  const total = normalizeOptions(config.options).length;
  const l = config.limit ?? 0;
  return l > 0 ? Math.min(l, total) : total;
}
type Q = { id: string; type: QuestionType; prompt: string; config: Config };
type AnswerValue = string | string[] | Record<string, string>;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Typeform/Tally-style one-question-per-screen survey walkthrough, mobile-first.
 * Big tap targets, progress bar, auto-advance on single/scale, Enter to advance.
 *
 * This renders the questionnaire exactly as a respondent would see it — display
 * logic, carry-forward, option shuffling and "other" inputs all evaluate live —
 * but nothing is stored: the app designs and simulates surveys, it doesn't
 * field them. Answers exist only in component state so the author can walk
 * every branch of their own logic.
 */
export function PreviewForm({
  questions,
  title,
  welcomeMessage = null,
  closingMessage = null,
  backHref,
}: {
  questions: Q[];
  title: string;
  welcomeMessage?: string | null;
  closingMessage?: string | null;
  /** Where "돌아가기" goes — the preview takes over the whole window. */
  backHref: string;
}) {
  // step: -1 = intro, 0..n-1 = questions
  const [step, setStep] = useState(-1);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Free text typed for a selected special "other" option, keyed by question
  // id. Lives outside `answers` so labels stay pure for skip logic.
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});
  const otherTextsRef = useRef(otherTexts);
  useEffect(() => {
    otherTextsRef.current = otherTexts;
  }, [otherTexts]);

  // One random seed per walkthrough: option shuffles stay stable across
  // re-renders and back-navigation, but differ between respondents.
  const [shuffleSeed] = useState(() => Math.floor(Math.random() * 0xffffffff));
  /** An option plus an optional display-only override of its label. */
  type DisplayOption = ReturnType<typeof normalizeOptions>[number] & { display?: string };

  /** Respondent-facing option order (none-first / other-last / optional shuffle). */
  function optionsFor(ql: Q): DisplayOption[] {
    // Carry-forward: options are the respondent's own selections in the source
    // question, in the source's authored order (no shuffle — order is meaning).
    const from = normalizeOptionsFrom(ql.config.optionsFrom);
    if (from) {
      const src = questions.find((s) => s.id === from.questionId);
      // Render-time data comes from state (answers), not the ref mirror.
      const labels = src ? carriedOptionLabels(src.config.options, answers[src.id]) : [];
      const opts: DisplayOption[] = normalizeOptions(labels);
      // A carried "other" pick shows what the respondent actually typed for it
      // (display only — the stored value stays the source label, so skip
      // logic, aggregation and carry clamps keep matching).
      if (src) {
        const srcOther = normalizeOptions(src.config.options).find((o) => o.special === "other");
        const typed = (otherTexts[src.id] ?? "").trim();
        if (srcOther && typed) {
          return opts.map((o) =>
            o.label === srcOther.label ? { ...o, display: `${o.label}: ${typed}` } : o,
          );
        }
      }
      return opts;
    }
    return displayOptions(
      normalizeOptions(ql.config.options),
      ql.config.randomizeOptions === true,
      hashSeed(`${shuffleSeed}:${ql.id}`),
    );
  }

  const total = questions.length;
  const q = step >= 0 ? questions[step] : null;
  const progress = step < 0 ? 0 : Math.round(((step) / total) * 100);

  // Keep a ref of the latest answers so auto-advance (fired from a timer, before
  // React re-renders) evaluates skip logic against the just-set answer.
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);
  useEffect(() => () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); }, []);

  function visibleAt(idx: number, ans: Record<string, AnswerValue>): boolean {
    const ql = questions[idx];
    if (!ql) return false;
    if (!questionVisible(ql.config.displayLogic, ans)) return false;
    // A carry-forward question with nothing selected in its source has no
    // options to show — skip it like an unsatisfied display condition.
    const from = normalizeOptionsFrom(ql.config.optionsFrom);
    if (from) {
      const src = questions.find((s) => s.id === from.questionId);
      if (!src || carriedOptionLabels(src.config.options, ans[src.id]).length === 0) return false;
    }
    return true;
  }
  /** Next visible question index after `from`, or `total` if none remain. */
  function nextVisible(from: number, ans: Record<string, AnswerValue>): number {
    let n = from + 1;
    while (n < total && !visibleAt(n, ans)) n++;
    return n;
  }
  /** Previous visible question index before `from`, or -1 (intro). */
  function prevVisible(from: number, ans: Record<string, AnswerValue>): number {
    let n = from - 1;
    while (n >= 0 && !visibleAt(n, ans)) n--;
    return n;
  }

  function goForward() {
    setError(null);
    const n = nextVisible(step, answersRef.current);
    if (n >= total) { setDone(true); return; }
    setStep(n);
  }

  function goBack() {
    setError(null);
    setStep(prevVisible(step, answersRef.current));
  }

  function start() {
    setError(null);
    const n = nextVisible(-1, answersRef.current);
    if (n >= total) { setDone(true); return; }
    setStep(n);
  }

  /** Back to the intro with a clean slate, to walk a different logic branch. */
  function restart() {
    setError(null);
    setAnswers({});
    setOtherTexts({});
    setDone(false);
    setStep(-1);
  }

  /** Advance from the current question. */
  function advance() {
    goForward();
  }

  function setOpen(qid: string, v: string) {
    setAnswers((a) => ({ ...a, [qid]: v }));
  }

  function setOtherText(qid: string, v: string) {
    setOtherTexts((m) => ({ ...m, [qid]: v }));
  }
  /** Deselecting the "other" option discards whatever was typed for it. */
  function dropOtherText(qid: string) {
    setOtherTexts((m) => {
      if (!(qid in m)) return m;
      const { [qid]: _drop, ...rest } = m;
      return rest;
    });
  }

  function setSingle(qid: string, v: string, autoAdvance: boolean) {
    setAnswers((a) => ({ ...a, [qid]: v }));
    if (autoAdvance) {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => goForward(), 260);
    }
  }
  // US-003: "없음" (special none) is mutually exclusive with everything else.
  function toggleMulti(qid: string, v: string, noneLabel?: string) {
    setAnswers((a) => {
      const cur = Array.isArray(a[qid]) ? (a[qid] as string[]) : [];
      return { ...a, [qid]: toggleMultiExclusive(cur, v, noneLabel) };
    });
  }
  function setMatrixCell(qid: string, row: string, col: string) {
    setAnswers((a) => {
      const cur = (a[qid] && typeof a[qid] === "object" && !Array.isArray(a[qid])
        ? (a[qid] as Record<string, string>)
        : {});
      return { ...a, [qid]: { ...cur, [row]: col } };
    });
  }
  // Tap-to-rank: tapping an unranked option assigns it the next rank; tapping a
  // ranked option removes it and the later picks renumber automatically. Nothing
  // is pre-ranked, and picking stops at `limit` (top-N) options.
  function toggleRank(qid: string, opt: string, limit: number) {
    setAnswers((a) => {
      const cur = Array.isArray(a[qid]) ? [...(a[qid] as string[])] : [];
      const idx = cur.indexOf(opt);
      if (idx >= 0) {
        cur.splice(idx, 1);
        return { ...a, [qid]: cur };
      }
      if (cur.length >= limit) return a; // at the top-N cap
      return { ...a, [qid]: [...cur, opt] };
    });
  }

  // ----- Completion screen -----
  if (done) {
    return (
      <Screen backHref={backHref}>
        <div className="flex flex-col items-center text-center">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-indigo-600 text-4xl text-white">
            ✓
          </div>
          <h2 className="text-2xl font-bold">마지막 화면</h2>
          {/* The author's closing copy, shown as respondents would see it. */}
          <p className="mt-3 whitespace-pre-line text-gray-500">
            {closingMessage || "소중한 의견 감사합니다 🙏"}
          </p>
          <button
            onClick={restart}
            className="mt-8 rounded-xl border-2 border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 transition hover:border-gray-300"
          >
            처음부터 다시 보기
          </button>
        </div>
      </Screen>
    );
  }

  // ----- Intro screen -----
  if (step < 0) {
    return (
      <Screen progress={0} backHref={backHref}>
        <div className="flex flex-col">
          <span className="mb-3 text-sm font-medium uppercase tracking-wide text-indigo-600">설문</span>
          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{title}</h1>
          {welcomeMessage && (
            <p className="mt-4 whitespace-pre-line text-lg text-gray-600">{welcomeMessage}</p>
          )}
          <p className="mt-4 text-gray-500">{total}개 문항 · 약 {Math.max(1, Math.round(total * 0.3))}분 소요</p>
          <button
            onClick={start}
            className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-4 text-lg font-semibold text-white transition active:scale-[0.99] sm:w-auto"
          >
            시작하기 <span aria-hidden>→</span>
          </button>
          <p className="mt-3 text-xs text-gray-400">Enter 키로도 진행할 수 있어요</p>
        </div>
      </Screen>
    );
  }

  // ----- Question screen -----
  const config = q!.config;
  const answered = answers[q!.id];
  const hasAnswer = (() => {
    if (q!.type === "multi") return Array.isArray(answered) && answered.length > 0;
    if (q!.type === "ranking")
      return Array.isArray(answered) && answered.length === rankLimit(config);
    if (q!.type === "matrix") {
      const rows = config.rows ?? [];
      const obj = answered && typeof answered === "object" && !Array.isArray(answered)
        ? (answered as Record<string, string>)
        : {};
      return rows.length > 0 && rows.every((r) => obj[r]);
    }
    return answered != null && answered !== "";
  })();
  // A single question with its text-input "other" option picked suppresses
  // auto-advance (the respondent is typing) and needs an explicit continue
  // button. A noText "other" behaves like a normal option.
  const singleOtherSelected =
    q!.type === "single" &&
    (() => {
      const otherOpt = optionsFor(q!).find((o) => o.special === "other" && !o.noText);
      return otherOpt != null && answered === otherOpt.label;
    })();
  const needsButton =
    q!.type === "multi" || q!.type === "open" || q!.type === "ranking" || q!.type === "matrix" ||
    singleOtherSelected;
  // No further visible question after this one (skip logic may hide the tail).
  const lastVisible = nextVisible(step, answers) >= total;
  // AI follow-up probing is design metadata: it's part of the exported
  // questionnaire spec, but nothing in this app generates follow-ups, so the
  // preview states that rather than pretending to ladder.
  const probeConfig = q!.type === "open" ? normalizeProbe(config.probe) : undefined;
  const probeNote = probeConfig?.enabled
    ? `AI 후속 질문 최대 ${probeConfig.maxProbes}회로 설정된 문항입니다 — 미리보기에서는 실제 후속 질문을 생성하지 않습니다.`
    : null;

  return (
    <Screen progress={progress} backHref={backHref} onEnter={() => (hasAnswer || q!.type === "open") && advance()}>
      <div className="flex flex-col">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-indigo-600">
          <span>{step + 1}</span><span className="text-gray-300">→</span><span className="text-gray-400">{total}</span>
        </div>
        <h2 className="mb-6 text-2xl font-semibold leading-snug sm:text-3xl">{q!.prompt}</h2>

        {/* single — picking "other" opens an inline text input (no auto-advance),
            unless the author turned its text input off (noText) */}
        {q!.type === "single" &&
          (() => {
            const opts = optionsFor(q!);
            const textOther = opts.find((o) => o.special === "other" && !o.noText);
            return (
              <div className="flex flex-col gap-3">
                {opts.map((opt, i) => {
                  const opensText = opt.special === "other" && !opt.noText;
                  return (
                    <OptionButton
                      key={opt.id}
                      letter={LETTERS[i]}
                      label={opt.display ?? opt.label}
                      selected={answered === opt.label}
                      onClick={() => {
                        if (!opensText) dropOtherText(q!.id);
                        setSingle(q!.id, opt.label, !opensText);
                      }}
                    />
                  );
                })}
                {textOther && answered === textOther.label && (
                  <OtherTextInput
                    value={otherTexts[q!.id] ?? ""}
                    onChange={(v) => setOtherText(q!.id, v)}
                  />
                )}
              </div>
            );
          })()}

        {/* multi — deselecting "other" discards its typed text */}
        {q!.type === "multi" &&
          (() => {
            const opts = optionsFor(q!);
            const otherOpt = opts.find((o) => o.special === "other");
            const noneOpt = opts.find((o) => o.special === "none");
            const picked = Array.isArray(answered) ? (answered as string[]) : [];
            return (
              <div className="flex flex-col gap-3">
                {opts.map((opt, i) => (
                  <OptionButton
                    key={opt.id}
                    letter={LETTERS[i]}
                    label={opt.display ?? opt.label}
                    selected={picked.includes(opt.label)}
                    multi
                    onClick={() => {
                      // Deselecting "other" — or selecting "none", which clears
                      // it — discards the typed other text.
                      const otherPicked = otherOpt != null && picked.includes(otherOpt.label);
                      if (opt.special === "other" && picked.includes(opt.label)) dropOtherText(q!.id);
                      if (opt.special === "none" && !picked.includes(opt.label) && otherPicked)
                        dropOtherText(q!.id);
                      toggleMulti(q!.id, opt.label, noneOpt?.label);
                    }}
                  />
                ))}
                {otherOpt && !otherOpt.noText && picked.includes(otherOpt.label) && (
                  <OtherTextInput
                    value={otherTexts[q!.id] ?? ""}
                    onChange={(v) => setOtherText(q!.id, v)}
                  />
                )}
              </div>
            );
          })()}

        {/* scale */}
        {q!.type === "scale" &&
          (() => {
            const min = config.scale?.min ?? 1;
            const max = config.scale?.max ?? 5;
            const nums = Array.from({ length: max - min + 1 }, (_, k) => min + k);
            return (
              <div>
                <div className="flex flex-wrap gap-2">
                  {nums.map((n) => (
                    <button
                      key={n}
                      onClick={() => setSingle(q!.id, String(n), true)}
                      className={`h-14 min-w-14 flex-1 rounded-xl border-2 text-lg font-semibold transition active:scale-95 ${
                        answered === String(n)
                          ? "border-indigo-600 bg-indigo-600 text-white"
                          : "border-gray-200 hover:border-indigo-400"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-xs text-gray-400">
                  <span>{config.scale?.minLabel ?? min}</span>
                  <span>{config.scale?.maxLabel ?? max}</span>
                </div>
              </div>
            );
          })()}

        {/* nps (0–10) — uniform grid cells (no flex stretch), NPS zone colors */}
        {q!.type === "nps" &&
          (() => {
            // A fixed 11-column grid keeps every cell identical regardless of how
            // the row fills, unlike flex-wrap+flex-1 which stretched 9 and 10.
            const zoneClass = (n: number, selected: boolean) => {
              const zone = n <= 6 ? "detractor" : n <= 8 ? "passive" : "promoter";
              if (selected) {
                return zone === "detractor"
                  ? "border-rose-500 bg-rose-500 text-white"
                  : zone === "passive"
                    ? "border-amber-500 bg-amber-500 text-white"
                    : "border-emerald-500 bg-emerald-500 text-white";
              }
              return zone === "detractor"
                ? "border-rose-200 bg-rose-50 text-rose-600 hover:border-rose-400"
                : zone === "passive"
                  ? "border-amber-200 bg-amber-50 text-amber-600 hover:border-amber-400"
                  : "border-emerald-200 bg-emerald-50 text-emerald-600 hover:border-emerald-400";
            };
            return (
              <div>
                <div className="grid grid-cols-11 gap-1 sm:gap-1.5">
                  {Array.from({ length: 11 }, (_, n) => (
                    <button
                      key={n}
                      onClick={() => setSingle(q!.id, String(n), true)}
                      className={`flex aspect-square items-center justify-center rounded-lg border-2 text-sm font-semibold tabular-nums transition active:scale-95 sm:text-base ${zoneClass(
                        n,
                        answered === String(n),
                      )}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-xs text-gray-400">
                  <span>0 · 전혀 추천 안 함</span>
                  <span>적극 추천함 · 10</span>
                </div>
              </div>
            );
          })()}

        {/* ranking — tap options in order of preference (nothing pre-ranked);
            a ranked special "other" opens the same inline text input */}
        {q!.type === "ranking" &&
          (() => {
            const opts = optionsFor(q!);
            const otherOpt = opts.find((o) => o.special === "other");
            const picks = Array.isArray(answered) ? (answered as string[]) : [];
            const limit = rankLimit(config);
            const capped = picks.length >= limit;
            return (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-gray-500">
                  {config.limit && config.limit > 0
                    ? `선호하는 순서대로 ${limit}개를 선택하세요.`
                    : "선호하는 순서대로 모두 선택하세요."}{" "}
                  <span className={capped ? "font-medium text-indigo-600" : "text-gray-400"}>
                    ({picks.length}/{limit})
                  </span>
                </p>
                <div className="flex flex-col gap-2">
                  {opts.map((o) => {
                    const opt = o.label;
                    const rank = picks.indexOf(opt); // -1 if not yet picked
                    const picked = rank >= 0;
                    const disabled = !picked && capped;
                    return (
                      <button
                        key={o.id}
                        onClick={() => {
                          // Unranking "other" discards its typed text.
                          if (o.special === "other" && picked) dropOtherText(q!.id);
                          toggleRank(q!.id, opt, limit);
                        }}
                        disabled={disabled}
                        className={`flex items-center gap-3 rounded-xl border-2 px-4 py-4 text-left text-lg transition active:scale-[0.99] ${
                          picked
                            ? "border-indigo-600 bg-indigo-50"
                            : disabled
                              ? "border-gray-100 text-gray-300"
                              : "border-gray-200 hover:border-indigo-400"
                        }`}
                      >
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold ${
                            picked
                              ? "border-indigo-600 bg-indigo-600 text-white"
                              : "border-gray-300 text-transparent"
                          }`}
                        >
                          {picked ? rank + 1 : "•"}
                        </span>
                        <span className="flex-1">{o.display ?? opt}</span>
                        {picked && <span className="shrink-0 text-xs text-indigo-600">{rank + 1}순위 · 탭하여 해제</span>}
                      </button>
                    );
                  })}
                </div>
                {otherOpt && !otherOpt.noText && picks.includes(otherOpt.label) && (
                  <OtherTextInput
                    value={otherTexts[q!.id] ?? ""}
                    onChange={(v) => setOtherText(q!.id, v)}
                  />
                )}
              </div>
            );
          })()}

        {/* matrix — one row per sub-question, columns as choices */}
        {q!.type === "matrix" &&
          (() => {
            const rows = config.rows ?? [];
            const cols = config.columns ?? [];
            const obj =
              answered && typeof answered === "object" && !Array.isArray(answered)
                ? (answered as Record<string, string>)
                : {};
            return (
              <div className="flex flex-col gap-4">
                {rows.map((row) => (
                  <div key={row}>
                    <p className="mb-2 text-base font-medium">{row}</p>
                    <div className="flex flex-wrap gap-2">
                      {cols.map((col) => (
                        <button
                          key={col}
                          onClick={() => setMatrixCell(q!.id, row, col)}
                          className={`rounded-lg border-2 px-3 py-2 text-sm transition active:scale-95 ${
                            obj[row] === col
                              ? "border-indigo-600 bg-indigo-50 font-medium"
                              : "border-gray-200 hover:border-indigo-400"
                          }`}
                        >
                          {col}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

        {/* open */}
        {q!.type === "open" && (
          <>
            <textarea
              autoFocus
              rows={4}
              value={(answered as string) ?? ""}
              onChange={(e) => setOpen(q!.id, e.target.value)}
              placeholder="자유롭게 작성해 주세요…"
              className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-lg outline-none focus:border-indigo-500"
            />
            {probeNote && (
              <p className="mt-3 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/50 px-3 py-2 text-sm text-indigo-700">
                {probeNote}
              </p>
            )}
          </>
        )}

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        {/* nav */}
        <div className="mt-8 flex items-center justify-between">
          <button onClick={goBack} className="text-sm text-gray-400 hover:text-gray-700">
            ← 이전
          </button>
          {(needsButton || lastVisible) && (
            <button
              onClick={advance}
              disabled={
                (q!.type === "multi" || q!.type === "matrix" || q!.type === "ranking") && !hasAnswer
              }
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-40"
            >
              {lastVisible ? "마치기" : "다음"} <span aria-hidden>→</span>
            </button>
          )}
        </div>
      </div>
    </Screen>
  );
}

/** Inline free-text input shown while the special "other" option is selected. */
function OtherTextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      autoFocus
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={OTHER_TEXT_MAX}
      placeholder="기타 내용을 입력해 주세요…"
      className="w-full rounded-xl border-2 border-indigo-200 bg-indigo-50/40 px-4 py-3 text-lg outline-none focus:border-indigo-500"
    />
  );
}

function OptionButton({
  letter,
  label,
  selected,
  multi,
  onClick,
}: {
  letter: string;
  label: string;
  selected: boolean;
  multi?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-3 rounded-xl border-2 px-4 py-4 text-left text-lg transition active:scale-[0.99] ${
        selected ? "border-indigo-600 bg-indigo-50" : "border-gray-200 hover:border-indigo-400"
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-sm font-semibold ${
          selected ? "border-indigo-600 bg-indigo-600 text-white" : "border-gray-300 text-gray-400 group-hover:border-indigo-400"
        } ${multi ? "rounded-md" : "rounded-md"}`}
      >
        {selected && multi ? "✓" : letter}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

function Screen({
  children,
  progress,
  backHref,
  onEnter,
}: {
  children: React.ReactNode;
  progress?: number;
  backHref: string;
  onEnter?: () => void;
}) {
  useEffect(() => {
    if (!onEnter) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && !e.metaKey)) {
        e.preventDefault();
        onEnter();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onEnter]);

  return (
    <main className="relative flex min-h-[100dvh] flex-col bg-neutral-50">
      {progress != null && (
        <div className="fixed inset-x-0 top-0 z-10 h-1 bg-gray-200">
          <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div className="fixed inset-x-0 top-0 z-10 flex items-center justify-between gap-3 px-3 py-2">
        <a
          href={backHref}
          className="rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-gray-700 shadow-sm ring-1 ring-gray-200 hover:text-gray-900"
        >
          ← 설문으로 돌아가기
        </a>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
          미리보기 · 저장되지 않음
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-lg">{children}</div>
      </div>
    </main>
  );
}
