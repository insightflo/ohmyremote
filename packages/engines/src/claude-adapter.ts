import {
  createLineDecoder,
  type EngineRunStatus,
  type NormalizedEngineEvent,
  parseNormalizedEngineEvent,
} from "@ohmyremote/core";

export const CLAUDE_SAFE_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;
export const CLAUDE_UNSAFE_ALLOWED_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

export type ClaudeOutputFormat = "json" | "stream-json";
export type ClaudeToolPolicy = "safe" | "unsafe";

export type ClaudeSessionSelection =
  | { mode: "new" }
  | { mode: "continue" }
  | { mode: "resume"; engineSessionId: string; forkSession?: boolean };

export interface ClaudeCommandOptions {
  prompt: string;
  outputFormat: ClaudeOutputFormat;
  session?: ClaudeSessionSelection;
  toolPolicy?: ClaudeToolPolicy;
  tools?: readonly string[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
}

export interface ClaudeCommandSpec {
  command: "claude";
  args: string[];
}

export interface ClaudeJsonUsage {
  [key: string]: unknown;
}

export interface ClaudeJsonResponse {
  result: string;
  engineSessionId?: string;
  usage?: ClaudeJsonUsage;
  raw: Record<string, unknown>;
}

export interface ClaudeStreamParseResult {
  events: NormalizedEngineEvent[];
  engineSessionId?: string;
  malformedLineCount: number;
}

export interface ClaudeStreamJsonParser {
  push(chunk: string | Uint8Array): NormalizedEngineEvent[];
  finish(status?: EngineRunStatus): NormalizedEngineEvent[];
  engineSessionId(): string | undefined;
  malformedLineCount(): number;
}

function formatTools(tools: readonly string[]): string {
  return tools.join(",");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sessionArgs(selection: ClaudeSessionSelection): string[] {
  if (selection.mode === "new") {
    return [];
  }

  if (selection.mode === "continue") {
    return ["--continue"];
  }

  const args = ["--resume", selection.engineSessionId];
  if (selection.forkSession === true) {
    args.push("--fork-session");
  }

  return args;
}

function captureSessionIdFromLine(line: string): string | undefined {
  if (line.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return isNonEmptyString(parsed.session_id) ? parsed.session_id : undefined;
  } catch {
    return undefined;
  }
}

export function buildClaudeCommandSpec(options: ClaudeCommandOptions): ClaudeCommandSpec {
  const selectedSession = options.session ?? { mode: "new" };
  const selectedPolicy = options.toolPolicy ?? "safe";
  const defaultTools = selectedPolicy === "unsafe" ? CLAUDE_UNSAFE_ALLOWED_TOOLS : CLAUDE_SAFE_ALLOWED_TOOLS;
  const tools = options.tools ?? defaultTools;
  const allowedTools = options.allowedTools ?? tools;

  const args: string[] = ["-p", options.prompt, "--output-format", options.outputFormat];
  if (options.outputFormat === "stream-json") {
    args.push("--include-partial-messages", "--verbose");
  }

  if (isNonEmptyString(options.model)) {
    args.push("--model", options.model);
  }

  args.push(...sessionArgs(selectedSession));
  args.push("--tools", formatTools(tools));
  args.push("--allowedTools", formatTools(allowedTools));

  if ((options.disallowedTools?.length ?? 0) > 0) {
    args.push("--disallowedTools", formatTools(options.disallowedTools!));
  }

  if (isFiniteNumber(options.maxTurns)) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (isFiniteNumber(options.maxBudgetUsd)) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  return {
    command: "claude",
    args,
  };
}

export function parseClaudeJsonOutput(output: string): ClaudeJsonResponse {
  const parsed = JSON.parse(output) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("claude json output must be an object");
  }

  const raw = parsed as Record<string, unknown>;
  if (!isNonEmptyString(raw.result)) {
    throw new Error("claude json output is missing result");
  }

  return {
    result: raw.result,
    engineSessionId: isNonEmptyString(raw.session_id) ? raw.session_id : undefined,
    usage: typeof raw.usage === "object" && raw.usage !== null ? (raw.usage as ClaudeJsonUsage) : undefined,
    raw,
  };
}

function extractErrorMessage(parsed: Record<string, unknown>): string {
  // Claude CLI sometimes returns subtype=success while is_error=true.
  // In that case, the most useful message is usually in the `result` field.
  if (typeof parsed.result === "string" && parsed.result.length > 0) return parsed.result;

  // Try common error fields in priority order
  if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
  if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
  if (typeof parsed.body === "string" && parsed.body.length > 0) return parsed.body;

  // Error might be an object with its own message
  if (parsed.error && typeof parsed.error === "object") {
    const errObj = parsed.error as Record<string, unknown>;
    if (typeof errObj.message === "string") return errObj.message;
    if (typeof errObj.type === "string") return errObj.type;
    return JSON.stringify(parsed.error).slice(0, 500);
  }

  // Last resort: stringify the whole parsed object for debugging
  const raw = JSON.stringify(parsed).slice(0, 500);
  return `Claude error: ${raw}`;
}

function translateClaudeLineToEvents(parsed: Record<string, unknown>): NormalizedEngineEvent[] {
  const type = parsed.type as string;

  if (type === "stream_event") {
    const event = parsed.event as Record<string, unknown> | undefined;
    if (!event) return [];

    const eventType = event.type as string;
    const delta = event.delta as Record<string, unknown> | undefined;

    if (eventType === "content_block_delta" && delta) {
      const deltaType = delta.type as string;
      if (deltaType === "text_delta" && typeof delta.text === "string") {
        return [{ type: "text_delta", text: delta.text, raw: parsed }];
      }
    }

    if (eventType === "content_block_start") {
      const contentBlock = event.content_block as Record<string, unknown> | undefined;
      if (contentBlock?.type === "tool_use") {
        return [{
          type: "tool_start",
          toolName: (contentBlock.name as string) ?? "unknown",
          callId: contentBlock.id as string | undefined,
          raw: parsed,
        }];
      }
    }

    if (eventType === "content_block_stop") {
      // Could signal tool_end but we don't have enough context here
      return [];
    }

    return [];
  }

  if (type === "assistant") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? []) as Array<Record<string, unknown>>;
    const events: NormalizedEngineEvent[] = [];

