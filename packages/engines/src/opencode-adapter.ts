import {
  createLineDecoder,
  parseNormalizedEngineEvent,
  type EngineRunStatus,
  type NormalizedEngineEvent,
} from "@ohmyremote/core";

export type OpenCodeSessionSelection =
  | { mode: "new" }
  | { mode: "continue"; forkSession?: boolean }
  | { mode: "resume"; engineSessionId: string; forkSession?: boolean };

export interface OpenCodeCommandOptions {
  prompt: string;
  session?: OpenCodeSessionSelection;
  attachUrl?: string;
  fileAttachments?: readonly string[];
  model?: string;
  agent?: string;
}

export interface OpenCodeCommandSpec {
  command: "opencode";
  args: string[];
}

export type OpenCodePermissionPolicy = "safe" | "unsafe";

export const OPENCODE_SAFE_ALLOWED_TOOLS = ["read", "glob", "grep", "list"] as const;
export const OPENCODE_UNSAFE_ADDITIONAL_TOOLS = ["edit"] as const;

export const OPENCODE_UNSAFE_BASH_POLICY = {
  "*": "deny",
  "git *": "allow",
  "pnpm *": "allow",
  "npm *": "allow",
  "cargo *": "allow",
  "python *": "allow",
  "node *": "allow",
  "rm *": "deny",
  "sudo *": "deny",
  "dd *": "deny",
  "mkfs *": "deny",
} as const;

type PermissionLeaf = "allow" | "deny";

type OpenCodePermissionValue = PermissionLeaf | Record<string, PermissionLeaf>;

interface OpenCodePermissionConfig {
  permission: Record<string, OpenCodePermissionValue>;
}

export interface OpenCodeStreamParseResult {
  events: NormalizedEngineEvent[];
  engineSessionId?: string;
  malformedLineCount: number;
}

export interface OpenCodeJsonlParser {
  push(chunk: string | Uint8Array): NormalizedEngineEvent[];
  finish(status?: EngineRunStatus): NormalizedEngineEvent[];
  engineSessionId(): string | undefined;
  malformedLineCount(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRunStatus(value: unknown): EngineRunStatus {
  if (value === "success" || value === "error" || value === "cancelled") {
    return value;
  }

  return "unknown";
}

function sessionArgs(selection: OpenCodeSessionSelection): string[] {
  if (selection.mode === "new") {
    return [];
  }

  if (selection.mode === "continue") {
    const args = ["--continue"];
    if (selection.forkSession === true) {
      args.push("--fork");
    }

    return args;
  }

  const args = ["--session", selection.engineSessionId];
  if (selection.forkSession === true) {
    args.push("--fork");
  }

  return args;
}

function normalizeType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.toLowerCase().replace(/[\s.-]+/g, "_");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asOptionalString(value);
    if (text !== undefined) {
      return text;
    }
  }

  return undefined;
}

function extractToolName(event: Record<string, unknown>): string | undefined {
  if (isRecord(event.tool)) {
    return firstString(event.tool.name);
  }

  return firstString(event.toolName, event.name, event.tool_name);
}

function mapOpenCodeEvent(rawEvent: unknown): NormalizedEngineEvent | null {
  const normalized = parseNormalizedEngineEvent(rawEvent);
  if (normalized !== null) {
    return normalized;
  }

  if (!isRecord(rawEvent)) {
    return null;
  }

  const eventType = normalizeType(rawEvent.type);
  switch (eventType) {
    case "started":
    case "run_started":
    case "run_start":
      return {
        type: "run_started",
        runId: firstString(rawEvent.runId, rawEvent.run_id, rawEvent.id),
        timestamp: firstString(rawEvent.timestamp, rawEvent.time),
        raw: rawEvent,
      };
    case "text":
    case "text_delta":
    case "message_delta":
    case "output_text_delta": {
      // OpenCode wraps text in part.text
      const part = isRecord(rawEvent.part) ? rawEvent.part : undefined;
      const text = firstString(part?.text, rawEvent.text, rawEvent.delta, rawEvent.content, rawEvent.message);
      if (text === undefined) {
        return null;
      }

      return {
        type: "text_delta",
        text,
        channel: firstString(rawEvent.channel),
        raw: rawEvent,
      };
    }
    case "tool_use": {
      // OpenCode emits tool_use with part.tool and part.state
      const part = isRecord(rawEvent.part) ? rawEvent.part : undefined;
      const toolName = firstString(part?.tool, extractToolName(rawEvent));
      if (toolName === undefined) return null;
      const state = isRecord(part?.state) ? part!.state : undefined;
      const status = firstString(state?.status);
      if (status === "pending" || status === undefined) {
        return {
          type: "tool_start",
          toolName,
          callId: firstString(part?.callID, rawEvent.callId, rawEvent.call_id),
          input: state?.input,
          raw: rawEvent,
        };
      }
      return {
        type: "tool_end",
        toolName,
        callId: firstString(part?.callID, rawEvent.callId, rawEvent.call_id),
        output: state?.output ?? state?.error,
        raw: rawEvent,
      };
    }
    case "tool_start":
    case "tool_started":
    case "tool_call_start":
    case "tool_call_started": {
      const toolName = extractToolName(rawEvent);
      if (toolName === undefined) {
        return null;
      }

      return {
        type: "tool_start",
        toolName,
        callId: firstString(rawEvent.callId, rawEvent.call_id, rawEvent.toolCallId, rawEvent.id),
        input: rawEvent.input ?? rawEvent.arguments,
        raw: rawEvent,
      };
    }
    case "tool_end":
    case "tool_finished":
    case "tool_call_end":
    case "tool_call_finished": {
      const toolName = extractToolName(rawEvent);
      if (toolName === undefined) {
        return null;
      }

      return {
        type: "tool_end",
        toolName,
        callId: firstString(rawEvent.callId, rawEvent.call_id, rawEvent.toolCallId, rawEvent.id),
        output: rawEvent.output ?? rawEvent.result,
        raw: rawEvent,
      };
    }
    case "step_start":
    case "step_finish":
      // OpenCode step lifecycle — skip silently
      return null;
    case "error":
    case "run_error": {
      const message = firstString(rawEvent.message, rawEvent.error);
      if (message === undefined) {
        return null;
      }

      return {
        type: "error",
        message,
        code: firstString(rawEvent.code),
        raw: rawEvent,
      };
    }
    case "finished":
    case "completed":
    case "run_finished":
    case "run_end":
      return {
        type: "run_finished",
        status: asRunStatus(rawEvent.status),
        raw: rawEvent,
      };
    case "file_uploaded":
    case "upload_completed":
      return {
        type: "file_uploaded",
        filePath: firstString(rawEvent.filePath, rawEvent.path),
        fileName: firstString(rawEvent.fileName, rawEvent.name),
        sizeBytes: typeof rawEvent.sizeBytes === "number" ? rawEvent.sizeBytes : undefined,
        url: firstString(rawEvent.url),
        raw: rawEvent,
      };
    case "file_downloaded":
    case "download_completed":
      return {
        type: "file_downloaded",
        filePath: firstString(rawEvent.filePath, rawEvent.path),
        fileName: firstString(rawEvent.fileName, rawEvent.name),
        sizeBytes: typeof rawEvent.sizeBytes === "number" ? rawEvent.sizeBytes : undefined,
        url: firstString(rawEvent.url),
        raw: rawEvent,
      };
    default:
      return null;
  }
}

