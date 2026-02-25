import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

test("denies symlink download paths with SANDBOX_VIOLATION", async () => {
  const storage = createSqliteStorageDatabase();
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "ohmy-symlink-"));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "ohmy-outside-"));

  try {
    await seed(repository);
    const outsideFile = path.join(outsideDir, "outside.txt");
    writeFileSync(outsideFile, "outside");
    symlinkSync(outsideFile, path.join(projectRoot, "link.txt"));

    const service = new DownloadService(repository);

    await assert.rejects(
      () =>
        service.readDownload({
          projectId: "project-1",
          sessionId: "session-1",
          projectRoot,
          requestPath: "link.txt",
        }),
      (error) => {
        return error instanceof SandboxViolationError && error.code === "SANDBOX_VIOLATION";
      }
    );
  } finally {
    storage.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
