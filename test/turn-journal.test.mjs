import assert from 'node:assert/strict';
import test from 'node:test';
import {createTurnStore} from '../src/turns/turn-store.mjs';

const event=(type,extra={})=>({type,turnId:'turn',...extra});

test('journal assigns one sequence across ordinary, tool, segment and terminal events',()=>{
  let delivered=[];const store=createTurnStore();store.start({runtimeId:'r',turnId:'turn',emit:value=>delivered.push(value)});
  store.emit('r','turn',event('turn_started'));
  store.emit('r','turn',event('segment_delta',{delta:'ordinary'}));
  store.emit('r','turn',event('assistant_message',{source:'tool',messageId:'m1',text:'tool'}));
  store.emit('r','turn',event('segment_done'));
  store.finish('r','turn',event('turn_done'));
  assert.deepEqual(delivered.map(value=>value.seq),[1,2,3,4,5]);
  assert.deepEqual(store.replay('turn',0).events.map(value=>value.type),['turn_started','segment_delta','assistant_message','segment_done','turn_done']);
  assert.deepEqual(store.replay('turn',2).events.map(value=>value.seq),[3,4,5]);
  assert.deepEqual(store.replay('turn',5).events,[]);
});

test('detached transport does not stop journal updates or terminal recovery',()=>{
  const delivered=[],store=createTurnStore();store.start({runtimeId:'r',turnId:'turn',emit:value=>delivered.push(value)});store.emit('r','turn',event('turn_started'));store.received('turn');store.detached('turn');
  store.emit('r','turn',event('segment_delta',{delta:'after close'}));store.finish('r','turn',event('turn_done'));
  assert.equal(delivered.length,1);const replay=store.replay('turn',1);assert.deepEqual(replay.events.map(value=>value.type),['segment_delta','turn_done']);assert.equal(replay.finished,true);
});

test('journal TTL and turn cap remove terminal turns but retain a running turn',()=>{
  let clock=0;const store=createTurnStore({now:()=>clock,journalTtlMs:100,maxTurns:2});
  for(const id of ['old','new']){store.start({runtimeId:'r',turnId:id,emit(){}});store.emit('r',id,{type:'turn_started',turnId:id});store.finish('r',id,{type:'turn_done',turnId:id});clock+=10}
  store.start({runtimeId:'r',turnId:'running',emit(){}});store.emit('r','running',{type:'turn_started',turnId:'running'});
  assert.equal(store.status('old'),null);assert.equal(store.status('running').active,true);
  clock=200;assert.equal(store.status('new'),null);assert.equal(store.status('running').active,true);
});

test('journal event and byte caps mark a turn explicitly unrecoverable without resetting seq',()=>{
  const store=createTurnStore({maxEventsPerTurn:2,maxBytesPerTurn:200,maxTotalBytes:300});store.start({runtimeId:'r',turnId:'turn',emit(){}});
  store.emit('r','turn',event('turn_started'));store.emit('r','turn',event('segment_delta',{delta:'x'}));store.emit('r','turn',event('segment_delta',{delta:'y'}));store.finish('r','turn',event('turn_done'));
  const replay=store.replay('turn',0);assert.equal(replay.recoverable,false);assert.equal(replay.journalOverflow,true);assert.equal(replay.latestSeq,4);assert.deepEqual(replay.events,[]);
});

test('client request lookup moves from pending to found to expired without exposing request data',()=>{
  let clock=0;const store=createTurnStore({now:()=>clock,journalTtlMs:100});
  assert.deepEqual(store.requestRecovery('missing'),{status:'NOT_FOUND'});
  assert.equal(store.reserveRequest('request').status,'PENDING');assert.deepEqual(store.requestRecovery('request'),{status:'PENDING'});
  store.start({runtimeId:'r',turnId:'turn',clientRequestId:'request',emit(){}});store.emit('r','turn',event('turn_started'));store.finish('r','turn',event('turn_done'));
  const found=store.requestRecovery('request');assert.equal(found.status,'FOUND');assert.equal(found.turnId,'turn');assert.equal(found.finished,true);assert.equal('prompt' in found,false);
  clock=101;assert.deepEqual(store.requestRecovery('request'),{status:'EXPIRED'});clock=202;assert.deepEqual(store.requestRecovery('request'),{status:'NOT_FOUND'});
});
