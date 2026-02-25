import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { UploadService } from "../src/file-upload.ts";

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

test("stores upload in sandbox and records sha256 + size", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ohmy-upload-"));

  try {
    await seed(repository);
    const service = new UploadService(repository, {
      dataDir: tmpDir,
      maxUploadBytes: 1024,
      now: () => 1700000000000,
    });

    const result = await service.storeUpload({
      projectId: "project-1",
      sessionId: "session-1",
      originalName: "../../evil.txt",
      bytes: Buffer.from("hello upload"),
    });

    assert.equal(result.storedRelPath.includes(".."), false);
    assert.equal(result.sizeBytes, Buffer.byteLength("hello upload"));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);

    const records = await service.listRecentUploads("project-1", "session-1", 10);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.sizeBytes, Buffer.byteLength("hello upload"));
    assert.equal(records[0]?.sha256, result.sha256);
    assert.equal(records[0]?.direction, "upload");
  } finally {
    storage.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});
