# 서드파티 고지

Loop Studio는 MIT 라이선스입니다(LICENSE). 아래는 함께 사용하거나 배포본에 동봉되는
구성요소의 출처와 라이선스입니다.

## 데이터셋 (선택 설치)

**NVIDIA Nemotron-Personas-Korea** — 대표성 표본에 쓰이는 한국어 페르소나 코퍼스.
<https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea>
라이선스: **CC BY 4.0** (<https://creativecommons.org/licenses/by/4.0/>) — 저작자 표시 필요.
이 저장소는 코퍼스를 포함하지 않습니다. 사용자가 직접 내려받아 설치하는 선택 구성요소입니다.

**행정안전부 주민등록 인구통계** — 대표성 표본의 인구 비례 배분 근거.
공공데이터포털 <https://www.data.go.kr/data/15097972/openapi.do> (이용 조건은 제공처 표기에 따름)
이 저장소는 스냅샷 데이터를 포함하지 않습니다.

## 배포본에 동봉되는 런타임

**Node.js** — 데스크톱 배포본(.dmg)에 사이드카로 동봉됩니다.
라이선스: MIT (<https://github.com/nodejs/node/blob/main/LICENSE>)
소스에서 `--with-intl=small-icu`로 빌드해 사용합니다. 저장소에는 포함되지 않습니다.

## 주요 의존성

| 구성요소 | 라이선스 |
|---|---|
| Next.js, React | MIT |
| Tauri | MIT / Apache-2.0 |
| @electric-sql/pglite (PGlite) | Apache-2.0 |
| Drizzle ORM | Apache-2.0 |
| Vega · Vega-Lite | BSD-3-Clause |
| @astryxdesign/core, flint-chart | MIT |

전체 목록과 정확한 고지는 `bun install` 후 `node_modules/<패키지>/LICENSE`를 참고하세요.

## AI 제공자

설계·검토·시뮬레이션은 사용자 컴퓨터에 설치된 **Claude Code** 또는 **Cursor Agent** CLI를
호출합니다. 이 저장소는 두 도구를 포함하지 않으며, 사용 시 각 제공자의 약관과 데이터 정책이
적용됩니다 — 설문 내용이 해당 제공자로 전송됩니다.
