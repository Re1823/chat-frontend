const OPERATION=/^[A-Za-z0-9_-]{16,128}$/;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function createRscBridgeHandoff({loadOperation,productionSession,stopOld,startTarget,inspectTarget,resumeLastGood}){
 const validated=async id=>{if(!OPERATION.test(id||''))throw fail('invalid carryover operation');const op=await loadOperation(id),state=op?.state||op?.handoffState,source=op?.sourceSessionId||op?.currentProductionSessionId,targetEvidence=op?.targetEvidence||op?.preparedTargetEvidence;if(!op||op.operationId&&op.operationId!==id||state!=='ACTIVATING'||source!==(await productionSession())||op.lastGoodSessionId!==source||!['PREPARED','SHADOW_VALIDATED'].includes(targetEvidence))throw fail('carryover operation rejected',409);return {...op,sourceSessionId:source,targetSessionId:op.targetSessionId||op.preparedTargetSessionId}};
 return {
  async activate(id){const op=await validated(id);const sourceExit=await stopOld(op);try{const started=await startTarget(op);return {oldStopped:true,ready:await inspectTarget(op,started)}}catch(error){
    if(!sourceExit?.sourceStopped)throw error;
    const recovered=await resumeLastGood(op,{afterTargetFailure:true});
    if(!recovered?.sourceReady)throw fail('last-good recovery was not ready',503);
    throw error;
  }},
  async rollback(id){const op=await loadOperation(id);if(!op||!OPERATION.test(id||''))throw fail('invalid carryover operation');return resumeLastGood(op,{afterTargetFailure:true})}
 };
}
export function dispatchRscBridge(message,handoff){if(message.op==='activate_carryover'&&Object.keys(message).sort().join(',')==='op,operationId')return handoff.activate(message.operationId);if(message.op==='rollback_carryover'&&Object.keys(message).sort().join(',')==='op,operationId')return handoff.rollback(message.operationId);throw fail('invalid carryover request')}
