import type { NormalizedEngineEvent } from "@ohmyremote/core";

export interface TelegramMessageHandle {
  messageId: number;
}

export interface TelegramMessageTransport {
  sendMessage(chatId: number, text: string): Promise<TelegramMessageHandle>;
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
}

export interface StreamerOptions {
  editIntervalMs?: number;
  chunkIntervalMs?: number;
  now?: () => number;
}

export interface RunFinishSummary {
  status: string;
  durationMs: number;
  engineSessionId?: string;
}

interface RunStreamState {
  statusMessageId?: number;
  lastEditAt: number;
  lastChunkAt: number;
  textBuffer: string;
}

const DEFAULT_EDIT_INTERVAL_MS = 1500;
const DEFAULT_CHUNK_INTERVAL_MS = 5000;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export class TelegramRunStreamer {
  private readonly editIntervalMs: number;
  private readonly chunkIntervalMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, RunStreamState>();

  public constructor(private readonly transport: TelegramMessageTransport, options: StreamerOptions = {}) {
    this.editIntervalMs = options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
    this.chunkIntervalMs = options.chunkIntervalMs ?? DEFAULT_CHUNK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  public async handleEvent(chatId: number, runId: string, event: NormalizedEngineEvent): Promise<void> {
    const state = this.getState(runId);
    const now = this.now();

    if (event.type === "text_delta") {
      state.textBuffer += event.text;
    }

    if (event.type === "error") {
      const errorMsg = (event as { message?: string }).message ?? "Unknown error";
      await this.safeSend(chatId, `[Error] ${sanitizePlainText(errorMsg)}`);
    }

    try {
      if (now - state.lastEditAt >= this.editIntervalMs) {
        await this.sendOrEditStatus(chatId, runId, state, now);
      }

      if (state.textBuffer.length > 0 && now - state.lastChunkAt >= this.chunkIntervalMs) {
        const chunk = sanitizePlainText(state.textBuffer);
        state.textBuffer = "";
        state.lastChunkAt = now;
        await this.safeSend(chatId, chunk);
      }
    } catch (error) {
      console.warn(`[TelegramRunStreamer] handleEvent error for run ${runId}:`, String(error));
    }
  }

  public async finishRun(chatId: number, runId: string, summary: RunFinishSummary): Promise<void> {
    const state = this.getState(runId);

    try {
      if (state.textBuffer.length > 0) {
        const chunk = sanitizePlainText(state.textBuffer);
        state.textBuffer = "";
        await this.safeSend(chatId, chunk);
      }

      const lines = [
        `Run ${runId}`,
        `status=${summary.status}`,
        `duration_ms=${summary.durationMs}`,
        `engine_session_id=${summary.engineSessionId ?? "unknown"}`,
      ];

      await this.safeSend(chatId, sanitizePlainText(lines.join("\n")));
    } catch (error) {
      console.warn(`[TelegramRunStreamer] finishRun error for run ${runId}:`, String(error));
    } finally {
      this.states.delete(runId);
    }
  }

  private getState(runId: string): RunStreamState {
    const existing = this.states.get(runId);
    if (existing !== undefined) {
      return existing;
    }

    const created: RunStreamState = {
      lastEditAt: 0,
      lastChunkAt: 0,
      textBuffer: "",
    };
    this.states.set(runId, created);
    return created;
  }

  private async safeSend(chatId: number, text: string): Promise<void> {
    const trimmed = text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);
    try {
      await this.transport.sendMessage(chatId, trimmed);
    } catch (error) {
      console.warn(`[TelegramRunStreamer] safeSend failed (chatId=${chatId}):`, String(error));
    }
  }

  private async sendOrEditStatus(chatId: number, runId: string, state: RunStreamState, now: number): Promise<void> {
    const preview = state.textBuffer.slice(0, 120);
    const statusText = sanitizePlainText(`Run ${runId}\npreview=${preview}`).slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);

    if (state.statusMessageId === undefined) {
      try {
        const sent = await this.transport.sendMessage(chatId, statusText);
        state.statusMessageId = sent.messageId;
        state.lastEditAt = now;
      } catch (error) {
        console.warn(`[TelegramRunStreamer] sendOrEditStatus send failed:`, String(error));
      }
      return;
    }

    try {
      await this.transport.editMessage(chatId, state.statusMessageId, statusText);
      state.lastEditAt = now;
    } catch {
      try {
        const sent = await this.transport.sendMessage(chatId, statusText);
        state.statusMessageId = sent.messageId;
        state.lastEditAt = now;
      } catch (error) {
        console.warn(`[TelegramRunStreamer] sendOrEditStatus fallback send failed:`, String(error));
      }
    }
  }
}

export function sanitizePlainText(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
}
