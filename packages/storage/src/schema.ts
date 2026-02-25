import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  defaultEngine: text("default_engine").notNull(),
  opencodeAttachUrl: text("opencode_attach_url"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull()
});

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  externalChatId: text("external_chat_id"),
  title: text("title"),
  isPublicGroup: integer("is_public_group", { mode: "number" }).notNull().default(0),
  unsafeUntil: integer("unsafe_until", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull()
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  chatId: text("chat_id").notNull(),
  command: text("command").notNull(),
  runId: text("run_id"),
  decision: text("decision").notNull(),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "number" }).notNull()
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  chatId: text("chat_id").references(() => chats.id),
  provider: text("provider").notNull(),
  engineSessionId: text("engine_session_id"),
  status: text("status").notNull(),
  prompt: text("prompt").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull()
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at", { mode: "number" }),
  finishedAt: integer("finished_at", { mode: "number" }),
  summaryJson: text("summary_json"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull()
});

export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  seq: integer("seq", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull()
});

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  runId: text("run_id").references(() => runs.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").references(() => sessions.id),
  direction: text("direction").notNull(),
  originalName: text("original_name").notNull(),
  storedRelPath: text("stored_rel_path").notNull(),
  sizeBytes: integer("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull()
});

export const telegramInbox = sqliteTable("telegram_inbox", {
  updateId: integer("update_id", { mode: "number" }).primaryKey(),
  chatId: text("chat_id"),
  payloadJson: text("payload_json").notNull(),
  receivedAt: integer("received_at", { mode: "number" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id).unique(),
  status: text("status").notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "number" }),
  availableAt: integer("available_at", { mode: "number" }).notNull(),
  attempts: integer("attempts", { mode: "number" }).notNull().default(0),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull()
});

export const schema = {
  projects,
  chats,
  auditLogs,
  sessions,
  runs,
  runEvents,
  files,
  telegramInbox,
  jobs
};

export type Schema = typeof schema;
