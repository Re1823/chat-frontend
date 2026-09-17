import {transitionCarryover} from './state-machine.mjs';
import {targetReadyEvidence,quiescentEvidence} from '../../../deploy/rsc-activation-safety.mjs';
const fail=reason=>Object.assign(new Error(reason),{reason});
export function targetReady(checks,targetSessionId){return targetReadyEvidence(checks,targetSessionId)}
export function createActivationController({stateStore,sendGate,inspectProduction,validateTarget,bridge,routeQueued,mutex}){
 const step=async(next,options)=>stateStore.save(transitionCarryover(stateStore.get(),next,options));
 const preflight=async()=>{const state=stateStore.get(),p=await inspectProduction();if(state.state!=='VALIDATED')throw fail('TARGET_NOT_VALIDATED');if(p?.quiescent===true?false:!quiescentEvidence(p))throw fail('NOT_QUIESCENT');if(p.sessionId!==undefined&&(p.sessionId!==state.sourceSessionId||p.lastGoodSessionId!==state.sourceSessionId))throw fail('STALE_CARRYOVER');const target=await validateTarget(state);if(!target.valid)throw fail(target.reason||'TARGET_INVALID');return {state,p,target};};
 return {
  preflight,
  async activate(operationId){if(!/^[A-Za-z0-9_-]{16,128}$/.test(operationId||''))throw fail('INVALID_OPERATION');const lock=await mutex();let oldStopped=false;try{await preflight();await step('ACTIVATING');sendGate.block();const again=await inspectProduction();if(again.active||again.activeTurnId)throw fail('NOT_QUIESCENT');await step('STARTING_TARGET');const result=await bridge.activateCarryover(operationId);oldStopped=Boolean(result.oldStopped);if(!targetReady(result.ready,stateStore.get().targetSessionId))throw fail('TARGET_NOT_READY');await step('TARGET_READY');await step('CANDIDATE_ACTIVE');await sendGate.commit(routeQueued);return stateStore.get()}catch(error){const current=stateStore.get();if(!['COMMITTED','ROLLBACK','ROLLED_BACK'].includes(current.state))await step('ROLLBACK',{failureReason:error.reason||'ACTIVATION_FAILED'});if(oldStopped)await bridge.rollbackCarryover(operationId);if(stateStore.get().state==='ROLLBACK')await step('ROLLED_BACK',{failureReason:error.reason||'ACTIVATION_FAILED'});await sendGate.rollback(routeQueued);throw error}finally{await lock.release()}},
  async confirmFirstTurn(){if(stateStore.get().state!=='CANDIDATE_ACTIVE')throw fail('NOT_CANDIDATE_ACTIVE');await step('COMMITTED');return stateStore.get()}
 };
}
