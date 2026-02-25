import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { createServer } from "../src/index.ts";

test("api smoke: healthz and projects endpoint", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "ohmy-api-smoke-"));

  const app = createServer({
    repository,
    runApi: {
      async enqueueRun(_input) {
        return { runId: "run-1" };
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

    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);

    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(projects.statusCode, 200);
    const body = projects.json() as Array<{ id: string }>;
    assert.equal(body.length, 1);
    assert.equal(body[0]?.id, "project-1");
  } finally {
    await app.close();
    storage.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
