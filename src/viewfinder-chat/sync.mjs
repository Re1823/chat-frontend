import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
const REQUEST_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_TEXT=/screenpeek/i;
const DISABLE_TEXT=/(不用|关闭|停止|结束|退出|停用)/;

export async function productionClaudeIdentity({socket,session='dwell-claude'}={}){
  if(process.platform!=='linux')return null;
  const targetSocket=socket||'/run/qiuqiu-claude-bridge/dwell-frontend.sock';
  const candidate=async pid=>{
    const command=(await readFile(`/proc/${pid}/cmdline`)).toString().split('\0');
    const resume=command.indexOf('--resume'),mcp=command.indexOf('--mcp-config'),workspace=command.indexOf('--add-dir');
    return command[0]==='/usr/bin/claude'&&resume>=0&&/^[0-9a-f-]{36}$/i.test(command[resume+1]||'')&&command[mcp+1]==='/root/.config/qiuqiu/frontend-message.mcp.json'&&command[workspace+1]==='/opt/qiuqiu/chat-frontend'?`${pid}:${command[resume+1]}`:null;
  };
  try{
    const {stdout}=await execFileAsync('/usr/bin/tmux',['-S',targetSocket,'display-message','-p','-t',session,'#{pane_pid}'],{timeout:3000});
    const pid=Number(stdout.trim());
    if(Number.isSafeInteger(pid)&&pid>0)return await candidate(pid);
  }catch{}
  const pids=(await readdir('/proc')).filter(name=>/^\d+$/.test(name));
  const matches=(await Promise.all(pids.map(async pid=>{try{return (await readFile(`/proc/${pid}/comm`,'utf8')).trim()==='claude'?await candidate(Number(pid)):null}catch{return null}}))).filter(Boolean);
  return matches.length===1?matches[0]:null;
}

