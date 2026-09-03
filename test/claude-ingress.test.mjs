import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudeIngress } from '../src/hooks/claude-ingress.mjs';

test('version adapter maps candidate raw fields into canonical frames',async()=>{
  const ingress=createClaudeIngress();
  const frame=await ingress.adapt({hook_event_name:'MessageDisplay',message_id:'raw-m',index:2,delta:'文本',final:true},{runtimeId:'r'});
  assert.deepEqual(frame,{kind:'assistant_frame',messageId:'raw-m',sequence:2,text:'文本',final:true,textMode:'delta'});
  assert.deepEqual(await ingress.adapt({hookEventName:'StopFailure',reason:'failed'}),{kind:'turn_stop',outcome:'failed',reason:'failed'});
});

test('adapter owns fallbacks and raw capture failures never affect canonical transport',async()=>{
  const logs=[];const ingress=createClaudeIngress({captureRaw:async()=>{throw new Error('disk')},debug:value=>logs.push(value)});
  const first=await ingress.adapt({event:'message_display',content:'A'},{runtimeId:'r'});
  const second=await ingress.adapt({event:'message_display',content:'B'},{runtimeId:'r'});
  assert.equal(first.sequence,0);assert.equal(second.sequence,1);assert.equal(first.messageId,'r-message');assert.equal(logs.length,2);
  assert.equal(await ingress.adapt({event:'SessionStart'}),null);
});
