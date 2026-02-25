export type EngineRunStatus = 'success' | 'error' | 'cancelled' | 'unknown';

export interface BaseEngineEvent {
  type:
    | 'run_started'
    | 'engine_meta'
    | 'text_delta'
    | 'tool_start'
    | 'tool_end'
    | 'error'
    | 'run_finished'
    | 'file_uploaded'
    | 'file_downloaded';
  raw?: unknown;
}

export interface RunStartedEvent extends BaseEngineEvent {
  type: 'run_started';
  runId?: string;
  timestamp?: string;
}

export interface EngineMetaEvent extends BaseEngineEvent {
  type: 'engine_meta';
  engine?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface TextDeltaEvent extends BaseEngineEvent {
  type: 'text_delta';
  text: string;
  channel?: string;
}

export interface ToolStartEvent extends BaseEngineEvent {
  type: 'tool_start';
  toolName: string;
  callId?: string;
  input?: unknown;
}

export interface ToolEndEvent extends BaseEngineEvent {
  type: 'tool_end';
  toolName: string;
  callId?: string;
  output?: unknown;
}

export interface ErrorEvent extends BaseEngineEvent {
  type: 'error';
  message: string;
  code?: string;
}

export interface RunFinishedEvent extends BaseEngineEvent {
  type: 'run_finished';
  status: EngineRunStatus;
}

export interface FileUploadedEvent extends BaseEngineEvent {
  type: 'file_uploaded';
  filePath?: string;
  fileName?: string;
  sizeBytes?: number;
  url?: string;
}

export interface FileDownloadedEvent extends BaseEngineEvent {
  type: 'file_downloaded';
  filePath?: string;
  fileName?: string;
  sizeBytes?: number;
  url?: string;
}

export type NormalizedEngineEvent =
  | RunStartedEvent
  | EngineMetaEvent
  | TextDeltaEvent
  | ToolStartEvent
  | ToolEndEvent
  | ErrorEvent
  | RunFinishedEvent
  | FileUploadedEvent
  | FileDownloadedEvent;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function asRunStatus(value: unknown): EngineRunStatus {
  if (value === 'success' || value === 'error' || value === 'cancelled') {
    return value;
  }

  return 'unknown';
}

export function parseNormalizedEngineEvent(value: unknown): NormalizedEngineEvent | null {
  if (!isObject(value)) {
    return null;
  }

  const type = value.type;
  if (typeof type !== 'string') {
    return null;
  }

  switch (type) {
    case 'run_started':
      return {
        type,
        runId: asOptionalString(value.runId),
        timestamp: asOptionalString(value.timestamp),
        raw: value,
      };
    case 'engine_meta':
      return {
        type,
        engine: asOptionalString(value.engine),
        model: asOptionalString(value.model),
        metadata: asOptionalRecord(value.metadata),
        raw: value,
      };
    case 'text_delta': {
      const text = asOptionalString(value.text);
      if (text === undefined) {
        return null;
      }

      return {
        type,
        text,
        channel: asOptionalString(value.channel),
        raw: value,
      };
    }
    case 'tool_start': {
      const toolName = asOptionalString(value.toolName);
      if (toolName === undefined) {
        return null;
      }

      return {
        type,
        toolName,
        callId: asOptionalString(value.callId),
        input: value.input,
        raw: value,
      };
    }
    case 'tool_end': {
      const toolName = asOptionalString(value.toolName);
      if (toolName === undefined) {
        return null;
      }

      return {
        type,
        toolName,
        callId: asOptionalString(value.callId),
        output: value.output,
        raw: value,
      };
    }
    case 'error': {
      const message = asOptionalString(value.message);
      if (message === undefined) {
        return null;
      }

      return {
        type,
        message,
        code: asOptionalString(value.code),
        raw: value,
      };
    }
    case 'run_finished':
      return {
        type,
        status: asRunStatus(value.status),
        raw: value,
      };
    case 'file_uploaded':
      return {
        type,
        filePath: asOptionalString(value.filePath),
        fileName: asOptionalString(value.fileName),
        sizeBytes: asOptionalNumber(value.sizeBytes),
        url: asOptionalString(value.url),
        raw: value,
      };
    case 'file_downloaded':
      return {
        type,
        filePath: asOptionalString(value.filePath),
        fileName: asOptionalString(value.fileName),
        sizeBytes: asOptionalNumber(value.sizeBytes),
        url: asOptionalString(value.url),
        raw: value,
      };
    default:
      return null;
  }
}
