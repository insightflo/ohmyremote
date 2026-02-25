import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { createServer } from "../src/index.ts";

test("api basic auth is enforced when configured", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "ohmy-api-auth-"));

  const app = createServer({
    repository,
    runApi: {
      async enqueueRun(_input) {
        return { runId: "run-1" };
      },
    },
    basicAuthUser: "u",
    basicAuthPass: "p",
  });

  try {
    await repository.createProject({
      id: "project-1",
      name: "Demo",
      rootPath: projectRoot,
      defaultEngine: "claude",
    });

    const unauthorized = await app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(unauthorized.statusCode, 401);

    const authHeader = `Basic ${Buffer.from("u:p").toString("base64")}`;
    const authorized = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: authHeader },
    });
    assert.equal(authorized.statusCode, 200);
  } finally {
    await app.close();
    storage.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
