import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseTranscript, textContent} from '../src/runtimes/rsc/transcript-parser.mjs';
import {classify, conversationalTurns} from '../src/runtimes/rsc/selector.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const fixturePath = fileURLToPath(new URL('../fixtures/rsc-recent-tail-tool-result.jsonl', import.meta.url));

test('tool_result remains inside a completed frontend-message turn', async () => {
  const records = parseTranscript(await readFile(fixturePath), {sourceSessionId: sessionId});
  const prompt = records[0];
  const finalAssistant = records[3];

  assert.equal(classify(prompt).kind, 'clean');
  assert.equal(classify(finalAssistant).kind, 'clean');
  assert.equal(textContent(finalAssistant), 'assistant-A-complete');
  assert.equal(records[4].subtype, 'stop_hook_summary');
  assert.equal(records[5].subtype, 'turn_duration');
  const turns=conversationalTurns(records);
  assert.equal(turns.length,1);
  assert.equal(turns[0].assistantText,'assistant-A');
  assert.equal(turns[0].assistantMessages.length,1);
});
