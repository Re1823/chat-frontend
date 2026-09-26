import {mkdir,open,readFile,rename,rm,chmod} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';

const REQUEST_ID=/^[A-Za-z0-9_-]{1,128}$/;
const ACTIVE_STATES=new Set(['dispatching','active','delivery_uncertain']);
const TERMINAL_STATES=new Set(['finished','failed','delivery_failed']);
const clone=value=>JSON.parse(JSON.stringify(value));

export function createDurableTurnQueue({
  path,
  dispatch,
  canDispatch=async()=>true,
  now=()=>Date.now(),
  createTurnId=randomUUID,
  retryMs=250,
  retentionMs=20*60*1000,
  maxPending=128,
  setTimer=setTimeout,
  clearTimer=clearTimeout,
  reconcileInterrupted=null,
  log=()=>{}
}={}){
  if(!path||typeof dispatch!=='function')throw new Error('durable turn queue requires path and dispatch');
  let records=[],running=false,timer=null,initialized=false,persistChain=Promise.resolve();
  const subscribers=new Map();
  const iso=()=>new Date(now()).toISOString();
  const find=id=>records.find(item=>item.clientRequestId===id);
  const publicRecord=item=>item?{status:item.status,clientRequestId:item.clientRequestId,turnId:item.turnId||null,createdAt:item.createdAt,updatedAt:item.updatedAt,finishedAt:item.finishedAt||null,error:item.error||null,errorCode:item.errorCode||null}:null;
  const safeRecords=()=>records.map(item=>({...item,imageIds:[...(item.imageIds||[])]}));
  const writeState=async()=>{
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const temp=join(dirname(path),`.turn-queue-${process.pid}-${Date.now()}.tmp`),handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({version:1,records:safeRecords()},null,2)+'\n');await handle.sync();await handle.close();await rename(temp,path);await chmod(path,0o600);if(process.platform!=='win32'){const directory=await open(dirname(path),'r');await directory.sync();await directory.close()}}
    catch(error){await handle.close().catch(()=>{});await rm(temp,{force:true});throw error}
  };
  const persist=()=>{persistChain=persistChain.then(writeState,writeState);return persistChain};
  const gc=()=>{const cutoff=now()-retentionMs;records=records.filter(item=>!TERMINAL_STATES.has(item.status)||Date.parse(item.finishedAt||item.updatedAt)>=cutoff)};
  const addSubscriber=(id,subscriber)=>{if(!subscriber)return;let set=subscribers.get(id);if(!set){set=new Set();subscribers.set(id,set)}set.add(subscriber)};
  const broadcast=(item,event)=>{for(const subscriber of subscribers.get(item.clientRequestId)||[]){try{subscriber.emit?.(event)}catch{}}};
  const closeSubscribers=item=>{for(const subscriber of subscribers.get(item.clientRequestId)||[]){try{subscriber.end?.()}catch{}}subscribers.delete(item.clientRequestId)};
  const schedule=()=>{if(timer!==null||running)return;timer=setTimer(()=>{timer=null;void pump()},retryMs);timer?.unref?.()};
  const setPending=async(item,error)=>{item.status='pending';item.updatedAt=iso();item.error=error?String(error.message||error).slice(0,200):null;item.errorCode=error?.code||null;await persist();schedule()};
  const finish=async(item,state,error=null,{preservePrompt=false,errorCode=null}={})=>{item.status=state;item.updatedAt=item.finishedAt=iso();item.error=error?String(error.message||error).slice(0,200):null;item.errorCode=errorCode;if(!preservePrompt)delete item.prompt;item.imageIds=[];await persist();closeSubscribers(item)};
  const reconcileActive=async item=>{
    if(typeof reconcileInterrupted!=='function')return;
    try{
      const result=await reconcileInterrupted(clone(item));
      if(result?.type==='turn_error'&&result.code==='DELIVERY_NOT_ACCEPTED'){broadcast(item,result);await finish(item,'delivery_failed',result.error,{preservePrompt:true,errorCode:result.code});schedule();return}
      item.status=result?.state==='input_accepted'?'active':'delivery_uncertain';item.updatedAt=iso();item.error=result?.state==='input_accepted'?null:String(result?.code||result?.reason||'DELIVERY_UNCERTAIN').slice(0,200);await persist();schedule();
    }catch(error){item.status='delivery_uncertain';item.updatedAt=iso();item.error=String(error?.code||error?.message||error).slice(0,200);await persist();schedule()}
  };
  const pump=async()=>{
    if(running)return;running=true;
    try{
      while(true){
        gc();const unresolved=records.find(record=>record.status==='delivery_uncertain');if(unresolved){await reconcileActive(unresolved);if(ACTIVE_STATES.has(unresolved.status))break;continue}
        if(records.some(record=>ACTIVE_STATES.has(record.status)))break;
        const item=records.find(record=>record.status==='pending');
        if(!item)break;
        if(!await canDispatch(item)){schedule();break}
        item.turnId||=createTurnId();item.status='dispatching';item.updatedAt=iso();await persist();
        let terminal=null;
        const emit=event=>{
          if(event?.type==='turn_started'){item.status='active';item.updatedAt=iso();void persist().catch(()=>{})}
          if(['turn_done','turn_stopped','turn_error'].includes(event?.type))terminal=event;
          broadcast(item,event);
        };
        try{
          await dispatch(clone(item),emit);
          if(!terminal)throw Object.assign(new Error('turn ended without a terminal event'),{retryableBeforeDispatch:false});
          await finish(item,terminal.type==='turn_error'&&terminal.code==='DELIVERY_NOT_ACCEPTED'?'delivery_failed':terminal.type==='turn_error'?'failed':'finished',terminal.type==='turn_error'?terminal.error:null,{preservePrompt:terminal.code==='DELIVERY_NOT_ACCEPTED',errorCode:terminal.type==='turn_error'?terminal.code||'REPLY_FAILED':null});
        }catch(error){
          if(error?.retryableBeforeDispatch===true){await setPending(item,error);break}
          if(!terminal)broadcast(item,{type:'turn_error',turnId:item.turnId,error:String(error?.message||'reply_failed')});
          await finish(item,'failed',error);
        }
      }
    }catch(error){log({event:'turn_queue_worker_error',error:String(error?.message||error).slice(0,200)});schedule()}
    finally{running=false;if(records.some(item=>item.status==='pending'||item.status==='delivery_uncertain')&&timer===null)schedule()}
  };
  return {
    async initialize(){
      if(initialized)return this.snapshot();
      try{const value=JSON.parse(await readFile(path,'utf8'));records=Array.isArray(value?.records)?value.records:[]}catch(error){if(error.code!=='ENOENT')throw error;records=[]}
      for(const item of records)if(['dispatching','active'].includes(item.status)){item.status='delivery_uncertain';item.error='server_restarted_during_active_turn';item.updatedAt=iso();item.finishedAt=null}
      gc();await persist();initialized=true;if(records.some(item=>item.status==='pending'||item.status==='delivery_uncertain'))schedule();return this.snapshot();
    },
    async enqueue(request,subscriber){
      if(!initialized)await this.initialize();
      const id=String(request?.clientRequestId||'');if(!REQUEST_ID.test(id))throw Object.assign(new Error('invalid_client_request_id'),{statusCode:400});
      const existing=find(id);addSubscriber(id,subscriber);
      if(existing){subscriber?.emit?.({type:'turn_queued',clientRequestId:id,queueState:existing.status,turnId:existing.turnId||null});if(TERMINAL_STATES.has(existing.status))subscriber?.end?.();return {...publicRecord(existing),created:false}}
      if(records.filter(item=>item.status==='pending').length>=maxPending)throw Object.assign(new Error('turn_queue_full'),{statusCode:503});
      const item={clientRequestId:id,runtimeId:String(request.runtimeId||''),conversationId:String(request.conversationId||''),prompt:String(request.prompt||''),imageIds:[...(request.imageIds||[])],status:'pending',turnId:null,createdAt:iso(),updatedAt:iso(),finishedAt:null,error:null,errorCode:null};
      records.push(item);await persist();broadcast(item,{type:'turn_queued',clientRequestId:id,queueState:'pending',turnId:null});void pump();return {...publicRecord(item),created:true};
    },
    unsubscribe(clientRequestId,subscriber){const set=subscribers.get(clientRequestId);if(!set)return;set.delete(subscriber);if(!set.size)subscribers.delete(clientRequestId)},
    recovery(clientRequestId){const item=find(clientRequestId);if(!item)return {status:'NOT_FOUND'};if(item.status==='pending'||item.status==='dispatching')return {status:'PENDING',queueState:item.status,turnId:item.turnId||null};if(ACTIVE_STATES.has(item.status))return {status:'FOUND',queueState:item.status,turnId:item.turnId,finished:false};return {status:'FOUND',queueState:item.status,turnId:item.turnId,finished:true,error:item.error||null,errorCode:item.errorCode||null}},
    snapshot(){const pending=records.filter(item=>item.status==='pending').length,active=records.filter(item=>ACTIVE_STATES.has(item.status)).length,streamSubscribers=[...subscribers.values()].reduce((sum,set)=>sum+set.size,0);return {initialized,pending,active,total:records.length,running,streamSubscribers,oldestPendingAt:records.find(item=>item.status==='pending')?.createdAt||null,items:records.map(publicRecord)}},
    async drain(){await pump();return this.snapshot()},
    records:()=>safeRecords(),
    close(){if(timer!==null)clearTimer(timer);timer=null;subscribers.clear()}
  };
}
