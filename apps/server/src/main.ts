import path from "node:path";
import { mkdir } from "node:fs/promises";

import { applySchema, createSqliteStorageDatabase, createStorageRepository } from "@ohmyremote/storage";

import { loadConfig } from "./config.js";
import { createServer } from "./index.js";
import { RunOrchestrator, type RunExecutor } from "./orchestrator.js";

const executor: RunExecutor = {
  async execute() {
    return {
      events: [
        { type: "run_started", timestamp: new Date().toISOString() },
        { type: "run_finished", status: "success" },
      ],
      exitStatus: "success",
    };
  },
};

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(path.resolve(config.DATA_DIR), { recursive: true });
  const dbPath = path.resolve(config.DATA_DIR, "ohmyremote.sqlite");
  const storage = createSqliteStorageDatabase(dbPath);
  applySchema(storage.sqlite);
  const repository = createStorageRepository(storage.db);

  for (const project of config.projects) {
    const existing = await repository.getProject(project.id);
    if (!existing) {
      await repository.createProject({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        defaultEngine: project.defaultEngine,
        opencodeAttachUrl: project.opencodeAttachUrl ?? null,
      });
    }
  }

  const orchestrator = new RunOrchestrator(repository, executor);
  const app = createServer({
    repository,
    runApi: {
      enqueueRun(input) {
        return orchestrator.enqueueRun(input);
      },
    },
    basicAuthUser: config.DASHBOARD_BASIC_AUTH_USER,
    basicAuthPass: config.DASHBOARD_BASIC_AUTH_PASS,
  });

  await app.listen({
    host: config.DASHBOARD_BIND_HOST,
    port: config.DASHBOARD_PORT,
  });
}

void main();