function captureSessionId(rawEvent: unknown): string | undefined {
  if (!isRecord(rawEvent)) {
    return undefined;
  }

  return firstString(rawEvent.sessionID, rawEvent.sessionId);
}

export function buildOpenCodeCommandSpec(options: OpenCodeCommandOptions): OpenCodeCommandSpec {
  const selectedSession = options.session ?? { mode: "new" };
  const args: string[] = ["run", options.prompt, "--format", "json"];

  args.push(...sessionArgs(selectedSession));

  const attachUrl = asOptionalString(options.attachUrl);
  if (attachUrl !== undefined) {
    args.push("--attach", attachUrl);
  }

  for (const filePath of options.fileAttachments ?? []) {
    args.push("-f", filePath);
  }

  if (asOptionalString(options.model)) {
    args.push("--model", options.model!);
  }

  if (asOptionalString(options.agent)) {
    args.push("--agent", options.agent!);
  }

  return {
    command: "opencode",
    args,
  };
}

export function createOpenCodePermissionConfigContent(policy: OpenCodePermissionPolicy): string {
  const basePermission: Record<string, OpenCodePermissionValue> = {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    external_directory: "deny",
  };

  if (policy === "unsafe") {
    basePermission.edit = { "*": "allow" };
    basePermission.bash = { ...OPENCODE_UNSAFE_BASH_POLICY };
  }

  const config: OpenCodePermissionConfig = {
    permission: basePermission,
  };

  return JSON.stringify(config);
}

export function createOpenCodeJsonlParser(): OpenCodeJsonlParser {
  const lineDecoder = createLineDecoder();
  let latestEngineSessionId: string | undefined;
  let malformedCount = 0;
  let runFinishedEmitted = false;

  const parseLines = (lines: string[]): NormalizedEngineEvent[] => {
    const events: NormalizedEngineEvent[] = [];

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedCount += 1;
        continue;
      }

      const parsedSessionId = captureSessionId(parsed);
      if (parsedSessionId !== undefined) {
        latestEngineSessionId = parsedSessionId;
      }

      const event = mapOpenCodeEvent(parsed);
      if (event === null) {
        continue;
      }

      if (event.type === "run_finished") {
        if (runFinishedEmitted) {
          continue;
        }

        runFinishedEmitted = true;
      }

      events.push(event);
    }

    return events;
  };

  return {
    push(chunk) {
      return parseLines(lineDecoder.push(chunk));
    },
    finish(status = "unknown") {
      const events = parseLines(lineDecoder.flush());

      if (!runFinishedEmitted) {
        events.push({ type: "run_finished", status });
        runFinishedEmitted = true;
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

export function parseOpenCodeJsonlOutput(
  output: string,
  status: EngineRunStatus = "unknown"
): OpenCodeStreamParseResult {
  const parser = createOpenCodeJsonlParser();
  const events = parser.push(output);
  const finalEvents = parser.finish(status);

  return {
    events: [...events, ...finalEvents],
    engineSessionId: parser.engineSessionId(),
    malformedLineCount: parser.malformedLineCount(),
  };
}
