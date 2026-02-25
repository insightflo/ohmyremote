import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StorageRepository } from "@ohmyremote/storage";

export class UploadTooLargeError extends Error {
  public constructor(public readonly maxUploadBytes: number, public readonly actualBytes: number) {
    super(`upload size ${actualBytes} exceeds MAX_UPLOAD_BYTES=${maxUploadBytes}`);
    this.name = "UploadTooLargeError";
  }
}

export class SandboxViolationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

export class ArchiveUploadRejectedError extends Error {
  public constructor(public readonly originalName: string) {
    super(`archive uploads are rejected for safety: ${originalName}`);
    this.name = "ArchiveUploadRejectedError";
  }
}

export interface UploadInput {
  projectId: string;
  sessionId: string;
  originalName: string;
  bytes: Uint8Array;
}

export interface UploadResult {
  fileId: string;
  storedAbsPath: string;
  storedRelPath: string;
  sizeBytes: number;
  sha256: string;
}

export interface UploadServiceOptions {
  dataDir: string;
  maxUploadBytes: number;
  now?: () => number;
}

export class UploadService {
  private readonly now: () => number;

  public constructor(
    private readonly repository: StorageRepository,
    private readonly options: UploadServiceOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  public async storeUpload(input: UploadInput): Promise<UploadResult> {
    const sizeBytes = input.bytes.byteLength;
    if (sizeBytes > this.options.maxUploadBytes) {
      throw new UploadTooLargeError(this.options.maxUploadBytes, sizeBytes);
    }

    const safeName = sanitizeFileName(input.originalName);
    if (isArchiveName(safeName)) {
      throw new ArchiveUploadRejectedError(input.originalName);
    }
    const timestamp = this.now();
    const relDir = path.posix.join("uploads", input.projectId, input.sessionId);
    const relPath = path.posix.join(relDir, `${timestamp}-${safeName}`);

    const baseDir = path.resolve(this.options.dataDir);
    const absPath = path.resolve(baseDir, relPath);
    if (!absPath.startsWith(baseDir + path.sep)) {
      throw new SandboxViolationError("resolved path escapes data directory");
    }

    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, input.bytes);

    const written = await stat(absPath);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const fileId = randomUUID();

    await this.repository.createFileRecord({
      id: fileId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      direction: "upload",
      originalName: input.originalName,
      storedRelPath: relPath,
      sizeBytes: written.size,
      sha256,
      createdAt: timestamp,
    });

    return {
      fileId,
      storedAbsPath: absPath,
      storedRelPath: relPath,
      sizeBytes: written.size,
      sha256,
    };
  }

  public async listRecentUploads(projectId: string, sessionId: string, limit = 10) {
    return this.repository.listFileRecordsBySession({
      projectId,
      sessionId,
      direction: "upload",
      limit,
    });
  }
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  if (base.length === 0 || base === "." || base === "..") {
    return "upload.bin";
  }

  return base;
}

function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".zip") ||
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".gz") ||
    lower.endsWith(".rar") ||
    lower.endsWith(".7z")
  );
}
