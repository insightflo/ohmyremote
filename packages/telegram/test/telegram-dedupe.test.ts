import assert from "node:assert/strict";
import test from "node:test";

import { TelegramCommandHandler, type RunGateway, type TelegramDataStore, type TelegramUpdate } from "../src/index.js";

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

function ownerPrivateRunUpdate(updateId: number, messageId: number, ownerId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      text: "/run hello",
      chat: { id: 100, type: "private" },
      from: { id: ownerId },
    },
  };
}

test("duplicate update_id does not create second run", async () => {
  const store = new MemoryStore();
  const { gateway, getCalls } = createRunGatewaySpy();
  const handler = new TelegramCommandHandler({
    ownerUserId: 42,
    store,
    runGateway: gateway,
  });

  const first = await handler.handleUpdate(ownerPrivateRunUpdate(1001, 20, 42));
  const second = await handler.handleUpdate(ownerPrivateRunUpdate(1001, 20, 42));

  assert.equal(first.length > 0, true);
  assert.equal(second.length, 0);
  assert.equal(getCalls(), 1);
});
