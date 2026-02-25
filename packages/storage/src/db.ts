import { DatabaseSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/sqlite-proxy";

import { schema } from "./schema.js";

const CREATE_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    default_engine TEXT NOT NULL,
    opencode_attach_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    external_chat_id TEXT,
    title TEXT,
    is_public_group INTEGER NOT NULL DEFAULT 0,
    unsafe_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT,
    chat_id TEXT NOT NULL,
    command TEXT NOT NULL,
    run_id TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    chat_id TEXT,
    provider TEXT NOT NULL,
    engine_session_id TEXT,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (chat_id) REFERENCES chats(id)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    summary_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )`,
  `CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id)
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT,
    project_id TEXT NOT NULL,
    session_id TEXT,
    direction TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_rel_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_inbox (
    update_id INTEGER PRIMARY KEY NOT NULL,
    chat_id TEXT,
    payload_json TEXT NOT NULL,
    received_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    available_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id)
  )`
] as const;

export type StorageDb = ReturnType<typeof drizzle<typeof schema>>;

export interface StorageDatabase {
  db: StorageDb;
  sqlite: DatabaseSync;
  close: () => void;
}

export function createSqliteStorageDatabase(filename = ":memory:"): StorageDatabase {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle(async (statement, params, method) => {
    const prepared = sqlite.prepare(statement);

    if (method === "run") {
      prepared.run(...params);
      return { rows: [] };
    }

    prepared.setReturnArrays(true);

    if (method === "get") {
      const row = prepared.get(...params);
      return { rows: row === undefined ? [] : [row] };
    }

    const rows = prepared.all(...params) as unknown[];
    return { rows };
  }, { schema });

  return {
    db,
    sqlite,
    close: () => sqlite.close()
  };
}

export function applySchema(sqlite: DatabaseSync): void {
  for (const statement of CREATE_TABLE_STATEMENTS) {
    sqlite.exec(statement);
  }

  ensureColumn(sqlite, "runs", "prompt", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(sqlite, "chats", "is_public_group", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sqlite, "chats", "unsafe_until", "INTEGER");
  ensureColumn(sqlite, "sessions", "engine_session_id", "TEXT");
}

function ensureColumn(sqlite: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  const names = new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
  if (names.has(column)) {
    return;
  }

  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
