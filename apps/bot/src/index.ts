import { Bot, InputFile } from "grammy";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProcessRunner, ProjectsConfigSchema, type NormalizedEngineEvent } from "@ohmyremote/core";
import {
  buildClaudeCommandSpec,
  createClaudeStreamJsonParser,
  buildOpenCodeCommandSpec,
  createOpenCodeJsonlParser,
  createOpenCodePermissionConfigContent,
} from "@ohmyremote/engines";
import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";
import {
  createTelegramDataStore,
  TelegramCommandHandler,
  TelegramRunStreamer,
  type TelegramMessageTransport,
  type DownloadGateway,
  type RunGateway,
  type StopGateway,
} from "@ohmyremote/telegram";

export interface CreateBotOptions {
  ownerUserId: number;
  runGateway: RunGateway;
  stopGateway: StopGateway;
  downloadGateway: DownloadGateway;
  cancelRun?: (runId: string) => Promise<void>;
  store: ReturnType<typeof createTelegramDataStore>;
  reloadProjects?: () => Promise<{ count: number; configPath: string }>;
  killSwitchDisableRuns?: boolean;
  auditSink?: (record: {
    userId?: number;
    chatId: number;
    command: string;
    runId?: string;
    decision: "allow" | "deny";
    reason?: string;
  }) => void | Promise<void>;
}

export function createBot(token: string, options: CreateBotOptions) {
  const bot = new Bot(token);

  bot.catch((err) => {
    console.error("[bot.catch] unhandled error:", err.error);
  });

  bot.command("reload_projects", async (ctx) => {
    if (ctx.chat.type !== "private") {
      return;
    }
    if (ctx.from?.id !== options.ownerUserId) {
      return;
    }
    if (!options.reloadProjects) {
      await ctx.reply("reload_projects is not configured.");
      return;
    }

    const result = await options.reloadProjects();
    await ctx.reply(`Reloaded ${result.count} projects from ${result.configPath}`);
  });

  const handler = new TelegramCommandHandler({
    ownerUserId: options.ownerUserId,
    runGateway: options.runGateway,
    stopGateway: options.stopGateway,
    downloadGateway: options.downloadGateway,
    store: options.store,
    killSwitchDisableRuns: options.killSwitchDisableRuns,
    auditSink: options.auditSink,
    reloadProjects: options.reloadProjects ? async () => {
      const result = await options.reloadProjects!();
      return { count: result.count };
    } : undefined,
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const messageId = ctx.callbackQuery.message?.message_id;
    const chatId = ctx.callbackQuery.message?.chat.id;

    if (!chatId || !messageId) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (ctx.from?.id !== options.ownerUserId) {
      await ctx.answerCallbackQuery({ text: "Access denied." });
      return;
    }

    // Handle stop_run: directly (not routed through handler)
    if (data.startsWith("stop_run:") && options.cancelRun) {
      const runId = data.slice("stop_run:".length);
      try {
        await options.cancelRun(runId);
        try { await ctx.answerCallbackQuery({ text: "Stopping..." }); } catch { /* ignore */ }
      } catch {
        try { await ctx.answerCallbackQuery({ text: "Failed to stop" }); } catch { /* ignore */ }
      }
      return;
    }

    let toast: string | undefined;
    try {
      const result = await handler.handleCallbackQuery(chatId, data, messageId);
      toast = result.toast;
      for (const action of result.actions) {
        if (action.type === "edit_keyboard") {
          try {
            await ctx.api.editMessageText(chatId, action.messageId, action.text, {
              reply_markup: { inline_keyboard: action.inlineKeyboard },
            });
          } catch (err) {
            const msg = String(err);
            if (!msg.includes("message is not modified")) {
              console.warn("[callback_query] editMessageText failed:", msg);
            }
          }
        }
      }
    } catch (err) {
      console.error("[callback_query] handler error:", String(err));
    }

    try {
      await ctx.answerCallbackQuery(toast ? { text: toast } : undefined);
    } catch {
      // expired or already answered — ignore
    }
  });

  bot.on("message", async (ctx) => {
    const actions = await handler.handleUpdate(ctx.update as never);
    for (const action of actions) {
      if (action.type === "reply") {
        await ctx.reply(action.text, { parse_mode: undefined });
        continue;
      }

      if (action.type === "send_document") {
        await ctx.replyWithDocument(new InputFile(action.filePath), {
          caption: action.caption,
          parse_mode: undefined,
        });
        continue;
      }

      if (action.type === "reply_keyboard") {
        await ctx.reply(action.text, {
          parse_mode: undefined,
          reply_markup: { inline_keyboard: action.inlineKeyboard },
        });
        continue;
      }
    }
  });

  return { bot, handler };
}

