import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { DownloadService, SandboxViolationError } from "../src/file-download.ts";

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

test("allows in-root downloads and blocks traversal with SANDBOX_VIOLATION", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "ohmy-download-"));

  try {
    await seed(repository);
    writeFileSync(path.join(projectRoot, "notes.txt"), "hello");

    const service = new DownloadService(repository, { now: () => 1700000000000 });

    const ok = await service.readDownload({
      projectId: "project-1",
      sessionId: "session-1",
      projectRoot,
      requestPath: "notes.txt",
    });

    assert.equal(ok.sizeBytes, 5);
    assert.equal(ok.content.toString("utf8"), "hello");

    await assert.rejects(
      () =>
        service.readDownload({
          projectId: "project-1",
          sessionId: "session-1",
          projectRoot,
          requestPath: "../../../etc/passwd",
        }),
      (error) => {
        return error instanceof SandboxViolationError && error.code === "SANDBOX_VIOLATION";
      }
    );
  } finally {
    storage.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
