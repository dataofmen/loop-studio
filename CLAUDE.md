# CLAUDE.md — Loop Studio

## What this is

설문을 **설계 → 검토 → 미리보기 → 합성 시뮬레이션**하는 로컬 단일 사용자 도구.
응답 수집은 하지 않는다 — 문항이 실제로 어떻게 작동할지를 배포 전에 확인하는 것이 목적이다.

방향 전환의 배경과 결정 기록: [docs/design-notes.md](docs/design-notes.md).
사용자 가이드: [docs/user-guide.md](docs/user-guide.md).

## Stack

- **Next.js 15** (App Router, `src/`, TS) · **Runtime**: bun(dev) / node(패키징 시)
- **DB: 임베디드 PGlite** — `@electric-sql/pglite` + `drizzle-orm/pglite`.
  데이터는 `LOOP_DATA_DIR`(기본 `~/.loop`) 폴더 하나. 서버·Docker 없음.
- **AI: 로컬 agent CLI** — `claude` 또는 `cursor-agent`. API 키 없음.

## Commands

```bash
bun install
bun run dev         # 마이그레이션 후 개발 서버 (127.0.0.1:3000)
bun run typecheck   # tsc --noEmit — 모든 작업 완료 기준
bun run test        # vitest (bunx vitest run — DOM 테스트는 happy-dom env 필요)
bun run build       # 프로덕션 standalone 빌드
bun run db:generate # 스키마 변경 → 마이그레이션 SQL
bun run db:migrate  # 마이그레이션 적용
bun scripts/verify-db.ts        # DB 왕복 스모크
bun scripts/verify-pipeline.ts  # 설계→페르소나→시뮬→분석 전 구간 (실 CLI 사용, 수 분)
```

## Conventions

- 커뮤니케이션·문서는 한글, 코드/주석/변수명은 영어.
- **모든 응답은 합성이다.** `is_synthetic`은 그 불변식의 표식으로 남아 있고, 집계는 항상
  이를 명시적으로 확인한다. 산출물(분석·리포트·내보내기)은 합성 데이터임을 표기한다.
- `workspace_id`는 고정값 `LOCAL_WORKSPACE_ID` 하나. 쿼리 형태를 바꾸지 않으려고 남겨둔
  파티션 키다.
- 새 LLM 호출은 `runLlmJson`/`runLlmText`(`src/lib/llm.ts`)를 쓴다 — 사용자가 고른 CLI·모델·
  실행 경로가 자동으로 채워진다.

## 런타임 경계 (자주 밟는 지뢰)

- **클라이언트 컴포넌트는 DB·child_process를 임포트할 수 없다.** 상수 하나 때문에 PGlite나
  node:child_process가 브라우저 번들로 끌려온다. 그래서 순수 메타 모듈을 분리해 둔다:
  - `src/lib/agent-cli-meta.ts` — CLI 종류·라벨·기본 모델·상태 타입
  - `src/lib/settings-meta.ts` — 설정 형태·범위·라벨 포맷
  클라이언트는 항상 `-meta`에서 임포트할 것.
- **마이그레이션은 서버와 별도 프로세스**로 먼저 돈다(`scripts/db-migrate.mjs`). Next는
  `instrumentation.ts`를 edge 런타임으로도 컴파일하는데 node:fs를 읽는 마이그레이터는 그
  번들에서 깨지고, PGlite는 단일 커넥션이라 동시 접근도 안 된다.
- **콘솔 라우트는 `force-dynamic`** — 빌드 시점에는 사용자 DB가 없다.
- 스키마는 Web Crypto 전역을 쓴다(`node:crypto` 금지) — 모든 런타임에서 임포트 가능해야 한다.

## AI 접근 (`src/lib/agent-cli.ts`)

두 CLI가 print 모드에서 **같은 JSON 봉투**(`{type:"result", is_error, result}`)를 반환한다.
파싱은 공유하고 argv만 분기한다.

- claude: `-p <prompt> --output-format json --model <model>`
- cursor: `+ --mode ask --trust` (ask = 읽기 전용 Q&A, trust = 워크스페이스 신뢰 프롬프트 회피)

주의:
- **PATH 탐색**: GUI로 띄운 앱은 로그인 셸 PATH를 못 받는다. `resolveCliBin`이 inherited PATH →
  로그인 셸(`$SHELL -lic`) 순으로 찾고 캐시한다. 설정에서 절대경로 override 가능.
- **cwd**: 두 CLI 모두 cwd를 워크스페이스로 취급하므로 항상 스크래치 디렉터리에서 실행한다
  (`LOOP_AGENT_CWD`, 기본 OS 임시 폴더). 프로젝트 안에서 돌리면 설문 프롬프트가 무관한
  레포 내용을 끌어온다.
