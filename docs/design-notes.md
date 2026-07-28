# PRD — Loop Studio: 로컬 데스크톱 앱 전환

> 응답 수집을 포기하고 **설계 → 검토 → 미리보기 → 시뮬레이션** 4단계에 집중하는
> 단일 사용자 로컬 앱으로 재패키징한다.

## 1. 목표 / 비목표

**목표**
- 설치 = 앱 하나 내려받아 실행. Docker·Colima·Ollama·API 키·DB 셋업 전부 불필요.
- AI는 사용자 머신에 이미 있는 `claude` / `cursor-agent` CLI를 호출 (구독 재사용, 키 관리 0).
- 데이터는 사용자 폴더 하나(`~/Library/Application Support/Loop`) = 백업·이전이 파일 복사.
- 업데이트는 앱 내 알림 + 새 버전 설치.

**비목표 (이번에 버리는 것)**
- 실제 응답 수집 일체 — 응답 링크 발송, 이메일, 인앱 SDK, 수신자, 쿼터, 무결성 게이트.
- 실제 응답 기반 보정(calibration) / 지식 적재 / 크로스 리서치 질의 / MCP 커넥터.
- 멀티 워크스페이스·멤버·초대·RBAC·감사 로그.
- 웹 배포(Vercel). 서버는 앱 내부에서만 뜬다.

## 2. 확정된 결정

| 항목 | 결정 |
|---|---|
| 패키징 | **Tauri v2 데스크톱 앱** (macOS 우선, arm64) |
| DB | **PGlite 내장** (`@electric-sql/pglite` + pgvector 확장) |
| AI | **CLI 어댑터** — `claude` \| `cursor-agent` 선택 |
| 응답수집 | **완전 삭제** (코드·스키마·테스트에서 제거) |

## 3. 유지 / 삭제 경계

### 유지 (앱의 4단계)

| 단계 | 화면 | 핵심 모듈 |
|---|---|---|
| ① 설계 | `/surveys/[id]/edit` | editor, AI 문항 생성(`surveys.ts`), `revisions.ts`, `question-config`, `display-logic`, `carry-forward`, `none-exclusive`, `other-text`, `demographic-presets`, `templates`, `constructs`(문항 메타·재사용) |
| ② 검토 | 검토 패널 | `review-ai`, `review-checks`, `logic-lint`, `path-test`, `publish-gate`→**검토 게이트**로 개명, `logic-map-panel`, `logic-flow-diagram`, `question-diff` |
| ③ 미리보기 | `/preview/[id]` | `respond-form.tsx` 렌더러 (제출·저장 경로 제거, 클라이언트 전용 시뮬레이션 워크스루) |
| ④ 시뮬레이션 | `/surveys/[id]/simulate` | `personas`, `population`, `ocean`, `simulate`, `quality`(분포), `run-history`, `sim-answers` |
| 결과 | 시뮬 결과 보기 | `analysis`, `insights`, `themes`, `reports`, `export`(wide/long CSV·AI zip·SPSS zip), `stats` |

### 삭제

| 영역 | 경로 | 추정 LOC |
|---|---|---|
| 인앱 서베이 SDK | `sdk/`, `shared/in-app-targeting.ts`, `src/app/api/sdk/`, `surveys/[id]/in-app/`, `demo-host/` | ~6,300 |
| 응답 제출 | `src/app/r/[id]/actions.ts`(+테스트), `sdk-submit`, `response-meta`, `probe(s)`, `interview*`, `followups` | ~2,500 |
| 발송·수신자 | `email.ts`, `dispatch-*`, `recipient-*`, `respondents` 테이블 | ~1,200 |
| 쿼터 | `quota-core`, `quota`, `quota-population`, `quota-panel/actions` | ~1,800 |
| 무결성 | `integrity*` | ~700 |
| 보정 | `calibration*`, `diagnosis*`, `profile*`, `trend*`, `construct-calibration` | ~2,200 |
| 지식·반입 | `knowledge*`, `import*`(반입 전체), `embeddings.ts` | ~4,000 |
| 인증·워크스페이스 | `login/`, `invite/`, `auth/`, `session`, `password`, `auth-middleware`, `middleware.ts`, `permissions`, `workspace-members`, `settings/members|tokens|audit`, `api-tokens`, `audit` | ~2,500 |
| MCP | `src/app/api/mcp/`, `mcp.ts` | ~600 |
| 프로바이더 | `ollama.ts`, `sim-provider.ts`(교체), `settings.ts` LLM 파트 축소 | ~500 |

