import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNormalizedEngineEvent } from '../src/index.js';

test('parses minimal normalized event payload', () => {
  const event = parseNormalizedEngineEvent({ type: 'run_started' });
  assert.equal(event?.type, 'run_started');
});
