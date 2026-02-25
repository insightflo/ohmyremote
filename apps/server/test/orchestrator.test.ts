import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedEngineEvent } from "@ohmyremote/core";
import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { RunOrchestrator, SessionAlreadyActiveError, type RunExecutor } from "../src/orchestrator.ts";

async function seed(repository: ReturnType<typeof createStorageRepository>): Promise<void> {
  await repository.createProject({
    id: "project-1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultEngine: "claude"
  });

  await repository.createSession({
    id: "session-1",
    projectId: "project-1",
    provider: "claude",
    status: "active",
    prompt: "Run task 8"
  });
}

test("processes leased job and persists sequential run events", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);

  const fixtureEvents: readonly NormalizedEngineEvent[] = [
    { type: "run_started" },
    { type: "text_delta", text: "hello" },
    { type: "tool_start", toolName: "read" },
    { type: "tool_end", toolName: "read" },
    { type: "run_finished", status: "success" }
  ];

  const executor: RunExecutor = {
    async execute() {
      return {
        events: fixtureEvents,
        exitStatus: "success",
        bytesIn: 100,
        bytesOut: 240
      };
    }
  };

  const orchestrator = new RunOrchestrator(repository, executor);

  try {
    await seed(repository);

    const { runId } = await orchestrator.enqueueRun({
      projectId: "project-1",
      sessionId: "session-1",
      idempotencyKey: "idem-1",
      prompt: "do stuff"
    });

    await assert.rejects(
      () =>
        orchestrator.enqueueRun({
          projectId: "project-1",
          sessionId: "session-1",
          idempotencyKey: "idem-2",
          prompt: "do other"
        }),
      (error) => error instanceof SessionAlreadyActiveError
    );

    const processed = await orchestrator.processNextLeasedJob({
      owner: "worker-1",
      leaseDurationMs: 30_000
    });

    assert.ok(processed);
    assert.equal(processed.runId, runId);
    assert.equal(processed.runStatus, "completed");
    assert.equal(processed.summary.toolCallsCount, 1);
    assert.equal(processed.summary.bytesIn, 100);
    assert.equal(processed.summary.bytesOut, 240);
    assert.ok(processed.summary.durationMs >= 0);

    const events = await repository.listRunEvents(runId);
    assert.equal(events.length, fixtureEvents.length);
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3, 4, 5]
    );
    assert.deepEqual(
      events.map((event) => event.eventType),
      fixtureEvents.map((event) => event.type)
    );

    const run = await repository.getRunById(runId);
    assert.equal(run?.status, "completed");
    assert.ok(run?.startedAt);
    assert.ok(run?.finishedAt);
    assert.ok(run?.summaryJson);

    const summary = JSON.parse(run.summaryJson ?? "{}");
    assert.equal(summary.duration_ms >= 0, true);
    assert.equal(summary.tool_calls_count, 1);
    assert.equal(summary.bytes_in, 100);
    assert.equal(summary.bytes_out, 240);
    assert.equal(summary.exit_status, "success");

    const job = await repository.getJobByRunId(runId);
    assert.equal(job?.status, "completed");
    assert.equal(job?.leaseOwner, null);
  } finally {
    storage.close();
  }
});
