# Code Patterns

## 프로세스 실행 패턴

```typescript
// packages/core/src/runner.ts
// 자식 프로세스 실행 및 스트리밍 파싱
const process = spawn('claude', ['-p', prompt], {
  cwd: projectRoot,
  stdio: ['ignore', 'pipe', 'pipe']
})

process.stdout.on('data', (chunk) => {
  // 스트리밍 출력 파싱
  decodeAndParse(chunk)
})

process.stderr.on('data', (chunk) => {
  // 에러 로깅
})
```

## Drizzle ORM 패턴

```typescript
// packages/storage/src/schema.ts
// SQLite 스키마 정의
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  engine: text('engine').notNull(),
  projectId: text('project_id').references(() => projects.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
})
```

## Telegram 인라인 키보드 패턴

```typescript
// packages/telegram/src/handler.ts
// 세션별 엔진 전환 버튼
const inlineKeyboard: InlineKeyboard = [
  [
    { text: 'claude ✓', callback_data: 'engine:claude' },
    { text: 'opencode', callback_data: 'engine:opencode' }
  ],
  [
    { text: '🆕 새 세션', callback_data: 'session:new' },
    { text: '💻 세션', callback_data: 'session:list' }
  ]
]
```

## Fastify API 라우팅 패턴

```typescript
// apps/server/src/index.ts
// 라우터 등록
server.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date() }
})

server.post('/run', async (request, reply) => {
  // 실행 로직
})
```

## 세션 관리 패턴

```typescript
// packages/core/src/engine-events.ts
// 세션 이벤트 타입 정의
export type EngineEvent =
  | { type: 'start'; prompt: string }
  | { type: 'text'; content: string }
  | { type: 'tool'; tool: string; input: unknown }
  | { type: 'error'; error: string }
  | { type: 'end'; exitCode: number }
```
