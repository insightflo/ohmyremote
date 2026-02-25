import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { StorageRepository } from "@ohmyremote/storage";

export class SandboxViolationError extends Error {
  public readonly code = "SANDBOX_VIOLATION";

  public constructor(message: string) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

export interface DownloadInput {
  projectId: string;
  sessionId: string;
  projectRoot: string;
  requestPath: string;
}

export interface DownloadResult {
  absPath: string;
  content: Buffer;
  sizeBytes: number;
}

export interface DownloadServiceOptions {
  now?: () => number;
}

export class DownloadService {
  private readonly now: () => number;

  public constructor(
    private readonly repository: StorageRepository,
    options: DownloadServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  public async readDownload(input: DownloadInput): Promise<DownloadResult> {
    if (path.isAbsolute(input.requestPath)) {
      throw new SandboxViolationError("absolute path is not allowed");
    }

    const root = await realpath(input.projectRoot);
    const candidate = path.resolve(root, input.requestPath);
    if (!candidate.startsWith(root + path.sep)) {
      throw new SandboxViolationError("path traversal blocked");
    }

    await assertNoSymlink(root, candidate);

    const data = await readFile(candidate);
    const fileInfo = await lstat(candidate);
    const sha256 = createHash("sha256").update(data).digest("hex");

    const relPath = path.relative(root, candidate);
    await this.repository.createFileRecord({
      id: randomUUID(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      direction: "download",
      originalName: path.basename(candidate),
      storedRelPath: relPath,
      sizeBytes: fileInfo.size,
      sha256,
      createdAt: this.now(),
    });

    return {
      absPath: candidate,
      content: data,
      sizeBytes: fileInfo.size,
    };
  }
}

async function assertNoSymlink(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);

  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new SandboxViolationError("symlink path is not allowed");
    }
  }
}
