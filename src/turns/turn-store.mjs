export function createTurnStore({journalTtlMs=20*60*1000,maxTurns=256,maxEventsPerTurn=4096,maxBytesPerTurn=2*1024*1024,maxTotalBytes=16*1024*1024,now=()=>Date.now()}={}){
  let active=null;
  const metadata=new Map();
  const requestIndex=new Map();
  let totalJournalBytes=0;
  const iso=()=>new Date(now()).toISOString();
  const update=(id,patch)=>{const item=metadata.get(id);if(item)Object.assign(item,patch,{updatedAt:iso()})};
  const publicStatus=item=>item?{turnId:item.turnId,clientRequestId:item.clientRequestId,state:item.state,active:item.active,receivedByRuntime:item.receivedByRuntime,hasOutput:item.hasOutput,finished:item.finished,stopped:item.stopped,error:item.error,detached:item.detached,createdAt:item.createdAt,updatedAt:item.updatedAt,completedAt:item.completedAt}:null;
  const remove=id=>{const item=metadata.get(id);if(!item)return;totalJournalBytes-=item.journalBytes;metadata.delete(id);if(item.clientRequestId)requestIndex.set(item.clientRequestId,{status:'EXPIRED',expiresAt:now()+journalTtlMs})};
  const gc=()=>{
    const cutoff=now()-journalTtlMs;
    for(const [id,item] of requestIndex)if(item.status==='EXPIRED'&&item.expiresAt<=now())requestIndex.delete(id);
    for(const [id,item] of metadata)if(item.finished&&Date.parse(item.completedAt||item.updatedAt)<cutoff)remove(id);
    while(metadata.size>maxTurns){const oldest=[...metadata].find(([,item])=>item.finished);if(!oldest)break;remove(oldest[0])}
    while(totalJournalBytes>maxTotalBytes){const oldest=[...metadata].find(([,item])=>item.finished);if(!oldest)break;remove(oldest[0])}
  };
  const append=(turn,event)=>{
    gc();
    const item=metadata.get(turn.turnId);if(!item)throw new Error('活动 turn 不存在或不匹配');
    const journalEvent={...event,seq:item.nextSeq++,timestamp:iso()};
    const bytes=Buffer.byteLength(JSON.stringify(journalEvent),'utf8');
    while(totalJournalBytes+bytes>maxTotalBytes){const oldest=[...metadata].find(([id,value])=>id!==turn.turnId&&value.finished);if(!oldest)break;remove(oldest[0])}
    if(item.recoverable&&(item.events.length>=maxEventsPerTurn||item.journalBytes+bytes>maxBytesPerTurn||totalJournalBytes+bytes>maxTotalBytes)){
      totalJournalBytes-=item.journalBytes;item.events=[];item.journalBytes=0;item.recoverable=false;item.journalOverflow=true;
    }
    if(item.recoverable){item.events.push(journalEvent);item.journalBytes+=bytes;totalJournalBytes+=bytes}
    update(turn.turnId,{latestSeq:journalEvent.seq});
    return journalEvent;
  };
  const deliver=(turn,event)=>{try{turn.emit?.(event)}catch{update(turn.turnId,{detached:true});turn.emit=null}};
  const endMetadata=(turn,event)=>update(turn.turnId,{active:false,finished:true,completedAt:iso(),stopped:event.type==='turn_stopped',state:event.type==='turn_stopped'?'stopped':event.type==='turn_error'?'error':'finished',error:event.type==='turn_error'?'reply_failed':null});
  const inactiveWaiters=new Set();
  const settleWaiters=()=>{for(const resolve of inactiveWaiters)resolve(true);inactiveWaiters.clear()};
  const requireActive=(runtimeId,turnId)=>{
    if(!active||active.runtimeId!==runtimeId||active.turnId!==turnId)throw new Error('活动 turn 不存在或不匹配');
    return active;
  };
  const close=(turn,event)=>{
    if(turn.closed)return false;
    const journalEvent=append(turn,event);endMetadata(turn,event);turn.closed=true;turn.state=event.type;active=null;settleWaiters();deliver(turn,journalEvent);gc();return true;
  };
  return {
    reserveRequest(clientRequestId){
      gc();if(!clientRequestId)return {status:'UNTRACKED',created:true};
      const existing=requestIndex.get(clientRequestId);if(existing)return {status:existing.status,turnId:existing.turnId||null,created:false};
      requestIndex.set(clientRequestId,{status:'PENDING',turnId:null,createdAt:iso()});return {status:'PENDING',turnId:null,created:true};
    },
    releaseRequest(clientRequestId){const item=requestIndex.get(clientRequestId);if(item?.status==='PENDING'&&!item.turnId)requestIndex.delete(clientRequestId)},
    requestRecovery(clientRequestId){
      gc();const request=requestIndex.get(clientRequestId);if(!request)return {status:'NOT_FOUND'};
      if(request.status==='PENDING')return {status:'PENDING'};
      if(request.status==='EXPIRED')return {status:'EXPIRED'};
      const item=metadata.get(request.turnId);if(!item)return {status:'EXPIRED'};
      return {status:'FOUND',turnId:item.turnId,state:item.state,active:item.active,receivedByRuntime:item.receivedByRuntime,finished:item.finished,recoverable:item.recoverable,journalOverflow:item.journalOverflow,latestSeq:item.latestSeq,createdAt:item.createdAt,updatedAt:item.updatedAt,completedAt:item.completedAt};
    },
    start({runtimeId,turnId,emit,clientRequestId=null}){
      if(active)throw Object.assign(new Error('Claude tmux runtime 当前已有活动回复'),{statusCode:409});
      if(clientRequestId){const request=requestIndex.get(clientRequestId);if(request?.turnId&&request.turnId!==turnId)throw Object.assign(new Error('clientRequestId 已绑定其他 turn'),{statusCode:409});requestIndex.set(clientRequestId,{status:'FOUND',turnId,createdAt:request?.createdAt||iso()})}
      const createdAt=iso();metadata.set(turnId,{turnId,clientRequestId,state:'pre_turn',active:true,receivedByRuntime:false,hasOutput:false,finished:false,stopped:false,error:null,detached:false,createdAt,updatedAt:createdAt,completedAt:null,nextSeq:1,latestSeq:0,events:[],journalBytes:0,recoverable:true,journalOverflow:false});
      gc();
      active={runtimeId,turnId,emit,state:'running',closed:false};
      return active;
    },
    get(){return active},
    quiescence(){gc();const values=[...metadata.values()];return {unfinishedJournalCount:values.filter(item=>item.active&&!item.finished).length,pendingClientRequestCount:[...requestIndex.values()].filter(item=>item.status==='PENDING').length}},
    status(turnId){gc();return publicStatus(metadata.get(turnId))},
    replay(turnId,afterSeq=0){
      gc();const item=metadata.get(turnId);if(!item)return null;
      return {...publicStatus(item),events:item.recoverable?item.events.filter(event=>event.seq>afterSeq).map(event=>({...event})):[],latestSeq:item.latestSeq,recoverable:item.recoverable,journalOverflow:item.journalOverflow};
    },
    sending(turnId){update(turnId,{state:'sending',receivedByRuntime:null})},
    received(turnId){const value=metadata.get(turnId);update(turnId,{receivedByRuntime:true,...(!value?.finished?{state:value?.hasOutput?'streaming':'received'}:{})})},
    detached(turnId){update(turnId,{detached:true});if(active?.turnId===turnId)active.emit=null},
    matches(runtimeId,turnId){return !!active&&active.runtimeId===runtimeId&&active.turnId===turnId},
    emit(runtimeId,turnId,event){const turn=requireActive(runtimeId,turnId);if(turn.closed)return false;const journalEvent=append(turn,event);if(event.type==='segment_delta'||event.type==='assistant_message')update(turnId,{hasOutput:true,receivedByRuntime:true,state:'streaming'});deliver(turn,journalEvent);return true},
    requestStop(runtimeId,turnId){const turn=requireActive(runtimeId,turnId);if(turn.state==='running')turn.state='stop_requested';return turn},
    finish(runtimeId,turnId,event){return close(requireActive(runtimeId,turnId),event)},
    discard(runtimeId,turnId){const turn=requireActive(runtimeId,turnId);if(turn.closed)return false;update(turnId,{active:false,finished:true,completedAt:iso(),state:'not_delivered',receivedByRuntime:false});turn.closed=true;turn.state='discarded';active=null;settleWaiters();gc();return true},
    waitForInactive(runtimeId,turnId,timeoutMs){
      if(!this.matches(runtimeId,turnId))return Promise.resolve(true);
      return new Promise(resolve=>{const timer=setTimeout(()=>{inactiveWaiters.delete(done);resolve(false)},timeoutMs);const done=value=>{clearTimeout(timer);resolve(value)};inactiveWaiters.add(done)});
    }
  };
}