- **에러 메시지에 프롬프트를 흘리지 말 것** — execFile 원본 에러는 커맨드라인 전체(=프롬프트)를
  담고 있다. 반드시 distill해서 던진다.

## 시뮬레이션 (`src/lib/simulate.ts`)

CLI 왕복이 호출당 수 초라 1인 1콜은 비현실적이다. **한 번의 호출이 여러 페르소나를 처리한다.**

- 기본 5명/콜(`batchSize`) · 동시 4프로세스(`concurrency`) — 설정 화면에서 조절.
- 트레이드오프: 한 컨텍스트에 묶인 페르소나끼리 응답이 닮아갈 수 있다. 프롬프트가 독립 판단을
  명시적으로 요구하고, **품질이 우선이면 batchSize=1**로 완전 독립 실행이 가능하다.
- 모델이 배치에서 누락한 페르소나는 실패로 집계한다 — 지어낸 답으로 메우지 않는다.
- fail-fast: 처음 3배치가 전부 실패하면 조기 중단(설치 안 됨·미로그인·레이트리밋). 부분 실패는
  완료 처리하되 `jobs.error`에 남겨 UI에 경고로 표시한다 —
  "1000/1000 ✓"인데 실제로 2건만 저장됐던 사고의 재발 방지.
- 후처리는 실제 제출과 같은 규칙을 통과한다: 표시 로직 blanking, carry-forward 클램프,
  '없음' 배타, 기타 자유입력 sanitize.

## 페르소나 (`src/lib/persona-corpus.ts`, `src/lib/personas.ts`)

- **코퍼스는 선택 사항.** 있으면 Nemotron-Personas-Korea에서 층화 표본을 뽑고, 없으면 agent
  CLI가 설명에 맞는 페르소나를 생성한다.
- **대표성 표본은 코퍼스 전용** — 지어낸 사람은 대표성을 가질 수 없고, 그렇게 부르면 안 된다.
  UI가 이 구분을 명시한다.
- 샘플러는 `node:sqlite`를 쓰는 **node 서브프로세스**(`scripts/sample-personas.mjs`).
  Bun에는 node:sqlite가 없어서 인터프리터를 node로 고정한다.
- OCEAN 성향은 결정론적: 코퍼스 페르소나는 sourceUuid, 생성 페르소나는 profile 텍스트를 키로.

## 화면 구조

- `/dashboard` — 설문 목록 + 생성 + CLI 미설치 안내
- `/surveys/[id]` — 개요: 메트릭 · 검토 게이트(ReviewControls) · AI 리뷰 패널 · 문항 미리보기
- `/surveys/[id]/edit` — ① 설계: Editor + RevisionPanel(AI 수정·버전) + 템플릿 삽입
- `/surveys/[id]/simulate` — ② 시뮬레이션: PersonaPanel + SimulationPanel + Quality + 실행 이력
- `/surveys/[id]/results` — ③ 결과: 분포 · AI 인사이트 · 주관식 테마 · 리포트 · 내보내기 · 피드백
- `/preview/[id]` — 응답자 시점 워크스루 (저장 없음, 상태 무관)
- `/templates`, `/constructs`, `/settings`

## 상태 모델 (`src/lib/survey-status.ts`)

`draft → reviewed → simulated`. 수집이 없으므로 발행/일시중단/마감 축은 없다.
문항을 편집하면 draft로 돌아간다 — 검토 결과와 시뮬 데이터는 당시 내용에 대한 것이기 때문.

## 설계 보조 기능 (유지)

- **AI 수정 제안 + 버전**(`revisions.ts`): 피드백 → 제안(미적용) → 적용 시 문항 교체 + 버전 기록,
  과거 버전으로 비파괴 복원. ⚠️ 적용은 문항 행을 교체(ID 변경)한다.
- **검토**(`review-ai`, `review-checks`, `logic-lint`, `path-test`): AI 리뷰 + 결정론적 구조·로직 점검.
  게이트는 soft — 경고만 하고 명시적 확인으로 넘어갈 수 있다.
- **데모그래픽 프리셋**(`demographic-presets.ts`): 성별·연령대·지역(행안부 17개 시도 / 여론조사
  8권역)·직업·학력·혼인·가구소득 8종. 지역 프리셋은 population.ts 스코프명과 일치해 인구 비례
  배분과 연동된다.
- **문항 메타·구성 개념**(`question-meta`, `constructs`): 같은 개념이 설문 간에 이어지도록 통제
  어휘로 정규화. 임베딩 흡수는 제거됐다(로컬 임베딩 모델 소멸) — exact/alias 매칭만 한다.
