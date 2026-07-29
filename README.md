# Loop Studio

> macOS 데스크톱 앱 · 로컬 전용 · 서버·계정·API 키 없음

설문을 **설계하고 · 검토하고 · 미리 보고 · 합성 응답으로 시뮬레이션**하는 로컬 도구.

응답 수집은 하지 않습니다. 문항이 실제로 어떻게 작동할지를 사람에게 배포하기 전에
확인하는 것이 전부입니다.

- **서버·계정·API 키 없음** — 데이터는 내 컴퓨터 폴더 하나에 들어 있고, AI는 이미 쓰고 있는
  로컬 CLI(Claude Code 또는 Cursor Agent)를 그대로 빌려 씁니다.
- **Docker 없음** — Postgres(PGlite)가 앱 안에서 돕니다.

## 설치 (앱)

**[최신 버전 내려받기 →](https://github.com/dataofmen/loop-studio/releases/latest)**
· [앱이 열리지 않을 때](#처음-실행하기)

> ⚠️ **Apple Silicon(M1 이상) 전용입니다. Intel Mac에서는 실행되지 않습니다.**
> 애플 메뉴  → `이 Mac에 관하여`의 칩 항목이 **Apple M1/M2/M3/M4** 인지 확인하세요.
> macOS 11 이상 필요.

1. AI CLI 중 하나를 설치하고 로그인합니다. 설계·검토·시뮬레이션이 전부 이 CLI를 통해
   실행되므로 이게 없으면 앱이 할 수 있는 일이 없습니다.
   ```bash
   npm i -g @anthropic-ai/claude-code     # 또는
   curl https://cursor.com/install -fsS | bash
   ```
2. 내려받은 `.dmg`(35MB)를 열어 앱을 Applications로 끌어다 놓습니다.
3. **처음 한 번만 승인**이 필요합니다 — 아래 "처음 실행하기"를 따라 하세요.

## 처음 실행하기

이 앱은 Apple 유료 개발자 인증서로 서명되지 않았습니다. 그래서 macOS가 첫 실행을 한 번
막습니다. **한 번만** 넘어가면 그 뒤로는 보통 앱처럼 더블클릭으로 열립니다.

가장 흔한 막히는 지점부터 말씀드리면 — **"확인 없이 열기" 버튼은 처음부터 있지 않습니다.
앱을 한 번 열어 보고 차단된 뒤에야 설정에 나타납니다.** 순서를 지켜 주세요.

1. `Applications`(응용 프로그램)에서 **Loop Studio를 더블클릭**합니다.
2. 열 수 없다는 메시지가 나옵니다. **취소**를 누릅니다. (여기서 "휴지통으로 이동"을 누르지 마세요.)
3. `시스템 설정`(  → 시스템 설정)을 열고 왼쪽에서 **개인정보 보호 및 보안**을 선택합니다.
4. 오른쪽을 **아래로 스크롤**하면 `보안` 항목에
   *"Loop Studio"이(가) 차단되었습니다…* 같은 문구와 함께 **`확인 없이 열기`** 버튼이 있습니다.
   이 버튼은 1~2단계를 거치지 않으면 보이지 않습니다.
5. 버튼을 누르고, 확인 창에서 한 번 더 **열기**를 누른 뒤 Touch ID나 로그인 암호로 승인합니다.
6. 앱이 열립니다. 이후에는 더블클릭으로 바로 열립니다.

### 잘 안 될 때

| 증상 | 원인과 해결 |
|---|---|
| 4단계에 버튼이 없다 | 1~2단계를 건너뛴 경우입니다. 앱을 한 번 더 더블클릭해 차단시킨 뒤 설정을 다시 보세요. |
| "손상되었기 때문에 열 수 없습니다" | 내려받다 파일이 깨진 경우가 대부분입니다. 릴리스 페이지의 SHA-256과 대조해 보고(`shasum -a 256 <파일>`) 다르면 다시 내려받으세요. |
| 열렸지만 창이 비어 있거나 안내가 뜬다 | AI CLI(`claude` 또는 `cursor-agent`)를 설치·로그인하지 않은 경우입니다. 1단계를 먼저 하세요. |
| Apple Silicon인데도 실행되지 않는다 | macOS 11 이상인지 확인하세요. |

> 터미널을 쓰신다면 3~5단계 대신 한 줄로도 됩니다:
> `xattr -d com.apple.quarantine "/Applications/Loop Studio.app"`
> 이 명령은 macOS의 출처 확인을 건너뛰겠다는 뜻이므로, 신뢰하는 파일에만 쓰세요.

데이터는 `~/Library/Application Support/io.github.dataofmen.loop-studio`에 저장됩니다.

## 개발 환경에서 실행

1. AI CLI 중 하나를 설치하고 로그인합니다.
   ```bash
   npm i -g @anthropic-ai/claude-code     # 또는
   curl https://cursor.com/install -fsS | bash
   ```
2. 의존성을 받고 실행합니다.
   ```bash
   bun install
   bun run dev
   ```
3. http://127.0.0.1:3000 을 엽니다.

CLI가 안 잡히면 대시보드 상단에 안내가 뜹니다 — 설정에서 도구를 바꾸거나 실행 파일
경로를 직접 지정하세요.

## 쓰는 순서

| 단계 | 화면 | 하는 일 |
|---|---|---|
| ① 설계 | `/surveys/[id]/edit` | 목표 한 줄 → AI가 문항 초안 생성, 표시 로직·carry-forward·데모그래픽 프리셋 편집 |
| ② 검토 | 개요 탭 | AI 리뷰 + 구조·로직 자동 점검 → 통과하면 '검토 완료' |
| ③ 미리보기 | `/preview/[id]` | 응답자가 보는 그대로 걸어보기 (아무것도 저장하지 않음) |
| ④ 시뮬레이션 | `/surveys/[id]/simulate` | 페르소나 표본 생성 → 합성 응답 생성 |
| ⑤ 결과 | `/surveys/[id]/results` | 문항별 분포·AI 인사이트·주관식 테마·리포트·분석용 내보내기 |

## 데이터

전부 `~/.loop` 안에 있습니다 (`LOOP_DATA_DIR`로 변경 가능).
백업은 이 폴더 복사, 이전은 붙여넣기, 초기화는 삭제입니다.

## 페르소나 코퍼스 (선택)

기본값은 AI가 설명에 맞는 페르소나를 만들어내는 방식입니다. 그럴듯하지만 **실제 인구
분포를 따르지는 않습니다.**

공식 인구통계에 비례하는 **대표성 표본**을 쓰려면 NVIDIA
[Nemotron-Personas-Korea](https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea)
코퍼스가 필요합니다 (100만 명, 실제 인구통계 분포, CC BY 4.0).

```bash
# 1) 샤드 한 개를 data/train-00000-of-00009.parquet 로 내려받고
bun run personas:build          # → data/personas.db (uv 필요)

# 2) 대표성 배분에 쓸 행정안전부 인구통계 스냅샷
DATA_GO_KR_SERVICE_KEY=... bun run population:build
```

`PERSONA_DB_PATH`로 다른 위치의 코퍼스를 가리킬 수 있습니다.

## 명령어

```bash
bun run dev         # 마이그레이션 후 개발 서버 (127.0.0.1)
bun run build       # 프로덕션 빌드 (standalone)
bun run start       # 마이그레이션 후 프로덕션 서버 (127.0.0.1)
bun run package     # 빌드 + dist/app 번들 조립 (run.sh로 단독 실행 가능)
bun run app:build   # .app / .dmg 빌드 (Rust + vendor/ Node 필요)
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run db:generate # 스키마 변경 → 마이그레이션 SQL
bun run db:migrate  # 마이그레이션 적용
```

### 앱 빌드 준비

`bun run app:build` 전에 두 가지가 필요합니다.

```bash
# 1) Rust 툴체인
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2) 동봉할 Node 런타임. Homebrew node는 Homebrew dylib에 링크돼 있어 다른
#    컴퓨터에서 실행되지 않으므로 아래 중 하나를 쓰세요.

# 2-a) 작게 (권장) — 안 쓰는 ICU 데이터 32MB를 뺀 소스 빌드. 20~30분 소요.
mkdir -p vendor && cd vendor
curl -LO https://nodejs.org/dist/v24.18.0/node-v24.18.0.tar.gz
tar xzf node-v24.18.0.tar.gz && cd node-v24.18.0
./configure --with-intl=small-icu --without-node-snapshot
make -j$(sysctl -n hw.ncpu)

# 2-b) 빠르게 — 공식 바이너리 (앱이 34MB 커집니다)
mkdir -p vendor && cd vendor
curl -LO https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz
tar xzf node-v24.18.0-darwin-arm64.tar.gz
```

## 보안·프라이버시

이 앱의 보안 모델은 "네트워크에 없다"입니다.

- **로그인이 없습니다.** 서버는 `127.0.0.1`에만 바인딩되어 같은 컴퓨터에서만 접근됩니다.
  같은 머신의 다른 사용자·프로세스는 신뢰 경계 안으로 봅니다 — 공용 컴퓨터에서는 쓰지 마세요.
- **데이터는 로컬 폴더 하나**(`~/Library/Application Support/io.github.dataofmen.loop-studio`).
  암호화하지 않습니다 — 필요하면 FileVault 같은 디스크 암호화를 쓰세요.
- **설문 내용은 내가 로그인한 AI 제공자로 전송됩니다.** 설계·검토·시뮬레이션이 로컬 CLI를
  호출하기 때문입니다. 민감한 내용은 해당 제공자의 데이터 정책을 먼저 확인하세요.
- **텔레메트리·사용 분석·자동 업데이트 없음.** 앱이 먼저 외부로 통신하는 경로는 없습니다.
- **프롬프트 인젝션 대비**: 설문 텍스트가 AI CLI에 전달되므로, 남이 만든 마크다운 설문에
  지시문이 숨어 있을 수 있습니다. 그래서 CLI 호출은 도구 없이 실행합니다
  (claude는 `--disallowed-tools`, cursor는 `--mode ask`). 그래도 출처를 모르는 설문 파일은
  내용을 한 번 읽어 보고 반입하는 편이 안전합니다.
- **배포본은 코드 서명이 없습니다.** 첫 실행에 Gatekeeper 경고가 뜨는 이유이며, 신뢰할 수 있는
  경로로 받은 파일만 여세요. 직접 빌드하는 방법은 아래에 있습니다.

취약점을 발견하면 공개 이슈보다 이 저장소의 Security advisory로 알려주세요.

## 문서

- [사용자 가이드](docs/user-guide.md) — 설계 → 검토 → 미리보기 → 시뮬레이션 → 결과
- [설문 마크다운 형식](docs/survey-markdown.md) — 문서로 작성한 설문 불러오기
- [설계 노트](docs/design-notes.md) — 이 방향을 택한 배경과 결정 기록
- [서드파티 고지](NOTICE.md)
