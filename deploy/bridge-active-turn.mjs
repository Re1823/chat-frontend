export function createBridgeActiveTurn(){
  let active=null;
  const released=new Map();
  const requireMatch=turnId=>{
    if(!active||active.turnId!==turnId)throw Object.assign(new Error('active turn does not match'),{status:409});
    return active;
  };
  return {
    reserve(turnId,details={},now=new Date().toISOString()){
      if(active)throw Object.assign(new Error('active turn already exists'),{status:409});
      active={turnId,phase:'input_submitting',createdAt:now,submittedAt:null,acceptedAt:null,details};return active;
    },
    markSubmitted(turnId,now=new Date().toISOString()){const turn=requireMatch(turnId);turn.phase='input_submitted';turn.submittedAt=now;return turn},
    markAccepted(turnId,now=new Date().toISOString()){const turn=requireMatch(turnId);turn.phase='input_accepted';turn.acceptedAt=now;return turn},
    markRunning(turnId){const turn=requireMatch(turnId);turn.phase='running';return turn},
    markUncertain(turnId,reason='DELIVERY_UNCERTAIN'){const turn=requireMatch(turnId);turn.phase='delivery_uncertain';turn.uncertainReason=reason;return turn},
    failDelivery(turnId,code='DELIVERY_NOT_ACCEPTED'){
      const turn=requireMatch(turnId);active=null;released.set(turnId,{outcome:'delivery_failed',code});if(released.size>256)released.delete(released.keys().next().value);return turn;
    },
    failBeforeSent(turnId){if(!active||active.turnId!==turnId||active.phase!=='input_submitting')return false;active=null;return true},
    complete(turnId){
      if(released.has(turnId))return false;
      requireMatch(turnId);active=null;
      released.set(turnId,{outcome:'completed'});
      if(released.size>256)released.delete(released.keys().next().value);
      return true;
    },
    wasReleased(turnId){return released.has(turnId)},
    releasedOutcome(turnId){return released.get(turnId)||null},
    clear(){active=null},
    get(){return active},
    status(){return active?{active:true,activeTurnId:active.turnId,activePhase:active.phase,activeCreatedAt:active.createdAt,activeSubmittedAt:active.submittedAt,activeAcceptedAt:active.acceptedAt}:{active:false,activeTurnId:null,activePhase:null,activeCreatedAt:null,activeSubmittedAt:null,activeAcceptedAt:null}}
  };
}
