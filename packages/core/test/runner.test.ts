import assert from 'node:assert/strict';
import test from 'node:test';

import { ProcessRunner, SingleFlightSessionError } from '../src/index.js';

const LONG_RUNNING_SCRIPT = 'setInterval(() => {}, 10_000);';
const IGNORE_SIGINT_SCRIPT = `
  process.on('SIGINT', () => {});
  process.stdout.write('READY\\n');
  setInterval(() => {}, 10_000);
`;

test('cancel stops long-running process and marks cancelled', async () => {
  const runner = new ProcessRunner();
  const lifecycleStatuses: string[] = [];

  const handle = runner.start({
    sessionId: 'session-cancel',
    command: process.execPath,
    args: ['-e', LONG_RUNNING_SCRIPT],
    onLifecycle: (event) => {
      lifecycleStatuses.push(event.status);
    }
  });

  await delay(40);
  handle.cancel();

  const result = await handle.result;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancelled, true);
  assert.ok(result.signal === 'SIGINT' || result.signal === 'SIGKILL');
  assert.ok(lifecycleStatuses.includes('cancelling'));
  assert.equal(lifecycleStatuses[lifecycleStatuses.length - 1], 'exited');
});

test('cancel escalates to SIGKILL when process ignores SIGINT', async () => {
  const runner = new ProcessRunner();
  const lifecycleStatuses: string[] = [];
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const handle = runner.start({
    sessionId: 'session-kill',
    command: process.execPath,
    args: ['-e', IGNORE_SIGINT_SCRIPT],
    cancelGraceMs: 20,
    onStdout: (chunk) => {
      if (chunk.toString().includes('READY')) {
        readyResolve?.();
      }
    },
    onLifecycle: (event) => {
      lifecycleStatuses.push(event.status);
    }
  });

  await ready;
  handle.cancel();

  const result = await handle.result;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(lifecycleStatuses.includes('killing'));
});

test('single-flight rejects concurrent runs in same session', async () => {
  const runner = new ProcessRunner();

  const first = runner.start({
    sessionId: 'session-single-flight',
    command: process.execPath,
    args: ['-e', LONG_RUNNING_SCRIPT]
  });

  assert.throws(
    () =>
      runner.start({
        sessionId: 'session-single-flight',
        command: process.execPath,
        args: ['-e', LONG_RUNNING_SCRIPT]
      }),
    (error: unknown) => {
      assert.ok(error instanceof SingleFlightSessionError);
      return true;
    }
  );

  first.cancel();
  const result = await first.result;
  assert.equal(result.status, 'cancelled');
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
