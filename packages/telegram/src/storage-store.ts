import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { StorageRepository } from "@ohmyremote/storage";

import type { CliSessionInfo, CliSessionPeek, OpenCodeConfig, TelegramDataStore } from "./handler.js";

function rootPathToClaudeProjectDir(rootPath: string): string {
  return rootPath.replace(/\//g, "-");
}

async function findClaudeProjectDir(projectRootPath: string): Promise<string | null> {
  const claudeProjectsDir = path.join(homedir(), ".claude", "projects");

  // Try exact match first
  const exact = path.join(claudeProjectsDir, rootPathToClaudeProjectDir(projectRootPath));
  try {
    const s = await stat(exact);
    if (s.isDirectory()) return exact;
  } catch { /* not found */ }

  // Scan for fuzzy match — directory name contains the last path segments
  try {
    const dirs = await readdir(claudeProjectsDir);
    // Normalize: /home/user/projects/myapp → home-user-projects-myapp
    const normalized = rootPathToClaudeProjectDir(projectRootPath).toLowerCase();
    for (const dir of dirs) {
      if (dir.toLowerCase() === normalized) {
        return path.join(claudeProjectsDir, dir);
      }
    }
    // Partial match: last 2 segments
    const segments = projectRootPath.split("/").filter(Boolean);
    const tail = segments.slice(-2).join("-").toLowerCase();
    for (const dir of dirs) {
      if (dir.toLowerCase().endsWith(tail)) {
        return path.join(claudeProjectsDir, dir);
      }
    }
  } catch { /* can't scan */ }

  return null;
}

async function scanCliSessions(projectRootPath: string, limit: number): Promise<CliSessionInfo[]> {
  const sessionDir = await findClaudeProjectDir(projectRootPath);
  if (!sessionDir) return [];

  let files: string[];
  try {
    files = await readdir(sessionDir);
  } catch {
    return [];
  }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  // Get file stats for sorting by modification time
  const fileStats: Array<{ name: string; sessionId: string; mtimeMs: number }> = [];
  for (const f of jsonlFiles) {
    try {
      const s = await stat(path.join(sessionDir, f));
      fileStats.push({
        name: f,
        sessionId: f.replace(".jsonl", ""),
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // skip
    }
  }

  // Sort by most recent first
  fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const results: CliSessionInfo[] = [];
  for (const entry of fileStats.slice(0, limit)) {
    const filePath = path.join(sessionDir, entry.name);
    const info = await extractSessionInfo(filePath, entry.sessionId, entry.mtimeMs);
    if (info) {
      results.push(info);
    }
  }

  return results;
}

async function extractSessionInfo(
  filePath: string,
  sessionId: string,
  mtimeMs: number,
): Promise<CliSessionInfo | null> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    let firstPrompt = "";
    let lastActivity = mtimeMs;

    for await (const line of rl) {
      if (!line.includes('"type":"user"')) continue;

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type !== "user") continue;

        const message = parsed.message as Record<string, unknown> | undefined;
        const content = message?.content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content.find((b: Record<string, unknown>) => b.type === "text") as Record<string, unknown> | undefined)?.text as string ?? ""
            : "";

        if (!firstPrompt && text.length > 0) {
          firstPrompt = text;
        }

        if (parsed.timestamp) {
          const ts = new Date(parsed.timestamp as string).getTime();
          if (ts > lastActivity) lastActivity = ts;
        }
      } catch {
        // skip malformed lines
      }
    }

    if (!firstPrompt) {
      firstPrompt = "(empty session)";
    }

    return { sessionId, firstPrompt, lastActivity };
  } catch {
    return null;
  }
}

async function peekCliSessionImpl(
  projectRootPath: string,
  sessionId: string,
  tailCount: number,
): Promise<CliSessionPeek | null> {
  const sessionDir = await findClaudeProjectDir(projectRootPath);
  if (!sessionDir) return null;

  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  try {
    await stat(filePath);
  } catch {
    return null;
  }

  // Read file in reverse to get last N meaningful entries
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);

  const entries: CliSessionPeek["entries"] = [];
  // Scan from end
  for (let i = lines.length - 1; i >= 0 && entries.length < tailCount; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      const type = parsed.type as string;
      const timestamp = parsed.timestamp as string | undefined;
      const timeStr = timestamp
        ? new Date(timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
        : "";

      if (type === "user") {
        const message = parsed.message as Record<string, unknown> | undefined;
        const content = message?.content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? ((content as Array<Record<string, unknown>>).find((b) => b.type === "text") as Record<string, unknown> | undefined)?.text as string ?? ""
            : "";
        if (text) {
          entries.push({ type: "user", timestamp: timeStr, summary: text.slice(0, 80) + (text.length > 80 ? "…" : "") });
        }
      } else if (type === "assistant") {
        const message = parsed.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (Array.isArray(content)) {
          const textBlock = (content as Array<Record<string, unknown>>).find((b) => b.type === "text");
          if (textBlock) {
            const text = textBlock.text as string;
            entries.push({ type: "assistant", timestamp: timeStr, summary: text.slice(0, 80) + (text.length > 80 ? "…" : "") });
          }
          const toolBlocks = (content as Array<Record<string, unknown>>).filter((b) => b.type === "tool_use");
          for (const tb of toolBlocks) {
            entries.push({ type: "tool_use", timestamp: timeStr, summary: `${tb.name as string ?? "tool"}(…)` });
          }
        }
      } else if (type === "tool_result" || type === "direct") {
        // skip noise
      } else if (type === "progress" || type === "hook_progress" || type === "bash_progress" || type === "agent_progress" || type === "mcp_progress") {
        // skip progress events
      } else if (type === "file-history-snapshot" || type === "queue-operation" || type === "thinking") {
        // skip
      } else if (type === "system") {
        const subtype = parsed.subtype as string | undefined;
        const sysContent = parsed.content as string | undefined;
        if (subtype && sysContent) {
          entries.push({ type: "system", timestamp: timeStr, summary: sysContent.slice(0, 60) + (sysContent.length > 60 ? "…" : "") });
        }
      }
    } catch {
      // skip malformed
    }
  }

  // Reverse to chronological order
  entries.reverse();

  return { sessionId, entries };
}

