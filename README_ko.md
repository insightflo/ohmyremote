# OhMyRemote

Telegram으로 AI 코딩 에이전트(Claude Code, OpenCode)를 원격 제어하세요. 프롬프트 실행, 모델 전환, 세션 모니터링, 프로젝트 관리까지 — 모든 것을 폰으로.

## 기능

- **Telegram 대시보드** — 버튼 한 번으로 모든 것을 관리하는 인터랙티브 인라인 키보드 UI (`/d`)
- **멀티 엔진** — Claude Code CLI와 OpenCode 지원, 세션별 엔진 전환 가능
- **모델 선택** — 대시보드에서 모델(Claude의 Opus/Sonnet/Haiku, OpenCode의 멀티 프로바이더)과 에이전트 선택
- **CLI 세션 모니터** — PC에서 실행 중인 Claude CLI 세션을 방해하지 않고 둘러보고 확인
- **세션 관리** — 새 세션 생성, 기존 CLI 세션에 연결, 또는 처음부터 시작
- **실시간 응답 스트리밍** — AI가 작업하는 동안 Telegram으로 실시간 응답 스트리밍
- **멀티 프로젝트** — 대시보드에서 프로젝트 전환
- **Unsafe 모드** — 시간 제한이 있는 안전하지 않은 툴 실행, 자동 만료
- **작업 큐** — 동시 작업 실행(최대 3개), 리스 갱신 및 실패 복구
- **파일 전송** — 프로젝트 디렉토리로 파일 업로드/다운로드
- **감사 로깅** — 모든 명령과 실행이 로깅됨
- **대시보드 API** — 헬스 체크와 Prometheus 메트릭이 있는 Fastify 서버

## 아키텍처

```
pnpm monorepo
├── apps/
│   ├── bot/          # grammY Telegram 봇 (long-polling)
│   ├── server/       # Fastify API + 대시보드
│   └── web/          # Vite + React 대시보드 (개발중)
└── packages/
    ├── core/         # 공유 타입, 설정 스키마, 프로세스 러너
    ├── engines/      # Claude/OpenCode CLI 어댑터
    ├── storage/      # SQLite + Drizzle ORM
    └── telegram/     # 명령 핸들러, 스트리밍, 인라인 키보드
```

봇은 AI 엔진 프로세스(`claude -p` 또는 `opencode run`)를 자식 프로세스로 실행하고, 스트리밍 출력을 파싱하여 이벤트를 실시간으로 Telegram에 전달합니다.

## 사전 요구사항

- Node.js 20+
- pnpm 9+
- Claude Code CLI 설치 및 인증 완료 (`claude` 명령어 사용 가능)
- (선택) OpenCode 설치 — OpenCode 엔진 지원용

## 빠른 시작

```bash
# 의존성 설치
pnpm install

# 설정 파일 복사
cp config/projects.example.json config/projects.json
cp .env.example .env

# .env에 Telegram 봇 토큰과 소유자 사용자 ID 입력
# config/projects.json에 프로젝트 경로 입력

# 테스트 실행
pnpm test

# 타입 체크
pnpm -r run typecheck

# 봇 + 서버 시작
pnpm start
```

## 설정

### Telegram 봇 설정

