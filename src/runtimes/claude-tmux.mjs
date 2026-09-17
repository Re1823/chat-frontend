import { randomUUID } from 'node:crypto';
import { createFrameBuffer } from '../turns/frame-buffer.mjs';
import { turnEvent } from '../turns/events.mjs';
import { createFrontendDelivery } from '../presentation/frontend-delivery.mjs';

const terminal=event=>['turn_done','turn_stopped','turn_error'].includes(event.type);

export function createClaudeTmuxRuntime({config,transport,registry,turnStore,ingress,imageStore=null,frameBufferFactory=createFrameBuffer,log=record=>console.info(JSON.stringify(record))}){
  const frontendDelivery=createFrontendDelivery({turnStore,runtimeId:config.runtimeId});
  const finished=new Map(),stopOperations=new Map(),thoughtPolls=new Map();
  let finalizations=0;
  const record=(event,turnId,details={})=>{try{log({time:new Date().toISOString(),component:'node',event,turnId,clientRequestId:turnStore.status?.(turnId)?.clientRequestId||null,...details})}catch{}};
  const remember=(turn,event)=>{finished.set(turn.turnId,{runtimeId:turn.runtimeId,event:event.type});if(finished.size>256)finished.delete(finished.keys().next().value)};
  let reconciliation={state:'uninitialized',runtime:null};
  let frames=frameBufferFactory();
  let ingressChain=Promise.resolve();
  const emittedSegmentDone=new Set();
  const statusError=state=>state==='missing'?'Claude Code tmux session 不存在':state==='exited'?'Claude Code 已退出':state==='unconfigured'?'Claude tmux runtime 尚未配置':'Claude tmux runtime 当前不可用';
  const emitSegmentDone=(turn,runtimeId)=>{if(emittedSegmentDone.has(turn.turnId))return;emittedSegmentDone.add(turn.turnId);turnStore.emit(runtimeId,turn.turnId,turnEvent.segmentDone(turn.turnId))};
  const syncThoughts=async turn=>{if(!transport.thoughtSnapshot||!turnStore.matches(turn.runtimeId,turn.turnId))return;try{const snapshot=await transport.thoughtSnapshot(turn.turnId),signature=JSON.stringify(snapshot);if(thoughtPolls.get(turn.turnId)?.signature===signature)return;const state=thoughtPolls.get(turn.turnId)||{};state.signature=signature;thoughtPolls.set(turn.turnId,state);if(snapshot.items?.length||snapshot.suppressedTexts?.length)turnStore.emit(turn.runtimeId,turn.turnId,turnEvent.thoughtProcess(turn.turnId,snapshot))}catch{}};
  const scheduleThoughts=turn=>{if(!transport.thoughtSnapshot)return;const state=thoughtPolls.get(turn.turnId)||{};thoughtPolls.set(turn.turnId,state);const tick=async()=>{if(!turnStore.matches(turn.runtimeId,turn.turnId))return;await syncThoughts(turn);state.timer=setTimeout(tick,350);state.timer.unref?.()};state.timer=setTimeout(tick,0);state.timer.unref?.()};
  const stopThoughts=async turn=>{const state=thoughtPolls.get(turn.turnId);if(state?.timer)clearTimeout(state.timer);await syncThoughts(turn);thoughtPolls.delete(turn.turnId)};
  const finalize=async(turn,event,{released=false}={})=>{
    if(!turnStore.matches(turn.runtimeId,turn.turnId))return;
    finalizations++;try{await stopThoughts(turn);remember(turn,event);
    try{turnStore.finish(turn.runtimeId,turn.turnId,event)}
    finally{
      await imageStore?.finishTurn?.(turn.turnId,event.type==='turn_error'?'failed':event.type==='turn_stopped'?'stopped':'finished');
      record('node_finalized',turn.turnId,{terminal:event.type,active:false});
      if(!released){await transport.complete?.(turn.turnId);record('bridge_complete',turn.turnId)}
    }} finally {finalizations--}
  };
  const processRaw=async raw=>{
    const turn=turnStore.get();
    const hook=raw.hook_event_name||raw.hookEventName||raw.event||raw.type;
    if(['Stop','StopFailure','stop','stop_failure'].includes(hook))record('hook_received',turn?.turnId||null,{hook});
    if(!turn){record('late_hook_ignored',null,{hook});return {accepted:false,reason:'no_active_turn'}};
    if(raw.turnId&&raw.turnId!==turn.turnId){record('stale_hook_ignored',raw.turnId);return {accepted:false,reason:'turn_mismatch'}};
    const frame=await ingress.adapt(raw,{runtimeId:turn.runtimeId});if(!frame)return {accepted:false,reason:'ignored'};
    if(frame.kind==='assistant_frame'){
      for(const item of frames.push(frame)){
        if(item.kind==='assistant_frame'){if(!turnStore.status?.(turn.turnId)?.hasOutput)record('first_output',turn.turnId);turnStore.emit(turn.runtimeId,turn.turnId,turnEvent.delta(turn.turnId,item.text))}
        if(item.kind==='message_final')emitSegmentDone(turn,turn.runtimeId);
      }
      return {accepted:true};
    }
    if(frame.kind==='turn_error'||(frame.kind==='turn_stop'&&frame.outcome==='failed')){
      emitSegmentDone(turn,turn.runtimeId);
      await finalize(turn,turnEvent.error(turn.turnId,frame.message||frame.reason||'Claude Code 回复失败'));
      return {accepted:true};
    }
    if(frame.kind==='turn_stop'){
      emitSegmentDone(turn,turn.runtimeId);
      const event=turn.state==='stop_requested'?turnEvent.stopped(turn.turnId):turnEvent.done(turn.turnId);
      await finalize(turn,event);
      return {accepted:true};
    }
    return {accepted:false,reason:'ignored'};
  };
  return {
    reserveRequest(clientRequestId){return turnStore.reserveRequest(clientRequestId)},
    releaseRequest(clientRequestId){return turnStore.releaseRequest(clientRequestId)},
    requestRecovery(clientRequestId){return turnStore.requestRecovery(clientRequestId)},
    bindFrontendDelivery(){return frontendDelivery.bind()},
    deliverSavedPhoto(photo,text=''){
      const turn=turnStore.get();if(!turn||turn.runtimeId!==config.runtimeId||turn.state!=='running'||turn.closed||turnStore.status(turn.turnId)?.detached)throw Object.assign(new Error('No active frontend turn'),{statusCode:409});
      const messageId=randomUUID();turnStore.emit(config.runtimeId,turn.turnId,{type:'assistant_message',turnId:turn.turnId,messageId,text,source:'tool',images:[photo]});return {ok:true,messageId};
    },
    configuration(){return {enabled:config.enabled,unsupportedPlatform:config.unsupportedPlatform,runtimeId:config.runtimeId}},
    async initialize(){
      let saved=await registry.load();
      if(!saved&&config.enabled&&config.workspace)saved=await registry.save({runtimeId:config.runtimeId,sessionName:config.sessionName,workspace:config.workspace,claudeCommand:config.claudeBinary,createdAt:new Date().toISOString()});
      reconciliation=await registry.reconcile();
      if(config.enabled&&reconciliation.state==='missing'&&config.autoCreate){await transport.createSession({sessionName:saved.sessionName,workspace:saved.workspace,command:saved.claudeCommand||config.claudeBinary,args:config.launchArgs||[]});reconciliation=await registry.reconcile()}
      return reconciliation;
    },
    async status(){reconciliation=await registry.reconcile();return reconciliation},
    async preflight(runtimeId,{allowDisabled=false}={}){
      if(!config.enabled&&!allowDisabled)throw Object.assign(new Error(config.unsupportedPlatform?'Claude tmux runtime 只支持 Linux/WSL/VPS':'Claude tmux runtime 未启用'),{statusCode:503});
      const state=await this.status();
      if(state.state!=='connected')throw Object.assign(new Error(statusError(state.state)),{statusCode:state.state==='missing'?404:503});
      if(runtimeId!==state.runtime.runtimeId)throw Object.assign(new Error('runtimeId 不匹配'),{statusCode:404});
      if(turnStore.get()||stopOperations.size)throw Object.assign(new Error('Claude tmux runtime 当前已有活动回复'),{statusCode:409});
      return state.runtime;
    },
    async chat({runtimeId,prompt,emit,signal,clientRequestId=null,turnId=randomUUID(),images=[]}){
      const runtime=await this.preflight(runtimeId);
      if(signal?.aborted)throw Object.assign(new Error('client disconnected'),{statusCode:499});
      turnStore.start({runtimeId,turnId,emit,clientRequestId});frames=frameBufferFactory();record('turn_started',turnId);
      const discardDisconnected=()=>{turnStore.discard(runtimeId,turnId);void imageStore?.finishTurn?.(turnId,'not_delivered');record('client_disconnected',turnId,{beforeSend:true});record('node_finalized',turnId,{terminal:'not_delivered',active:false})};
      try{
        if(signal?.aborted){discardDisconnected();throw Object.assign(new Error('client disconnected'),{statusCode:499})}
        turnStore.emit(runtimeId,turnId,turnEvent.started(turnId));
        if(images.length)turnStore.emit(runtimeId,turnId,turnEvent.userImages(turnId,images));
        if(signal?.aborted){discardDisconnected();throw Object.assign(new Error('client disconnected'),{statusCode:499})}
        turnStore.sending(turnId);
        const onDisconnect=()=>{turnStore.detached(turnId);record('client_disconnected',turnId)};
        signal?.addEventListener('abort',onDisconnect,{once:true});
        if(signal?.aborted)onDisconnect();
        await transport.sendPrompt({sessionName:runtime.sessionName,turnId,prompt,delayMs:config.submitDelayMs});
        turnStore.received(turnId);record('runtime_send_confirmed',turnId);scheduleThoughts(turnStore.get());
      }catch(error){
        if(turnStore.matches(runtimeId,turnId)){
          try{turnStore.finish(runtimeId,turnId,turnEvent.error(turnId,error.message));await imageStore?.finishTurn?.(turnId,'failed');record('node_finalized',turnId,{terminal:'turn_error',active:false})}catch{}
        }
        throw Object.assign(error,{streamStarted:true});
      }
      return {turnId};
    },
    async diagnosticChat({runtimeId,prompt,emit,turnId=randomUUID()}){
      const runtime=await this.preflight(runtimeId,{allowDisabled:true});
      turnStore.start({runtimeId,turnId,emit});frames=frameBufferFactory();
      turnStore.emit(runtimeId,turnId,turnEvent.started(turnId));
      try{await transport.sendPrompt({sessionName:runtime.sessionName,turnId,prompt,delayMs:config.submitDelayMs})}
      catch(error){turnStore.finish(runtimeId,turnId,turnEvent.error(turnId,error.message));throw Object.assign(error,{streamStarted:true})}
      return {turnId};
    },
    async ingestRaw(raw){
      const result=ingressChain.then(()=>processRaw(raw));
      ingressChain=result.catch(()=>undefined);
      return result;
    },
    async stop({runtimeId,turnId}){
      if(!turnId||registry.get()?.runtimeId!==runtimeId)throw Object.assign(new Error('runtimeId/turnId mismatch'),{statusCode:409});
      if(stopOperations.has(turnId))return stopOperations.get(turnId);
      if(finished.get(turnId)?.runtimeId===runtimeId){record('duplicate_stop',turnId);return {ok:true,status:'already_stopped',turnId,turnReleased:true}}
      if(!turnStore.matches(runtimeId,turnId)){record('stale_stop_rejected',turnId);throw Object.assign(new Error('turnId mismatch'),{statusCode:409})}
      const turn=turnStore.requestStop(runtimeId,turnId);
      record('stop_requested',turnId);
      const operation=Promise.resolve().then(async()=>{
        const result=await transport.interrupt(registry.get().sessionName,turnId);
        record('bridge_stop_result',turnId,{stopSent:result?.stopSent===true,turnReleased:result?.turnReleased===true});
        if(result?.turnId===turnId&&result.turnReleased===true&&(result.stopSent===true||result.status==='already_stopped')){
          const hookConfirmed=!turnStore.matches(runtimeId,turnId);
          if(!hookConfirmed)await finalize(turn,turnEvent.stopped(turnId),{released:true});
          return {ok:true,status:hookConfirmed?'stopped':'stop_unconfirmed',turnId,stopSent:result.stopSent,turnReleased:true};
        }
        // Legacy transports without a release acknowledgement still require a hook.
        const confirmed=await turnStore.waitForInactive(runtimeId,turnId,config.stopTimeoutMs);
        return confirmed?{ok:true,status:'stopped',turnId}:{ok:false,status:'stop_unconfirmed',error:'已发送 Escape，但当前回复尚未确认停止。'};
      }).finally(()=>stopOperations.delete(turnId));
      stopOperations.set(turnId,operation);
      return operation;
    },
    turnStatus(turnId){const result=turnStore.status(turnId);record('recovery_status_query',turnId,{state:result?.state||'unknown'});return result},
    turnEvents(turnId,afterSeq){const result=turnStore.replay(turnId,afterSeq);record('recovery_events_query',turnId,{state:result?.state||'unknown',afterSeq});return result},
    activeTurnId(){return turnStore.get()?.turnId||null},
    hasActiveTurn(){return !!turnStore.get()},
    quiescence(){const journal=turnStore.quiescence?.();return {runtimeActive:!!turnStore.get(),activeTurnId:turnStore.get()?.turnId||null,unfinishedJournalCount:journal?.unfinishedJournalCount,finalizationInProgress:finalizations>0,pendingClientRequestCount:journal?.pendingClientRequestCount}},
    isTerminalEvent:terminal
  };
}
