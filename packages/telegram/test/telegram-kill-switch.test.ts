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
  return {
    gateway: {
      async enqueueRun(_input) {
        calls += 1;
        return { runId: "run-1" };
      },
    },
    getCalls: () => calls,
  };
}

test("kill switch blocks run creation and returns maintenance message", async () => {
  const store = new MemoryStore();
  const { gateway, getCalls } = createRunGatewaySpy();

  const handler = new TelegramCommandHandler({
    ownerUserId: 42,
    store,
    runGateway: gateway,
    killSwitchDisableRuns: true,
  });

  const actions = await handler.handleUpdate({
    update_id: 10,
    message: {
      message_id: 99,
      text: "/run hello",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
    },
  });

  assert.equal(getCalls(), 0);
  assert.equal(actions.length, 1);
  assert.match(actions[0]?.text ?? "", /maintenance mode/i);
});

test("unsafe mode banner is included in follow-up replies before expiry", async () => {
  const store = new MemoryStore();
  const { gateway } = createRunGatewaySpy();

  const now = 1_700_000_000_000;
  const handler = new TelegramCommandHandler({
    ownerUserId: 42,
    store,
    runGateway: gateway,
    now: () => now,
  });

  const enabled = await handler.handleUpdate({
    update_id: 20,
    message: {
      message_id: 1,
      text: "/enable_unsafe 5",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
    },
  });
  assert.equal(enabled.length, 1);
  assert.match(enabled[0]?.text ?? "", /UNSAFE MODE/i);

  const status = await handler.handleUpdate({
    update_id: 21,
    message: {
      message_id: 2,
      text: "/status",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
    },
  });

  assert.equal(status.length, 1);
  assert.match(status[0]?.text ?? "", /^UNSAFE MODE/);
});

test("audit sink receives deny/allow decisions", async () => {
  const store = new MemoryStore();
  const { gateway } = createRunGatewaySpy();
  const records: Array<{ command: string; decision: string; reason?: string }> = [];

  const handler = new TelegramCommandHandler({
    ownerUserId: 42,
    store,
    runGateway: gateway,
    auditSink(record) {
      records.push({ command: record.command, decision: record.decision, reason: record.reason });
    },
  });

  await handler.handleUpdate({
    update_id: 30,
    message: {
      message_id: 1,
      text: "/run hi",
      chat: { id: 100, type: "private" },
      from: { id: 777 },
    },
  });

  await handler.handleUpdate({
    update_id: 31,
    message: {
      message_id: 2,
      text: "/run hi",
      chat: { id: 100, type: "private" },
      from: { id: 42 },
    },
  });

  assert.equal(records.some((record) => record.decision === "deny" && record.reason === "non-owner"), true);
  assert.equal(records.some((record) => record.decision === "allow" && record.command === "run"), true);
});
