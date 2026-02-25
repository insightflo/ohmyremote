export type EngineProvider = "claude" | "opencode";

export interface SessionRequest {
  provider: EngineProvider;
  prompt: string;
}

export interface SessionResponse {
  id: string;
  accepted: boolean;
}

export * from './config.js';
export * from './engine-events.js';
export * from './line-decoder.js';
export * from './engine-event-parser.js';
export * from './runner.js';
