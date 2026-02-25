import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";

import { auditLogs, chats, files, jobs, projects, runEvents, runs, schema, sessions, telegramInbox } from "./schema.js";
import type { StorageDb } from "./db.js";

export interface StorageRepository {
  createProject(input: {
    id: string;
    name: string;
    rootPath: string;
    defaultEngine: string;
    opencodeAttachUrl?: string | null;
  }): Promise<void>;
  getProject(projectId: string): Promise<typeof projects.$inferSelect | undefined>;
  listProjects(): Promise<(typeof projects.$inferSelect)[]>;
  createChat(input: {
    id: string;
    projectId: string;
    externalChatId?: string | null;
    title?: string | null;
  }): Promise<void>;
  upsertChatByExternalChatId(input: {
    externalChatId: string;
    projectId: string;
    title?: string | null;
  }): Promise<void>;
  setChatUnsafeUntil(input: {
    externalChatId: string;
    unsafeUntil: number | null;
  }): Promise<void>;
  getChatUnsafeUntil(externalChatId: string): Promise<number | undefined>;
  createSession(input: {
    id: string;
    projectId: string;
    chatId?: string | null;
    provider: string;
    engineSessionId?: string | null;
    status: string;
    prompt: string;
  }): Promise<void>;
  setSessionEngineSessionId(input: { sessionId: string; engineSessionId: string | null }): Promise<void>;
  getSessionById(sessionId: string): Promise<typeof sessions.$inferSelect | undefined>;
  listSessionsByProject(projectId: string): Promise<(typeof sessions.$inferSelect)[]>;
  createRun(input: {
    id: string;
    projectId: string;
    sessionId: string;
    idempotencyKey: string;
    prompt: string;
    status: string;
    startedAt?: number;
    summaryJson?: string | null;
  }): Promise<void>;
  getRunById(runId: string): Promise<typeof runs.$inferSelect | undefined>;
  getRunByIdempotencyKey(idempotencyKey: string): Promise<typeof runs.$inferSelect | undefined>;
  findActiveRunBySession(sessionId: string): Promise<typeof runs.$inferSelect | undefined>;
  markRunInFlight(input: {
    runId: string;
    startedAt: number;
  }): Promise<void>;
  finalizeRun(input: {
    runId: string;
    status: string;
    finishedAt: number;
    summaryJson?: string | null;
  }): Promise<void>;
  abandonRun(input: {
    runId: string;
    finishedAt: number;
  }): Promise<void>;
  listRunsByStatus(status: string): Promise<(typeof runs.$inferSelect)[]>;
  listRunsBySession(input: {
    sessionId: string;
    limit?: number;
  }): Promise<(typeof runs.$inferSelect)[]>;
  listRuns(limit?: number): Promise<(typeof runs.$inferSelect)[]>;
  appendRunEvent(input: {
    id: string;
    runId: string;
    eventType: string;
    payloadJson: string;
    createdAt?: number;
  }): Promise<number>;
  listRunEvents(runId: string): Promise<(typeof runEvents.$inferSelect)[]>;
  listRunEventsPage(input: {
    runId: string;
    minSeq?: number;
    limit?: number;
  }): Promise<(typeof runEvents.$inferSelect)[]>;
  insertTelegramInbox(input: {
    updateId: number;
    chatId?: string | null;
    payloadJson: string;
    receivedAt?: number;
  }): Promise<boolean>;
  enqueueJob(input: {
    id: string;
    runId: string;
    availableAt: number;
  }): Promise<void>;
  leaseNextJob(input: {
    owner: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<typeof jobs.$inferSelect | undefined>;
  getJobByRunId(runId: string): Promise<typeof jobs.$inferSelect | undefined>;
  completeJob(input: {
    jobId: string;
    now: number;
  }): Promise<void>;
  failJob(input: {
    jobId: string;
    now: number;
    error: string;
  }): Promise<void>;
  requeueLeasedJobByRunId(input: {
    runId: string;
    now: number;
  }): Promise<void>;
  createFileRecord(input: {
    id: string;
    projectId: string;
    sessionId?: string | null;
    runId?: string | null;
    direction: string;
    originalName: string;
    storedRelPath: string;
    sizeBytes: number;
    sha256: string;
    createdAt?: number;
  }): Promise<void>;
  listFileRecordsBySession(input: {
    projectId: string;
    sessionId: string;
    direction?: string;
    limit?: number;
  }): Promise<(typeof files.$inferSelect)[]>;
  listFileRecordsBySessionId(input: {
    sessionId: string;
    direction?: string;
    limit?: number;
  }): Promise<(typeof files.$inferSelect)[]>;
  listFileRecords(limit?: number): Promise<(typeof files.$inferSelect)[]>;
  listTelegramInbox(limit?: number): Promise<(typeof telegramInbox.$inferSelect)[]>;
  appendAuditLog(input: {
    id: string;
    userId?: string | null;
    chatId: string;
    command: string;
    runId?: string | null;
    decision: string;
    reason?: string | null;
    createdAt?: number;
  }): Promise<void>;
  renewJobLease(input: {
    jobId: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<void>;
  cancelRun(input: {
    runId: string;
    now: number;
  }): Promise<void>;
}

export class DrizzleStorageRepository implements StorageRepository {
  public constructor(private readonly db: StorageDb) {}

  public async createProject(input: {
    id: string;
    name: string;
    rootPath: string;
    defaultEngine: string;
    opencodeAttachUrl?: string | null;
  }): Promise<void> {
    const now = Date.now();
    await this.db.insert(projects).values({
      id: input.id,
      name: input.name,
      rootPath: input.rootPath,
      defaultEngine: input.defaultEngine,
      opencodeAttachUrl: input.opencodeAttachUrl ?? null,
      createdAt: now,
      updatedAt: now
    });
  }

  public async getProject(projectId: string): Promise<typeof projects.$inferSelect | undefined> {
    const rows = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return rows[0];
  }

  public async listProjects(): Promise<(typeof projects.$inferSelect)[]> {
    return this.db.select().from(projects).orderBy(asc(projects.createdAt));
  }

  public async createChat(input: {
    id: string;
    projectId: string;
    externalChatId?: string | null;
    title?: string | null;
  }): Promise<void> {
    const now = Date.now();
    await this.db.insert(chats).values({
      id: input.id,
      projectId: input.projectId,
      externalChatId: input.externalChatId ?? null,
      title: input.title ?? null,
      isPublicGroup: 0,
      unsafeUntil: null,
      createdAt: now,
      updatedAt: now
    });
  }

  public async upsertChatByExternalChatId(input: {
    externalChatId: string;
    projectId: string;
    title?: string | null;
  }): Promise<void> {
    const now = Date.now();
    const existing = await this.db
      .select()
      .from(chats)
      .where(eq(chats.externalChatId, input.externalChatId))
      .limit(1);

    if (existing[0]) {
      await this.db
        .update(chats)
        .set({
          projectId: input.projectId,
          title: input.title ?? existing[0].title,
          updatedAt: now,
        })
        .where(eq(chats.id, existing[0].id));
      return;
    }

    await this.db.insert(chats).values({
      id: input.externalChatId,
      projectId: input.projectId,
      externalChatId: input.externalChatId,
      title: input.title ?? null,
      isPublicGroup: 0,
      unsafeUntil: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  public async setChatUnsafeUntil(input: {
    externalChatId: string;
    unsafeUntil: number | null;
  }): Promise<void> {
    const now = Date.now();
    await this.db
      .update(chats)
      .set({
        unsafeUntil: input.unsafeUntil,
        updatedAt: now,
      })
      .where(eq(chats.externalChatId, input.externalChatId));
  }

  public async getChatUnsafeUntil(externalChatId: string): Promise<number | undefined> {
    const rows = await this.db
      .select({ unsafeUntil: chats.unsafeUntil })
      .from(chats)
      .where(eq(chats.externalChatId, externalChatId))
      .limit(1);
    const value = rows[0]?.unsafeUntil;
    return typeof value === "number" ? value : undefined;
  }

  public async createSession(input: {
    id: string;
    projectId: string;
    chatId?: string | null;
    provider: string;
    engineSessionId?: string | null;
    status: string;
    prompt: string;
  }): Promise<void> {
    const now = Date.now();
    await this.db.insert(sessions).values({
      id: input.id,
      projectId: input.projectId,
      chatId: input.chatId ?? null,
      provider: input.provider,
      engineSessionId: input.engineSessionId ?? null,
      status: input.status,
      prompt: input.prompt,
      createdAt: now,
      updatedAt: now
    });
  }

  public async setSessionEngineSessionId(input: {
    sessionId: string;
    engineSessionId: string | null;
  }): Promise<void> {
    await this.db
      .update(sessions)
      .set({ engineSessionId: input.engineSessionId, updatedAt: Date.now() })
      .where(eq(sessions.id, input.sessionId));
  }

  public async getSessionById(sessionId: string): Promise<typeof sessions.$inferSelect | undefined> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    return rows[0];
  }

  public async listSessionsByProject(projectId: string): Promise<(typeof sessions.$inferSelect)[]> {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.projectId, projectId))
      .orderBy(asc(sessions.createdAt));
  }

  public async createRun(input: {
    id: string;
    projectId: string;
    sessionId: string;
    idempotencyKey: string;
    prompt: string;
    status: string;
    startedAt?: number;
    summaryJson?: string | null;
  }): Promise<void> {
    const now = Date.now();

    await this.db.insert(runs).values({
      id: input.id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      prompt: input.prompt,
      status: input.status,
      startedAt: input.startedAt,
      summaryJson: input.summaryJson ?? null,
      createdAt: now,
      updatedAt: now
    });
  }

  public async getRunById(runId: string): Promise<typeof runs.$inferSelect | undefined> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    return rows[0];
  }

  public async getRunByIdempotencyKey(idempotencyKey: string): Promise<typeof runs.$inferSelect | undefined> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0];
  }

  public async findActiveRunBySession(sessionId: string): Promise<typeof runs.$inferSelect | undefined> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, sessionId),
          or(eq(runs.status, "queued"), eq(runs.status, "in_flight"), eq(runs.status, "leased"))
        )
      )
      .orderBy(asc(runs.createdAt))
      .limit(1);

    return rows[0];
  }

  public async markRunInFlight(input: {
    runId: string;
    startedAt: number;
  }): Promise<void> {
    await this.db
      .update(runs)
      .set({
        status: "in_flight",
        startedAt: input.startedAt,
        updatedAt: input.startedAt
      })
      .where(eq(runs.id, input.runId));
  }

  public async finalizeRun(input: {
    runId: string;
    status: string;
    finishedAt: number;
    summaryJson?: string | null;
  }): Promise<void> {
    await this.db
      .update(runs)
      .set({
        status: input.status,
        finishedAt: input.finishedAt,
        summaryJson: input.summaryJson ?? null,
        updatedAt: input.finishedAt
      })
      .where(eq(runs.id, input.runId));
  }

  public async abandonRun(input: {
    runId: string;
    finishedAt: number;
  }): Promise<void> {
    await this.db
      .update(runs)
      .set({
        status: "abandoned",
        finishedAt: input.finishedAt,
        updatedAt: input.finishedAt
      })
      .where(and(eq(runs.id, input.runId), eq(runs.status, "in_flight")));
  }

  public async listRunsByStatus(status: string): Promise<(typeof runs.$inferSelect)[]> {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.status, status))
      .orderBy(asc(runs.createdAt));
  }

  public async listRunsBySession(input: {
    sessionId: string;
    limit?: number;
  }): Promise<(typeof runs.$inferSelect)[]> {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, input.sessionId))
      .orderBy(sql`${runs.createdAt} desc`)
      .limit(input.limit ?? 50);
  }

  public async listRuns(limit = 1000): Promise<(typeof runs.$inferSelect)[]> {
    return this.db
      .select()
      .from(runs)
      .orderBy(sql`${runs.createdAt} desc`)
      .limit(limit);
  }

  public async appendRunEvent(input: {
    id: string;
    runId: string;
    eventType: string;
    payloadJson: string;
    createdAt?: number;
  }): Promise<number> {
    const seqRows = await this.db
      .select({ maxSeq: sql<number>`coalesce(max(${runEvents.seq}), 0)` })
      .from(runEvents)
      .where(eq(runEvents.runId, input.runId));

    const nextSeq = (seqRows[0]?.maxSeq ?? 0) + 1;
    await this.db.insert(runEvents).values({
      id: input.id,
      runId: input.runId,
      seq: nextSeq,
      eventType: input.eventType,
      payloadJson: input.payloadJson,
      createdAt: input.createdAt ?? Date.now()
    });

    return nextSeq;
  }

  public async listRunEvents(runId: string): Promise<(typeof runEvents.$inferSelect)[]> {
    return this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq));
  }

  public async listRunEventsPage(input: {
    runId: string;
    minSeq?: number;
    limit?: number;
  }): Promise<(typeof runEvents.$inferSelect)[]> {
    const minSeq = input.minSeq ?? 1;
    return this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, input.runId), sql`${runEvents.seq} >= ${minSeq}`))
      .orderBy(asc(runEvents.seq))
      .limit(input.limit ?? 100);
  }

  public async insertTelegramInbox(input: {
    updateId: number;
    chatId?: string | null;
    payloadJson: string;
    receivedAt?: number;
  }): Promise<boolean> {
    const existing = await this.db
      .select({ updateId: telegramInbox.updateId })
      .from(telegramInbox)
      .where(eq(telegramInbox.updateId, input.updateId))
      .limit(1);

    if (existing.length > 0) {
      return false;
    }

    await this.db.insert(telegramInbox).values({
      updateId: input.updateId,
      chatId: input.chatId ?? null,
      payloadJson: input.payloadJson,
      receivedAt: input.receivedAt ?? Date.now()
    });

    return true;
  }

  public async enqueueJob(input: {
    id: string;
    runId: string;
    availableAt: number;
  }): Promise<void> {
    const now = Date.now();
    await this.db.insert(jobs).values({
      id: input.id,
      runId: input.runId,
      status: "queued",
      availableAt: input.availableAt,
      createdAt: now,
      updatedAt: now
    });
  }

  public async leaseNextJob(input: {
    owner: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<typeof jobs.$inferSelect | undefined> {
    const candidates = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "queued"),
          lte(jobs.availableAt, input.now),
          or(isNull(jobs.leaseExpiresAt), lte(jobs.leaseExpiresAt, input.now))
        )
      )
      .orderBy(asc(jobs.availableAt), asc(jobs.createdAt))
      .limit(1);

    const candidate = candidates[0];

    if (!candidate) {
      return undefined;
    }

    const leaseUntil = input.now + input.leaseDurationMs;
    await this.db
      .update(jobs)
      .set({
        leaseOwner: input.owner,
        leaseExpiresAt: leaseUntil,
        status: "leased",
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: input.now
      })
      .where(
        and(
          eq(jobs.id, candidate.id),
          eq(jobs.status, "queued"),
          or(isNull(jobs.leaseExpiresAt), lte(jobs.leaseExpiresAt, input.now))
        )
      );

    const leased = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, candidate.id), eq(jobs.leaseOwner, input.owner), eq(jobs.status, "leased")))
      .limit(1);

    return leased[0];
  }

  public async getJobByRunId(runId: string): Promise<typeof jobs.$inferSelect | undefined> {
    const rows = await this.db.select().from(jobs).where(eq(jobs.runId, runId)).limit(1);
    return rows[0];
  }

  public async completeJob(input: {
    jobId: string;
    now: number;
  }): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now
      })
      .where(eq(jobs.id, input.jobId));
  }

  public async failJob(input: {
    jobId: string;
    now: number;
    error: string;
  }): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: input.error,
        updatedAt: input.now
      })
      .where(eq(jobs.id, input.jobId));
  }

  public async requeueLeasedJobByRunId(input: {
    runId: string;
    now: number;
  }): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt: input.now,
        updatedAt: input.now
      })
      .where(and(eq(jobs.runId, input.runId), eq(jobs.status, "leased")));
  }

  public async createFileRecord(input: {
    id: string;
    projectId: string;
    sessionId?: string | null;
    runId?: string | null;
    direction: string;
    originalName: string;
    storedRelPath: string;
    sizeBytes: number;
    sha256: string;
    createdAt?: number;
  }): Promise<void> {
    await this.db.insert(files).values({
      id: input.id,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      direction: input.direction,
      originalName: input.originalName,
      storedRelPath: input.storedRelPath,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      createdAt: input.createdAt ?? Date.now(),
    });
  }

  public async listFileRecordsBySession(input: {
    projectId: string;
    sessionId: string;
    direction?: string;
    limit?: number;
  }): Promise<(typeof files.$inferSelect)[]> {
    const filter = input.direction
      ? and(
          eq(files.projectId, input.projectId),
          eq(files.sessionId, input.sessionId),
          eq(files.direction, input.direction)
        )
      : and(eq(files.projectId, input.projectId), eq(files.sessionId, input.sessionId));

    return this.db
      .select()
      .from(files)
      .where(filter)
      .orderBy(sql`${files.createdAt} desc`)
      .limit(input.limit ?? 10);
  }

  public async listFileRecordsBySessionId(input: {
    sessionId: string;
    direction?: string;
    limit?: number;
  }): Promise<(typeof files.$inferSelect)[]> {
    const filter = input.direction
      ? and(eq(files.sessionId, input.sessionId), eq(files.direction, input.direction))
      : eq(files.sessionId, input.sessionId);

    return this.db
      .select()
      .from(files)
      .where(filter)
      .orderBy(sql`${files.createdAt} desc`)
      .limit(input.limit ?? 20);
  }

  public async listFileRecords(limit = 1000): Promise<(typeof files.$inferSelect)[]> {
    return this.db
      .select()
      .from(files)
      .orderBy(sql`${files.createdAt} desc`)
      .limit(limit);
  }

  public async listTelegramInbox(limit = 1000): Promise<(typeof telegramInbox.$inferSelect)[]> {
    return this.db
      .select()
      .from(telegramInbox)
      .orderBy(sql`${telegramInbox.receivedAt} desc`)
      .limit(limit);
  }

  public async appendAuditLog(input: {
    id: string;
    userId?: string | null;
    chatId: string;
    command: string;
    runId?: string | null;
    decision: string;
    reason?: string | null;
    createdAt?: number;
  }): Promise<void> {
    await this.db.insert(auditLogs).values({
      id: input.id,
      userId: input.userId ?? null,
      chatId: input.chatId,
      command: input.command,
      runId: input.runId ?? null,
      decision: input.decision,
      reason: input.reason ?? null,
      createdAt: input.createdAt ?? Date.now(),
    });
  }

  public async renewJobLease(input: {
    jobId: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<void> {
    const leaseUntil = input.now + input.leaseDurationMs;
    await this.db
      .update(jobs)
      .set({
        leaseExpiresAt: leaseUntil,
        updatedAt: input.now,
      })
      .where(and(eq(jobs.id, input.jobId), eq(jobs.status, "leased")));
  }

  public async cancelRun(input: {
    runId: string;
    now: number;
  }): Promise<void> {
    await this.db
      .update(runs)
      .set({
        status: "cancelled",
        finishedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(runs.id, input.runId));

    await this.db
      .update(jobs)
      .set({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(eq(jobs.runId, input.runId));
  }
}

export function createStorageRepository(db: StorageDb): StorageRepository {
  return new DrizzleStorageRepository(db);
}

export type StorageSchema = typeof schema;
