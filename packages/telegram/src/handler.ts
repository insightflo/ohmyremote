import { randomUUID } from "node:crypto";

function formatRelativeDate(timestamp: number, now: number): string {
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export type EngineProvider = "claude" | "opencode";

export interface TelegramUser {
  id: number;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath?: string;
}

export interface CliSessionInfo {
  sessionId: string;
  firstPrompt: string;
  lastActivity: number;
}

export interface CliSessionPeek {
  sessionId: string;
  entries: Array<{
    type: string;
    timestamp: string;
    summary: string;
  }>;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  provider: string;
  engineSessionId?: string | null;
  prompt?: string;
  lastRunPrompt?: string;
  lastRunAt?: number;
}

export interface TelegramDataStore {
  insertTelegramInbox(input: {
    updateId: number;
    chatId?: string | null;
    payloadJson: string;
    receivedAt?: number;
  }): Promise<boolean>;
  listProjects(): Promise<ProjectRecord[]>;
  listSessionsByProject(projectId: string): Promise<SessionRecord[]>;
  createSession(input: {
    id: string;
    projectId: string;
    chatId?: string | null;
    provider: string;
    status: string;
    prompt: string;
  }): Promise<void>;
  getSessionById(sessionId: string): Promise<SessionRecord | undefined>;
  setSessionEngineSessionId?(sessionId: string, engineSessionId: string): Promise<void>;
  getUnsafeUntil?(chatId: string): Promise<number | undefined>;
  setUnsafeUntil?(chatId: string, unsafeUntil: number): Promise<void>;
  clearUnsafeUntil?(chatId: string): Promise<void>;
  listRecentUploads?(projectId: string, sessionId: string, limit: number): Promise<
    Array<{ originalName: string; storedRelPath: string; sizeBytes: number }>
  >;
  listCliSessions?(projectRootPath: string, limit: number): Promise<CliSessionInfo[]>;
  peekCliSession?(projectRootPath: string, sessionId: string, tailCount: number): Promise<CliSessionPeek | null>;
  loadOpenCodeConfig?(): Promise<OpenCodeConfig>;
}

export interface OpenCodeConfig {
  models: Array<{ label: string; value: string }>;
  agents: Array<{ label: string; value: string }>;
  categories: Array<{ label: string; value: string }>;
}

export interface RunGateway {
  enqueueRun(input: {
    projectId: string;
    sessionId: string;
    idempotencyKey: string;
    prompt: string;
  }): Promise<{ runId: string }>;
}

export interface StopGateway {
  stopSession(sessionId: string): Promise<boolean>;
}

export interface DownloadGateway {
  getFile(input: {
    projectId: string;
    sessionId: string;
    requestPath: string;
  }): Promise<{ sizeBytes: number; filePath?: string }>;
}

export interface TelegramHandlerOptions {
  ownerUserId: number;
  store: TelegramDataStore;
  runGateway: RunGateway;
  stopGateway?: StopGateway;
  downloadGateway?: DownloadGateway;
  killSwitchDisableRuns?: boolean;
  reloadProjects?: () => Promise<{ count: number }>;

  auditSink?: (record: {
    userId?: number;
    chatId: number;
    command: string;
    runId?: string;
    decision: "allow" | "deny";
    reason?: string;
  }) => void | Promise<void>;
  now?: () => number;
}

export interface TelegramReplyAction {
  type: "reply";
  text: string;
}

export interface TelegramSendDocumentAction {
  type: "send_document";
  filePath: string;
  caption?: string;
}

export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboardRow = InlineKeyboardButton[];

export interface TelegramReplyWithKeyboardAction {
  type: "reply_keyboard";
  text: string;
  inlineKeyboard: InlineKeyboardRow[];
}

export interface TelegramEditKeyboardAction {
  type: "edit_keyboard";
  messageId: number;
  text: string;
  inlineKeyboard: InlineKeyboardRow[];
}

export type TelegramAction =
  | TelegramReplyAction
  | TelegramSendDocumentAction
  | TelegramReplyWithKeyboardAction
  | TelegramEditKeyboardAction;

interface ChatState {
  projectId?: string;
  sessionId?: string;
  defaultEngine: EngineProvider;
  model?: string;
  openCodeAgent?: string;
  unsafeUntil?: number;
  lastRunId?: string;
}

export class TelegramCommandHandler {
  private readonly chatState = new Map<string, ChatState>();
  private readonly now: () => number;

  public constructor(private readonly options: TelegramHandlerOptions) {
    this.now = options.now ?? Date.now;
  }

  public async handleUpdate(update: TelegramUpdate): Promise<TelegramAction[]> {
    const message = update.message;
    if (message === undefined) {
      return [];
    }

    if (message.chat.type !== "private") {
      await this.audit({
        userId: message.from?.id,
        chatId: message.chat.id,
        command: message.text?.split(/\s+/)[0] ?? "<non-text>",
        decision: "deny",
        reason: "group-or-non-private-chat",
      });
      return [];
    }

    const fromId = message.from?.id;
    if (fromId !== this.options.ownerUserId) {
      await this.audit({
        userId: fromId,
        chatId: message.chat.id,
        command: message.text?.split(/\s+/)[0] ?? "<non-text>",
        decision: "deny",
        reason: "non-owner",
      });
      return [{ type: "reply", text: "Access denied: owner only." }];
    }

    const accepted = await this.options.store.insertTelegramInbox({
      updateId: update.update_id,
      chatId: String(message.chat.id),
      payloadJson: JSON.stringify(update),
      receivedAt: this.now(),
    });

    if (!accepted) {
      return [];
    }

    const text = message.text?.trim();
    if (text === undefined || text.length === 0) {
      return [];
    }

    const state = this.getState(message.chat.id);
    if (this.options.store.getUnsafeUntil) {
      const persistedUnsafeUntil = await this.options.store.getUnsafeUntil(String(message.chat.id));
      state.unsafeUntil = persistedUnsafeUntil;
    }

    if (!text.startsWith("/")) {
      const actions = await this.handleRun(message, text, state);
      return this.decorateUnsafeBanner(actions, state);
    }

    const [commandName, ...rest] = text.slice(1).split(/\s+/g);
    const args = rest.filter((item) => item.length > 0);

    let actions: TelegramAction[];
    switch (commandName) {
      case "start":
        actions = [
          {
            type: "reply",
            text: "Welcome. Use /help for commands.",
          },
        ];
        break;
      case "help":
        actions = [
          {
            type: "reply",
            text:
              "/projects /use <project> /sessions /newsession <engine> [name] /use_session <id> /engine <claude|opencode> /run <text> /continue [text] /attach <engine_session_id> /status /stop /enable_unsafe <minutes> /uploads /get <path> /current /whoami",
          },
        ];
        break;
      case "whoami":
        actions = [
          {
            type: "reply",
            text: `user_id=${fromId ?? "unknown"}\nchat_id=${message.chat.id}`,
          },
        ];
        break;
      case "projects":
        actions = await this.handleProjects();
        break;
      case "use":
        actions = await this.handleUseProject(args, state);
        break;
      case "sessions":
        actions = await this.handleSessions(state);
        break;
      case "newsession":
        actions = await this.handleNewSession(args, state, String(message.chat.id));
        break;
      case "use_session":
        actions = await this.handleUseSession(args, state);
        break;
      case "engine":
        actions = await this.handleSetEngine(args, state);
        break;
      case "run":
        actions = await this.handleRun(message, args.join(" "), state);
        break;
      case "status":
        actions = await this.handleStatus(state);
        break;
      case "stop":
        actions = await this.handleStop(state);
        break;
      case "enable_unsafe":
        actions = await this.handleEnableUnsafe(args, state, String(message.chat.id));
        break;
      case "uploads":
        actions = await this.handleUploads(state, String(message.chat.id));
        break;
      case "get":
        actions = await this.handleGet(args, state, String(message.chat.id));
        break;
      case "continue":
        actions = await this.handleContinue(message, args.join(" "), state);
        break;
      case "attach":
        actions = await this.handleAttach(args, state, String(message.chat.id));
        break;
      case "reload_projects":
        return [];
      case "current":
        actions = await this.handleCurrent(state);
        break;
      case "dashboard":
      case "d":
        actions = await this.handleDashboard(state);
        break;
      default:
        actions = [{ type: "reply", text: `Unknown command: /${commandName}` }];
        break;
    }

    return this.decorateUnsafeBanner(actions, state);
  }

  public getChatModel(chatId: number): string | undefined {
    return this.chatState.get(String(chatId))?.model;
  }

  public getChatOpenCodeAgent(chatId: number): string | undefined {
    return this.chatState.get(String(chatId))?.openCodeAgent;
  }

  private getState(chatId: number): ChatState {
    const key = String(chatId);
    const current = this.chatState.get(key);
    if (current !== undefined) {
      return current;
    }

    const created: ChatState = { defaultEngine: "claude" };
    this.chatState.set(key, created);
    return created;
  }

  private async handleProjects(): Promise<TelegramAction[]> {
    const projects = await this.options.store.listProjects();
    if (projects.length === 0) {
      return [{ type: "reply", text: "No projects configured." }];
    }

    return [{ type: "reply", text: projects.map((project) => `${project.id}: ${project.name}`).join("\n") }];
  }

  private async handleUseProject(args: string[], state: ChatState): Promise<TelegramAction[]> {
    const projectId = args[0];
    if (!projectId) {
      return [{ type: "reply", text: "Usage: /use <project_id>" }];
    }

    const projects = await this.options.store.listProjects();
    const found = projects.find((project) => project.id === projectId);
    if (!found) {
      return [{ type: "reply", text: `Unknown project: ${projectId}` }];
    }

    state.projectId = projectId;
    state.sessionId = undefined;
    return [{ type: "reply", text: `Active project set to ${projectId}.` }];
  }

  private async handleSessions(state: ChatState): Promise<TelegramAction[]> {
    const projectId = await this.ensureProject(state);
    if (!projectId) {
      return [{ type: "reply", text: "No projects configured." }];
    }

    const sessions = await this.options.store.listSessionsByProject(projectId);
    if (sessions.length === 0) {
      return [{ type: "reply", text: `No sessions for ${projectId}. Use /newsession.` }];
    }

    return [{ type: "reply", text: sessions.map((session) => `${session.id} (${session.provider})`).join("\n") }];
  }

  private async handleNewSession(args: string[], state: ChatState, chatId: string): Promise<TelegramAction[]> {
    const projectId = await this.ensureProject(state);
    if (!projectId) {
      return [{ type: "reply", text: "No projects configured." }];
    }

    const engineArg = args[0];
    const engine = this.parseEngine(engineArg) ?? state.defaultEngine;
    if (engineArg !== undefined && this.parseEngine(engineArg) === undefined) {
      return [{ type: "reply", text: "Usage: /newsession <claude|opencode> [name]" }];
    }

    const sessionId = randomUUID();
    const name = args.slice(1).join(" ").trim();
    await this.options.store.createSession({
      id: sessionId,
      projectId,
      chatId,
      provider: engine,
      status: "active",
      prompt: name,
    });

    state.sessionId = sessionId;
    return [{ type: "reply", text: `Session created: ${sessionId} (${engine})` }];
  }

  private async handleUseSession(args: string[], state: ChatState): Promise<TelegramAction[]> {
    const sessionId = args[0];
    if (!sessionId) {
      return [{ type: "reply", text: "Usage: /use_session <session_id>" }];
    }

    const session = await this.options.store.getSessionById(sessionId);
    if (!session) {
      return [{ type: "reply", text: `Unknown session: ${sessionId}` }];
    }

    state.projectId = session.projectId;
    state.sessionId = session.id;
    return [{ type: "reply", text: `Active session set to ${sessionId}.` }];
  }

  private async handleSetEngine(args: string[], state: ChatState): Promise<TelegramAction[]> {
    const engine = this.parseEngine(args[0]);
    if (engine === undefined) {
      return [{ type: "reply", text: "Usage: /engine <claude|opencode>" }];
    }

    state.defaultEngine = engine;
    return [{ type: "reply", text: `Default engine set to ${engine}.` }];
  }

  private async handleRun(message: TelegramMessage, runText: string, state: ChatState): Promise<TelegramAction[]> {
    const prompt = runText.trim();
    if (prompt.length === 0) {
      return [{ type: "reply", text: "Usage: /run <text>" }];
    }

    if (this.options.killSwitchDisableRuns) {
      await this.audit({
        userId: message.from?.id,
        chatId: message.chat.id,
        command: "run",
        decision: "deny",
        reason: "kill-switch",
      });
      return [{ type: "reply", text: "Maintenance mode: run execution is currently disabled." }];
    }

    const projectId = await this.ensureProject(state);
    if (!projectId) {
      return [{ type: "reply", text: "No projects configured." }];
    }

    const sessionId = await this.ensureSession(projectId, state, String(message.chat.id));
    const idempotencyKey = `tg:${message.chat.id}:${message.message_id}`;

    const { runId } = await this.options.runGateway.enqueueRun({
      projectId,
      sessionId,
      idempotencyKey,
      prompt,
    });

    await this.audit({
      userId: message.from?.id,
      chatId: message.chat.id,
      command: "run",
      runId,
      decision: "allow",
    });

    state.lastRunId = runId;
    return [{ type: "reply", text: `Run queued: ${runId}` }];
  }

  private async handleStatus(state: ChatState): Promise<TelegramAction[]> {
    const parts = [
      `project=${state.projectId ?? "unset"}`,
      `session=${state.sessionId ?? "unset"}`,
      `engine=${state.defaultEngine}`,
      `last_run=${state.lastRunId ?? "none"}`,
    ];

    if (state.unsafeUntil !== undefined) {
      parts.push(`unsafe_until=${new Date(state.unsafeUntil).toISOString()}`);
    }

    return [{ type: "reply", text: parts.join("\n") }];
  }

  private async handleCurrent(state: ChatState): Promise<TelegramAction[]> {
    if (!state.projectId) {
      return [{ type: "reply", text: "No active project. Use /projects to list, /use <id> to select." }];
    }

    const projects = await this.options.store.listProjects();
    const project = projects.find((p) => p.id === state.projectId);

    const parts = [
      `project: ${project ? `${project.name} (${project.id})` : state.projectId}`,
      `engine: ${state.defaultEngine}`,
      `session: ${state.sessionId ?? "none"}`,
    ];

    return [{ type: "reply", text: parts.join("\n") }];
  }

  private async handleContinue(message: TelegramMessage, runText: string, state: ChatState): Promise<TelegramAction[]> {
    const projectId = await this.ensureProject(state);
    if (!projectId) {
      return [{ type: "reply", text: "No projects configured." }];
    }

    if (this.options.killSwitchDisableRuns) {
      return [{ type: "reply", text: "Maintenance mode: run execution is currently disabled." }];
    }

    // Create or reuse a session with __continue__ marker as engineSessionId
    const sessionId = await this.ensureSession(projectId, state, String(message.chat.id));

    // Set engineSessionId to __continue__ so the runner uses --continue flag
    if (this.options.store.setSessionEngineSessionId) {
      await this.options.store.setSessionEngineSessionId(sessionId, "__continue__");
    }

    const prompt = runText.trim();
    if (prompt.length === 0) {
      return [{ type: "reply", text: `Session ${sessionId} set to continue mode. Send a message to run.` }];
    }

    // If prompt given, enqueue a run immediately
    const idempotencyKey = `tg:${message.chat.id}:${message.message_id}`;
    const { runId } = await this.options.runGateway.enqueueRun({
      projectId,
      sessionId,
      idempotencyKey,
      prompt,
    });

    state.lastRunId = runId;
    return [{ type: "reply", text: `Continuing latest session. Run queued: ${runId}` }];
  }

  private async handleAttach(args: string[], state: ChatState, chatId: string): Promise<TelegramAction[]> {
    const engineSessionId = args[0];
    if (!engineSessionId) {
      return [{ type: "reply", text: "Usage: /attach <engine_session_id>\nGet session IDs with: claude conversation list" }];
    }

    const projectId = await this.ensureProject(state);
    if (!projectId) {
      return [{ type: "reply", text: "No projects configured." }];
    }

    const sessionId = await this.ensureSession(projectId, state, chatId);

    if (this.options.store.setSessionEngineSessionId) {
      await this.options.store.setSessionEngineSessionId(sessionId, engineSessionId);
    }

    return [{ type: "reply", text: `Attached engine session: ${engineSessionId}\nNext run will resume this session.` }];
  }

  private async handleStop(state: ChatState): Promise<TelegramAction[]> {
    if (!state.sessionId) {
      return [{ type: "reply", text: "No active session." }];
    }

    if (this.options.stopGateway === undefined) {
      return [{ type: "reply", text: "Stop gateway is not configured." }];
    }

    const stopped = await this.options.stopGateway.stopSession(state.sessionId);
    return [{ type: "reply", text: stopped ? "Stop requested." : "No running task for this session." }];
  }

  private async handleEnableUnsafe(args: string[], state: ChatState, chatId: string): Promise<TelegramAction[]> {
    const minutes = Number(args[0]);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return [{ type: "reply", text: "Usage: /enable_unsafe <minutes>" }];
    }

    const unsafeUntil = this.now() + minutes * 60_000;
    state.unsafeUntil = unsafeUntil;
    if (this.options.store.setUnsafeUntil) {
      await this.options.store.setUnsafeUntil(chatId, unsafeUntil);
    }
    return [{ type: "reply", text: `UNSAFE MODE enabled until ${new Date(unsafeUntil).toISOString()}` }];
  }

  private async handleUploads(state: ChatState, chatId: string): Promise<TelegramAction[]> {
    const projectId = await this.ensureProject(state);
    if (!projectId) {
      return [{ type: "reply", text: "No projects configured." }];
    }

    const sessionId = await this.ensureSession(projectId, state, chatId);
    if (this.options.store.listRecentUploads === undefined) {
      return [{ type: "reply", text: "Uploads listing is not configured yet." }];
    }

    const uploads = await this.options.store.listRecentUploads(projectId, sessionId, 10);
    if (uploads.length === 0) {
      return [{ type: "reply", text: "No uploads for this session." }];
    }

    return [
      {
        type: "reply",
        text: uploads
          .map((item) => `${item.originalName} (${item.sizeBytes} bytes) -> ${item.storedRelPath}`)
          .join("\n"),
      },
    ];
  }

  private async handleGet(args: string[], state: ChatState, chatId: string): Promise<TelegramAction[]> {
    const requestPath = args.join(" ").trim();
    if (requestPath.length === 0) {
      return [{ type: "reply", text: "Usage: /get <path>" }];
    }

    const projectId = await this.ensureProject(state);
    if (!projectId) {
      return [{ type: "reply", text: "No projects configured." }];
    }

    const sessionId = await this.ensureSession(projectId, state, chatId);
    if (this.options.downloadGateway === undefined) {
      return [{ type: "reply", text: "Download gateway is not configured." }];
    }

    const file = await this.options.downloadGateway.getFile({
      projectId,
      sessionId,
      requestPath,
    });

    if (file.filePath) {
      return [
        {
          type: "send_document",
          filePath: file.filePath,
          caption: `Downloaded ${requestPath} (${file.sizeBytes} bytes).`,
        },
      ];
    }

    return [{ type: "reply", text: `Downloaded ${requestPath} (${file.sizeBytes} bytes).` }];
  }

  public async handleCallbackQuery(
    chatId: number,
    callbackData: string,
    messageId: number,
  ): Promise<{ actions: TelegramAction[]; toast?: string }> {
    const state = this.getState(chatId);
    if (this.options.store.getUnsafeUntil) {
      state.unsafeUntil = await this.options.store.getUnsafeUntil(String(chatId));
    }

    const [action, ...valueParts] = callbackData.split(":");
    const value = valueParts.join(":");
    let toast: string | undefined;

    switch (action) {
      case "proj": {
        const projects = await this.options.store.listProjects();
        const found = projects.find((p) => p.id === value);
        if (!found) break;
        state.projectId = value;
        state.sessionId = undefined;
        toast = `Project: ${found.name}`;
        break;
      }
      case "engine": {
        const engine = this.parseEngine(value);
        if (engine) {
          state.defaultEngine = engine;
          toast = `Engine: ${engine}`;
        }
        break;
      }
      case "newsession": {
        const projectId = await this.ensureProject(state);
        if (projectId) {
          const sessionId = randomUUID();
          await this.options.store.createSession({
            id: sessionId,
            projectId,
            chatId: String(chatId),
            provider: state.defaultEngine,
            status: "active",
            prompt: "",
          });
          state.sessionId = sessionId;
          toast = `New session created`;
        }
        break;
      }
      case "continue": {
        const projectId = await this.ensureProject(state);
        if (projectId) {
          const sessionId = await this.ensureSession(projectId, state, String(chatId));
          if (this.options.store.setSessionEngineSessionId) {
            await this.options.store.setSessionEngineSessionId(sessionId, "__continue__");
          }
          toast = "Continue mode ON — send a message to resume";
        }
        break;
      }
      case "session": {
        const session = await this.options.store.getSessionById(value);
        if (session) {
          state.projectId = session.projectId;
          state.sessionId = session.id;
          toast = `Session: ${session.id.slice(0, 8)}…`;
        }
        break;
      }
      case "sessions": {
        return { actions: await this.renderSessionsSubmenu(state, messageId) };
      }
      case "unsafe": {
        const minutes = Number(value);
        if (Number.isFinite(minutes) && minutes > 0) {
          const unsafeUntil = this.now() + minutes * 60_000;
          state.unsafeUntil = unsafeUntil;
          if (this.options.store.setUnsafeUntil) {
            await this.options.store.setUnsafeUntil(String(chatId), unsafeUntil);
          }
          toast = `UNSAFE MODE ON for ${minutes}m`;
        }
        break;
      }
      case "unsafe_off": {
        state.unsafeUntil = undefined;
        if (this.options.store.clearUnsafeUntil) {
          await this.options.store.clearUnsafeUntil(String(chatId));
        }
        toast = "Unsafe mode OFF";
        break;
      }
      case "model": {
        state.model = value || undefined;
        toast = value ? `Model: ${value}` : "Model: default";
        break;
      }
      case "agent": {
        state.openCodeAgent = value || undefined;
        toast = value ? `Agent: ${value}` : "Agent: default";
        break;
      }
      case "models": {
        return { actions: await this.renderModelsSubmenu(state, messageId) };
      }
      case "clisessions": {
        return { actions: await this.renderCliSessionsSubmenu(state, messageId) };
      }
      case "clipeek": {
        return { actions: await this.renderCliPeek(state, messageId, value) };
      }
      case "cliattach": {
        const projectId = await this.ensureProject(state);
        if (projectId) {
          const sessionId = await this.ensureSession(projectId, state, String(chatId));
          if (this.options.store.setSessionEngineSessionId) {
            await this.options.store.setSessionEngineSessionId(sessionId, value);
          }
          toast = `Session attached: ${value.slice(0, 8)}…`;
        }
        break;
      }
      case "refresh": {
        if (this.options.reloadProjects) {
          const result = await this.options.reloadProjects();
          toast = `Reloaded ${result.count} projects`;
        }
        break;
      }
      case "back":
        break;
    }

    return { actions: await this.renderDashboard(state, messageId), toast };
  }

  private async handleDashboard(state: ChatState): Promise<TelegramAction[]> {
    return this.renderDashboard(state, undefined);
  }

  private async renderDashboard(
    state: ChatState,
    messageId: number | undefined,
  ): Promise<TelegramAction[]> {
    const projects = await this.options.store.listProjects();
    const projectId = await this.ensureProject(state);

    const currentProject = projects.find((p) => p.id === state.projectId);

    let activeSession = "new";
    if (state.sessionId) {
      const sessionRecord = await this.options.store.getSessionById(state.sessionId);
      if (sessionRecord?.engineSessionId && sessionRecord.engineSessionId !== "__continue__") {
        activeSession = sessionRecord.engineSessionId.slice(0, 8) + "…";
      }
    }

    const unsafeOn = state.unsafeUntil !== undefined && state.unsafeUntil > this.now();
    const unsafeLabel = unsafeOn
      ? `ON (until ${new Date(state.unsafeUntil!).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })})`
      : "OFF";

    const modelLabel = state.model ?? "default";
    const agentLabel = state.openCodeAgent ?? "default";

    const textLines = [
      "📋 OhMyRemote Dashboard",
      "",
      `Project: ${currentProject ? currentProject.name : state.projectId ?? "unset"}`,
      `Engine:  ${state.defaultEngine}`,
      `Model:   ${modelLabel}`,
    ];
    if (state.defaultEngine === "opencode") {
      textLines.push(`Agent:   ${agentLabel}`);
    }
    textLines.push(
      `Session: ${activeSession}`,
      `Unsafe:  ${unsafeLabel}`,
    );
    const text = textLines.join("\n");

    const keyboard: InlineKeyboardRow[] = [];

    // Project buttons (up to 3 per row)
    if (projects.length > 0) {
      const projectRow: InlineKeyboardRow = [];
      for (const project of projects.slice(0, 6)) {
        const isSelected = project.id === state.projectId;
        projectRow.push({
          text: isSelected ? `✅ ${project.name}` : project.name,
          callback_data: `proj:${project.id}`,
        });
        if (projectRow.length === 3) {
          keyboard.push([...projectRow]);
          projectRow.length = 0;
        }
      }
      if (projectRow.length > 0) keyboard.push(projectRow);
    }

    // Engine toggle
    keyboard.push([
      {
        text: state.defaultEngine === "claude" ? "claude ✓" : "claude",
        callback_data: "engine:claude",
      },
      {
        text: state.defaultEngine === "opencode" ? "opencode ✓" : "opencode",
        callback_data: "engine:opencode",
      },
    ]);

    // Model / Agent selection
    keyboard.push([
      { text: `🧠 Model: ${modelLabel}`, callback_data: "models" },
    ]);

    // Session management
    keyboard.push([
      { text: "🆕 New Session", callback_data: "newsession" },
      { text: "💻 Sessions", callback_data: "clisessions" },
    ]);

    // Unsafe toggle
    keyboard.push([
      { text: "⚠️ Unsafe 30m", callback_data: "unsafe:30" },
      { text: "⚠️ Unsafe 60m", callback_data: "unsafe:60" },
      { text: unsafeOn ? "🔒 Unsafe OFF" : "🔒 Safe", callback_data: "unsafe_off" },
    ]);

    // Refresh
    keyboard.push([{ text: "🔄 Refresh", callback_data: "refresh" }]);

    if (messageId !== undefined) {
      return [
        {
          type: "edit_keyboard",
          messageId,
          text,
          inlineKeyboard: keyboard,
        },
      ];
    }

    return [
      {
        type: "reply_keyboard",
        text,
        inlineKeyboard: keyboard,
      },
    ];
  }

  private async renderSessionsSubmenu(
    state: ChatState,
    messageId: number,
  ): Promise<TelegramAction[]> {
    const projectId = await this.ensureProject(state);
    if (!projectId) {
      return this.renderDashboard(state, messageId);
    }

    const sessions = await this.options.store.listSessionsByProject(projectId);

    if (sessions.length === 0) {
      const keyboard: InlineKeyboardRow[] = [[{ text: "⬅️ Back", callback_data: "back" }]];
      return [{ type: "edit_keyboard", messageId, text: "📋 Sessions\n\nNo sessions found.", inlineKeyboard: keyboard }];
    }

    const lines = ["📋 Sessions\n"];
    for (const session of sessions.slice(0, 8)) {
      const isSelected = session.id === state.sessionId;
      const mark = isSelected ? "▶ " : "  ";
      const prompt = session.lastRunPrompt || session.prompt || "-";
      const truncated = prompt.length > 40 ? prompt.slice(0, 40) + "…" : prompt;
      const dateStr = session.lastRunAt
        ? formatRelativeDate(session.lastRunAt, this.now())
        : "no runs";
      lines.push(`${mark}${truncated}\n   ${session.provider} · ${dateStr}`);
    }
    const text = lines.join("\n");

    const keyboard: InlineKeyboardRow[] = [];
    for (const session of sessions.slice(0, 8)) {
      const isSelected = session.id === state.sessionId;
      const prompt = session.lastRunPrompt || session.prompt || session.id.slice(0, 8);
      const btnLabel = `${isSelected ? "✅ " : ""}${prompt.length > 30 ? prompt.slice(0, 30) + "…" : prompt}`;
      keyboard.push([{ text: btnLabel, callback_data: `session:${session.id}` }]);
    }

    keyboard.push([{ text: "⬅️ Back", callback_data: "back" }]);

    return [
      {
        type: "edit_keyboard",
        messageId,
        text,
        inlineKeyboard: keyboard,
      },
    ];
  }

  private async renderCliPeek(
    state: ChatState,
    messageId: number,
    sessionId: string,
  ): Promise<TelegramAction[]> {
    const projects = await this.options.store.listProjects();
    const project = projects.find((p) => p.id === state.projectId);

    if (!project?.rootPath || !this.options.store.peekCliSession) {
      return [{ type: "edit_keyboard", messageId, text: "Cannot peek this session.", inlineKeyboard: [[{ text: "⬅️ Back", callback_data: "clisessions" }]] }];
    }

    const peek = await this.options.store.peekCliSession(project.rootPath, sessionId, 15);
    if (!peek || peek.entries.length === 0) {
      return [{ type: "edit_keyboard", messageId, text: `💻 Session ${sessionId.slice(0, 8)}…\n\nNo activity found.`, inlineKeyboard: [[{ text: "⬅️ Back", callback_data: "clisessions" }]] }];
    }

    const lines = [`💻 Session ${sessionId.slice(0, 8)}…\n`];
    for (const entry of peek.entries) {
      const time = entry.timestamp;
      const icon = entry.type === "user" ? "👤"
        : entry.type === "assistant" ? "🤖"
        : entry.type === "tool_use" ? "🔧"
        : entry.type === "tool_result" ? "📎"
        : entry.type === "error" ? "❌"
        : "·";
      lines.push(`${time} ${icon} ${entry.summary}`);
    }

    // Truncate to fit Telegram 4096 char limit
    let text = lines.join("\n");
    if (text.length > 4000) {
      text = text.slice(0, 4000) + "\n…(truncated)";
    }

    const keyboard: InlineKeyboardRow[] = [
      [{ text: "▶️ Use this session", callback_data: `cliattach:${sessionId}` }],
      [{ text: "🔄 Refresh", callback_data: `clipeek:${sessionId}` }],
      [{ text: "⬅️ Back", callback_data: "clisessions" }],
    ];

    return [{ type: "edit_keyboard", messageId, text, inlineKeyboard: keyboard }];
  }

  private async renderCliSessionsSubmenu(
    state: ChatState,
    messageId: number,
  ): Promise<TelegramAction[]> {
    if (!this.options.store.listCliSessions) {
      return [{ type: "edit_keyboard", messageId, text: "CLI session scanning not available.", inlineKeyboard: [[{ text: "⬅️ Back", callback_data: "back" }]] }];
    }

    const projects = await this.options.store.listProjects();
    const project = projects.find((p) => p.id === state.projectId);
    if (!project?.rootPath) {
      return [{ type: "edit_keyboard", messageId, text: "No project selected or missing rootPath.", inlineKeyboard: [[{ text: "⬅️ Back", callback_data: "back" }]] }];
    }

    const cliSessions = await this.options.store.listCliSessions(project.rootPath, 8);
    if (cliSessions.length === 0) {
      return [{ type: "edit_keyboard", messageId, text: `💻 CLI Sessions\n\nNo Claude CLI sessions found for ${project.name}.`, inlineKeyboard: [[{ text: "⬅️ Back", callback_data: "back" }]] }];
    }

    const lines = [`💻 CLI Sessions — ${project.name}\n`];
    for (const s of cliSessions) {
      const prompt = s.firstPrompt.length > 50 ? s.firstPrompt.slice(0, 50) + "…" : s.firstPrompt;
      const dateStr = formatRelativeDate(s.lastActivity, this.now());
      lines.push(`${prompt}\n   ${dateStr}`);
    }
    const text = lines.join("\n");

    const keyboard: InlineKeyboardRow[] = [];
    for (const s of cliSessions) {
      const prompt = s.firstPrompt.length > 35 ? s.firstPrompt.slice(0, 35) + "…" : s.firstPrompt;
      keyboard.push([{ text: prompt, callback_data: `clipeek:${s.sessionId}` }]);
    }
    keyboard.push([{ text: "⬅️ Back", callback_data: "back" }]);

    return [{ type: "edit_keyboard", messageId, text, inlineKeyboard: keyboard }];
  }

  private async renderModelsSubmenu(
    state: ChatState,
    messageId: number,
  ): Promise<TelegramAction[]> {
    const keyboard: InlineKeyboardRow[] = [];

    if (state.defaultEngine === "claude") {
      const claudeModels = [
        { label: "Opus 4.6", value: "claude-opus-4-6" },
        { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
        { label: "Haiku 4.5", value: "claude-haiku-4-5-20251001" },
      ];

      const text = `🧠 Claude Models\n\nCurrent: ${state.model ?? "default"}`;
      keyboard.push([{ text: state.model ? "🔄 Default" : "✅ Default", callback_data: "model:" }]);
      for (const m of claudeModels) {
        const isSelected = state.model === m.value;
        keyboard.push([{
          text: `${isSelected ? "✅ " : ""}${m.label}`,
          callback_data: `model:${m.value}`,
        }]);
      }
      keyboard.push([{ text: "⬅️ Back", callback_data: "back" }]);
      return [{ type: "edit_keyboard", messageId, text, inlineKeyboard: keyboard }];
    }

    // OpenCode: model + agent — load from config dynamically
    let openCodeModels: Array<{ label: string; value: string }>;
    let openCodeAgents: Array<{ label: string; value: string }>;

    const config = await this.options.store.loadOpenCodeConfig?.();
    if (config && (config.models.length > 0 || config.agents.length > 0)) {
      openCodeModels = config.models;
      // Combine named agents and categories
      openCodeAgents = [{ label: "Default", value: "" }, ...config.agents, ...config.categories];
    } else {
      // Fallback if config can't be loaded
      openCodeModels = [
        { label: "Claude Sonnet 4.6", value: "anthropic:claude-sonnet-4-6" },
        { label: "Claude Opus 4.6", value: "anthropic:claude-opus-4-6" },
      ];
      openCodeAgents = [{ label: "Default", value: "" }];
    }

    const text = [
      "🧠 OpenCode Models & Agents",
      "",
      `Model: ${state.model ?? "default"}`,
      `Agent: ${state.openCodeAgent ?? "default"}`,
    ].join("\n");

    // Model buttons
    keyboard.push([{ text: state.model ? "🔄 Default Model" : "✅ Default Model", callback_data: "model:" }]);
    for (let i = 0; i < openCodeModels.length; i += 2) {
      const row: InlineKeyboardRow = [];
      for (const m of openCodeModels.slice(i, i + 2)) {
        const isSelected = state.model === m.value;
        row.push({ text: `${isSelected ? "✅ " : ""}${m.label}`, callback_data: `model:${m.value}` });
      }
      keyboard.push(row);
    }

    // Agent buttons
    keyboard.push([{ text: "── Agent ──", callback_data: "refresh" }]);
    for (let i = 0; i < openCodeAgents.length; i += 3) {
      const row: InlineKeyboardRow = [];
      for (const a of openCodeAgents.slice(i, i + 3)) {
        const isSelected = (state.openCodeAgent ?? "") === a.value;
        row.push({ text: `${isSelected ? "✅ " : ""}${a.label}`, callback_data: `agent:${a.value}` });
      }
      keyboard.push(row);
    }

    keyboard.push([{ text: "⬅️ Back", callback_data: "back" }]);
    return [{ type: "edit_keyboard", messageId, text, inlineKeyboard: keyboard }];
  }

  private async ensureProject(state: ChatState): Promise<string | undefined> {
    if (state.projectId) {
      return state.projectId;
    }

    const projects = await this.options.store.listProjects();
    if (projects.length === 0) {
      return undefined;
    }

    state.projectId = projects[0].id;
    return state.projectId;
  }

  private async ensureSession(projectId: string, state: ChatState, chatId: string): Promise<string> {
    if (state.sessionId) {
      return state.sessionId;
    }

    const sessions = await this.options.store.listSessionsByProject(projectId);
    if (sessions.length > 0) {
      state.sessionId = sessions[0].id;
      return state.sessionId;
    }

    const newSessionId = randomUUID();
    await this.options.store.createSession({
      id: newSessionId,
      projectId,
      chatId,
      provider: state.defaultEngine,
      status: "active",
      prompt: "",
    });
    state.sessionId = newSessionId;
    return newSessionId;
  }

  private parseEngine(engine: string | undefined): EngineProvider | undefined {
    if (engine === "claude" || engine === "opencode") {
      return engine;
    }

    return undefined;
  }

  private decorateUnsafeBanner(actions: TelegramAction[], state: ChatState): TelegramAction[] {
    if (!state.unsafeUntil || state.unsafeUntil <= this.now()) {
      return actions;
    }

    const expiresAt = new Date(state.unsafeUntil).toISOString();
    return actions.map((action) => {
      if (action.type === "reply") {
        return {
          ...action,
          text: `UNSAFE MODE (expires ${expiresAt})\n${action.text}`,
        };
      }

      if (action.type === "reply_keyboard" || action.type === "edit_keyboard") {
        return {
          ...action,
          text: `UNSAFE MODE (expires ${expiresAt})\n${action.text}`,
        };
      }

      return {
        ...action,
        caption: `UNSAFE MODE (expires ${expiresAt})\n${action.caption ?? ""}`.trimEnd(),
      };
    });
  }

  private async audit(record: {
    userId?: number;
    chatId: number;
    command: string;
    runId?: string;
    decision: "allow" | "deny";
    reason?: string;
  }): Promise<void> {
    if (this.options.auditSink) {
      await this.options.auditSink(record);
    }
  }
}
