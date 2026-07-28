/**
 * US-006: QConfig consumer contract — the carry-forward class of bugs
 * ("new config field silently ignored by a consumer") made structural.
 *
 * The canonical behavioral field list of `QConfig` (question-diff.ts) lives
 * here as ONE constant, and every consumer group declares, per field, either
 * how it handles it or WHY it doesn't apply. Two enforcement layers:
 *
 *  1. Compile time — `keyof QConfig` must equal `QCONFIG_FIELDS` (both
 *     directions), and each consumer record is `Record<QConfigField, …>`,
 *     so adding a QConfig field without touching this file fails `typecheck`,
 *     and each missing per-consumer declaration is its own type error.
 *  2. Runtime (qconfig-contract.test.ts) — every declaration must carry a
 *     non-blank `where`/`reason`, so nobody can satisfy the type with "".
 *
 * ── 새 QConfig 필드 추가 체크리스트 (developer checklist) ──
 *  1. question-diff.ts QConfig에 필드 추가 → typecheck가 이 파일의
 *     QCONFIG_FIELDS 불일치로 실패한다. 필드를 상수에 추가.
 *  2. 그러면 QCONFIG_CONSUMERS의 10개 소비처 전부가 타입 에러가 된다 —
 *     각 소비처 코드를 실제로 갱신(또는 해당 없음 사유를 명시)하며 선언을 채운다.
 *     markdown 그룹을 "handled"로 선언하면 survey-markdown-contract.test.ts가
 *     정본 픽스처에 그 필드가 실제로 실려 왕복하는지까지 검사한다.
 *  3. "n/a"는 게으름이 아니라 판단이다: 사유가 설명이 안 되면 처리 누락이다.
 *  4. 회고 원칙 ③(소비처 전수 갱신)의 기계화 — grep 대신 이 파일이 실패한다.
 */

import type { QConfig } from "@/lib/question-diff";

/** Single source of truth: QConfig's behavioral fields. */
export const QCONFIG_FIELDS = [
  "options",
  "scale",
  "rows",
  "columns",
  "limit",
  "displayLogic",
  "probe",
  "randomizeOptions",
  "optionsFrom",
  "meta",
  "sourceQuid",
] as const;

export type QConfigField = (typeof QCONFIG_FIELDS)[number];

// Compile-time equality with the real type, both directions. A field added to
// QConfig but not QCONFIG_FIELDS (or vice versa) turns these into `never`
// mismatches and fails typecheck.
type _MissingFromConst = Exclude<keyof QConfig, QConfigField>; // expect never
type _ExtraInConst = Exclude<QConfigField, keyof QConfig>; // expect never
const _assertNoMissing: _MissingFromConst extends never ? true : never = true;
const _assertNoExtra: _ExtraInConst extends never ? true : never = true;
void _assertNoMissing;
void _assertNoExtra;

/** How one consumer group treats one field. */
export type FieldHandling =
  | { status: "handled"; where: string }
  | { status: "n/a"; reason: string };

export const CONSUMER_GROUPS = [
  "respond",
  "simulate",
  "quality",
  "lint-structure",
  "lint-logic",
  "review-input",
  "proposal-schema",
  "compare",
  "templates",
  "markdown",
] as const;

export type ConsumerGroup = (typeof CONSUMER_GROUPS)[number];

const h = (where: string): FieldHandling => ({ status: "handled", where });
const na = (reason: string): FieldHandling => ({ status: "n/a", reason });

/**
 * The contract: per consumer group, what happens to every QConfig field.
 * `Record<QConfigField, …>` makes a missing declaration a compile error at
 * the exact consumer that ignored the new field.
 */