- **내보내기**(`export-core.ts` 순수 + `export.ts`): wide/long CSV · AI 번들(zip) · SPSS 번들(zip).
  변수명 `q01`/`q05_1`/`q06_r1`/`q07_n`, 미노출 공란 vs 무응답 -99.

## 패키징 · 크기 (수치는 실측)

`.app` 115MB / `.dmg` 35MB. 기동은 최초 약 2.9초, 이후 약 1.1초.

무게의 대부분은 동봉한 Node 런타임(58MB)이고 나머지가 앱 번들(56MB)이다. 줄일 때 밟은 함정:

- **Node는 full ICU를 뺀 소스 빌드가 크게 이긴다.** 공식 바이너리에는 쓰지 않는 ICU 데이터가
  31.6MB 들어 있다 — 이 앱의 로케일 포맷은 전부 클라이언트(WebKit)에서 일어난다.
  `--with-intl=small-icu` 빌드는 strip 후 58MB(공식 92MB). prepare-sidecar가
  `vendor/node-v*/out/Release/node`(직접 빌드)를 `vendor/node-v*/bin/node`(공식)보다 우선한다.
  전제 조건: 서버 코드에 `Intl`/`localeCompare` 사용이 0이어야 한다.
- **Node는 strip 후 반드시 ad-hoc 재서명**. 서명이 깨지면 macOS가 수정된 Mach-O를 즉시
  SIGKILL한다. `codesign --force --sign -`로 되살린다 (prepare-sidecar가 스트립·재서명·
  실행 검증까지 한다).
- **마이그레이터가 drizzle-orm을 쓰면 11MB를 통째로 실어야 한다** — 모든 SQL 방언이 들어 있다.
  Next가 트레이스하는 실제 필요분은 약 1MB. 그래서 `scripts/db-migrate.mjs`는 PGlite에 직접
  SQL을 던지며, 기록은 drizzle과 **바이트 호환**(같은 `drizzle.__drizzle_migrations`, 같은
  sha256 해시, 같은 적용 규칙)이라 두 마이그레이터를 섞어 써도 된다.
- **번들에서 걷어내는 것**(scripts/package-app.ts `prune`): typescript(next·drizzle의 컴파일
  타임 peer), sharp·@img(이미지 최적화용 — `images.unoptimized`로 껐다), caniuse-lite,
  next의 amphtml-validator, 소스맵·타입선언·PGlite 미사용 확장 아카이브.
- **Next 내부를 지울 때는 `NODE_ENV=production`으로 검증할 것.** `compiled/babel`과
  `dist/next-devtools`는 이름만 보면 빌드 전용 같지만 프로덕션 startup 경로에서 require된다
  (next-devtools/server/shared.js → babel/code-frame). NODE_ENV 없이 띄운 하니스에서는 통과해
  버려서 한 번 속았다 — 그래서 `run.sh`가 NODE_ENV=production을 설정한다.

**데이터 폴더는 한 프로세스만 열 수 있다** (`src/db/lock.ts` + db-migrate.mjs의 같은 검사).
PGlite는 DB를 메모리에 올리고 되쓰기 때문에 두 프로세스가 한 폴더를 열면 커넥션이 둘이 아니라
서로를 덮어쓰는 사본이 둘이고, 나중에 flush한 쪽이 이긴다 — 설문이 조용히 사라진다. 실제로
진단 중에 앱이 켜진 상태로 같은 폴더에 서버를 하나 더 띄워 설문 하나를 잃었다. 이제 두 번째
프로세스는 pid를 밝히며 거부한다. 죽은 소유자의 잠금은 pid 생존 확인으로 자동 인수한다.

기동 시간에서 가장 큰 몫은 PGlite 콜드 부팅(약 1.5초)이다. 그래서 마이그레이션 스크립트는
**DB를 열기 전에** 마이그레이션 셋의 지문을 `<dataDir>/db/.loop-migrations`와 비교해, 바뀐 게
없으면 0.08초에 끝낸다. 마커를 db 디렉터리 안에 두는 이유는 DB를 지우면 마커도 함께 사라져야
하기 때문 — 살아남은 마커는 새 DB가 필요한 마이그레이션을 건너뛰게 만든다.

## 알려진 한계

- 코드 서명 미적용 — 배포본은 Gatekeeper 경고가 뜬다.
- probe(AI 후속 질문) 설정은 설계 메타데이터로만 남아 있다. 시뮬레이션이 이를 반영하지 않으므로
  현재는 아무 데이터도 만들지 않는다. 미리보기는 이 사실을 명시한다.
