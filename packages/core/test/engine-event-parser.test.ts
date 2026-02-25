import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngineEventParser, type NormalizedEngineEvent } from '../src/index.js';

test('handles partial chunk splits across lines', () => {
  const parser = createEngineEventParser();
  const events: NormalizedEngineEvent[] = [];

  events.push(...parser.push('{"type":"run_started"}\n{"type":"text_'));
  events.push(...parser.push('delta","text":"he'));
  events.push(...parser.push('llo"}\n'));
  events.push(...parser.finish('success'));

  assert.deepEqual(
    events.map((event) => event.type),
    ['run_started', 'text_delta', 'run_finished']
  );

  const textEvent = events.find((event) => event.type === 'text_delta');
  assert.equal(textEvent?.type, 'text_delta');
  if (textEvent?.type === 'text_delta') {
    assert.equal(textEvent.text, 'hello');
  }
});

test('skips malformed lines and reports them without crashing', () => {
  const malformedLines: string[] = [];
  const parser = createEngineEventParser({
    onMalformedLine: (malformed) => {
      malformedLines.push(malformed.line);
    },
  });

  const events = [
    ...parser.push('{"type":"run_started"}\n'),
    ...parser.push('{bad json}\n'),
    ...parser.push('{"type":"text_delta","text":"ok"}\n'),
    ...parser.finish('success'),
  ];

  assert.equal(malformedLines.length, 1);
  assert.equal(malformedLines[0], '{bad json}');
  assert.equal(parser.malformedLineCount(), 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_started', 'text_delta', 'run_finished']
  );
});

test('emits run_finished exactly once per parser lifecycle', () => {
  const parser = createEngineEventParser();

  const first = parser.push('{"type":"run_finished","status":"success"}\n');
  const second = parser.push('{"type":"run_finished","status":"error"}\n');
  const final = parser.finish('error');

  const allEvents = [...first, ...second, ...final];
  const runFinishedEvents = allEvents.filter((event) => event.type === 'run_finished');

  assert.equal(runFinishedEvents.length, 1);
  assert.equal(runFinishedEvents[0]?.type, 'run_finished');
  if (runFinishedEvents[0]?.type === 'run_finished') {
    assert.equal(runFinishedEvents[0].status, 'success');
  }
});
