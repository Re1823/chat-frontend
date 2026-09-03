import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalFrame } from '../src/hooks/canonical-frame.mjs';
import { createFrameBuffer } from '../src/turns/frame-buffer.mjs';

test('canonical frames are reordered, serialized and deduplicated',()=>{
  const buffer=createFrameBuffer();
  assert.deepEqual(buffer.push(canonicalFrame.assistant({messageId:'m',sequence:1,text:'B'})),[]);
  assert.deepEqual(buffer.push(canonicalFrame.assistant({messageId:'m',sequence:0,text:'A'})).map(x=>x.text),['A','B']);
  assert.deepEqual(buffer.push(canonicalFrame.assistant({messageId:'m',sequence:1,text:'B'})),[]);
  const final=buffer.push(canonicalFrame.assistant({messageId:'m',sequence:2,text:'C',final:true}));
  assert.deepEqual(final.map(x=>x.kind),['assistant_frame','message_final']);
});

test('snapshot frames emit suffixes and surface conflicts without duplicating text',()=>{
  const buffer=createFrameBuffer();
  assert.equal(buffer.push(canonicalFrame.assistant({messageId:'m',sequence:0,text:'你',textMode:'snapshot'}))[0].text,'你');
  assert.equal(buffer.push(canonicalFrame.assistant({messageId:'m',sequence:1,text:'你好',textMode:'snapshot'}))[0].text,'好');
  assert.equal(buffer.push(canonicalFrame.assistant({messageId:'m',sequence:2,text:'冲突',textMode:'snapshot'}))[0].kind,'frame_conflict');
});
