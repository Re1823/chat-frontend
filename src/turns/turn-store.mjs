export function createTurnStore(){
  let active=null;
  const inactiveWaiters=new Set();
  const settleWaiters=()=>{for(const resolve of inactiveWaiters)resolve(true);inactiveWaiters.clear()};
  const requireActive=(runtimeId,turnId)=>{
    if(!active||active.runtimeId!==runtimeId||active.turnId!==turnId)throw new Error('活动 turn 不存在或不匹配');
    return active;
  };
  const close=(turn,event)=>{
    if(turn.closed)return false;
    turn.closed=true;turn.state=event.type;active=null;settleWaiters();turn.emit(event);return true;
  };
  return {
    start({runtimeId,turnId,emit}){
      if(active)throw Object.assign(new Error('Claude tmux runtime 当前已有活动回复'),{statusCode:409});
      active={runtimeId,turnId,emit,state:'running',closed:false};
      return active;
    },
    get(){return active},
    matches(runtimeId,turnId){return !!active&&active.runtimeId===runtimeId&&active.turnId===turnId},
    emit(runtimeId,turnId,event){const turn=requireActive(runtimeId,turnId);if(turn.closed)return false;turn.emit(event);return true},
    requestStop(runtimeId,turnId){const turn=requireActive(runtimeId,turnId);if(turn.state==='running')turn.state='stop_requested';return turn},
    finish(runtimeId,turnId,event){return close(requireActive(runtimeId,turnId),event)},
    discard(runtimeId,turnId){const turn=requireActive(runtimeId,turnId);if(turn.closed)return false;turn.closed=true;turn.state='discarded';active=null;settleWaiters();return true},
    waitForInactive(runtimeId,turnId,timeoutMs){
      if(!this.matches(runtimeId,turnId))return Promise.resolve(true);
      return new Promise(resolve=>{const timer=setTimeout(()=>{inactiveWaiters.delete(done);resolve(false)},timeoutMs);const done=value=>{clearTimeout(timer);resolve(value)};inactiveWaiters.add(done)});
    }
  };
}
