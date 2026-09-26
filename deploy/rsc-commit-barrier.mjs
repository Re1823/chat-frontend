const acceptedPhases=new Set(['input_accepted','running']);
export function evaluateCandidateCommit({state,turn,terminalType,actualSessionId,health}={}){
 const reasons=[];
 if(!state?.candidateActiveSessionId||!['CANDIDATE_ACTIVE','VALIDATING'].includes(state.handoffState))reasons.push('CANDIDATE_NOT_VALIDATING');
 if(state?.candidateState!=='VALIDATING')reasons.push('CANDIDATE_STATE_NOT_VALIDATING');
 if(state?.operationGeneration!==state?.rotationAttemptGeneration)reasons.push('ATTEMPT_CAS_MISMATCH');
 if(turn?.details?.lease?.generation!==state?.rotationAttemptGeneration||turn?.details?.lease?.sessionId!==state?.candidateActiveSessionId)reasons.push('TURN_LEASE_MISMATCH');
 if(!state?.firstRealTurnId||turn?.turnId!==state.firstRealTurnId)reasons.push('FIRST_REAL_TURN_MISMATCH');
 if(!acceptedPhases.has(turn?.phase)||!turn?.acceptedAt)reasons.push('INPUT_NOT_ACCEPTED');
 if(terminalType!=='turn_done')reasons.push('TURN_NOT_FINISHED');
 if(actualSessionId!==state?.candidateActiveSessionId)reasons.push('OWNER_MISMATCH');
 if(state?.preparedTargetEvidence!=='PREPARED')reasons.push('PREPARED_VALIDATION_MISSING');
 if(health?.healthy!==true||health?.transcriptStable!==true)reasons.push(health?.reason||'READINESS_NOT_STABLE');
 return {allowed:reasons.length===0,reasons};
}

export function committedCandidateState(state,{now=new Date().toISOString()}={}){
 const generation=(state.productionGeneration||state.committedGeneration||1)+1,target=state.candidateActiveSessionId;
 return {...state,currentProductionSessionId:target,lastGoodSessionId:target,preparedTargetSessionId:target,preparedTargetEvidence:'FIRST_TURN_VALIDATED',handoffState:'ACTIVE',candidateState:'COMMITTED',candidateActiveSessionId:null,candidateSourceSessionId:null,candidateDebugOffset:null,candidateClaudePid:null,candidateHelperPid:null,productionGeneration:generation,committedGeneration:generation,firstRealTurnCommittedAt:now,updatedAt:now};
}
