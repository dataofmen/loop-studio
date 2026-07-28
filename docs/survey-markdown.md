# Loop Survey Markdown — 문법 레퍼런스

설문 한 장을 사람이 읽고 쓰는 마크다운으로 표현하는 포맷(내부 명칭 `.lsm`, 파일은 `.md`).
**무손실 왕복**이 계약이다: `export → import`가 원래 설문을 동일하게 복원하고,
`serialize → parse → resolve → serialize`는 문자열까지 안정적이다
(`src/lib/survey-markdown-contract.test.ts`가 고정).

- 파서/직렬화(순수 모듈): `src/lib/survey-markdown.ts` — `parseSurveyMarkdown` / `serializeSurveyMarkdown` / `resolveMarkdownRefs`
- import(서버 액션 + UI): `src/lib/survey-import.ts`, `/surveys/import`
- export(라우트 + UI): `src/lib/survey-export.ts`, `GET /surveys/[id]/export`
- 필드 대응 선언: `src/lib/qconfig-contract.ts`의 `markdown` 소비처 그룹

오류 정책: 파싱·참조·구조·로직 오류를 **라인 번호 + 사유**로 모두 수집하고,
하나라도 있으면 설문을 **생성하지 않는다**(전체 거부). 문법 태그(`[other]`, `showIf:` 등)는
파싱 후 config로만 존재하며 응답자에게 절대 노출되지 않는다.

## 1. 문서 구조

```markdown
---
(설문 헤더 — YAML frontmatter)
---

### <앵커> [<type> <속성...>] {<meta...>}
(선택) showIf 블록
프롬프트 텍스트
(타입별 본문: 보기 리스트 / matrix 표)
```

## 2. 설문 헤더 — frontmatter

```markdown
---
title: 고객 만족도 설문
researchGoal: 재구매 의향의 핵심 동인을 파악한다
welcome: |
  안녕하세요! 3분이면 끝납니다.
  부담 없이 답해주세요.
closing: 참여해주셔서 감사합니다.
---
```

| 키 | 필수 | 비고 |
|---|---|---|
| `researchGoal` | ✅ | 누락 시 오류(설문 생성 요건). title 없으면 이 값이 제목 폴백 |
| `title` | — | |
| `welcome` / `closing` | — | 환영/종료 화면 문구 |

- 멀티라인 값은 `키: |` 블록 스칼라(들여쓰기 2칸). 단일라인은 bare 스칼라
  (빈 값이거나 `"`, `|`, `>`로 시작하면 따옴표 필요 — export가 자동 처리).

## 3. 문항 헤딩

형식: `### <앵커> [<type> <속성...>] {<meta...>}`

- **앵커**: 사람이 참조에 쓰는 토큰(`Q1`, `Q2`… 자유). export는 항상
  `{#q_<quid>}`를 함께 출력하고 참조도 그 토큰으로 쓴다(안정 참조).
  파서는 가시 앵커·`#q_<quid>`·bare quid 3형을 모두 참조 대상으로 등록한다.
- **type**: `single` / `multi` / `scale` / `open` / `ranking` / `matrix` / `nps` (7종).
- **속성**(타입 스코프 인라인, 공백 구분, 값에 공백 있으면 `"..."`):

| 속성 | 적용 타입 | config 대응 |
|---|---|---|
| `min= max= minLabel= maxLabel=` | scale | `scale` (nps는 0–10 고정, 속성 없음) |
| `limit=N` | multi, ranking | `limit` (최대 선택/상위 N) |
| `randomize` (bare 플래그) | 보기 있는 타입 | `randomizeOptions: true` |
| `probe maxProbes=N guidance="…"` | open | `probe {enabled, maxProbes(1..5), guidance?}` |
| `optionsFrom=<참조> mode=selected` | single, multi, ranking | `optionsFrom` (보기 가져오기, `mode`는 `selected` 유일) |

- **meta**(`{...}` 블록, 선택): `construct=` `topic=` `population=` `source=`
  `validatedScale=` `notes=`. `source` ∈ `custom`/`validated`/`adapted`.
  `{#q_<quid>}` 문항 ID 토큰도 이 블록에 함께 놓인다.

헤딩 다음 줄부터 **프롬프트**(빈 줄 또는 본문 요소 전까지). 빈 프롬프트는 오류.

