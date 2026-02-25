import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { createServer } from "../src/index.ts";

test("metrics endpoint emits prometheus metrics", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "ohmy-metrics-"));

  const app = createServer({
    repository,
    runApi: {
      async enqueueRun(_input) {
        return { runId: "run-api" };
      },
    },
  });

  try {
    await repository.createProject({
      id: "project-1",
      name: "Demo",
      rootPath: projectRoot,
      defaultEngine: "claude",
    });
    await repository.createSession({
      id: "session-1",
      projectId: "project-1",
      provider: "claude",
      status: "active",
      prompt: "hello",
    });
    await repository.createRun({
      id: "run-1",
      projectId: "project-1",
      sessionId: "session-1",
      idempotencyKey: "idemp-1",
      prompt: "hello",
      status: "completed",
      startedAt: 1_000,
      summaryJson: JSON.stringify({ duration_ms: 1200, bytes_in: 10, bytes_out: 40 }),
    });
    await repository.finalizeRun({
      runId: "run-1",
      status: "completed",
      finishedAt: 2_500,
      summaryJson: JSON.stringify({ duration_ms: 1200, bytes_in: 10, bytes_out: 40 }),
    });
    await repository.createFileRecord({
      id: "file-1",
      projectId: "project-1",
      sessionId: "session-1",
      direction: "upload",
      originalName: "a.txt",
      storedRelPath: "uploads/a.txt",
      sizeBytes: 12,
      sha256: "x",
    });
    await repository.insertTelegramInbox({
      updateId: 100,
      chatId: "chat-1",
      payloadJson: JSON.stringify({ message: { text: "hello" } }),
    });

    const response = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /runs_total\{engine="claude",status="completed"\}/);
    assert.match(response.body, /run_duration_seconds_count\{engine="claude"\}/);
    assert.match(response.body, /file_bytes_total\{direction="upload"\}/);
    assert.match(response.body, /telegram_updates_total\{type="message"\}/);
  } finally {
    await app.close();
    storage.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