export function createViewfinderChatSync({turnQueue,postBridge,identity=async()=>null,now=Date.now,heartbeatMs=60000,maxEvents=512}={}){
  if(!turnQueue||typeof postBridge!=='function')throw new TypeError('ScreenPeek needs the production turn queue and bridge client');
  let enabled=false,epoch=null,expiresAt=0,owner=null,sequence=0,sendTail=Promise.resolve();
  const events=[],turns=new Map();
  const snapshot=()=>({enabled,connected:enabled&&expiresAt>now(),epoch:enabled?epoch:null});
  const current=e=>enabled&&epoch===e&&expiresAt>now();
  const append=value=>{const event={...value,id:++sequence};events.push(event);if(events.length>maxEvents)events.shift();return event};
  const disable=reason=>{const prior=epoch;enabled=false;epoch=null;expiresAt=0;owner=null;if(prior&&reason)console.warn('[screenpeek-sync] disabled:',reason);return prior};
  const queueBridge=(expected,payload)=>{
    sendTail=sendTail.catch(()=>{}).then(async()=>{
      if(!current(expected))return;
      try{const result=await postBridge('/api/internal/vf-chat-event',{epoch:expected,...payload});if(result?.ok!==true)throw Error('bridge_rejected_event')}
      catch(error){if(current(expected))disable(`bridge_event_${error?.message||'failed'}`)}
    });
  };
  const validOwner=async()=>{if(!enabled)return false;const checking=epoch,expected=owner;let found=null;try{found=await identity()}catch{}if(epoch!==checking)return false;if(!found||found!==expected){disable('production_identity_changed');return false}return true};
  const bridgeStatus=async()=>{try{return await postBridge('/api/internal/vf-chat-status',{})}catch{return {connected:false}}};
  return {
    snapshot,
    async status(){if(enabled)await validOwner();const bridge=await bridgeStatus();return {...snapshot(),connected:bridge?.connected===true&&snapshot().connected}},
    async set(enabledRequest){
      if(enabledRequest!==true&&enabledRequest!==false)throw Error('invalid_enabled');
      if(!enabledRequest){const prior=disable('requested_off');if(prior)try{await postBridge('/api/internal/vf-chat-sync',{enabled:false,epoch:prior})}catch{}return {ok:true,enabled:false,connected:(await bridgeStatus())?.connected===true}}
      let found=null;try{found=await identity()}catch{}
      if(!found)return {ok:false,enabled:false,connected:false,error:'production_session_unavailable'};
      const next=randomUUID();let reply;
      try{reply=await postBridge('/api/internal/vf-chat-sync',{enabled:true,epoch:next})}catch{return {ok:false,enabled:false,connected:false,error:'viewfinder_unavailable'}}
      if(reply?.ok!==true||reply?.connected!==true)return {ok:false,enabled:false,connected:false,error:reply?.error||'viewfinder_offline'};
      enabled=true;epoch=next;expiresAt=now()+heartbeatMs;owner=found;
      return {ok:true,enabled:true,connected:true};
    },
    async heartbeat(requestEpoch){if(!current(requestEpoch)||!await validOwner()||!current(requestEpoch))return {ok:false,enabled:false,error:'sync_disabled'};expiresAt=now()+heartbeatMs;return {ok:true,enabled:true}},
    disconnected(requestEpoch){if(epoch===requestEpoch)disable('bridge_disconnected');return {ok:true,enabled:false}},
    events(after=0){return {enabled:current(epoch),epoch:current(epoch)?epoch:null,latestId:sequence,events:events.filter(event=>event.id>after)}},
    accepted({clientRequestId,text,source,acceptedEpoch}){
      if(!acceptedEpoch||!current(acceptedEpoch))return;
      if(source==='pwa'&&CONTROL_TEXT.test(text)&&DISABLE_TEXT.test(text))return;
      if(turns.has(clientRequestId))return;
      turns.set(clientRequestId,{epoch:acceptedEpoch,source,segments:[],turnId:null});
      append({type:'user_message',clientRequestId,text,source,epoch:acceptedEpoch});
      if(source==='pwa'&&text.trim())queueBridge(acceptedEpoch,{eventId:`u:${clientRequestId}`,type:'resend',text});
    },
    turnEvent(clientRequestId,event){
      const turn=turns.get(clientRequestId);if(!turn||!event)return;
      if(event.type==='turn_started'){
        turn.turnId=event.turnId;
        if(current(turn.epoch))queueBridge(turn.epoch,{eventId:`s:${clientRequestId}`,type:'delta'});
      }
      if(event.type==='assistant_message'&&event.source==='tool'&&typeof event.text==='string'&&event.text.trim()&&typeof event.messageId==='string'&&!turn.segments.some(item=>item.messageId===event.messageId)){
        turn.segments.push({messageId:event.messageId,text:event.text});
        if(current(turn.epoch)||turn.source==='screenpeek')append({type:'assistant_message',clientRequestId,turnId:turn.turnId||event.turnId,messageId:event.messageId,text:event.text,epoch:turn.epoch});
      }
      if(['turn_done','turn_stopped','turn_error'].includes(event.type)){
        if(current(turn.epoch)||turn.source==='screenpeek')append({type:event.type,clientRequestId,turnId:turn.turnId||event.turnId,epoch:turn.epoch});
        if(current(turn.epoch)){
          if(event.type==='turn_done'&&turn.segments.length)queueBridge(turn.epoch,{eventId:`d:${clientRequestId}`,type:'done',text:turn.segments.map(item=>item.text).join('|||')});
          else if(event.type==='turn_error')queueBridge(turn.epoch,{eventId:`e:${clientRequestId}`,type:'error',message:'这次回复未完成，请在 PWA 查看状态。'});
        }
        turns.delete(clientRequestId);
      }
    },
    async submit({epoch:requestEpoch,clientRequestId,text}){
      if(!current(requestEpoch)||!await validOwner())return {ok:false,error:'sync_disabled'};
      if(!REQUEST_ID.test(clientRequestId)||typeof text!=='string'||!text.trim()||text.length>16384)return {ok:false,error:'invalid_message'};
      const buffered=[],subscriber={emit:event=>buffered.push(event),end:()=>{}};
      const result=await turnQueue.enqueue({clientRequestId,source:'user',runtimeId:'claude-main',conversationId:'claude-main',prompt:text.trim(),imageIds:[]},subscriber);
      if(result.created)this.accepted({clientRequestId,text:text.trim(),source:'screenpeek',acceptedEpoch:requestEpoch});
      subscriber.emit=event=>this.turnEvent(clientRequestId,event);
      for(const event of buffered)subscriber.emit(event);
      return {ok:true,accepted:true,created:result.created,clientRequestId,turnId:result.turnId};
    }
  };
}

export function createViewfinderBridgeClient({url='http://127.0.0.1:43100',fetchImpl=fetch}={}){
  return async(path,body)=>{
    const response=await fetchImpl(url+path,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const result=await response.json();if(!response.ok)throw Error(result?.error||`bridge_http_${response.status}`);return result;
  };
}
