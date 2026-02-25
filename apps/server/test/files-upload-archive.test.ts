import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { ArchiveUploadRejectedError, UploadService } from "../src/file-upload.ts";

test("rejects archive uploads to avoid zip-bomb style inputs", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ohmy-upload-archive-"));
  const uploadService = new UploadService(repository, {
    dataDir: tmpRoot,
    maxUploadBytes: 1024 * 1024,
  });

  try {
    await assert.rejects(
      uploadService.storeUpload({
        projectId: "project-1",
        sessionId: "session-1",
        originalName: "bundle.zip",
        bytes: new Uint8Array([1, 2, 3]),
      }),
      (error) => error instanceof ArchiveUploadRejectedError,
    );

    const files = await repository.listFileRecordsBySession({
      projectId: "project-1",
      sessionId: "session-1",
      direction: "upload",
      limit: 10,
    });
    assert.equal(files.length, 0);
  } finally {
    storage.close();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
