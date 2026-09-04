import assert from 'node:assert/strict';
import test from 'node:test';
import {createBridgeActiveTurn} from '../deploy/bridge-active-turn.mjs';

test('Case A: failure before tmux send releases the reservation',()=>{
  const state=createBridgeActiveTurn();state.reserve('turn-a','start');
  assert.equal(state.failBeforeSent('turn-a'),true);assert.equal(state.status().active,false);
});

test('Case B: sent turn survives disconnect semantics until complete',()=>{
  const state=createBridgeActiveTurn();state.reserve('turn-b','start');state.markSent('turn-b','sent');
  assert.equal(state.failBeforeSent('turn-b'),false);assert.equal(state.status().active,true);
  state.complete('turn-b');assert.equal(state.status().active,false);
});

test('Case C: response EPIPE cannot change a sent turn but pre-send failure releases',()=>{
  const before=createBridgeActiveTurn();before.reserve('turn-c1');before.failBeforeSent('turn-c1');assert.equal(before.status().active,false);
  const after=createBridgeActiveTurn();after.reserve('turn-c2');after.markSent('turn-c2');assert.equal(after.status().active,true);
});

test('Case D: status reports safe active metadata without prompt content',()=>{
  const state=createBridgeActiveTurn();state.reserve('turn-d','created');state.markSent('turn-d','sent');
  assert.deepEqual(state.status(),{active:true,activeTurnId:'turn-d',activePhase:'awaiting-stop',activeCreatedAt:'created',activeSentAt:'sent'});
});