## 4. 보기 — 리스트 아이템

single/multi/ranking 전용. `- 라벨` + 선택 태그:

```markdown
- 검색
- 지인 추천 {#o_custom01}
- 기타 [other]
- 직접 입력 없는 기타 [other noText]
- 해당 없음 [none]
```

- `[other]` — 기타(항상 마지막 고정, 자유입력). `noText`는 자유입력 끔(**other 전용** —
  none에 붙이면 정규화가 드롭).
- `[none]` — 없음(항상 처음 고정, 배타).
- 옵션 id는 라벨에서 파생(`optionIdFromLabel`)되므로 보통 라벨만으로 무손실.
  파생 id와 다른 명시 id가 필요할 때만 `{#o_<id>}`를 쓴다(export가 자동 판단).
- `optionsFrom` 문항은 보기 목록을 **비운다**(원본에서 가져옴).

## 5. 행렬(matrix) — 마크다운 표

헤더 행 = `columns`(첫 셀은 빈 코너), 본문 각 행의 첫 셀 = `rows`:

```markdown
### Q6 [matrix]
각 항목의 만족도를 평가해주세요.

|          | 불만족 | 보통 | 만족 |
|----------|--------|------|------|
| 배송 속도 |        |      |      |
| 가격      |        |      |      |
```

셀 안의 파이프는 `\|`로 이스케이프. 표가 없으면 오류.

## 6. 조건 표시 — showIf 블록

**헤딩 바로 아래, 프롬프트보다 먼저** 온다(위치 규약 — 프롬프트 뒤에 두면
이어지는 `- ` 줄이 조건으로 오파싱된다). 빈 줄이 블록을 종료하므로 조건줄 사이에
빈 줄을 두지 않는다.

```markdown
### Q8 [single]
showIf: all
- Q1 eq "검색"
- Q3 gte 7
- Q2 in ["가격", "품질"]
검색으로 오신 이유를 골라주세요.
- 상단 노출
- 리뷰
```

- 헤더 `showIf: all|any` = `displayLogic.match`.
- 조건줄 `- <참조> <op> <값>`; `op` ∈ `eq` `ne` `in` `not_in` `gte` `lte` `gt` `lt` `contains`.
- 값: 문자열은 `"..."`, 숫자는 bare, 배열은 `["a","b"]`(in/not_in).

## 7. 참조 해석 규약 (무손실 핵심)

`showIf` 조건과 `optionsFrom`의 참조는 **다른 문항**을 가리킨다. 2단계 해석:

1. 모든 문항을 파싱하며 앵커→quid 매핑 생성(`{#q_...}` 있으면 보존, 없으면 생성).
2. `displayLogic.conditions[].questionId` / `optionsFrom.questionId`의 토큰을 quid로 치환.

규칙(위반은 라인+사유 오류 → 전체 거부):

- 정의되지 않은 앵커 참조 금지(dangling).
- 자기 자신·**뒤 문항 참조 금지**(forward reference) — 조건/carry는 앞 문항만.
- 중복 앵커·중복 `{#q_...}` 금지(참조 모호성).

import 시 quid→DB row id 재매핑이 한 번 더 일어난다(라이브 config의 참조는 row id).
export는 역방향(row id→quid)으로 되돌리고, 끊어진 참조는 드롭해 "export는 항상
재수입 가능"을 보장한다.

## 8. QConfig 필드 대응표

정본 선언은 `qconfig-contract.ts`의 `markdown` 그룹(컴파일타임 강제).

| QConfig 필드 | 마크다운 표현 |
|---|---|
| `options` | `- 라벨 [other\|none noText] {#o_id}` 리스트 |
| `scale` | `[scale min= max= minLabel= maxLabel=]` |
| `rows` / `columns` | matrix 마크다운 표 |
| `limit` | `limit=N` 속성 |
| `displayLogic` | `showIf:` 블록 |
| `probe` | `[open probe maxProbes= guidance=]` |
| `randomizeOptions` | `randomize` 플래그 |
| `optionsFrom` | `optionsFrom=<참조> mode=selected` |
| `meta` | 헤딩 `{...}` 블록 (단, `origin`/`constructId` 비표현 — import가 human origin 스탬프 + 사전 재해석) |
| `sourceQuid` | **비표현** (템플릿 provenance — PRD 비목표) |

