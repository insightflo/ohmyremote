import assert from "node:assert/strict";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { RunOrchestrator, type RunExecutor } from "../src/orchestrator.ts";

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

test("reconciles stale in-flight runs and requeues leased jobs", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);

  const executor: RunExecutor = {
    async execute() {
      return {
        events: [],
        exitStatus: "success"
      };
    }
  };

  const orchestrator = new RunOrchestrator(repository, executor);

  try {
    await seed(repository);

    await repository.createRun({
      id: "run-1",
      projectId: "project-1",
      sessionId: "session-1",
      idempotencyKey: "idem-reconcile",
      prompt: "reconcile",
      status: "queued"
    });

    await repository.enqueueJob({
      id: "job-1",
      runId: "run-1",
      availableAt: 1
    });

    const leased = await repository.leaseNextJob({
      owner: "worker-1",
      now: 5,
      leaseDurationMs: 1_000
    });
    assert.equal(leased?.status, "leased");

    await repository.markRunInFlight({ runId: "run-1", startedAt: 2 });

    const result = await orchestrator.reconcileInFlightRuns({
      now: 2_000,
      staleBeforeMs: 1
    });

    assert.deepEqual(result.abandonedRunIds, ["run-1"]);
    assert.equal(result.requeuedJobCount, 1);

    const run = await repository.getRunById("run-1");
    assert.equal(run?.status, "abandoned");
    assert.equal(run?.finishedAt, 2_000);

    const job = await repository.getJobByRunId("run-1");
    assert.equal(job?.status, "queued");
    assert.equal(job?.leaseOwner, null);
    assert.equal(job?.leaseExpiresAt, null);
    assert.equal(job?.availableAt, 2_000);
  } finally {
    storage.close();
  }
});