function createTransport(bot: Bot): TelegramMessageTransport {
  return {
    async sendMessage(chatId, text, keyboard) {
      const message = await bot.api.sendMessage(chatId, text, keyboard ? {
        reply_markup: { inline_keyboard: keyboard },
      } : undefined);
      return { messageId: message.message_id };
    },
    async editMessage(chatId, messageId, text, keyboard) {
      await bot.api.editMessageText(chatId, messageId, text, {
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      });
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isToolUnsafeEnabled(unsafeUntil: number | undefined, now: number): boolean {
  return typeof unsafeUntil === "number" && unsafeUntil > now;
}

function cleanEnvForEngine(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned = { ...env };
  delete cleaned.CLAUDECODE;

  // Ensure common binary directories are in PATH so spawned engines
  // (claude, opencode) can be found even when the bot runs outside a login shell.
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
  const currentPath = cleaned.PATH ?? "";
  const missing = extraPaths.filter((p) => !currentPath.split(":").includes(p));
  if (missing.length > 0) {
    cleaned.PATH = [...missing, currentPath].join(":");
  }

  return cleaned;
}

function formatFriendlyError(errorMsg: string): string {
  const lower = errorMsg.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("429") || lower.includes("too many requests")) {
    return "Rate limit hit. Wait a moment and try again.";
  }
  if (lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("401") || lower.includes("api key")) {
    return "Authentication error. Check your API key.";
  }
  if (lower.includes("quota") || lower.includes("billing") || lower.includes("insufficient") || lower.includes("402")) {
    return "Quota/billing issue. Check your account.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Request timed out. Try again.";
  }
  if (lower.includes("overloaded") || lower.includes("503") || lower.includes("529")) {
    return "API overloaded. Try again shortly.";
  }
  return `Run failed: ${errorMsg.slice(0, 500)}`;
}

const DEFAULT_MAX_TURNS = 30;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes with no stdout → kill (claude)
const OPENCODE_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for opencode (events can be sparse)
const CONTINUE_SESSION_MARKER = "__continue__";

async function runClaude(input: {
  cwd: string;
  prompt: string;
  engineSessionId?: string | null;
  unsafe: boolean;
  model?: string;
  runner: ProcessRunner;
  onEvent: (event: NormalizedEngineEvent) => Promise<void>;
  isCancelled: () => Promise<boolean>;
}): Promise<{ events: NormalizedEngineEvent[]; exitStatus: "success" | "error" | "cancelled"; engineSessionId?: string; bytesOut: number }> {
  const parser = createClaudeStreamJsonParser();
  const spec = buildClaudeCommandSpec({
    prompt: input.prompt,
    outputFormat: "stream-json",
    toolPolicy: input.unsafe ? "unsafe" : "safe",
    session: input.engineSessionId === CONTINUE_SESSION_MARKER
      ? { mode: "continue" }
      : input.engineSessionId
        ? { mode: "resume", engineSessionId: input.engineSessionId }
        : { mode: "new" },
    maxTurns: DEFAULT_MAX_TURNS,
    model: input.model,
  });

  const events: NormalizedEngineEvent[] = [];
  let bytesOut = 0;
  let lastActivityAt = Date.now();

  let stderrBuffer = "";
  const handle = input.runner.start({
    sessionId: `claude:${Date.now()}`,
    command: spec.command,
    args: spec.args,
    cwd: input.cwd,
    env: cleanEnvForEngine({ ...process.env }),
    cancelGraceMs: 2_000,
    onStdout: async (chunk) => {
      lastActivityAt = Date.now();
      bytesOut += chunk.byteLength;
      const parsed = parser.push(chunk);
      for (const event of parsed) {
        events.push(event);
        await input.onEvent(event);
      }
    },
    onStderr: async (chunk) => {
      lastActivityAt = Date.now();
      if (stderrBuffer.length < 10_000) {
        stderrBuffer += chunk.toString("utf8");
      }
    },
  });

  const poll = setInterval(() => {
    // Kill if idle too long (process hung after response)
    if (Date.now() - lastActivityAt > IDLE_TIMEOUT_MS) {
      console.warn(`[runClaude] idle timeout reached (${IDLE_TIMEOUT_MS}ms), cancelling`);
      handle.cancel();
      return;
    }

    void input.isCancelled().then((cancelled) => {
      if (cancelled) {
        handle.cancel();
      }
    });
  }, 500);
  poll.unref();

  const result = await handle.result.finally(() => clearInterval(poll));
  const status = result.status === "completed" ? "success" : result.status === "cancelled" ? "cancelled" : "error";

  // Emit stderr as error event if process failed and no error events were captured
  if (status === "error" && stderrBuffer.trim().length > 0 && !events.some((e) => e.type === "error")) {
    const errorEvent: NormalizedEngineEvent = { type: "error", message: stderrBuffer.trim().slice(0, 2000) };
    events.push(errorEvent);
    await input.onEvent(errorEvent);
  }

  const finalEvents = parser.finish(status);
  for (const event of finalEvents) {
    events.push(event);
    await input.onEvent(event);
  }

  return {
    events,
    exitStatus: status,
    engineSessionId: parser.engineSessionId(),
    bytesOut,
  };
}

async function runOpenCode(input: {
  cwd: string;
  prompt: string;
  engineSessionId?: string | null;
  attachUrl?: string | null;
  unsafe: boolean;
  model?: string;
  agent?: string;
  runner: ProcessRunner;
  onEvent: (event: NormalizedEngineEvent) => Promise<void>;
  isCancelled: () => Promise<boolean>;
}): Promise<{ events: NormalizedEngineEvent[]; exitStatus: "success" | "error" | "cancelled"; engineSessionId?: string; bytesOut: number }> {
  const parser = createOpenCodeJsonlParser();
  const spec = buildOpenCodeCommandSpec({
    prompt: input.prompt,
    session: input.engineSessionId === CONTINUE_SESSION_MARKER
      ? { mode: "continue" }
      : input.engineSessionId
        ? { mode: "resume", engineSessionId: input.engineSessionId }
        : { mode: "new" },
    attachUrl: input.attachUrl ?? undefined,
    model: input.model,
    agent: input.agent,
  });

  const events: NormalizedEngineEvent[] = [];
  let bytesOut = 0;
  let stdoutText = "";
  let lastActivityAt = Date.now();
  let stderrBuffer = "";

  const handle = input.runner.start({
    sessionId: `opencode:${Date.now()}`,
    command: spec.command,
    args: spec.args,
    cwd: input.cwd,
    env: {
      ...cleanEnvForEngine(process.env),
      OPENCODE_CONFIG_CONTENT: createOpenCodePermissionConfigContent(input.unsafe ? "unsafe" : "safe"),
    },
    cancelGraceMs: 2_000,
    onStdout: async (chunk) => {
      lastActivityAt = Date.now();
      bytesOut += chunk.byteLength;
      if (stdoutText.length < 1_000_000) {
        stdoutText += chunk.toString("utf8");
      }

      const parsed = parser.push(chunk);
      for (const event of parsed) {
        events.push(event);
        await input.onEvent(event);
      }
    },
    onStderr: async (chunk) => {
      lastActivityAt = Date.now();
      if (stderrBuffer.length < 10_000) {
        stderrBuffer += chunk.toString("utf8");
      }
    },
  });

  const poll = setInterval(() => {
    // Kill if idle too long (opencode events can be sparse)
    if (Date.now() - lastActivityAt > OPENCODE_IDLE_TIMEOUT_MS) {
      console.warn(`[runOpenCode] idle timeout reached (${OPENCODE_IDLE_TIMEOUT_MS}ms), cancelling`);
      handle.cancel();
      return;
    }

    void input.isCancelled().then((cancelled) => {
      if (cancelled) {
        handle.cancel();
      }
    });
  }, 500);
  poll.unref();

  const result = await handle.result.finally(() => clearInterval(poll));
  const status = result.status === "completed" ? "success" : result.status === "cancelled" ? "cancelled" : "error";
  // Emit stderr as error event if process failed
  if (status === "error" && stderrBuffer.trim().length > 0 && !events.some((e) => e.type === "error")) {
    const errorEvent: NormalizedEngineEvent = { type: "error", message: stderrBuffer.trim().slice(0, 2000) };
    events.push(errorEvent);
    await input.onEvent(errorEvent);
  }

  const finalEvents = parser.finish(status);
  for (const event of finalEvents) {
    events.push(event);
    await input.onEvent(event);
  }

  if (events.length === 0 && stdoutText.trim().startsWith("{") && stdoutText.trim().endsWith("}")) {
    try {
      const parsed = JSON.parse(stdoutText) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const maybeEvents = record["events"];
        if (Array.isArray(maybeEvents)) {
          for (const raw of maybeEvents) {
            const chunkEvents = parser.push(`${JSON.stringify(raw)}\n`);
            for (const event of chunkEvents) {
              events.push(event);
              await input.onEvent(event);
            }
          }
        }
      }
    } catch {
      console.warn("opencode json output parse failed");
    }
  }

  return {
    events,
    exitStatus: status,
    engineSessionId: parser.engineSessionId(),
    bytesOut,
  };
}

export async function startLongPolling(token: string): Promise<void> {
  const dataDir = process.env.DATA_DIR ?? "./data";
  const ownerUserId = Number(process.env.TELEGRAM_OWNER_USER_ID ?? "0");
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
    throw new Error("TELEGRAM_OWNER_USER_ID is required");
  }

  await mkdir(path.resolve(dataDir), { recursive: true });
  const storage = createSqliteStorageDatabase(`${dataDir}/ohmyremote.sqlite`);
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..", "..", "..");
  const projectsConfigPathRaw = process.env.PROJECTS_CONFIG_PATH ?? "./config/projects.json";
  const projectsConfigPath = path.isAbsolute(projectsConfigPathRaw)
    ? projectsConfigPathRaw
    : path.resolve(repoRoot, projectsConfigPathRaw);

  const seedProjects = async (): Promise<number> => {
    const projectsConfig = ProjectsConfigSchema.parse(JSON.parse(await readFile(projectsConfigPath, "utf8")));
    const configIds = new Set(projectsConfig.map((p) => p.id));

    // Remove projects no longer in config
    const existing = await repository.listProjects();
    for (const proj of existing) {
      if (!configIds.has(proj.id)) {
        await repository.deleteProject(proj.id);
      }
    }

    // Upsert projects from config
    for (const project of projectsConfig) {
      const ex = await repository.getProject(project.id);
      if (!ex) {
        await repository.createProject({
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          defaultEngine: project.defaultEngine,
          opencodeAttachUrl: project.opencodeAttachUrl ?? null,
        });
      }
    }
    return projectsConfig.length;
  };

  const seededCount = await seedProjects();

  const store = createTelegramDataStore(repository);

  const runGateway: RunGateway = {
    async enqueueRun(input) {
      const now = Date.now();
      const runId = randomUUID();
      await repository.createRun({
        id: runId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        prompt: input.prompt,
        status: "queued",
      });
      await repository.enqueueJob({
        id: randomUUID(),
        runId,
        availableAt: now,
      });
      return { runId };
    },
  };

  const stopGateway: StopGateway = {
    async stopSession(sessionId) {
      const latest = await repository.listRunsBySession({ sessionId, limit: 1 });
      const run = latest[0];
      if (!run || (run.status !== "queued" && run.status !== "in_flight" && run.status !== "leased")) {
        return false;
      }
      await repository.cancelRun({ runId: run.id, now: Date.now() });
      return true;
    },
  };

  const downloadGateway: DownloadGateway = {
    async getFile(input) {
      const project = await repository.getProject(input.projectId);
      if (!project) {
        throw new Error(`unknown project ${input.projectId}`);
      }

      const root = await realpath(project.rootPath);
      const candidate = path.resolve(root, input.requestPath);
      if (!candidate.startsWith(root + path.sep)) {
        throw new Error("SANDBOX_VIOLATION");
      }

      const relative = path.relative(root, candidate);
      const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
      let current = root;
      for (const segment of segments) {
        current = path.join(current, segment);
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) {
          throw new Error("SANDBOX_VIOLATION");
        }
      }

      const content = await readFile(candidate);
      return { sizeBytes: content.byteLength, filePath: candidate };
    },
  };

  const { bot, handler: commandHandler } = createBot(token, {
    ownerUserId,
    runGateway,
    stopGateway,
    downloadGateway,
    store,
    reloadProjects: async () => ({ count: await seedProjects(), configPath: projectsConfigPath }),
    killSwitchDisableRuns: process.env.KILL_SWITCH_DISABLE_RUNS === "true" || process.env.KILL_SWITCH_DISABLE_RUNS === "1",
    cancelRun: async (runId) => {
      await repository.cancelRun({ runId, now: Date.now() });
    },
    auditSink: async (record) => {
      await repository.appendAuditLog({
        id: randomUUID(),
        userId: record.userId ? String(record.userId) : null,
        chatId: String(record.chatId),
        command: record.command,
        runId: record.runId ?? null,
        decision: record.decision,
        reason: record.reason ?? null,
      });
    },
  });

  try {
    await bot.api.sendMessage(ownerUserId, `OhMyRemote bot is ready. projects=${seededCount} config=${projectsConfigPath}`);
  } catch (error) {
    console.warn("failed to send ready message", String(error));
  }

  const transport = createTransport(bot);
  const streamer = new TelegramRunStreamer(transport);
  const runner = new ProcessRunner();

  const MAX_CONCURRENT_JOBS = 3;
  const LEASE_RENEWAL_INTERVAL_MS = 15_000; // renew lease every 15s (lease is 30s)
  const activeJobs = new Set<string>();

  async function notifyChat(chatId: number | undefined, text: string): Promise<void> {
    if (chatId === undefined) return;
    try {
      await bot.api.sendMessage(chatId, text);
    } catch (err) {
      console.warn("[notifyChat] failed to send message", String(err));
    }
  }

  async function executeJob(job: { id: string; runId: string }): Promise<void> {
    // Lease renewal: keep extending the lease while job is running
    const leaseRenewal = setInterval(() => {
      void repository.renewJobLease({ jobId: job.id, now: Date.now(), leaseDurationMs: 30_000 }).catch((err: unknown) => {
        console.warn("[leaseRenewal] failed", String(err));
      });
    }, LEASE_RENEWAL_INTERVAL_MS);
    leaseRenewal.unref();

    try {
      await executeJobInner(job);
    } finally {
      clearInterval(leaseRenewal);
    }
  }

  async function executeJobInner(job: { id: string; runId: string }): Promise<void> {
    const run = await repository.getRunById(job.runId);
    if (!run) {
      await repository.failJob({ jobId: job.id, now: Date.now(), error: "missing run" });
      return;
    }

    const session = await repository.getSessionById(run.sessionId);
    if (!session) {
      await repository.failJob({ jobId: job.id, now: Date.now(), error: "missing session" });
      await repository.finalizeRun({ runId: run.id, status: "failed", finishedAt: Date.now() });
      console.warn(`[executeJob] run ${run.id} failed: missing session ${run.sessionId}`);
      return;
    }

    const project = await repository.getProject(run.projectId);
    const chatId = session.chatId ? Number(session.chatId) : undefined;

    if (!project) {
      await repository.failJob({ jobId: job.id, now: Date.now(), error: "missing project" });
      await repository.finalizeRun({ runId: run.id, status: "failed", finishedAt: Date.now() });
      await notifyChat(chatId, `Run failed: project "${run.projectId}" not found.`);
      return;
    }

    const startedAt = Date.now();
    await repository.markRunInFlight({ runId: run.id, startedAt });

    // Re-validate unsafe mode at execution time (not just enqueue time)
    const unsafeUntil = session.chatId ? await repository.getChatUnsafeUntil(session.chatId) : undefined;
    const unsafe = isToolUnsafeEnabled(unsafeUntil, startedAt);

    const onEvent = async (event: NormalizedEngineEvent) => {
      await repository.appendRunEvent({
        id: randomUUID(),
        runId: run.id,
        eventType: event.type,
        payloadJson: JSON.stringify(event),
        createdAt: Date.now(),
      });

      if (chatId !== undefined) {
        await streamer.handleEvent(chatId, run.id, event);
      }
    };

    const isCancelled = async () => {
      const latest = await repository.getRunById(run.id);
      return latest?.status === "cancelled";
    };

    let execResult:
      | { events: NormalizedEngineEvent[]; exitStatus: "success" | "error" | "cancelled"; engineSessionId?: string; bytesOut: number }
      | undefined;

    const chatModel = chatId !== undefined ? commandHandler.getChatModel(chatId) : undefined;
    const chatAgent = chatId !== undefined ? commandHandler.getChatOpenCodeAgent(chatId) : undefined;

    try {
      if (session.provider === "opencode") {
        execResult = await runOpenCode({
          cwd: project.rootPath,
          prompt: run.prompt,
          engineSessionId: session.engineSessionId,
          attachUrl: project.opencodeAttachUrl,
          unsafe,
          model: chatModel,
          agent: chatAgent,
          runner,
          onEvent,
          isCancelled,
        });
      } else {
        execResult = await runClaude({
          cwd: project.rootPath,
          prompt: run.prompt,
          engineSessionId: session.engineSessionId,
          unsafe,
          model: chatModel,
          runner,
          onEvent,
          isCancelled,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[executeJob] run ${run.id} threw:`, message);
      await onEvent({ type: "error", message, raw: { message } });
      execResult = { events: [{ type: "error", message, raw: { message } }], exitStatus: "error", bytesOut: 0 };
    }

    // Notify user of failure
    if (execResult.exitStatus === "error" && chatId !== undefined) {
      const errorEvents = execResult.events.filter((e) => e.type === "error");
      const errorMsg = errorEvents.length > 0
        ? (errorEvents[0] as { message?: string }).message ?? "Unknown error"
        : "Unknown error";
      const friendlyMsg = formatFriendlyError(errorMsg);
      await notifyChat(chatId, friendlyMsg);
    }

    if (execResult.engineSessionId) {
      await repository.setSessionEngineSessionId({
        sessionId: session.id,
        engineSessionId: execResult.engineSessionId,
      });
    }

    const finishedAt = Date.now();
    const runStatus = execResult.exitStatus === "success" ? "completed" : execResult.exitStatus === "cancelled" ? "cancelled" : "failed";
    await repository.finalizeRun({
      runId: run.id,
      status: runStatus,
      finishedAt,
      summaryJson: JSON.stringify({
        duration_ms: Math.max(0, finishedAt - startedAt),
        tool_calls_count: execResult.events.filter((event) => event.type === "tool_start").length,
        bytes_in: 0,
        bytes_out: execResult.bytesOut,
        exit_status: execResult.exitStatus,
      }),
    });
    await repository.completeJob({ jobId: job.id, now: finishedAt });

    if (chatId !== undefined) {
      await streamer.finishRun(chatId, run.id, {
        status: runStatus,
        durationMs: Math.max(0, finishedAt - startedAt),
        engineSessionId: execResult.engineSessionId,
      });
    }
  }

  // Graceful shutdown: cancel active processes, stop bot
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, stopping ${activeJobs.size} active jobs...`);

    try {
      await bot.api.sendMessage(ownerUserId, `Bot shutting down (${signal}). Active jobs: ${activeJobs.size}`);
    } catch { /* ignore */ }

    // Cancel all active process runner sessions
    runner.cancelAll();

    // Wait briefly for jobs to finish
    const deadline = Date.now() + 5_000;
    while (activeJobs.size > 0 && Date.now() < deadline) {
      await delay(200);
    }

    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

  void (async () => {
    const leaseOwner = `bot:${process.pid}`;
    while (true) {
      try {
        const now = Date.now();
        const inFlight = await repository.listRunsByStatus("in_flight");
        for (const run of inFlight) {
          const startedAt = run.startedAt ?? run.updatedAt;
          if (now - startedAt >= 60 * 60 * 1000) {
            await repository.abandonRun({ runId: run.id, finishedAt: now });
            await repository.requeueLeasedJobByRunId({ runId: run.id, now });
          }
        }

        if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
          await delay(750);
          continue;
        }

        const job = await repository.leaseNextJob({ owner: leaseOwner, now, leaseDurationMs: 30_000 });
        if (!job) {
          await delay(750);
          continue;
        }

        activeJobs.add(job.id);
        void executeJob(job)
          .catch((error) => console.warn("job execution error", String(error)))
          .finally(() => activeJobs.delete(job.id));
      } catch (error) {
        console.warn("worker loop error", String(error));
        await delay(1000);
      }
    }
  })();

  await bot.start();
}
