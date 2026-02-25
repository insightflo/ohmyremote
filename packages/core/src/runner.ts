import { spawn } from 'node:child_process';
import { type Readable } from 'node:stream';

export type RunnerLifecycleStatus =
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'killing'
  | 'exited';

export interface RunnerLifecycleEvent {
  status: RunnerLifecycleStatus;
  sessionId: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface RunnerResult {
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
}

export interface RunnerStartOptions {
  sessionId: string;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cancelGraceMs?: number;
  onStdout?: (chunk: Buffer) => void | Promise<void>;
  onStderr?: (chunk: Buffer) => void | Promise<void>;
  onLifecycle?: (event: RunnerLifecycleEvent) => void;
}

export interface RunnerHandle {
  readonly sessionId: string;
  readonly pid: number;
  readonly result: Promise<RunnerResult>;
  cancel: () => void;
}

const DEFAULT_CANCEL_GRACE_MS = 1_000;

export class SingleFlightSessionError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} already has an active run`);
    this.name = 'SingleFlightSessionError';
  }
}

export class ProcessRunner {
  private readonly activeBySession = new Map<string, RunnerHandle>();

  start(options: RunnerStartOptions): RunnerHandle {
    const existing = this.activeBySession.get(options.sessionId);
    if (existing !== undefined) {
      throw new SingleFlightSessionError(options.sessionId);
    }

    options.onLifecycle?.({ status: 'starting', sessionId: options.sessionId });

    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (child.pid === undefined) {
      throw new Error(`failed to start process for session ${options.sessionId}`);
    }

    options.onLifecycle?.({
      status: 'running',
      sessionId: options.sessionId,
      pid: child.pid
    });

    let cancelRequested = false;
    let killEscalationTimer: NodeJS.Timeout | undefined;

    const clearEscalation = (): void => {
      if (killEscalationTimer !== undefined) {
        clearTimeout(killEscalationTimer);
        killEscalationTimer = undefined;
      }
    };

    attachBackpressureStream(child, 'stdout', options.onStdout);
    attachBackpressureStream(child, 'stderr', options.onStderr);

    const result = new Promise<RunnerResult>((resolve, reject) => {
      child.once('error', (error) => {
        clearEscalation();
        this.activeBySession.delete(options.sessionId);
        reject(error);
      });

      child.once('close', (exitCode, signal) => {
        clearEscalation();
        this.activeBySession.delete(options.sessionId);

        options.onLifecycle?.({
          status: 'exited',
          sessionId: options.sessionId,
          pid: child.pid,
          exitCode,
          signal
        });

        const status = cancelRequested
          ? 'cancelled'
          : exitCode === 0
            ? 'completed'
            : 'failed';

        resolve({
          sessionId: options.sessionId,
          status,
          exitCode,
          signal,
          cancelled: cancelRequested
        });
      });
    });

    const cancel = (): void => {
      if (cancelRequested || child.killed) {
        return;
      }

      cancelRequested = true;

      options.onLifecycle?.({
        status: 'cancelling',
        sessionId: options.sessionId,
        pid: child.pid
      });

      child.kill('SIGINT');

      const graceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
      killEscalationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          options.onLifecycle?.({
            status: 'killing',
            sessionId: options.sessionId,
            pid: child.pid
          });
          child.kill('SIGKILL');
        }
      }, graceMs);
      killEscalationTimer.unref();
    };

    const handle: RunnerHandle = {
      sessionId: options.sessionId,
      pid: child.pid,
      result,
      cancel
    };

    this.activeBySession.set(options.sessionId, handle);
    return handle;
  }

  cancelAll(): void {
    for (const handle of this.activeBySession.values()) {
      handle.cancel();
    }
  }

  get activeCount(): number {
    return this.activeBySession.size;
  }
}

function attachBackpressureStream(
  child: { stdout: Readable; stderr: Readable },
  source: 'stdout' | 'stderr',
  callback: ((chunk: Buffer) => void | Promise<void>) | undefined
): void {
  if (callback === undefined) {
    return;
  }

  const stream = source === 'stdout' ? child.stdout : child.stderr;

  stream.on('data', (chunk: Buffer) => {
    const maybePromise = callback(chunk);
    if (maybePromise === undefined) {
      return;
    }

    stream.pause();
    void maybePromise.finally(() => {
      if (!stream.destroyed) {
        stream.resume();
      }
    });
  });
}