## 9. 예제 설문 (전 기능)

```markdown
---
title: 고객 만족도 설문
researchGoal: 재구매 의향의 핵심 동인을 파악한다
welcome: |
  안녕하세요! 3분이면 끝납니다.
closing: 참여해주셔서 감사합니다.
---

### Q1 [single] {construct="인지 경로" topic="획득" source=custom}
어떤 경로로 저희를 알게 되셨나요?
- 검색
- 지인 추천
- 기타 [other]
- 해당 없음 [none noText]

### Q2 [scale min=1 max=5 minLabel="전혀 아니다" maxLabel="매우 그렇다"]
전반적으로 만족하십니까?

### Q3 [multi limit=2 randomize]
구매 이유를 모두 고르세요.
- 가격
- 품질
- 배송

### Q4 [open probe maxProbes=3 guidance="구체 사례를 물어라"]
개선점을 자유롭게 적어주세요.

### Q5 [nps]
지인에게 추천할 의향은?

### Q6 [ranking limit=2]
중요도 순으로 정렬하세요.
- A
- B
- C

### Q7 [matrix]
각 항목의 만족도를 평가해주세요.

|          | 불만족 | 보통 | 만족 |
|----------|--------|------|------|
| 배송 속도 |        |      |      |
| 가격      |        |      |      |

### Q8 [single]
showIf: all
- Q1 eq "검색"
- Q2 gte 4
검색으로 오신 이유를 골라주세요.
- 상단 노출
- 리뷰

### Q9 [single optionsFrom=Q3 mode=selected]
그 중 가장 결정적이었던 하나는?
```

## 10. 새 config 필드 추가 체크리스트

`config.pipe` 같은 새 QConfig 필드를 추가할 때 (qconfig-contract 흐름의 마크다운 연장):

1. `question-diff.ts` QConfig에 필드 추가 → `bun run typecheck`가
   `qconfig-contract.ts`의 `QCONFIG_FIELDS` 불일치로 실패한다. 상수에 추가.
2. 10개 소비처 레코드가 전부 타입 에러가 된다 — **markdown 그룹**에 handled/n-a를
   판단해 선언한다("n/a"는 게으름이 아니라 판단: 사유가 설명이 안 되면 처리 누락).
3. handled로 선언했다면:
   - **파서**(`survey-markdown.ts` — 헤딩 속성/본문 요소 중 문법 위치를 정하고 파싱, 기존
     normalize\* 모듈에 정규화 위임 — shape 재발명 금지),
   - **직렬화**(`serializeQuestion`/`headingAttrs` — 파싱의 정확한 역함수로),
   - **정본 픽스처**(`survey-markdown-contract.test.ts`의 `CANONICAL`에 필드 실은 문항 추가),
   - **이 문서**(§3 속성표 + §8 대응표 + §9 예제)
   를 함께 갱신한다. 픽스처에 안 실으면 계약 테스트(coverage)가 필드명을 찍으며 실패한다.
4. n/a로 선언했다면 계약 테스트의 n/a 목록 기대값(`["sourceQuid"]`)도 함께 갱신한다.
5. `bunx vitest run src/lib/survey-markdown-contract.test.ts src/lib/survey-markdown.test.ts`
   — 문자열 안정성(serialize→parse→resolve→serialize 고정점)까지 통과해야 한다.

## 11. 저작 시 흔한 실수

- **showIf를 프롬프트 뒤에** 두면 보기 줄이 조건으로 파싱됨 — 반드시 헤딩 직후.
- showIf 조건줄 사이 **빈 줄** — 블록이 끊겨 나머지가 보기/프롬프트로 오파싱.
- `[none noText]` — noText는 other 전용이라 무시(드롭)됨.
- scale에 보기 리스트 — 보기 목록을 가질 수 없는 타입 오류.
- 조건이 **뒤 문항**을 참조 — forward reference 오류(앞 문항만 가능).
- matrix 표 헤더 첫 셀에 값 — 첫 셀은 빈 코너여야 함(값을 넣으면 열로 오인되지
  않고 코너로 무시되므로 열이 하나 사라진 것처럼 보임).
