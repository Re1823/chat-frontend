import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnStore } from '../src/turns/turn-store.mjs';

test('turn store keeps transient state in memory and finishes only once',async()=>{
  const events=[],store=createTurnStore();store.start({runtimeId:'r',turnId:'t',emit:event=>events.push(event)});
  assert.throws(()=>store.start({runtimeId:'r',turnId:'t2',emit(){}}),error=>error.statusCode===409);
  store.requestStop('r','t');assert.equal(store.get().state,'stop_requested');
  const waiting=store.waitForInactive('r','t',100);
  assert.equal(store.finish('r','t',{type:'turn_stopped',turnId:'t'}),true);
  assert.equal(await waiting,true);assert.equal(store.get(),null);
  assert.equal(events.length,1);assert.equal(events[0].type,'turn_stopped');assert.equal(events[0].turnId,'t');assert.equal(events[0].seq,1);assert.ok(events[0].timestamp);
  assert.throws(()=>store.finish('r','t',{type:'turn_done',turnId:'t'}),/不存在/);
});

test('stop remains unconfirmed on timeout',async()=>{
  const store=createTurnStore();store.start({runtimeId:'r',turnId:'t',emit(){}});store.requestStop('r','t');
  assert.equal(await store.waitForInactive('r','t',5),false);
  assert.equal(store.get().state,'stop_requested');
});


test('delivery metadata distinguishes pending dispatch from acknowledged receipt and expires safely',()=>{
 const store=createTurnStore();store.start({runtimeId:'r',turnId:'t',emit(){}});store.sending('t');assert.equal(store.status('t').receivedByRuntime,null);store.received('t');assert.equal(store.status('t').receivedByRuntime,true);store.finish('r','t',{type:'turn_done'});
 const copy=store.status('t');copy.active=true;assert.equal(store.status('t').active,false);
 for(let i=0;i<256;i++){store.start({runtimeId:'r',turnId:'other-'+i,emit(){}});store.discard('r','other-'+i)}assert.equal(store.status('t'),null);
});