export const QCONFIG_CONSUMERS: Record<ConsumerGroup, Record<QConfigField, FieldHandling>> = {
  // 응답 폼 + 공개 제출 경로 (r/[id]/respond-form.tsx, page.tsx, actions.ts)
  respond: {
    options: h("optionsFor→normalizeOptions/displayOptions 렌더·선택; special none 배타 토글(none-exclusive)·other 인라인 입력(other-text, single/multi/ranking, noText로 억제 가능), 제출 서버 재정화 포함"),
    scale: h("척도 UI — min/max 버튼 범위, minLabel/maxLabel 앵커 표시"),
    rows: h("matrix 행별 렌더 + 완답 판정(hasAnswer: 모든 행 응답 요구)"),
    columns: h("matrix 열 선택 버튼 렌더"),
    limit: h("rankLimit — ranking 상위 N 선택 캡 + 진행 가능 판정"),
    displayLogic: h("visibleAt→questionVisible — 조건 불충족 문항 건너뛰기(전·후진 공통)"),
    probe: h("advance()→normalizeProbe→requestProbe — 공개/owner-preview 경로 (US-013/004)"),
    randomizeOptions: h("displayOptions 세션 시드 셔플 (special 앵커 고정)"),
    optionsFrom: h("carriedOptionLabels로 원본 선택만 렌더, 원본 무응답 시 visibleAt이 스킵"),
    meta: na("응답자 노출·동작 없음 — 내부 태깅(분석·보정용) 전용"),
    sourceQuid: na("템플릿 출처 링크(provenance) 전용 — 응답 런타임 동작 없음"),
  },
  // 합성 시뮬레이션 (simulate.ts, sim-answers.ts)
  simulate: {
    options: h("buildQuestionsBlock 보기 나열 + other 지시(others.qN — single/multi/ranking, noText 제외) + none 배타 클램프(US-003)"),
    scale: h("척도 범위를 프롬프트에 지시, coerceSimAnswer가 숫자화"),
    rows: h("matrix 행을 프롬프트에 지시, coerce가 {행:열} 객체화"),
    columns: h("matrix 열을 프롬프트에 지시"),
    limit: h("ranking 상위 N개 지시 (정확히 N개 배열)"),
    displayLogic: h("questionVisible 불충족 문항을 emptyFor로 블랭킹 (실제 스킵과 동일 모양)"),
    probe: na("시뮬은 프로빙 생략(US-015 설계) — coerceSimAnswer가 probed echo도 스칼라로 강등"),
    randomizeOptions: na("표시 전용 셔플 — 저장·집계는 작성 순서 라벨이라 합성 결과에 영향 없음"),
    optionsFrom: h("carry 지시(원본 선택 내에서만) + clampCarriedAnswer/원본 무응답 블랭킹"),
    meta: h("meta.constructId 경유 construct 보정 증강 주입 (construct-calibration→시스템 프롬프트)"),
    sourceQuid: na("provenance 전용 — 시뮬 동작 없음"),
  },
  // 분포·품질 집계 (quality.ts, distribution-core.ts)
  quality: {
    options: h("optionLabels 라벨 기반 분포 tally (0 카운트 보기 포함)"),
    scale: h("min..max 범위 tally + mean"),
    rows: h("matrix per-row 분포 (computeQuestionDistribution)"),
    columns: h("matrix 열 tally + 집계 열 분포"),
    limit: na("분포는 1순위 빈도+avgRanks로 계산 — limit는 수집 단계 제약이라 집계에 불필요"),
    displayLogic: na("미노출 문항은 답이 비어 answerValues에서 자연 탈락 — 별도 처리 불필요"),
    probe: h("openAnswerText로 probed {answer,probes} shape도 answered 집계"),
    randomizeOptions: na("저장 답은 작성 순서 라벨(표시 전용 셔플) — 집계 무영향"),
    optionsFrom: h("computeDistributions가 원본 문항 options로 치환해 원본 라벨로 집계"),
    meta: na("품질 리포트는 분포 기반 — 메타 완성도는 review-checks(computeMetaCompleteness) 담당"),
    sourceQuid: na("provenance 전용 — 집계 무관"),
  },
  // 구조 검사 (logic-lint.ts lintQuestionStructure)
  "lint-structure": {
    options: h("too_few_options / empty_option_label / duplicate_option_label"),
    scale: na("normalizeProbe류 클램프 없음·에디터가 범위 관리 — min>max 미검사는 알려진 잔여 공백(노트)"),
    rows: h("matrix_missing_rows — 행 0개는 응답 폼 완답 판정 교착 (US-006에서 추가)"),
    columns: h("matrix_missing_columns (US-006에서 추가)"),
    limit: h("ranking_limit_over — 보기 수 초과 검사"),
    displayLogic: na("lint-logic(lintDisplayLogic) 담당 — 계층 분리"),
    probe: na("구조 규칙 없음 — normalizeProbe가 값 자체를 클램프(1..MAX_PROBES_CAP)"),
    randomizeOptions: na("불리언 표시 설정 — 구조 위반이 성립하지 않음"),
    optionsFrom: h("carry 문항은 정적 보기 규칙 전체 스킵(오탐 방지) — 원본 유효성은 lint-logic carry_*"),
    meta: na("computeMetaCompleteness(review-checks)가 별도 집계(meta_gap info)"),
    sourceQuid: na("provenance 전용"),
  },
  // 로직 검사 (logic-lint.ts lintDisplayLogic)
  "lint-logic": {
    options: h("value_not_in_options — 조건 값이 참조 문항 보기에 있는지 검증"),
    scale: na("척도 참조 조건은 수치 비교(gte/lte 등)라 보기 검증 대상 아님 — 범위 밖 값 경고는 잔여 공백(노트)"),
    rows: na("matrix는 조건 참조 대상이 아님 (조건 빌더가 노출 안 함)"),
    columns: na("matrix는 조건 참조 대상이 아님 (rows와 동일 — 조건 빌더 미노출)"),
    limit: na("표시 로직과 무관"),
    displayLogic: h("missing_ref / forward_ref / value_not_in_options / unreachable(경로 계산)"),
    probe: na("표시 로직과 무관"),
    randomizeOptions: na("표시 순서는 조건 평가와 무관 (라벨 기반 평가)"),
    optionsFrom: h("carry_missing_ref / carry_forward_ref / carry_source_not_choice + 참조 문항이 carry면 value 검증 스킵"),
    meta: na("표시 로직과 무관"),
    sourceQuid: na("provenance 전용"),
  },
  // AI 검토 입력 (review-ai.ts questionLine/buildReviewPrompt)
  "review-input": {
    options: h("보기 나열 + special 고정 표기([처음/마지막 고정])"),
    scale: h("척도 범위·앵커 라벨 표기"),
    rows: na("questionLine이 matrix 행/열을 나열하지 않음 — AI가 행 문구 품질을 못 봄, 알려진 잔여 공백(노트)"),
    columns: na("rows와 동일 잔여 공백 — matrix 열도 questionLine에 미표기(노트)"),
    limit: h("ranking 상위 N 표기"),
    displayLogic: h("describeLogic으로 조건 문장화 — '표기가 곧 현재 상태' 규칙으로 재제안 방지"),
    probe: h("AI 심층 질문 켜짐 + maxProbes 표기 (개방형 후속 탐침 재제안 방지)"),
    randomizeOptions: h("무작위 표시 + 고정 보기 제외 표기 (순서 편향 재지적 방지)"),
    optionsFrom: h("보기 가져오기 동적 표기 + 정적 보기 무시 명시 (전체 보기 고정 오탐 방지)"),
    meta: h("construct/topic 표기 (구성 개념 맥락 제공)"),
    sourceQuid: na("provenance 전용 — 검토 품질과 무관"),
  },
  // 제안 파이프라인 (revisions.ts validate→lint→materialize→apply/merge)
  "proposal-schema": {
    options: h("제안 스키마 포함 — 라벨-에코가 유실하는 id/special/noText는 reattachOptionMeta가 quid+라벨 매칭으로 재부착, mergeProposal 필드 단위 병합"),
    scale: h("제안 스키마 포함 (question-diff CONFIG_FIELDS 경유 diff)"),
    rows: h("제안 스키마 포함"),
    columns: h("제안 스키마 포함"),
    limit: h("제안 스키마 포함"),
    displayLogic: h("ref형 showIf sanitize→2단계 해석→materializeShowIf 저장형 물질화"),
    probe: h("제안 스키마 포함 — normalizeProbe 클램프 경유"),
    randomizeOptions: h("제안 스키마 포함"),
    optionsFrom: h("ref형 optionsFromRef validate→apply 2단계 해석 + merge 재매핑"),
    meta: h("stampMetaOrigin — AI 제안은 origin ai 강제, human meta 불가침(merge)"),
    sourceQuid: na("제안이 만지지 않는 provenance — apply 시 기존 값 보존(교체 문항은 스냅샷 복사)"),
  },
  // 버전 비교 표시 (question-diff.ts + compare-text.ts)
  compare: {
    options: h("diffOptions — id 기반 added/deleted/renamed/reordered"),
    scale: h("CONFIG_FIELDS diff + fmtScale 렌더"),
    rows: h("CONFIG_FIELDS diff + fmtList 렌더"),
    columns: h("CONFIG_FIELDS diff + fmtList 렌더"),
    limit: h("CONFIG_FIELDS diff + fmtLimit 렌더"),
    displayLogic: h("stableStringify 비교 + fmtDisplayLogic 문장화 (거짓 diff 방지 전례)"),
    probe: h("CONFIG_FIELDS diff + fmtProbe 렌더"),
    randomizeOptions: h("CONFIG_FIELDS diff + 켜짐/꺼짐 렌더"),
    optionsFrom: h("CONFIG_FIELDS diff + fmtOptionsFrom 문장화"),
    meta: h("CONFIG_FIELDS diff + fmtMeta (constructId 내부 필드는 표시 제외)"),
    sourceQuid: na("provenance는 내용 변경이 아님 — diff 대상에서 의도적 제외(CONFIG_FIELDS 미포함)"),
  },
  // 템플릿 저장·시딩 (templates.ts + template-refs.ts)
  templates: {
    options: h("스냅샷 원형 보존 (special 포함)"),
    scale: h("스냅샷 원형 보존"),
    rows: h("스냅샷 원형 보존"),
    columns: h("스냅샷 원형 보존"),
    limit: h("스냅샷 원형 보존"),
    displayLogic: h("저장 시 내부 참조 id→quid, 시딩 시 quid→새 id 재매핑; 미해석은 드롭+dropped 안내 (US-001)"),
    probe: h("스냅샷 원형 보존"),
    randomizeOptions: h("스냅샷 원형 보존"),
    optionsFrom: h("displayLogic과 동일 재매핑/드롭 규칙 (US-001)"),
    meta: h("스냅샷 보존 + deriveMetaTags로 템플릿 검색 태그 파생"),
    sourceQuid: h("시딩 시 새 문항에 원본 quid를 sourceQuid로 부여 (provenance 생성 지점)"),
  },
  // Loop Survey Markdown 파서·직렬화 (survey-markdown.ts — docs/survey-markdown.md가 문법 정본)
  // "handled" 선언은 survey-markdown-contract.test.ts가 정본 픽스처 왕복으로 검증한다.
  markdown: {
    options: h("`- 라벨 [other|none noText] {#o_id}` 리스트 ↔ serializeOption; 파싱은 normalizeOptions+promoteSpecialOptions 위임"),
    scale: h("헤딩 `[scale min= max= minLabel= maxLabel=]` 인라인 속성"),
    rows: h("matrix 마크다운 표 — 본문행 첫 셀"),
    columns: h("matrix 마크다운 표 — 헤더행(빈 코너 뒤)"),
    limit: h("헤딩 `limit=N` 인라인 속성 (multi/ranking)"),
    displayLogic: h("`showIf: all|any` 블록 + `- <참조> <op> <값>` 조건줄; 참조는 #q_<quid> 안정 토큰, resolveMarkdownRefs가 quid로 해석"),
    probe: h("헤딩 `[open probe maxProbes= guidance=]` 인라인 속성 → normalizeProbe"),
    randomizeOptions: h("헤딩 `randomize` bare 플래그"),
    optionsFrom: h("헤딩 `optionsFrom=<참조> mode=selected` 인라인 속성; 보기 목록은 비움"),
    meta: h("헤딩 `{construct= topic= population= source= validatedScale= notes=}` — origin/constructId는 비표현(import가 human origin 스탬프+사전 재해석, PRD 비목표)"),
    sourceQuid: na("템플릿 provenance 전용 — 마크다운은 문항 정의만 표현(PRD 비목표), import 시 미설정"),
  },
};
