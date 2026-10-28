const OPERATION=/^[A-Za-z0-9_-]{16,128}$/;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function createRscBridgeHandoff({loadOperation,productionSession,stopOld,inspectStopFailure,startTarget,inspectTarget,resumeLastGood}){
 const validated=async id=>{if(!OPERATION.test(id||''))throw fail('invalid carryover operation');const op=await loadOperation(id),state=op?.state||op?.handoffState,source=op?.sourceSessionId||op?.currentProductionSessionId,targetEvidence=op?.targetEvidence||op?.preparedTargetEvidence;if(!op||op.rotationPaused!==undefined&&op.rotationPaused!==false||op.rotationPauseConflict||op.operationId&&op.operationId!==id||state!=='ACTIVATING'||source!==(await productionSession())||op.lastGoodSessionId!==source||!['PREPARED','SHADOW_VALIDATED'].includes(targetEvidence))throw fail('carryover operation rejected',409);return {...op,sourceSessionId:source,targetSessionId:op.targetSessionId||op.preparedTargetSessionId}};
 return {
  async activate(id){const op=await validated(id);let sourceExit;try{sourceExit=await stopOld(op)}catch(error){
    let ownership;try{ownership=await inspectStopFailure?.(op,error)}catch{}
    if(ownership?.state==='SOURCE_INTACT')throw error;
    if(ownership?.state!=='SOURCE_STOPPED')throw Object.assign(new Error('source lifecycle uncertain'),{status:503,reason:'SOURCE_LIFECYCLE_UNCERTAIN',forceFailedSafe:true,cause:error});
    try{const recovered=await resumeLastGood(op,{afterTargetFailure:false});if(!recovered?.sourceReady)throw fail('last-good recovery was not ready',503)}catch(recoveryError){throw Object.assign(new Error('source recovery failed'),{status:503,reason:'SOURCE_RECOVERY_FAILED',forceFailedSafe:true,cause:recoveryError})}
    throw error;
  }try{const started=await startTarget(op);return {oldStopped:true,ready:await inspectTarget(op,started)}}catch(error){
    if(!sourceExit?.sourceStopped)throw error;
    try{const recovered=await resumeLastGood(op,{afterTargetFailure:true});if(!recovered?.sourceReady)throw fail('last-good recovery was not ready',503)}catch(recoveryError){throw Object.assign(new Error('target cleanup or source recovery failed'),{status:503,reason:'TARGET_RECOVERY_FAILED',forceFailedSafe:true,cause:recoveryError})}
    throw error;
  }},
  async rollback(id){const op=await loadOperation(id);if(!op||!OPERATION.test(id||''))throw fail('invalid carryover operation');return resumeLastGood(op,{afterTargetFailure:true})}
 };
}
export function dispatchRscBridge(message,handoff){if(message.op==='activate_carryover'&&Object.keys(message).sort().join(',')==='op,operationId')return handoff.activate(message.operationId);if(message.op==='rollback_carryover'&&Object.keys(message).sort().join(',')==='op,operationId')return handoff.rollback(message.operationId);throw fail('invalid carryover request')}
