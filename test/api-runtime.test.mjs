import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiRequest, extractTextDelta, safeBase } from '../src/providers/api-runtime.mjs';

test('API runtime builds the three established upstream request shapes', () => {
  const messages = [{role:'system',content:'sys'},{role:'user',content:'hello'}];
  const anthropic = createApiRequest({protocol:'anthropic',base:'https://a.example/',key:'ak',model:'am'}, messages, true);
  assert.equal(anthropic.url, 'https://a.example/v1/messages');
  assert.equal(anthropic.init.headers['x-api-key'], 'ak');
  assert.deepEqual(JSON.parse(anthropic.init.body), {model:'am',max_tokens:4096,stream:true,messages:[{role:'user',content:'hello'}],system:'sys'});

  const responses = createApiRequest({protocol:'responses',base:'https://o.example/v1',key:'ok',model:'om'}, messages, true);
  assert.equal(responses.url, 'https://o.example/v1/responses');
  assert.deepEqual(JSON.parse(responses.init.body), {model:'om',input:messages,stream:true,store:false});

  const chat = createApiRequest({protocol:'chat',base:'https://o.example',key:'ok',model:'cm'}, messages, false);
  assert.equal(chat.url, 'https://o.example/v1/chat/completions');
  assert.deepEqual(JSON.parse(chat.init.body), {model:'cm',messages,stream:false});
});

test('API runtime normalizes text deltas and rejects non-http bases', () => {
  assert.equal(extractTextDelta('anthropic',{type:'content_block_delta',delta:{text:'A'}}), 'A');
  assert.equal(extractTextDelta('responses',{type:'response.output_text.delta',delta:'B'}), 'B');
  assert.equal(extractTextDelta('chat',{choices:[{delta:{content:'C'}}]}), 'C');
  assert.equal(extractTextDelta('chat',{choices:[]}), '');
  assert.throws(() => safeBase('file:///tmp/key'), /只支持 http\/https/);
});
