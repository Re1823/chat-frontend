const BLOCKERS=Object.freeze(['OBSERVABILITY_NOT_READY','RUNTIME_ACTIVE','ACTIVE_TURN','UNFINISHED_JOURNAL','FINALIZATION_IN_PROGRESS','RECOVERY_IN_PROGRESS','IMAGE_BINDING_TRANSITION','SEND_GATE_NOT_OPEN','SEND_GATE_QUEUE_NOT_EMPTY','GENERATION_MISMATCH','HANDOFF_STATE']);
const knownBoolean=value=>typeof value==='boolean';
const knownCount=value=>Number.isSafeInteger(value)&&value>=0;
export function createRuntimeObservability({runtime,imageStore,coordinator}){
 let ready=false,recoveries=0;
 const snapshot=async({frozen=false}={})=>{const runtimeState=runtime?.quiescence?.(),images=imageStore?.quiescence?.(),gate=await coordinator?.snapshot?.(),productionGeneration=gate?.productionGeneration??gate?.generation,rotationAttemptGeneration=gate?.rotationAttemptGeneration??gate?.handoffGeneration,leaseGeneration=gate?.leaseGeneration??gate?.handoffGeneration;const blockers=[];
 if(!ready)blockers.push('OBSERVABILITY_NOT_READY');
 if(runtimeState?.runtimeActive!==false)blockers.push('RUNTIME_ACTIVE');if(runtimeState?.activeTurnId!==null)blockers.push('ACTIVE_TURN');
 if(!knownCount(runtimeState?.unfinishedJournalCount)||runtimeState.unfinishedJournalCount)blockers.push('UNFINISHED_JOURNAL');
 if(runtimeState?.finalizationInProgress!==false)blockers.push('FINALIZATION_IN_PROGRESS');
 if(recoveries)blockers.push('RECOVERY_IN_PROGRESS');
 if(!knownCount(images?.transitionalImageBindingCount)||images.transitionalImageBindingCount)blockers.push('IMAGE_BINDING_TRANSITION');
 const generationMismatch=!gate||!Number.isSafeInteger(productionGeneration)||(gate.rotationAttemptGeneration===undefined&&gate.leaseGeneration===undefined?gate.generation!==gate.handoffGeneration:leaseGeneration!==rotationAttemptGeneration);if(generationMismatch)blockers.push('GENERATION_MISMATCH');
 if(!frozen&&gate?.state!=='OPEN')blockers.push('SEND_GATE_NOT_OPEN');if(!frozen&&gate?.queueDepth!==0)blockers.push('SEND_GATE_QUEUE_NOT_EMPTY');
 if(!['VALIDATED','ACTIVE'].includes(gate?.handoffState))blockers.push('HANDOFF_STATE');
 return {observabilityReady:ready,runtimeActive:runtimeState?.runtimeActive,activeTurnId:runtimeState?.activeTurnId,unfinishedJournalCount:runtimeState?.unfinishedJournalCount,finalizationInProgress:runtimeState?.finalizationInProgress,recoveryInProgress:recoveries>0,recoveryCount:recoveries,transitionalImageBindingCount:images?.transitionalImageBindingCount,sendGateState:gate?.state,sendGateQueueDepth:gate?.queueDepth,sendGateOldestQueuedMs:gate?.oldestQueuedMs,sendGateGeneration:productionGeneration,productionGeneration,rotationAttemptGeneration,leaseGeneration,handoffState:gate?.handoffState,handoffGeneration:rotationAttemptGeneration,quiescent:blockers.length===0,blockers:[...new Set(blockers)]};
 };
 return {async reconcile(){ready=false;const initial=await snapshot();if(initial.runtimeActive===false&&initial.activeTurnId===null&&knownCount(initial.unfinishedJournalCount)&&initial.finalizationInProgress===false&&knownCount(initial.transitionalImageBindingCount))ready=true;return snapshot()},async snapshot(options){return snapshot(options)},async recovery(task){recoveries++;try{return await task()}finally{recoveries--}}};
}
export {BLOCKERS};
