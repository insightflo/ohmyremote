import assert from "node:assert/strict";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "../src/index.js";

async function seedProjectData(
  repository: ReturnType<typeof createStorageRepository>
): Promise<void> {
  await repository.createProject({
    id: "project-1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultEngine: "claude"
  });

  await repository.createChat({
    id: "chat-1",
    projectId: "project-1",
    externalChatId: "telegram:1001",
    title: "Main"
  });

  await repository.createSession({
    id: "session-1",
    projectId: "project-1",
    chatId: "chat-1",
    provider: "claude",
    status: "active",
    prompt: "hello"
  });
}

test("creates schema and supports insert/read through repository", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);

  try {
    await seedProjectData(repository);

    await repository.createRun({
      id: "run-1",
      projectId: "project-1",
      sessionId: "session-1",
      idempotencyKey: "idem-1",
      prompt: "hello",
      status: "running"
    });

    await repository.appendRunEvent({
      id: "evt-1",
      runId: "run-1",
      eventType: "stdout",
      payloadJson: JSON.stringify({ chunk: "hello" })
    });

    const project = await repository.getProject("project-1");
    const run = await repository.getRunByIdempotencyKey("idem-1");
    const events = await repository.listRunEvents("run-1");

    assert.equal(project?.name, "Demo");
    assert.equal(run?.id, "run-1");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.seq, 1);
    assert.equal(events[0]?.eventType, "stdout");
  } finally {
    storage.close();
  }
});

test("enforces unique runs.idempotency_key", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);

  try {
    await seedProjectData(repository);

    await repository.createRun({
      id: "run-1",
      projectId: "project-1",
      sessionId: "session-1",
      idempotencyKey: "idem-duplicate",
      prompt: "hello",
      status: "running"
    });

    await assert.rejects(
      () =>
        repository.createRun({
          id: "run-2",
          projectId: "project-1",
          sessionId: "session-1",
          idempotencyKey: "idem-duplicate",
          prompt: "hello",
          status: "queued"
        }),
      (error) => {
        if (!(error instanceof Error)) {
          return false;
        }

        if (!error.message.includes("Failed query")) {
          return false;
        }

        const maybeCause = (error as Error & { cause?: unknown }).cause;
        return String(maybeCause ?? "").includes("UNIQUE constraint failed: runs.idempotency_key");
      }
    );
  } finally {
    storage.close();
  }
});
