import { type EngineRunStatus, type NormalizedEngineEvent, parseNormalizedEngineEvent } from './engine-events.js';
import { createLineDecoder, type LineDecoder } from './line-decoder.js';

export interface MalformedLine {
  line: string;
  lineNumber: number;
  error: Error;
}

export interface EngineEventParserOptions {
  onEvent?: (event: NormalizedEngineEvent) => void;
  onMalformedLine?: (malformed: MalformedLine) => void;
  lineDecoder?: LineDecoder;
}

export interface EngineEventParser {
  push(chunk: string | Uint8Array): NormalizedEngineEvent[];
  finish(status?: EngineRunStatus): NormalizedEngineEvent[];
  hasFinished(): boolean;
  malformedLineCount(): number;
}

export function createEngineEventParser(options: EngineEventParserOptions = {}): EngineEventParser {
  const lineDecoder = options.lineDecoder ?? createLineDecoder();

  let lineNumber = 0;
  let malformedCount = 0;
  let runFinishedEmitted = false;

  const emit = (event: NormalizedEngineEvent, events: NormalizedEngineEvent[]): void => {
    if (event.type === 'run_finished') {
      if (runFinishedEmitted) {
        return;
      }

      runFinishedEmitted = true;
    }

    events.push(event);
    options.onEvent?.(event);
  };

  const reportMalformed = (line: string, error: Error): void => {
    malformedCount += 1;
    options.onMalformedLine?.({ line, lineNumber, error });
  };

  const parseLine = (line: string, events: NormalizedEngineEvent[]): void => {
    if (line.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      reportMalformed(line, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const normalized = parseNormalizedEngineEvent(parsed);
    if (!normalized) {
      return;
    }

    emit(normalized, events);
  };

  const consumeLines = (lines: string[]): NormalizedEngineEvent[] => {
    const events: NormalizedEngineEvent[] = [];
    for (const line of lines) {
      lineNumber += 1;
      parseLine(line, events);
    }

    return events;
  };

  const emitRunFinishedIfNeeded = (status: EngineRunStatus, events: NormalizedEngineEvent[]): void => {
    if (runFinishedEmitted) {
      return;
    }

    emit({ type: 'run_finished', status }, events);
  };

  return {
    push(chunk) {
      const lines = lineDecoder.push(chunk);
      return consumeLines(lines);
    },
    finish(status = 'unknown') {
      const events = consumeLines(lineDecoder.flush());
      emitRunFinishedIfNeeded(status, events);
      return events;
    },
    hasFinished() {
      return runFinishedEmitted;
    },
    malformedLineCount() {
      return malformedCount;
    },
  };
}
