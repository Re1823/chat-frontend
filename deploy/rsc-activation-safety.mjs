// Shared by the production bridge and tests. Missing evidence is never PASS.
const requiredFalse=['active','startupError','autoCompacted','emptySessionFallback','onboardingDetected'];
const requiredTrue=['claudeAlive','workspaceRoot','tmuxIdentity','singleManagedClaude','helperAlive','helperParentMatches','oldHelperAbsent','helperIdentityMatches','runtimeConnected','frontendMcpConnected','modelExact','effortHigh','noModelFallback','transcriptParseable','permissionsIntact','hooksIntact','claudeMdAvailable'];

export function targetReadyEvidence(value,targetSessionId){
 if(!value||value.resumedSessionId!==targetSessionId||value.active!==false||value.activeTurnId!==null)return false;
 if(value.obConfigured!==true)return false;
 if(value.obConnected!==undefined&&typeof value.obConnected!=='boolean')return false;
 return requiredTrue.every(key=>value[key]===true)&&requiredFalse.every(key=>value[key]===false);
}

export function quiescentEvidence(value){
 if(!value||value.active!==false||value.activeTurnId!==null)return false;
 return ['unfinishedJournal','unresolvedJournal','pendingFinalization','pendingDelivery','pendingClientRequest','imageBinding','recoveryInProgress','compactOrStartupTransition'].every(key=>value[key]===false)&&value.mutexFree===true&&value.gateState==='OPEN'&&value.queueDepth===0;
}

export function lifecycleFree(value){return Boolean(value?.claudeAbsent&&value?.helperAbsent&&value?.tmuxFree&&value?.runtimeOwnerCleared)};