1. **봇 생성** — Telegram에서 [@BotFather](https://t.me/BotFather)를 검색하고, `/newbot`을 보낸 후 안내를 따르세요. 봇 토큰을 복사합니다.

2. **사용자 ID 확인** — [@userinfobot](https://t.me/userinfobot)에게 아무 메시지를 보내세요. 숫자로 된 사용자 ID를 회신해줍니다. 이 ID로 본인만 봇을 제어할 수 있도록 제한합니다.

3. **`.env` 설정** — 예시 파일을 복사하고 값을 입력하세요:

```bash
cp .env.example .env
```

```env
# 필수
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234...    # @BotFather에서 받은 토큰
TELEGRAM_OWNER_USER_ID=987654321            # @userinfobot에서 받은 ID

# 선택
DATA_DIR=./data                              # SQLite 데이터베이스 위치
PROJECTS_CONFIG_PATH=./config/projects.json  # 프로젝트 목록 경로
DASHBOARD_PORT=4312                          # 웹 대시보드 포트
DASHBOARD_BIND_HOST=127.0.0.1               # 바인드 주소 (localhost만)
# DASHBOARD_BASIC_AUTH_USER=admin            # 대시보드 베이직 인증
# DASHBOARD_BASIC_AUTH_PASS=password
# KILL_SWITCH_DISABLE_RUNS=false             # 모든 실행을 중단하는 비상 스위치
```

### 환경 변수

| 변수 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `TELEGRAM_BOT_TOKEN` | 예 | — | @BotFather에서 받은 Telegram Bot API 토큰 |
| `TELEGRAM_OWNER_USER_ID` | 예 | — | 본인의 Telegram 숫자 사용자 ID (이 사용자만 봇 제어 가능) |
| `DATA_DIR` | 아니오 | `./data` | SQLite 데이터베이스 저장 디렉토리 |
| `PROJECTS_CONFIG_PATH` | 아니오 | `./config/projects.json` | 프로젝트 설정 파일 경로 |
| `DASHBOARD_PORT` | 아니오 | `4312` | Fastify 대시보드 포트 |
| `DASHBOARD_BIND_HOST` | 아니오 | `127.0.0.1` | 대시보드 바인드 주소 |
| `DASHBOARD_BASIC_AUTH_USER` | 아니오 | — | 대시보드 베이직 인증 사용자명 |
| `DASHBOARD_BASIC_AUTH_PASS` | 아니오 | — | 대시보드 베이직 인증 비밀번호 |
| `KILL_SWITCH_DISABLE_RUNS` | 아니오 | `false` | 모든 실행을 비활성화하는 비상 스위치 |

### 프로젝트 설정

```json
[
  {
    "id": "my-project",
    "name": "내 프로젝트",
    "rootPath": "/home/user/projects/my-project",
    "defaultEngine": "claude"
  },
  {
    "id": "opencode-project",
    "name": "OpenCode 프로젝트",
    "rootPath": "/home/user/projects/opencode-project",
    "defaultEngine": "opencode",
    "opencodeAttachUrl": "http://localhost:3000"
  }
]
```

## Telegram 대시보드

`/d` 또는 `/dashboard`를 보내면 인터랙티브 제어판이 열립니다:

```
📋 OhMyRemote 대시보드

프로젝트: 내 프로젝트
엔진:    claude
모델:    기본
세션:    새 세션
Unsafe:  끄기

[ 내 프로젝트 ✅ ] [ 다른 프로젝트 ]
[ claude ✓ ] [ opencode ]
[ 🧠 모델: 기본 ]
[ 🆕 새 세션 ] [ 💻 세션 ]
[ ⚠️ Unsafe 30분 ] [ ⚠️ Unsafe 60분 ] [ 🔒 안전 ]
[ 🔄 새로고침 ]
```

모든 버튼은 같은 메시지를 제자리에서 업데이트합니다. 설정 후 텍스트 메시지를 보내면 프롬프트로 실행됩니다.

### 대시보드 액션

| 버튼 | 동작 |
|------|------|
| 프로젝트 버튼 | 활성 프로젝트 전환 |
| 엔진 토글 | Claude와 OpenCode 간 전환 |
| 모델 | 모델/에이전트 선택 서브메뉴 열기 |
| 새 세션 | 새로운 AI 세션 시작 |
| 세션 | CLI 세션 둘러보기 — 활동 확인 또는 연결 |
| Unsafe | 시간 제한 unsafe 툴 실행 활성화 |
| 새로고침 | 대시보드 상태 다시 로드 |

### CLI 세션 모니터

**세션** 버튼은 선택한 프로젝트의 `~/.claude/projects/`에서 Claude CLI 세션을 스캔합니다. 각 세션은 다음을 표시합니다:

- 첫 번째 프롬프트 (대화 주제)
- 마지막 활동 시간

세션을 선택하면 실행 중인 세션을 방해하지 않고 최근 활동(사용자 메시지, 어시스턴트 응답, 툴 호출)을 보여주는 **peek 뷰**가 열립니다. 그 다음 **연결**하여 원격으로 대화를 계속할 수 있습니다.

## 텍스트 명령어

모든 기존 텍스트 명령어는 대시보드와 함께 계속 작동합니다:

| 명령어 | 설명 |
|--------|------|
| `/d`, `/dashboard` | 인터랙티브 대시보드 열기 |
| `/projects` | 설정된 프로젝트 목록 |
| `/use <id>` | 프로젝트 선택 |
| `/engine <claude\|opencode>` | 기본 엔진 설정 |
| `/newsession <engine> [이름]` | 새 세션 생성 |
| `/run <텍스트>` | 프롬프트 실행 |
| `/continue [텍스트]` | 가장 최근 세션 계속 |
| `/attach <session_id>` | 특정 엔진 세션에 연결 |
| `/stop` | 현재 실행 취소 |
| `/status` | 현재 상태 표시 |
| `/enable_unsafe <분>` | unsafe 모드 활성화 |
| `/uploads` | 최근 업로드 목록 |
| `/get <경로>` | 프로젝트에서 파일 다운로드 |
| `/help` | 모든 명령어 표시 |

## 배포

### macOS launchd

```bash
# 백그라운드 서비스로 설치
sed -e "s|__PROJECT_ROOT__|$PWD|g" \
    -e "s|__PNPM_BIN__|$(command -v pnpm)|g" \
    deploy/macos/launchd/server.plist > ~/Library/LaunchAgents/ai.ohmyremote.server.plist

sed -e "s|__PROJECT_ROOT__|$PWD|g" \
    -e "s|__PNPM_BIN__|$(command -v pnpm)|g" \
    deploy/macos/launchd/bot.plist > ~/Library/LaunchAgents/ai.ohmyremote.bot.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ohmyremote.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ohmyremote.bot.plist
```

로그: `/tmp/ohmyremote-{server,bot}.{out,err}.log`

### Tailscale을 통한 비공개 접근

대시보드를 루프백에 바인딩하고 Tailscale으로 노출:

```bash
tailscale serve http://127.0.0.1:4312
```

## 기술 스택

| 계층 | 기술 |
|------|------|
| 런타임 | Node.js 20+ / TypeScript 5.9 |
| 모노레포 | pnpm workspaces |
| 봇 | grammY |
| API | Fastify 5 |
| 데이터베이스 | SQLite + Drizzle ORM |
| 검증 | Zod |
| AI 엔진 | Claude Code CLI, OpenCode CLI |

## 라이선스

MIT