async function loadOpenCodeConfigImpl(): Promise<OpenCodeConfig> {
  const configDir = path.join(homedir(), ".config", "opencode");
  const result: OpenCodeConfig = { models: [], agents: [], categories: [] };

  // Read models from opencode.json providers
  try {
    const raw = await readFile(path.join(configDir, "opencode.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const providers = config.provider as Record<string, Record<string, unknown>> | undefined;
    if (providers) {
      for (const [providerId, provider] of Object.entries(providers)) {
        const models = provider.models as Record<string, Record<string, unknown>> | undefined;
        if (!models) continue;
        for (const [modelId, model] of Object.entries(models)) {
          const name = (model.name as string) ?? modelId;
          result.models.push({ label: name, value: `${providerId}/${modelId}` });
        }
      }
    }
  } catch { /* config not found */ }

  // Read agents and categories from oh-my-opencode.json
  try {
    const raw = await readFile(path.join(configDir, "oh-my-opencode.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const agents = config.agents as Record<string, Record<string, unknown>> | undefined;
    if (agents) {
      for (const name of Object.keys(agents)) {
        result.agents.push({ label: name, value: name });
      }
    }
    const categories = config.categories as Record<string, Record<string, unknown>> | undefined;
    if (categories) {
      for (const name of Object.keys(categories)) {
        result.categories.push({ label: name, value: `category:${name}` });
      }
    }
  } catch { /* config not found */ }

  return result;
}

export function createTelegramDataStore(repository: StorageRepository): TelegramDataStore {
  return {
    insertTelegramInbox(input) {
      return repository.insertTelegramInbox(input);
    },
    async listProjects() {
      const projects = await repository.listProjects();
      return projects.map((project) => ({ id: project.id, name: project.name, rootPath: project.rootPath }));
    },
    async listSessionsByProject(projectId) {
      const sessions = await repository.listSessionsByProject(projectId);
      const results = [];
      for (const session of sessions) {
        const recentRuns = await repository.listRunsBySession({ sessionId: session.id, limit: 1 });
        const lastRun = recentRuns[0];
        results.push({
          id: session.id,
          projectId: session.projectId,
          provider: session.provider,
          prompt: session.prompt || undefined,
          lastRunPrompt: lastRun?.prompt,
          lastRunAt: lastRun?.createdAt,
        });
      }
      return results;
    },
    async createSession(input) {
      if (input.chatId) {
        await repository.upsertChatByExternalChatId({
          externalChatId: input.chatId,
          projectId: input.projectId,
        });
      }
      return repository.createSession(input);
    },
    async getSessionById(sessionId) {
      const session = await repository.getSessionById(sessionId);
      if (!session) {
        return undefined;
      }

      return {
        id: session.id,
        projectId: session.projectId,
        provider: session.provider,
        engineSessionId: session.engineSessionId,
      };
    },
    async setSessionEngineSessionId(sessionId, engineSessionId) {
      await repository.setSessionEngineSessionId({ sessionId, engineSessionId });
    },
    getUnsafeUntil(chatId) {
      return repository.getChatUnsafeUntil(chatId);
    },
    async setUnsafeUntil(chatId, unsafeUntil) {
      const projects = await repository.listProjects();
      const fallbackProjectId = projects[0]?.id;
      if (!fallbackProjectId) {
        return;
      }

      await repository.upsertChatByExternalChatId({
        externalChatId: chatId,
        projectId: fallbackProjectId,
      });
      await repository.setChatUnsafeUntil({ externalChatId: chatId, unsafeUntil });
    },
    async clearUnsafeUntil(chatId) {
      await repository.setChatUnsafeUntil({ externalChatId: chatId, unsafeUntil: null });
    },
    async listRecentUploads(projectId, sessionId, limit) {
      const rows = await repository.listFileRecordsBySession({
        projectId,
        sessionId,
        direction: "upload",
        limit,
      });
      return rows.map((row) => ({
        originalName: row.originalName,
        storedRelPath: row.storedRelPath,
        sizeBytes: row.sizeBytes,
      }));
    },
    async listCliSessions(projectRootPath, limit) {
      return scanCliSessions(projectRootPath, limit);
    },
    async peekCliSession(projectRootPath, sessionId, tailCount) {
      return peekCliSessionImpl(projectRootPath, sessionId, tailCount);
    },
    async loadOpenCodeConfig() {
      return loadOpenCodeConfigImpl();
    },
  };
}
