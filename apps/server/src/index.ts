import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";

import Fastify from "fastify";
import type { StorageRepository } from "@ohmyremote/storage";
import { renderPrometheusMetrics } from "./metrics.js";

export * from "./orchestrator.js";
export {
  UploadService,
  UploadTooLargeError,
  ArchiveUploadRejectedError,
  SandboxViolationError as UploadSandboxViolationError,
  sanitizeFileName,
} from "./file-upload.js";
export {
  DownloadService,
  SandboxViolationError as DownloadSandboxViolationError,
} from "./file-download.js";

export interface RunEnqueueApi {
  enqueueRun(input: {
    projectId: string;
    sessionId: string;
    idempotencyKey: string;
    prompt: string;
    availableAt?: number;
  }): Promise<{ runId: string }>;
}

export interface ServerDependencies {
  repository: StorageRepository;
  runApi: RunEnqueueApi;
  basicAuthUser?: string;
  basicAuthPass?: string;
  webDistDir?: string;
}

function parseBasicAuth(header: string | undefined): { user: string; pass: string } | undefined {
  if (!header || !header.startsWith("Basic ")) {
    return undefined;
  }

  const encoded = header.slice("Basic ".length);
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return undefined;
  }

  return {
    user: decoded.slice(0, separator),
    pass: decoded.slice(separator + 1),
  };
}

export function createServer(deps: ServerDependencies) {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) {
      return;
    }

    const user = deps.basicAuthUser;
    const pass = deps.basicAuthPass;
    if (!user || !pass) {
      return;
    }

    const auth = parseBasicAuth(request.headers.authorization);
    if (!auth || auth.user !== user || auth.pass !== pass) {
      reply.header("WWW-Authenticate", 'Basic realm="dashboard"');
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const projects = await deps.repository.listProjects();
      for (const project of projects) {
        await access(project.rootPath);
      }

      return { ok: true };
    } catch (error) {
      reply.code(503);
      return { ok: false, error: String(error) };
    }
  });

  app.get("/", async (_request, reply) => {
    const distRoot = deps.webDistDir ?? path.resolve(process.cwd(), "apps/web/dist");
    const indexPath = path.join(distRoot, "index.html");

    try {
      const html = await readFile(indexPath, "utf8");
      reply.type("text/html; charset=utf-8");
      return html;
    } catch {
      reply.type("text/html; charset=utf-8");
      return "<!doctype html><html><body><h1>OhMyRemote Dashboard</h1><p>Build apps/web to serve full UI.</p></body></html>";
    }
  });

  app.get("/api/projects", async () => {
    return deps.repository.listProjects();
  });

  app.get("/metrics", async (_request, reply) => {
    const body = await renderPrometheusMetrics(deps.repository);
    reply.header("content-type", "text/plain; version=0.0.4");
    return body;
  });

  app.get<{ Querystring: { project_id?: string } }>("/api/sessions", async (request, reply) => {
    const projectId = request.query.project_id;
    if (!projectId) {
      reply.code(400);
      return { error: "project_id is required" };
    }

    return deps.repository.listSessionsByProject(projectId);
  });

  app.post<{
    Body: {
      projectId?: string;
      provider?: string;
      prompt?: string;
    };
  }>("/api/sessions", async (request, reply) => {
    const projectId = request.body.projectId;
    const provider = request.body.provider ?? "claude";
    if (!projectId) {
      reply.code(400);
      return { error: "projectId is required" };
    }

    const sessionId = randomUUID();
    await deps.repository.createSession({
      id: sessionId,
      projectId,
      provider,
      status: "active",
      prompt: request.body.prompt ?? "",
    });
    return { id: sessionId };
  });

  app.get<{ Querystring: { session_id?: string; limit?: string } }>("/api/runs", async (request, reply) => {
    const sessionId = request.query.session_id;
    if (!sessionId) {
      reply.code(400);
      return { error: "session_id is required" };
    }

    const limit = request.query.limit ? Number(request.query.limit) : 50;
    const rows = await deps.repository.listRunsBySession({ sessionId, limit });
    return rows.map((row) => ({
      ...row,
      summary: row.summaryJson ? JSON.parse(row.summaryJson) : null,
    }));
  });

  app.get<{ Params: { run_id: string } }>("/api/runs/:run_id", async (request, reply) => {
    const run = await deps.repository.getRunById(request.params.run_id);
    if (!run) {
      reply.code(404);
      return { error: "run not found" };
    }

    return {
      ...run,
      summary: run.summaryJson ? JSON.parse(run.summaryJson) : null,
    };
  });

  app.get<{
    Params: { run_id: string };
    Querystring: { min_seq?: string; limit?: string };
  }>("/api/runs/:run_id/events", async (request) => {
    const minSeq = request.query.min_seq ? Number(request.query.min_seq) : 1;
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    return deps.repository.listRunEventsPage({
      runId: request.params.run_id,
      minSeq,
      limit,
    });
  });

  app.get<{ Querystring: { session_id?: string; limit?: string } }>("/api/files", async (request, reply) => {
    const sessionId = request.query.session_id;
    if (!sessionId) {
      reply.code(400);
      return { error: "session_id is required" };
    }

    const limit = request.query.limit ? Number(request.query.limit) : 20;
    return deps.repository.listFileRecordsBySessionId({ sessionId, limit });
  });

  app.post<{
    Body: { projectId?: string; sessionId?: string; idempotencyKey?: string; prompt?: string };
  }>("/api/runs", async (request, reply) => {
    const projectId = request.body.projectId;
    const sessionId = request.body.sessionId;
    if (!projectId || !sessionId) {
      reply.code(400);
      return { error: "projectId and sessionId are required" };
    }

    const prompt = request.body.prompt?.trim();
    if (!prompt) {
      reply.code(400);
      return { error: "prompt is required" };
    }

    const idempotencyKey = request.body.idempotencyKey ?? `api:${sessionId}:${Date.now()}`;
    return deps.runApi.enqueueRun({ projectId, sessionId, idempotencyKey, prompt });
  });

  app.post<{ Params: { run_id: string } }>("/api/runs/:run_id/cancel", async (request) => {
    const now = Date.now();
    await deps.repository.cancelRun({ runId: request.params.run_id, now });
    return { ok: true };
  });

  return app;
}
