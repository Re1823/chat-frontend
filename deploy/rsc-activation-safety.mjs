// Shared by the production bridge and tests. Missing evidence is never PASS.
const requiredFalse=['active','startupError','autoCompacted','emptySessionFallback','onboardingDetected'];
const requiredTrue=['claudeAlive','processStable','resumeConfirmed','validSessionTranscript','workspaceRoot','projectDirectoryAdded','tmuxIdentity','singleManagedClaude','helperAlive','helperParentMatches','oldHelperAbsent','helperIdentityMatches','runtimeConnected','frontendMcpConnected','modelExact','effortHigh','noModelFallback','transcriptParseable','permissionsIntact','hooksIntact','claudeMdAvailable'];

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

export function sourceStopFailureState({operation,state,turn,oldPid,exitRequested,running,currentPid,currentSessionId,oldProcess,owners,helpers,oldHelpersAbsent}){
 if(!Number.isSafeInteger(oldPid)||oldPid<=0||state?.operationId!==operation?.operationId||state?.handoffState!=='ACTIVATING'||state?.currentProductionSessionId!==operation?.sourceSessionId||state?.lastGoodSessionId!==operation?.sourceSessionId||turn?.active!==false||turn?.activeTurnId!==null||!Array.isArray(owners)||!Array.isArray(helpers))return 'UNCERTAIN';
 const sourceOwned=oldProcess?.pid===oldPid&&oldProcess.cmd?.includes('--resume')&&oldProcess.cmd[oldProcess.cmd.indexOf('--resume')+1]===operation.sourceSessionId;
 if(exitRequested===false&&running===true&&currentPid===oldPid&&currentSessionId===operation.sourceSessionId&&sourceOwned&&owners.length===1&&owners[0].pid===oldPid&&helpers.length===1&&helpers[0].ppid===oldPid)return 'SOURCE_INTACT';
 if(running===false&&!oldProcess&&owners.length===0&&helpers.length===0&&oldHelpersAbsent===true)return 'SOURCE_STOPPED';
 return 'UNCERTAIN';
}
