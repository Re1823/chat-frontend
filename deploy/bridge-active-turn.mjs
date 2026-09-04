export function createBridgeActiveTurn(){
  let active=null;
  const requireMatch=turnId=>{
    if(!active||active.turnId!==turnId)throw Object.assign(new Error('active turn does not match'),{status:409});
    return active;
  };
  return {
    reserve(turnId,now=new Date().toISOString()){
      if(active)throw Object.assign(new Error('active turn already exists'),{status:409});
      active={turnId,phase:'sending',createdAt:now,sentAt:null};return active;
    },
    markSent(turnId,now=new Date().toISOString()){const turn=requireMatch(turnId);turn.phase='awaiting-stop';turn.sentAt=now;return turn},
    failBeforeSent(turnId){if(!active||active.turnId!==turnId||active.phase==='awaiting-stop')return false;active=null;return true},
    complete(turnId){requireMatch(turnId);active=null},
    clear(){active=null},
    get(){return active},
    status(){return active?{active:true,activeTurnId:active.turnId,activePhase:active.phase,activeCreatedAt:active.createdAt,activeSentAt:active.sentAt}:{active:false,activeTurnId:null,activePhase:null,activeCreatedAt:null,activeSentAt:null}}
  };
}
