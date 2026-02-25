import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { UploadService, UploadTooLargeError } from "../src/file-upload.ts";

async function seed(repository: ReturnType<typeof createStorageRepository>): Promise<void> {
  await repository.createProject({
    id: "project-1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultEngine: "claude",
  });

  await repository.createSession({
    id: "session-1",
    projectId: "project-1",
    provider: "claude",
    status: "active",
    prompt: "",
  });
}

test("rejects oversized upload and does not write a file record", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ohmy-upload-"));

  try {
    await seed(repository);
    const service = new UploadService(repository, {
      dataDir: tmpDir,
      maxUploadBytes: 1,
      now: () => 1700000000000,
    });

    await assert.rejects(
      () =>
        service.storeUpload({
          projectId: "project-1",
          sessionId: "session-1",
          originalName: "a.txt",
          bytes: Buffer.from("xx"),
        }),
      (error) => error instanceof UploadTooLargeError
    );

    const records = await service.listRecentUploads("project-1", "session-1", 10);
    assert.equal(records.length, 0);
  } finally {
    storage.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});