**합계 약 22,000 LOC 제거** (전체 54,000 중).

**스키마**: 남는 테이블 — `surveys`, `questions`, `responses`(합성 전용), `personas`,
`simulation_jobs`, `survey_revisions`, `survey_proposals`, `templates`, `constructs`,
`open_text_themes`, `study_reports`, `app_settings`(신규, workspace_settings 대체).
`workspace_id` 컬럼은 **남긴다** — 고정값 `local` 행 하나. (컬럼을 빼면 100개 넘는 쿼리를
건드려야 해서 이득 대비 위험이 큼.) 마이그레이션 0000~0038은 **단일 baseline으로 스쿼시**.

## 4. 아키텍처

```
┌─ Tauri 셸 (Rust) ─────────────────────────────┐
│  · 빈 포트 확보 → 사이드카 spawn → 헬스체크    │
│  · WebView → http://127.0.0.1:<port>          │
│  · 로그인 셸에서 PATH 상속 (CLI 탐색용)        │
│                                               │
│  ├─ 사이드카: node (번들) + Next standalone   │
│  │    ├─ PGlite  → <AppData>/Loop/db          │
│  │    ├─ agent-cli.ts → spawn claude|cursor   │
│  │    └─ personas → node:sqlite (인프로세스)  │
│  └─ 리소스: personas.db, population.json      │
└───────────────────────────────────────────────┘
```

## 5. 단계별 계획

### Phase 0 — 삭제 (브랜치 `feat/local-desktop`) ✅ 완료
1. 위 삭제 목록을 지운다. 참조 끊긴 import·테스트·패널·서버 액션·탭 정리.
2. 스키마에서 죽은 테이블 제거 → `drizzle/` 스쿼시 baseline 재생성.
3. `bun run typecheck` + `bunx vitest run` 그린.
- **검증**: 설계·검토·시뮬레이션 화면이 기존 Postgres에서 그대로 동작.

### Phase 1 — DB: Postgres → PGlite ✅ 완료
1. `@electric-sql/pglite`, `drizzle-orm/pglite`. `src/db/index.ts`를 싱글턴 PGlite로 교체
   (`extensions: { vector }`), 데이터 경로는 `LOOP_DATA_DIR` env.
2. 부팅 시 인프로세스 마이그레이션 (별도 `db:migrate` 프로세스 제거 — PGlite는 단일 프로세스 점유).
3. `docker-compose.yml`, `postgres` 드라이버, `DATABASE_URL` 제거.
- **주의**: `next dev`가 두 프로세스를 띄우면 DB 디렉터리 락 충돌 → 개발 모드 가드 필요.
- **검증**: 빈 폴더에서 앱 기동 → 설문 생성 → 시뮬 실행 → 재기동 후 데이터 유지.

### Phase 2 — AI: CLI 어댑터 ✅ 완료 (Phase 0에 흡수)
1. `src/lib/agent-cli.ts` 신설. 두 CLI가 **같은 JSON 봉투**(`{type:"result",is_error,result}`)를
   반환하는 것을 실측 확인 → 파싱 공유, 인자만 분기.
   - `claude -p <prompt> --output-format json --model <model>`
   - `cursor-agent -p <prompt> --output-format json --model <model> --mode ask --trust`
2. `llm.ts`를 이 어댑터 위로 재구성, `sim-provider.ts`·`ollama.ts` 삭제.
3. **PATH 해석**: GUI 실행 앱은 로그인 셸 PATH를 못 받는다. 부팅 시 `$SHELL -lic 'command -v claude'`로
   1회 탐색 후 캐시, 설정 화면에서 절대경로 수동 지정 가능.
4. **설정 화면 축소**: 프로바이더(claude|cursor) · 모델 · 동시성 · 배치 크기 · CLI 경로.
5. **시뮬레이션 배치화** — 실측 왕복이 호출당 ~3.5초라 1인 1콜은 비현실적.
   호출 1건이 페르소나 B명을 처리하도록 프롬프트/파싱 변경
   (`{"respondents":[{"i":1,"answers":{…}},…]}`), 기본 B=5 · 동시성 4.
   - 1,000명 ≈ 200콜 / 4병렬 ≈ 12분 예상.
   - **트레이드오프**: 한 컨텍스트에 묶인 페르소나끼리 응답이 서로 닮아갈 수 있음(응답 다양성 저하).
     "독립적으로 답하라" 지시 + 배치 내 순서 셔플로 완화하고, **B=1 옵션을 남겨** 품질 우선 실행 가능.
   - 기존 fail-fast / 부분 실패 경고는 배치 단위로 유지.
