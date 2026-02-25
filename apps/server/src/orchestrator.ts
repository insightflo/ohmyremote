import { randomUUID } from "node:crypto";

import type { NormalizedEngineEvent } from "@ohmyremote/core";
import type { StorageRepository } from "@ohmyremote/storage";

export type RunExitStatus = "success" | "error" | "cancelled";

export interface RunSummary {
  durationMs: number;
  toolCallsCount: number;
  bytesIn: number;
  bytesOut: number;
  exitStatus: RunExitStatus;
}

export interface RunExecutorResult {
  events: readonly NormalizedEngineEvent[];
  exitStatus: RunExitStatus;
  bytesIn?: number;
  bytesOut?: number;
  eventsPersisted?: boolean;
}

export interface RunExecutorInput {
  runId: string;
  projectId: string;
  sessionId: string;
  provider: string;
  prompt: string;
}

export interface RunExecutor {
  execute(input: RunExecutorInput): Promise<RunExecutorResult>;
}

export interface CreateRunInput {
  projectId: string;
  sessionId: string;
  idempotencyKey: string;
  prompt: string;
  availableAt?: number;
}

export interface EnqueueRunResult {
  runId: string;
}

export interface ProcessJobInput {
  owner: string;
  now?: number;
  leaseDurationMs: number;
}

export interface ProcessedRunResult {
  runId: string;
  jobId: string;
  runStatus: string;
  summary: RunSummary;
}

export interface ReconcileInput {
  now?: number;
  staleBeforeMs?: number;
}

export interface ReconcileResult {
  abandonedRunIds: string[];
  requeuedJobCount: number;
}

export class SessionAlreadyActiveError extends Error {
  public constructor(sessionId: string) {
    super(`session ${sessionId} already has an active run`);
    this.name = "SessionAlreadyActiveError";
  }
}

export class RunOrchestrator {
  private readonly activeSessions = new Set<string>();

  public constructor(
    private readonly repository: StorageRepository,
    private readonly executor: RunExecutor
  ) {}

  public async createRun(input: CreateRunInput): Promise<EnqueueRunResult> {
    const existing = await this.repository.getRunByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { runId: existing.id };
    }

    await this.assertSessionSingleFlight(input.sessionId);

    const runId = randomUUID();
    const jobId = randomUUID();
    const now = Date.now();

    await this.repository.createRun({
      id: runId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      prompt: input.prompt,
      status: "queued"
    });

    await this.repository.enqueueJob({
      id: jobId,
      runId,
      availableAt: input.availableAt ?? now
    });

