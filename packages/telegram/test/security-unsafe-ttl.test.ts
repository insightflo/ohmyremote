import assert from "node:assert/strict";
import test from "node:test";

import { TelegramCommandHandler, type RunGateway, type TelegramDataStore } from "../src/index.js";

class MemoryStore implements TelegramDataStore {
  private readonly updates = new Set<number>();

  public async insertTelegramInbox(input: {
    updateId: number;
    chatId?: string | null;
    payloadJson: string;
    receivedAt?: number;
  }): Promise<boolean> {
    if (this.updates.has(input.updateId)) {
      return false;
    }
    this.updates.add(input.updateId);
    return true;
  }

  public async listProjects(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: "project-1", name: "Project 1" }];
  }

  public async listSessionsByProject(_projectId: string): Promise<Array<{ id: string; projectId: string; provider: string }>> {
    return [];
  }

  public async createSession(_input: { id: string; projectId: string; chatId?: string | null; provider: string; status: string; prompt: string }): Promise<void> {
    return;
  }

  public async getSessionById(_sessionId: string): Promise<{ id: string; projectId: string; provider: string } | undefined> {
    return undefined;
  }
}

const gateway: RunGateway = {
  async enqueueRun(_input) {
    return { runId: "run-1" };
  },
};

test("unsafe mode expires and replies revert to normal", async () => {
  const store = new MemoryStore();
  let now = 1_700_000_000_000;
  const handler = new TelegramCommandHandler({
    ownerUserId: 42,
    store,
    runGateway: gateway,
    now: () => now,
  });

  await handler.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      text: "/enable_unsafe 1",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
    },
  });

  now += 30_000;
  const beforeExpiry = await handler.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      text: "/status",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
    },
  });
  assert.match(beforeExpiry[0]?.text ?? "", /^UNSAFE MODE/);

  now += 61_000;
  const afterExpiry = await handler.handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      text: "/status",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
    },
  });
  assert.equal((afterExpiry[0]?.text ?? "").startsWith("UNSAFE MODE"), false);
});
