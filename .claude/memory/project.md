# Project Memory

## 기본 정보
- **프로젝트명**: OhMyRemote
- **기술 스택**: Node.js 20+, TypeScript 5.9, pnpm workspaces, grammY, Fastify 5, SQLite + Drizzle ORM, Zod
- **시작일**: 2026-02-28
- **주요 용도**: Telegram으로 AI 코딩 에이전트(Claude Code, OpenCode) 원격 제어

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

**주요 동작**:
- 봇은 AI 엔진 프로세스(`claude -p` 또는 `opencode run`)를 자식 프로세스로 실행
- 스트리밍 출력을 파싱하여 이벤트를 실시간으로 Telegram에 전달
- 세션 관리, 작업 큐, 파일 전송, 감사 로깅 지원

## 주요 디렉토리
- `apps/bot/` — Telegram 봇 (grammY)
- `apps/server/` — Fastify API + 대시보드 API
- `apps/web/` — Vite + React 대시보드 (개발 중)
- `packages/core/` — 공유 타입, 설정 스키마, 프로세스 러너
- `packages/engines/` — Claude/OpenCode CLI 어댑터
- `packages/storage/` — SQLite + Drizzle ORM
- `packages/telegram/` — 명령 핸들러, 스트리밍, 인라인 키보드
- `config/` — 프로젝트 설정 파일
- `deploy/` — 배포 스크립트 (macOS launchd)
- `test/` — 테스트 파일

## 외부 서비스
- **Telegram** — 봇 API
- **Claude Code CLI** — AI 엔진 1
- **OpenCode CLI** — AI 엔진 2

## 특이사항
- 초기화 직후부터 Git 저장소에 커밋 (main 브랜치)
- 한국어 README (README_ko.md) 별도 저장
- macOS launchd를 통한 백그라운드 서비스 배포 지원
- Tailscale을 통한 비공개 접근 방식 지원
- 비상 스위치(KILL_SWITCH) 기능 제공
