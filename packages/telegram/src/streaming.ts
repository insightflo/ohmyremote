import type { NormalizedEngineEvent } from "@ohmyremote/core";

export interface TelegramMessageHandle {
  messageId: number;
}

export type InlineButton = { text: string; callback_data: string };

export interface TelegramMessageTransport {
  sendMessage(chatId: number, text: string, keyboard?: InlineButton[][]): Promise<TelegramMessageHandle>;
  editMessage(chatId: number, messageId: number, text: string, keyboard?: InlineButton[][] | null): Promise<void>;
}

export interface StreamerOptions {
  editIntervalMs?: number;
  now?: () => number;
}

export interface RunFinishSummary {
  status: string;
  durationMs: number;
  engineSessionId?: string;
}

interface RunStreamState {
  runId: string;
  startedAt: number;
  progressMessageId?: number;
  lastEditAt: number;
  textBuffer: string;
  toolNames: string[];
}

const DEFAULT_EDIT_INTERVAL_MS = 2000;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return `${m}m ${remainder}s`;
}

export class TelegramRunStreamer {
  private readonly editIntervalMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, RunStreamState>();

  public constructor(private readonly transport: TelegramMessageTransport, options: StreamerOptions = {}) {
    this.editIntervalMs = options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  public async handleEvent(chatId: number, runId: string, event: NormalizedEngineEvent): Promise<void> {
    const state = this.getState(runId);
    const now = this.now();

    if (event.type === "text_delta") {
      state.textBuffer += event.text;
    }

    if (event.type === "tool_start") {
      const name = (event as { toolName?: string }).toolName ?? "tool";
      state.toolNames.push(name);
    }

    if (event.type === "error") {
      const errorMsg = (event as { message?: string }).message ?? "Unknown error";
      await this.safeSend(chatId, `[Error] ${sanitizePlainText(errorMsg)}`);
      return;
    }

    try {
      if (now - state.lastEditAt >= this.editIntervalMs) {
        await this.updateProgress(chatId, state, now);
      }
    } catch (error) {
      console.warn(`[TelegramRunStreamer] handleEvent error for run ${runId}:`, String(error));
    }
  }

  public async finishRun(chatId: number, runId: string, summary: RunFinishSummary): Promise<void> {
    const state = this.getState(runId);

    try {
      const finalText = sanitizePlainText(state.textBuffer).trim();
      const elapsed = formatElapsed(summary.durationMs);
      const statusIcon = summary.status === "finished" ? "Done" : summary.status;
      const footer = `\n\n[${statusIcon} in ${elapsed}]`;

      if (finalText.length > 0) {
        // Split long output into multiple messages
        const chunks = splitText(finalText, TELEGRAM_MAX_MESSAGE_LENGTH - footer.length);

        // First chunk: replace progress message (no keyboard)
        const firstChunk = chunks[0] + (chunks.length === 1 ? footer : "");
        if (state.progressMessageId !== undefined) {
          try {
            await this.transport.editMessage(chatId, state.progressMessageId, firstChunk, null);
          } catch {
            await this.safeSend(chatId, firstChunk);
          }
        } else {
          await this.safeSend(chatId, firstChunk);
        }

        // Remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          const text = chunks[i] + (i === chunks.length - 1 ? footer : "");
          await this.safeSend(chatId, text);
        }
      } else {
        const doneText = `${statusIcon} in ${elapsed}`;
        if (state.progressMessageId !== undefined) {
          try {
            await this.transport.editMessage(chatId, state.progressMessageId, doneText, null);
          } catch {
            await this.safeSend(chatId, doneText);
          }
        } else {
          await this.safeSend(chatId, doneText);
        }
      }
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
      runId,
      startedAt: this.now(),
      lastEditAt: 0,
      textBuffer: "",
      toolNames: [],
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

  private async updateProgress(chatId: number, state: RunStreamState, now: number): Promise<void> {
    const elapsed = formatElapsed(now - state.startedAt);
    const preview = sanitizePlainText(state.textBuffer).slice(-300).trim();
    const recentTools = state.toolNames.slice(-3);
    const toolLine = recentTools.length > 0 ? `Tools: ${recentTools.join(", ")}\n` : "";

    const lines = [`Working... (${elapsed})`, toolLine, preview].filter(Boolean);
    const statusText = lines.join("\n").slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);

    const stopButton: InlineButton[][] = [[{ text: "Stop", callback_data: `stop_run:${state.runId}` }]];

    if (state.progressMessageId === undefined) {
      try {
        const sent = await this.transport.sendMessage(chatId, statusText, stopButton);
        state.progressMessageId = sent.messageId;
        state.lastEditAt = now;
      } catch (error) {
        console.warn(`[TelegramRunStreamer] updateProgress send failed:`, String(error));
      }
      return;
    }

    try {
      await this.transport.editMessage(chatId, state.progressMessageId, statusText, stopButton);
      state.lastEditAt = now;
    } catch {
      try {
        const sent = await this.transport.sendMessage(chatId, statusText, stopButton);
        state.progressMessageId = sent.messageId;
      } catch (error) {
        console.warn(`[TelegramRunStreamer] updateProgress fallback send failed:`, String(error));
      } finally {
        state.lastEditAt = now;
      }
    }
  }
}

/** Split text into chunks at line boundaries when possible */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0 || splitAt < maxLen * 0.5) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

export function sanitizePlainText(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
}
