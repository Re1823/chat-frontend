import assert from 'node:assert/strict';
import test from 'node:test';
import {captureTranscriptBaseline,deriveRecoveryBaseline,inspectTranscriptAcceptance,isIdleScreenSemantic,negativeAcceptanceDecision,promptDigest} from '../deploy/delivery-acceptance.mjs';
import {validateDispatchLease} from '../deploy/dispatch-lease.mjs';

const SESSION='session-production';
const stat={dev:10,ino:20};
const line=value=>`${JSON.stringify(value)}\n`;
const user=(text,uuid,timestamp='2026-09-25T07:00:00.000Z')=>({type:'user',userType:'external',sessionId:SESSION,uuid,timestamp,message:{role:'user',content:[{type:'text',text}]}});
const assistant=(uuid,timestamp='2026-09-25T07:00:01.000Z')=>({type:'assistant',sessionId:SESSION,uuid,timestamp,message:{role:'assistant',content:[{type:'text',text:'reply'}]}});

test('Enter success without a new transcript user record becomes a bounded stable-idle failure',()=>{
  const before=Buffer.from(line(user('before','u-before'))),baseline=captureTranscriptBaseline({buffer:before,stat,sessionId:SESSION});
  assert.equal(inspectTranscriptAcceptance({baseline,buffer:before,stat,sessionId:SESSION,expectedDigest:promptDigest('new message')}).state,'waiting');
  assert.deepEqual(negativeAcceptanceDecision({windowElapsed:true,writeInProgress:false,idleStableCount:3}),{state:'delivery_failed',code:'DELIVERY_NOT_ACCEPTED'});
});

test('resumed Claude idle screen accepts stable non-interactive unknown UI but rejects gates',()=>{
  assert.equal(isIdleScreenSemantic({kind:'READY'}),true);
  assert.equal(isIdleScreenSemantic({kind:'UNKNOWN',interactive:false}),true);
  assert.equal(isIdleScreenSemantic({kind:'UNKNOWN',interactive:true}),false);
  assert.equal(isIdleScreenSemantic({kind:'PERMISSION',interactive:true}),false);
});

test('a delayed exact external user record after the captured offset confirms acceptance',()=>{
  const before=Buffer.from(line(user('before','u-before'))),baseline=captureTranscriptBaseline({buffer:before,stat,sessionId:SESSION});
  const waiting=inspectTranscriptAcceptance({baseline,buffer:before,stat,sessionId:SESSION,expectedDigest:promptDigest('delayed')});
  const accepted=inspectTranscriptAcceptance({baseline,buffer:Buffer.concat([before,Buffer.from(line(user('delayed','u-delayed')))]),stat,sessionId:SESSION,expectedDigest:promptDigest('delayed')});
  assert.equal(waiting.state,'waiting');assert.equal(accepted.state,'input_accepted');assert.equal(accepted.userUuid,'u-delayed');
});

test('identical consecutive text only matches the record after this turn baseline',()=>{
  const first=Buffer.from(line(user('same text','u-first'))),baseline=captureTranscriptBaseline({buffer:first,stat,sessionId:SESSION});
  assert.equal(inspectTranscriptAcceptance({baseline,buffer:first,stat,sessionId:SESSION,expectedDigest:promptDigest('same text')}).state,'waiting');
  const accepted=inspectTranscriptAcceptance({baseline,buffer:Buffer.concat([first,Buffer.from(line(user('same text','u-second')))]),stat,sessionId:SESSION,expectedDigest:promptDigest('same text')});
  assert.equal(accepted.state,'input_accepted');assert.equal(accepted.userUuid,'u-second');assert.equal(accepted.recordOffset,first.length);
});

test('an unfinished trailing JSON line is write_in_progress and becomes accepted after newline completion',()=>{
  const before=Buffer.from(line(user('before','u-before'))),baseline=captureTranscriptBaseline({buffer:before,stat,sessionId:SESSION});
  const serialized=JSON.stringify(user('partial','u-partial')),partial=Buffer.concat([before,Buffer.from(serialized.slice(0,-4))]);
  const waiting=inspectTranscriptAcceptance({baseline,buffer:partial,stat,sessionId:SESSION,expectedDigest:promptDigest('partial')});
  assert.deepEqual({state:waiting.state,reason:waiting.reason,writeInProgress:waiting.writeInProgress},{state:'waiting',reason:'write_in_progress',writeInProgress:true});
  const accepted=inspectTranscriptAcceptance({baseline,buffer:Buffer.concat([before,Buffer.from(`${serialized}\n`)]),stat,sessionId:SESSION,expectedDigest:promptDigest('partial')});
  assert.equal(accepted.state,'input_accepted');
});

test('conflicting post-baseline evidence is uncertain and cannot authorize a retry',()=>{
  const before=Buffer.from(line(user('before','u-before'))),baseline=captureTranscriptBaseline({buffer:before,stat,sessionId:SESSION});
  const conflict=Buffer.concat([before,Buffer.from(line(assistant('a-conflict')))]);
  assert.deepEqual(inspectTranscriptAcceptance({baseline,buffer:conflict,stat,sessionId:SESSION,expectedDigest:promptDigest('expected')}),{state:'delivery_uncertain',reason:'CONFLICTING_OUTPUT_EVIDENCE'});
});

test('restart recovery derives an offset before the queued turn without historical text matching',()=>{
  const bytes=Buffer.from(line(user('old','old','2026-09-25T06:59:00.000Z'))+line(user('new','new','2026-09-25T07:01:00.000Z')));
  const baseline=deriveRecoveryBaseline({buffer:bytes,stat,sessionId:SESSION,createdAt:'2026-09-25T07:00:00.000Z'});
  assert.equal(baseline.offset,Buffer.byteLength(line(user('old','old','2026-09-25T06:59:00.000Z'))));
  assert.equal(inspectTranscriptAcceptance({baseline,buffer:bytes,stat,sessionId:SESSION,expectedDigest:promptDigest('new')}).state,'input_accepted');
});

test('production dispatch lease rejects an owner change before Enter',()=>{
  assert.throws(()=>validateDispatchLease({provided:{sessionId:'A',generation:8},expected:{sessionId:'B',generation:9},actualSessionId:'B'}),error=>error.code==='PRODUCTION_LEASE_CHANGED'&&error.status===409);
  assert.deepEqual(validateDispatchLease({provided:{sessionId:'A',generation:8},expected:{sessionId:'A',generation:8},actualSessionId:'A'}),{sessionId:'A',generation:8});
});
