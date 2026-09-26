export function createCandidateWatchdog({loadState,inspectCandidate,recoverLastGood,intervalMs=1000,setTimer=setTimeout,clearTimer=clearTimeout,log=()=>{}}={}){
  let timer=null,running=false;
  const stop=()=>{if(timer!==null)clearTimer(timer);timer=null};
  const schedule=()=>{stop();timer=setTimer(()=>void check(),intervalMs);timer?.unref?.()};
  const check=async()=>{
    if(running)return;
    running=true;
    try{
      const state=await loadState();
      if(state?.handoffState!=='CANDIDATE_ACTIVE'||!state.candidateActiveSessionId)return stop();
      const health=await inspectCandidate(state);
      if(health?.healthy===true)return schedule();
      stop();
      await recoverLastGood(state,health?.reason||'CANDIDATE_HEALTH_UNKNOWN');
      log({event:'candidate_watchdog_rollback',targetSessionId:state.candidateActiveSessionId,reason:health?.reason||'CANDIDATE_HEALTH_UNKNOWN'});
    }catch(error){log({event:'candidate_watchdog_error',reason:String(error?.message||error).slice(0,160)});schedule()}
    finally{running=false}
  };
  return {start(){schedule()},stop,checkNow:check,running:()=>running};
}
