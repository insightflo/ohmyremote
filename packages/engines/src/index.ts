import type { SessionRequest, SessionResponse } from "@ohmyremote/core";

export * from "./claude-adapter.js";
export * from "./opencode-adapter.js";

export interface EngineAdapter {
  readonly provider: "claude" | "opencode";
  run(request: SessionRequest): Promise<SessionResponse>;
}

export function createPlaceholderAdapter(provider: "claude" | "opencode"): EngineAdapter {
  return {
    provider,
    async run() {
      return {
        id: `${provider}-placeholder-session`,
        accepted: true
      };
    }
  };
}
