// Stop only the matching turn. Completed IDs are bounded in the shared turn state.
export function createBridgeStopController({state,sendEscape,log=()=>{}}){
  const pending=new Map();
  return {
    isPending(){return pending.size>0},
    stop(turnId){
      if(pending.has(turnId))return pending.get(turnId);
      if(state.wasReleased(turnId)){
        log('duplicate_stop',turnId);
        return Promise.resolve({status:'already_stopped',turnId,stopSent:false,turnReleased:true});
      }
      if(state.get()?.turnId!==turnId){
        log('stale_stop_rejected',turnId);
        return Promise.reject(Object.assign(new Error('turnId mismatch'),{status:409}));
      }
      if(state.get().phase==='sending')return Promise.reject(Object.assign(new Error('turn input is still being sent'),{status:409}));
      const operation=Promise.resolve().then(async()=>{
        log('stop_requested',turnId);
        // A normal Stop hook can release this turn while the operation is queued.
        if(state.wasReleased(turnId))return {status:'already_stopped',turnId,stopSent:false,turnReleased:true};
        await sendEscape();
        log('escape_sent',turnId);
        state.complete(turnId);
        log('bridge_active_released',turnId);
        return {status:'stopped',turnId,stopSent:true,turnReleased:true};
      }).finally(()=>pending.delete(turnId));
      pending.set(turnId,operation);
      return operation;
    }
  };
}