    for (const block of content) {
      if (block.type === "tool_use") {
        events.push({
          type: "tool_end",
          toolName: (block.name as string) ?? "unknown",
          callId: block.id as string | undefined,
          output: block.input,
          raw: parsed,
        });
      }
    }

    return events;
  }

  if (type === "result") {
    const subtype = parsed.subtype as string | undefined;
    const isError = parsed.is_error === true;
    const status: EngineRunStatus = subtype === "error" || isError
      ? "error"
      : subtype === "success"
        ? "success"
        : "unknown";
    const events: NormalizedEngineEvent[] = [];

    // If result contains an error message, emit error event before run_finished
    if (status === "error") {
      const errorMsg = extractErrorMessage(parsed);
      events.push({ type: "error", message: errorMsg, raw: parsed });
    }

    events.push({ type: "run_finished", status, raw: parsed });
    return events;
  }

  // Handle explicit error events from Claude CLI
  if (type === "error") {
    const message = extractErrorMessage(parsed);
    return [{ type: "error", message, raw: parsed }];
  }

  return [];
}

export function createClaudeStreamJsonParser(): ClaudeStreamJsonParser {
  const lineDecoder = createLineDecoder();
  let latestEngineSessionId: string | undefined;
  let runFinishedEmitted = false;
  let malformedCount = 0;

  const processLine = (line: string, events: NormalizedEngineEvent[]): void => {
    if (line.trim().length === 0) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      malformedCount += 1;
      return;
    }

    // Capture session_id from any line that has it
    if (isNonEmptyString(parsed.session_id)) {
      latestEngineSessionId = parsed.session_id;
    }

    const pushEvent = (event: NormalizedEngineEvent): void => {
      if (event.type === "run_finished") {
        if (runFinishedEmitted) return;
        runFinishedEmitted = true;
      }
      events.push(event);
    };

    // Allow already-normalized events to pass through (used by tests and internal tooling).
    const normalized = parseNormalizedEngineEvent(parsed);
    if (normalized) {
      pushEvent(normalized);
      return;
    }

    const translated = translateClaudeLineToEvents(parsed);
    for (const event of translated) {
      pushEvent(event);
    }
  };

  return {
    push(chunk) {
      const lines = lineDecoder.push(chunk);
      const events: NormalizedEngineEvent[] = [];
      for (const line of lines) {
        processLine(line, events);
      }
      return events;
    },
    finish(status = "unknown") {
      const remaining = lineDecoder.flush();
      const events: NormalizedEngineEvent[] = [];
      for (const line of remaining) {
        processLine(line, events);
      }
      if (!runFinishedEmitted) {
        runFinishedEmitted = true;
        events.push({ type: "run_finished", status });
      }
      return events;
    },
    engineSessionId() {
      return latestEngineSessionId;
    },
    malformedLineCount() {
      return malformedCount;
    },
  };
}

export function parseClaudeStreamJsonOutput(
  output: string,
  status: EngineRunStatus = "unknown"
): ClaudeStreamParseResult {
  const parser = createClaudeStreamJsonParser();
  const events = parser.push(output);
  const finalEvents = parser.finish(status);

  return {
    events: [...events, ...finalEvents],
    engineSessionId: parser.engineSessionId(),
    malformedLineCount: parser.malformedLineCount(),
  };
}
