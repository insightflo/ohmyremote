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

function createRunGatewaySpy(): { gateway: RunGateway; getCalls: () => number } {
  let calls = 0;
  const gateway: RunGateway = {
    async enqueueRun(_input) {
      calls += 1;
      return { runId: "run-1" };
    },
  };

  return { gateway, getCalls: () => calls };
}

test("non-owner update is rejected and does not enqueue run", async () => {
  const store = new MemoryStore();
  const { gateway, getCalls } = createRunGatewaySpy();
  const handler = new TelegramCommandHandler({
    ownerUserId: 42,
    store,
    runGateway: gateway,
  });

  const actions = await handler.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      text: "/run hi",
      chat: { id: 100, type: "private" },
      from: { id: 77 },
    },
  });

  assert.equal(getCalls(), 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "reply");
  assert.match(actions[0]?.text ?? "", /owner only/i);
});

test("group updates are ignored even from owner", async () => {
  const store = new MemoryStore();
  const { gateway, getCalls } = createRunGatewaySpy();
  const handler = new TelegramCommandHandler({
    ownerUserId: 42,
    store,
    runGateway: gateway,
  });

  const actions = await handler.handleUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      text: "/run hi",
      chat: { id: 100, type: "group" },
      from: { id: 42 },
    },
  });

  assert.equal(actions.length, 0);
  assert.equal(getCalls(), 0);
});