    return { runId };
  }

  public async enqueueRun(input: CreateRunInput): Promise<EnqueueRunResult> {
    return this.createRun(input);
  }

  public async processNextLeasedJob(input: ProcessJobInput): Promise<ProcessedRunResult | undefined> {
    const now = input.now ?? Date.now();
    const leasedJob = await this.repository.leaseNextJob({
      owner: input.owner,
      now,
      leaseDurationMs: input.leaseDurationMs
    });

    if (!leasedJob) {
      return undefined;
    }

    const run = await this.repository.getRunById(leasedJob.runId);
    if (!run) {
      await this.repository.failJob({
        jobId: leasedJob.id,
        now,
        error: "missing run for leased job"
      });
      return undefined;
    }

    if (this.activeSessions.has(run.sessionId)) {
      await this.repository.requeueLeasedJobByRunId({ runId: run.id, now });
      return undefined;
    }

    const session = await this.repository.getSessionById(run.sessionId);
    if (!session) {
      await this.repository.failJob({
        jobId: leasedJob.id,
        now,
        error: "missing session for run"
      });
      await this.repository.finalizeRun({
        runId: run.id,
        status: "failed",
        finishedAt: now,
        summaryJson: JSON.stringify({
          duration_ms: 0,
          tool_calls_count: 0,
          bytes_in: 0,
          bytes_out: 0,
          exit_status: "error"
        })
      });
      return undefined;
    }

    this.activeSessions.add(run.sessionId);
    const startedAt = Date.now();

    try {
      await this.repository.markRunInFlight({ runId: run.id, startedAt });

      const result = await this.executor.execute({
        runId: run.id,
        projectId: run.projectId,
        sessionId: run.sessionId,
        provider: session.provider,
        prompt: run.prompt
      });

      if (result.eventsPersisted !== true) {
        for (const event of result.events) {
          await this.repository.appendRunEvent({
            id: randomUUID(),
            runId: run.id,
            eventType: event.type,
            payloadJson: JSON.stringify(event),
            createdAt: Date.now()
          });
        }
      }

      const finishedAt = Date.now();
      const summary = deriveRunSummary({
        startedAt,
        finishedAt,
        events: result.events,
        exitStatus: result.exitStatus,
        bytesIn: result.bytesIn,
        bytesOut: result.bytesOut
      });
      const runStatus = mapExitStatusToRunStatus(result.exitStatus);

      await this.repository.finalizeRun({
        runId: run.id,
        status: runStatus,
        finishedAt,
        summaryJson: JSON.stringify({
          duration_ms: summary.durationMs,
          tool_calls_count: summary.toolCallsCount,
          bytes_in: summary.bytesIn,
          bytes_out: summary.bytesOut,
          exit_status: summary.exitStatus
        })
      });

      await this.repository.completeJob({ jobId: leasedJob.id, now: finishedAt });

      return {
        runId: run.id,
        jobId: leasedJob.id,
        runStatus,
        summary
      };
    } catch (error) {
      const finishedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);

      await this.repository.appendRunEvent({
        id: randomUUID(),
        runId: run.id,
        eventType: "error",
        payloadJson: JSON.stringify({ type: "error", message }),
        createdAt: finishedAt
      });

      await this.repository.finalizeRun({
        runId: run.id,
        status: "failed",
        finishedAt,
        summaryJson: JSON.stringify({
          duration_ms: Math.max(0, finishedAt - startedAt),
          tool_calls_count: 0,
          bytes_in: 0,
          bytes_out: 0,
          exit_status: "error"
        })
      });

      await this.repository.failJob({ jobId: leasedJob.id, now: finishedAt, error: message });
      throw error;
    } finally {
      this.activeSessions.delete(run.sessionId);
    }
  }

  public async reconcileInFlightRuns(input: ReconcileInput = {}): Promise<ReconcileResult> {
    const now = input.now ?? Date.now();
    const staleBeforeMs = input.staleBeforeMs ?? 0;
    const inFlightRuns = await this.repository.listRunsByStatus("in_flight");

    const staleRuns = inFlightRuns.filter((run) => {
      if (staleBeforeMs <= 0) {
        return true;
      }

      const startedAt = run.startedAt ?? run.updatedAt;
      return now - startedAt >= staleBeforeMs;
    });

    let requeuedJobCount = 0;
    const abandonedRunIds: string[] = [];

    for (const run of staleRuns) {
      await this.repository.abandonRun({ runId: run.id, finishedAt: now });
      await this.repository.requeueLeasedJobByRunId({ runId: run.id, now });
      abandonedRunIds.push(run.id);

      const job = await this.repository.getJobByRunId(run.id);
      if (job?.status === "queued") {
        requeuedJobCount += 1;
      }
    }

    return {
      abandonedRunIds,
      requeuedJobCount
    };
  }

  private async assertSessionSingleFlight(sessionId: string): Promise<void> {
    if (this.activeSessions.has(sessionId)) {
      throw new SessionAlreadyActiveError(sessionId);
    }

    const activeRun = await this.repository.findActiveRunBySession(sessionId);
    if (activeRun) {
      throw new SessionAlreadyActiveError(sessionId);
    }
  }
}

function mapExitStatusToRunStatus(exitStatus: RunExitStatus): string {
  switch (exitStatus) {
    case "success":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

function deriveRunSummary(input: {
  startedAt: number;
  finishedAt: number;
  events: readonly NormalizedEngineEvent[];
  exitStatus: RunExitStatus;
  bytesIn?: number;
  bytesOut?: number;
}): RunSummary {
  const encoder = new TextEncoder();
  const durationMs = Math.max(0, input.finishedAt - input.startedAt);
  const toolCallsCount = input.events.filter((event) => event.type === "tool_start").length;

  const inferredBytesOut = input.events.reduce((total, event) => {
    return total + encoder.encode(JSON.stringify(event)).byteLength;
  }, 0);

  return {
    durationMs,
    toolCallsCount,
    bytesIn: input.bytesIn ?? 0,
    bytesOut: input.bytesOut ?? inferredBytesOut,
    exitStatus: input.exitStatus
  };
}
