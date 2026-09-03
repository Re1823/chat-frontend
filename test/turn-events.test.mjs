import assert from 'node:assert/strict';
import test from 'node:test';
import { turnEvent, writeTurnEvent } from '../src/turns/events.mjs';

test('turn events have stable names and serialize as NDJSON', () => {
  const chunks=[];
  const response={write:chunk=>chunks.push(chunk)};
  const events=[turnEvent.started('t'),turnEvent.delta('t','x'),turnEvent.segmentDone('t'),turnEvent.done('t')];
  for(const event of events)writeTurnEvent(response,'ndjson',event);
  assert.deepEqual(chunks.map(chunk=>JSON.parse(chunk)),events);
});

test('legacy SSE serialization keeps its established delta and done frames', () => {
  const chunks=[];
  const response={write:chunk=>chunks.push(chunk)};
  writeTurnEvent(response,'sse',turnEvent.started('t'));
  writeTurnEvent(response,'sse',turnEvent.delta('t','x'));
  writeTurnEvent(response,'sse',turnEvent.segmentDone('t'));
  writeTurnEvent(response,'sse',turnEvent.done('t'));
  assert.deepEqual(chunks,['data: {"delta":"x"}\n\n','data: {"done":true}\n\n']);
});