- **검증**: 두 CLI 각각으로 50명 시뮬 실행 → 분포가 기존 Ollama 결과와 같은 자릿수인지 대조.

### Phase 3 — 페르소나 로컬화 ✅ 완료 (코퍼스는 선택 사항으로)
1. `scripts/sample_personas.ts`의 bun 서브프로세스 제거 → `node:sqlite`로 인프로세스 샘플링
   (Node 26 내장, 네이티브 모듈 불필요).
2. 코퍼스 다이어트: 프로필 생성에 쓰는 컬럼만 남긴 축약 SQLite를 앱 리소스에 번들
   (목표 <40MB / 3만 페르소나). `LOOP_PERSONA_DB` 로 외부 대형 코퍼스 교체 가능.
3. `population.json`(행안부 인구통계)도 프리빌드해 번들 — data.go.kr 키 불필요.
- **검증**: 코퍼스 없이 클린 설치한 앱에서 대표성 표본 1,000명 생성 성공.

### Phase 4 — 단일 사용자화 ✅ 완료
1. 로그인·세션·미들웨어 제거, `getWorkspaceId()`가 상수 `local` 반환.
2. 첫 실행 온보딩: CLI 탐지 결과 표시 → 없으면 설치 안내.
- **주의**: 인증이 없으므로 서버는 **127.0.0.1에만 바인딩**한다.

### Phase 5 — Tauri 패키징 ✅ 완료 (.app / .dmg 실행 확인)
1. `src-tauri/` (Tauri v2). `next.config.ts`에 `output: "standalone"`.
2. Node 바이너리를 사이드카로 동봉(`binaries/node-aarch64-apple-darwin`).
3. Rust: 포트 확보 → 사이드카 spawn(env: PORT, LOOP_DATA_DIR, PATH) → `/api/health` 폴링 → 창 로드.
   종료 시 사이드카 kill, PGlite 정상 종료.
4. `.dmg` 빌드. 예상 용량 ≈ 150MB.
- **서명**: Developer ID 인증서가 없으면 Gatekeeper 경고가 뜬다. 사내 인증서가 있으면 그걸 쓰고,
  없으면 ad-hoc 서명 + 첫 실행 안내(우클릭 열기)로 간다. **확인 필요 항목.**

### Phase 6 — 설치·관리 편의 ✅ 완료 (업데이터는 서명 확보 후로 유보)
1. ~~Tauri updater~~ — 업데이트 서명 키가 코드 서명과 함께 정해져야 해서 보류.
   현재는 새 .dmg로 교체 (데이터는 앱 밖 Application Support에 있어 보존된다).
2. 설정 화면에 데이터 폴더 경로·용량 + "폴더 열기". 백업·이전·초기화가 파일
   조작이라는 걸 화면에서 드러낸다.
3. README: 앱 설치(우클릭→열기 포함)와 개발 실행을 분리해 정리.

## 6. 리스크

| 리스크 | 영향 | 완화 |
|---|---|---|
| CLI 배치 응답의 다양성 저하 | 시뮬 품질 왜곡 | B=1 옵션 유지, 분포를 기존 결과와 대조 검증 |
| 구독 사용량 소진 | 대규모 시뮬 중단 | 실행 전 예상 호출 수 표시, 배치 크기로 조절 |
| PGlite 단일 프로세스 제약 | 개발 중 락 충돌 | 인프로세스 마이그레이션 + dev 가드 |
| Node 사이드카 번들 크기 | 150MB dmg | 허용 (대안: bun 컴파일은 Next 서버와 비호환) |
| 미서명 앱 | 첫 실행 마찰 | 사내 인증서 확인, 없으면 안내 문구 |
| 22k LOC 삭제 회귀 | 남은 기능 파손 | 별도 브랜치 + Phase마다 typecheck/vitest 게이트 |

## 7. 확정된 부가 결정 (2026-07-28)

1. **삭제 경계** — 보정·지식 질의·외부 반입·MCP·워크스페이스 권한까지 **전부 삭제**.
2. **코드 서명** — 사내 인증서 확보 여부 미정 → 우선 **ad-hoc 서명**으로 빌드하고
   설치 안내에 첫 실행 절차(우클릭 → 열기)를 넣는다. 인증서가 생기면 빌드 설정만 교체.
3. **배포 타깃** — **macOS Apple Silicon 단일 타깃**. Node 사이드카는 `aarch64-apple-darwin` 하나만 동봉.
4. **기존 데이터** — 이전하지 않는다. 새 앱은 빈 DB에서 시작.
