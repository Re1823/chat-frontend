import { randomUUID } from 'node:crypto';
import { createFrameBuffer } from '../turns/frame-buffer.mjs';
import { turnEvent } from '../turns/events.mjs';

const terminal=event=>['turn_done','turn_stopped','turn_error'].includes(event.type);

export function createClaudeTmuxRuntime({config,transport,registry,turnStore,ingress,frameBufferFactory=createFrameBuffer}){
  let reconciliation={state:'uninitialized',runtime:null};
  let frames=frameBufferFactory();
  let ingressChain=Promise.resolve();
  const emittedSegmentDone=new Set();
  const statusError=state=>state==='missing'?'Claude Code tmux session 不存在':state==='exited'?'Claude Code 已退出':state==='unconfigured'?'Claude tmux runtime 尚未配置':'Claude tmux runtime 当前不可用';
  const emitSegmentDone=(turn,runtimeId)=>{if(emittedSegmentDone.has(turn.turnId))return;emittedSegmentDone.add(turn.turnId);turnStore.emit(runtimeId,turn.turnId,turnEvent.segmentDone(turn.turnId))};
  const finalize=async(turn,event)=>{
    turnStore.finish(turn.runtimeId,turn.turnId,event);
    await transport.complete?.(turn.turnId);
  };
  const processRaw=async raw=>{
    const turn=turnStore.get();if(!turn)return {accepted:false,reason:'no_active_turn'};
    const frame=await ingress.adapt(raw,{runtimeId:turn.runtimeId});if(!frame)return {accepted:false,reason:'ignored'};
    if(frame.kind==='assistant_frame'){
      for(const item of frames.push(frame)){
        if(item.kind==='assistant_frame')turnStore.emit(turn.runtimeId,turn.turnId,turnEvent.delta(turn.turnId,item.text));
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
      if(turnStore.get())throw Object.assign(new Error('Claude tmux runtime 当前已有活动回复'),{statusCode:409});
      return state.runtime;
    },
    async chat({runtimeId,prompt,emit,signal,turnId=randomUUID()}){
      const runtime=await this.preflight(runtimeId);
      if(signal?.aborted)throw Object.assign(new Error('client disconnected'),{statusCode:499});
      turnStore.start({runtimeId,turnId,emit});frames=frameBufferFactory();
      try{
        if(signal?.aborted){turnStore.discard(runtimeId,turnId);throw Object.assign(new Error('client disconnected'),{statusCode:499})}
        turnStore.emit(runtimeId,turnId,turnEvent.started(turnId));
        if(signal?.aborted){turnStore.discard(runtimeId,turnId);throw Object.assign(new Error('client disconnected'),{statusCode:499})}
        await transport.sendPrompt({sessionName:runtime.sessionName,turnId,prompt,delayMs:config.submitDelayMs});
      }catch(error){
        if(turnStore.matches(runtimeId,turnId)){
          try{turnStore.finish(runtimeId,turnId,turnEvent.error(turnId,error.message))}catch{}
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
      const turn=turnStore.requestStop(runtimeId,turnId);
      const runtime=registry.get();
      await transport.interrupt(runtime.sessionName,turnId);
      const confirmed=await turnStore.waitForInactive(runtimeId,turnId,config.stopTimeoutMs);
      return confirmed?{ok:true,status:'stopped'}:{ok:false,status:'stop_unconfirmed',error:'已发送 Escape，但当前回复尚未确认停止。'};
    },
    hasActiveTurn(){return !!turnStore.get()},
    isTerminalEvent:terminal
  };
}
