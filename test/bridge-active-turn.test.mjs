import assert from 'node:assert/strict';
import test from 'node:test';
import {createBridgeActiveTurn} from '../deploy/bridge-active-turn.mjs';

test('Case A: failure before tmux send releases the reservation',()=>{
  const state=createBridgeActiveTurn();state.reserve('turn-a',{},'start');
  assert.equal(state.failBeforeSent('turn-a'),true);assert.equal(state.status().active,false);
});

test('Case B: sent turn survives disconnect semantics until complete',()=>{
  const state=createBridgeActiveTurn();state.reserve('turn-b',{},'start');state.markSubmitted('turn-b','sent');
  assert.equal(state.failBeforeSent('turn-b'),false);assert.equal(state.status().active,true);
  state.complete('turn-b');assert.equal(state.status().active,false);
});

test('Case C: response EPIPE cannot change a sent turn but pre-send failure releases',()=>{
  const before=createBridgeActiveTurn();before.reserve('turn-c1');before.failBeforeSent('turn-c1');assert.equal(before.status().active,false);
  const after=createBridgeActiveTurn();after.reserve('turn-c2');after.markSubmitted('turn-c2');assert.equal(after.status().active,true);
});

test('Case D: status reports safe active metadata without prompt content',()=>{
  const state=createBridgeActiveTurn();state.reserve('turn-d',{privateDigest:'hidden'},'created');state.markSubmitted('turn-d','sent');
  assert.deepEqual(state.status(),{active:true,activeTurnId:'turn-d',activePhase:'input_submitted',activeCreatedAt:'created',activeSubmittedAt:'sent',activeAcceptedAt:null});assert.equal(JSON.stringify(state.status()).includes('hidden'),false);
});

test('submitted, accepted, uncertain and failed are distinct bridge lifecycle states',()=>{
  const state=createBridgeActiveTurn();state.reserve('turn-e');state.markSubmitted('turn-e');assert.equal(state.status().activePhase,'input_submitted');
  state.markAccepted('turn-e');assert.equal(state.status().activePhase,'input_accepted');state.markRunning('turn-e');assert.equal(state.status().activePhase,'running');
  state.markUncertain('turn-e','TRANSCRIPT_REPLACED');assert.equal(state.status().activePhase,'delivery_uncertain');
  state.failDelivery('turn-e','DELIVERY_NOT_ACCEPTED');assert.equal(state.status().active,false);assert.deepEqual(state.releasedOutcome('turn-e'),{outcome:'delivery_failed',code:'DELIVERY_NOT_ACCEPTED'});
});
