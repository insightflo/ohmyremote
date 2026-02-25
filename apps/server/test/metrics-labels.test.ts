import assert from "node:assert/strict";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { createServer } from "../src/index.ts";

test("metrics do not include high-cardinality session_id/chat_id labels", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);

  const app = createServer({
    repository,
    runApi: {
      async enqueueRun(_input) {
        return { runId: "run-api" };
      },
    },
  });

  try {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes("session_id="), false);
    assert.equal(response.body.includes("chat_id="), false);
  } finally {
    await app.close();
    storage.close();
  }
});
