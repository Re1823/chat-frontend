import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createApiRequest, extractTextDelta } from './src/providers/api-runtime.mjs';
import { turnEvent, writeTurnEvent } from './src/turns/events.mjs';
import { loadClaudeTmuxConfig } from './src/config.mjs';
import { createTmuxTransport } from './src/runtimes/tmux-transport.mjs';
import { createRootBridgeTransport } from './src/runtimes/root-bridge-transport.mjs';
import { createRuntimeRegistry } from './src/runtimes/runtime-registry.mjs';
import { createTurnStore } from './src/turns/turn-store.mjs';
import { createClaudeIngress } from './src/hooks/claude-ingress.mjs';
import { createRawHookCapture } from './src/hooks/raw-capture.mjs';
import { createClaudeTmuxRuntime } from './src/runtimes/claude-tmux.mjs';
import { createOmbreDashboardService } from './src/ombre-dashboard/service.mjs';
import { createOmbreDashboardRoutes } from './src/ombre-dashboard/routes.mjs';
import { qiuqiuReadiness } from './src/readiness.mjs';
import { loadLocalEnv } from './src/local-env.mjs';
import { createModelUpstreamPolicy } from './src/security/model-upstream-policy.mjs';
import { createImageStore, IMAGE_ID_PATTERN } from './src/photos/image-store.mjs';
import { receiveImageUpload } from './src/photos/upload.mjs';
import { createPhotosStore } from './src/photos/photos-store.mjs';
import { createPhotosMcpHandler, photosMcpTools } from './src/photos/photos-mcp.mjs';
import {createProductionRscStateStore,createProductionRscCoordinator} from './src/runtimes/rsc/production-state.mjs';
import {createRuntimeObservability} from './src/runtimes/rsc/runtime-observability.mjs';
import {createDurableTurnQueue} from './src/turns/durable-turn-queue.mjs';
import {createPushSubscriptionStore} from './src/push/subscription-store.mjs';
import {createPushService} from './src/push/service.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json; charset=utf-8' };
const json = (res, status, data) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
const readBody = req => new Promise((resolve, reject) => { let s=''; req.on('data', c => { s += c; if (s.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch(e) { reject(e); } }); });
const readSmallJson=async(req,maxBytes=32768)=>{if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw Object.assign(new Error('json_content_type_required'),{statusCode:415});let bytes=0,text='';for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>maxBytes)throw Object.assign(new Error('push_request_too_large'),{statusCode:413});text+=chunk}try{return JSON.parse(text||'{}')}catch{throw Object.assign(new Error('invalid_json'),{statusCode:400})}};
const sameSiteRequest=req=>!req.headers['sec-fetch-site']||['same-origin','same-site','none'].includes(String(req.headers['sec-fetch-site']));
const requestOrigin=req=>`${String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim()}://${req.headers.host}`;
const NOTIFICATION_RESUME_DIAGNOSTIC_KEYS=['version','correlationId','sequence','stage','resumePath','displayMode','navigatorStandalone','locationOrigin','locationPathname','sessionsCount','claudeRuntimeSessionCount','activeIdPresent','activeIdValid','restoreSelected','selectedMessageCount','eligibleRecoveryAnchorCount','restoreEntered','recoveryReason','journalReplayAttemptedCount','runtimeRequestExecuted','runtimeHttpStatus','runtimeState','runtimeActive','runtimeActiveTurnPresent','onboarding','onboardingReason'];
const NOTIFICATION_RESUME_STAGES=new Set(['notification_received','local_state','runtime_refresh','recovery','final_render']);
const NOTIFICATION_RECOVERY_REASONS=new Set(['not_reached','no_current_session','non_claude_runtime_session','no_eligible_recovery_anchor','replay_attempted']);
const NOTIFICATION_ONBOARDING_REASONS=new Set(['not_rendered','no_current_session','current_session_empty','not_onboarding']);
const NOTIFICATION_RUNTIME_STATES=new Set(['not_requested','unknown','connected','unreachable','disabled','unsupported_platform','missing','exited']);
const PAGESHOW_DIAGNOSTIC_KEYS=['version','correlationId','sequence','eventPersisted','navigationType','scriptVersion','cacheVersion','visibilityState','displayModeStandalone','navigatorStandalone','locationOrigin','locationPathname','serviceWorkerControllerPresent','memorySessionsCount','memoryActiveIdPresent','memoryActiveIdValid','memoryCurrentSessionPresent','memoryCurrentMessageCount','storageState','storedSessionsCount','storedActiveIdPresent','storedActiveIdValid','storedCurrentSessionPresent','storedCurrentMessageCount','sessionCountMatches','activeSelectionMatches','onboardingVisible','renderReason'];
const PAGESHOW_NAVIGATION_TYPES=new Set(['navigate','reload','back_forward','prerender','unknown']);
const PAGESHOW_VISIBILITY_STATES=new Set(['visible','hidden','prerender','unknown']);
const PAGESHOW_STORAGE_STATES=new Set(['ok','missing','invalid','unavailable']);
const nullableBoolean=value=>value===null||typeof value==='boolean';
const nullableInteger=(value,min,max)=>value===null||(Number.isInteger(value)&&value>=min&&value<=max);
function validNotificationResumeDiagnostic(body,origin){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==NOTIFICATION_RESUME_DIAGNOSTIC_KEYS.length||NOTIFICATION_RESUME_DIAGNOSTIC_KEYS.some(key=>!(key in body)))return false;
  return body.version===1&&/^[0-9a-f]{12}$/.test(body.correlationId)&&Number.isInteger(body.sequence)&&body.sequence>=1&&body.sequence<=5&&NOTIFICATION_RESUME_STAGES.has(body.stage)&&body.resumePath==='notification_existing_client'&&['standalone','browser','unknown'].includes(body.displayMode)&&nullableBoolean(body.navigatorStandalone)&&body.locationOrigin===origin&&['/','other'].includes(body.locationPathname)&&nullableInteger(body.sessionsCount,0,10000)&&nullableInteger(body.claudeRuntimeSessionCount,0,10000)&&nullableBoolean(body.activeIdPresent)&&nullableBoolean(body.activeIdValid)&&nullableBoolean(body.restoreSelected)&&nullableInteger(body.selectedMessageCount,0,100000)&&nullableInteger(body.eligibleRecoveryAnchorCount,0,100000)&&nullableBoolean(body.restoreEntered)&&NOTIFICATION_RECOVERY_REASONS.has(body.recoveryReason)&&nullableInteger(body.journalReplayAttemptedCount,0,100000)&&typeof body.runtimeRequestExecuted==='boolean'&&nullableInteger(body.runtimeHttpStatus,100,599)&&NOTIFICATION_RUNTIME_STATES.has(body.runtimeState)&&nullableBoolean(body.runtimeActive)&&nullableBoolean(body.runtimeActiveTurnPresent)&&nullableBoolean(body.onboarding)&&NOTIFICATION_ONBOARDING_REASONS.has(body.onboardingReason);
}
function validPageshowDiagnostic(body,origin){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==PAGESHOW_DIAGNOSTIC_KEYS.length||PAGESHOW_DIAGNOSTIC_KEYS.some(key=>!(key in body)))return false;
  return body.version===1&&/^[0-9a-f]{12}$/.test(body.correlationId)&&Number.isInteger(body.sequence)&&body.sequence>=1&&body.sequence<=4&&typeof body.eventPersisted==='boolean'&&PAGESHOW_NAVIGATION_TYPES.has(body.navigationType)&&body.scriptVersion==='pwa23'&&body.cacheVersion==='pwa23-pageshow1'&&PAGESHOW_VISIBILITY_STATES.has(body.visibilityState)&&typeof body.displayModeStandalone==='boolean'&&nullableBoolean(body.navigatorStandalone)&&body.locationOrigin===origin&&['/','other'].includes(body.locationPathname)&&typeof body.serviceWorkerControllerPresent==='boolean'&&nullableInteger(body.memorySessionsCount,0,10000)&&typeof body.memoryActiveIdPresent==='boolean'&&typeof body.memoryActiveIdValid==='boolean'&&typeof body.memoryCurrentSessionPresent==='boolean'&&nullableInteger(body.memoryCurrentMessageCount,0,100000)&&PAGESHOW_STORAGE_STATES.has(body.storageState)&&nullableInteger(body.storedSessionsCount,0,10000)&&typeof body.storedActiveIdPresent==='boolean'&&typeof body.storedActiveIdValid==='boolean'&&typeof body.storedCurrentSessionPresent==='boolean'&&nullableInteger(body.storedCurrentMessageCount,0,100000)&&nullableBoolean(body.sessionCountMatches)&&nullableBoolean(body.activeSelectionMatches)&&typeof body.onboardingVisible==='boolean'&&NOTIFICATION_ONBOARDING_REASONS.has(body.renderReason);
}
async function relay(req, res, test=false, suppliedBody,validateUpstream) {
  try {
    const { config:cfg, messages=[] } = suppliedBody||await readBody(req);
    if (!cfg?.key || !cfg?.model) return json(res, 400, { error:'请先填写 API Key 和模型名' });
    const sample = test ? [{role:'user', content:'只回复 OK'}] : messages;
    const call = createApiRequest(cfg, sample, !test);
    if(validateUpstream)await validateUpstream(call.url);
    const upstream = await fetch(call.url, {...call.init,redirect:'error'});
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(()=>{});
      return json(res, upstream.status, { error:`模型上游请求失败（${upstream.status}）` });
    }
    if (test) {
      const data = await upstream.json();
      return json(res, 200, { ok:true, model:data.model || cfg.model });
    }
    const turnId=randomUUID();
    const format=String(req.headers.accept||'').includes('application/x-ndjson')?'ndjson':'sse';
    res.writeHead(200, { 'content-type':format==='ndjson'?'application/x-ndjson; charset=utf-8':'text/event-stream; charset=utf-8', 'cache-control':'no-cache', connection:'keep-alive' });
    writeTurnEvent(res,format,turnEvent.started(turnId));
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder(); let buffer='';
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      buffer += decoder.decode(value, {stream:true});
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') continue;
        try {
          const d = JSON.parse(raw); const delta=extractTextDelta(cfg.protocol,d);
          if (delta) writeTurnEvent(res,format,turnEvent.delta(turnId,delta));
        } catch {}
      }
    }
    writeTurnEvent(res,format,turnEvent.segmentDone(turnId));
    writeTurnEvent(res,format,turnEvent.done(turnId));
    res.end();
  } catch (e) { if (!res.headersSent) json(res,e?.statusCode||502,{error:e?.code||'model_upstream_unavailable'}); else res.end(); }
}

const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address||'');
const secretMatches=(actual,expected)=>{
  const a=Buffer.from(String(actual||'')),b=Buffer.from(String(expected||''));
  return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);
};
const CLAUDE_CHANNEL_TEST_PROMPT='这是前端 Claude 通道测试。不要调用任何工具，不要读取或修改文件，不要调用 Ombre Brain，只回复：前端通道测试成功';
const CLIENT_REQUEST_ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const internalPromptFor=(prompt,images)=>images.length?`<frontend_image_context>\nThis frontend turn includes ${images.length} image attachment${images.length===1?'':'s'} available only through mcp__qiuqiu-frontend__read_frontend_image. Image IDs: ${images.map(image=>image.imageId).join(', ')}. Read them when needed to understand this turn.\n</frontend_image_context>${prompt?`\n\n${prompt}`:''}`:prompt;

export function createClaudeTurnQueue({path,claudeRuntime,imageStore=null,rscCoordinator=null,log=record=>console.info(JSON.stringify(record)),...options}){
  const dispatchLease=async()=>{if(!rscCoordinator)return null;const state=await rscCoordinator.snapshot();if(state.state!=='OPEN'||!state.ownerSessionId)throw Object.assign(new Error('production_owner_unavailable'),{statusCode:503,retryableBeforeDispatch:true});return {sessionId:state.ownerSessionId,generation:state.leaseGeneration}};
  const canDispatch=async()=>{
    if(rscCoordinator&&(await rscCoordinator.snapshot()).state!=='OPEN')return false;
    if(claudeRuntime.hasActiveTurn())return false;
    if(claudeRuntime.canAcceptQueuedTurn&&!await claudeRuntime.canAcceptQueuedTurn())return false;
    try{return (await claudeRuntime.status()).state==='connected'}catch{return false}
  };
  const dispatch=async(item,emit)=>{
    const reservation=claudeRuntime.reserveRequest?.(item.clientRequestId);
    if(reservation&&!reservation.created)throw Object.assign(new Error('duplicate_client_request'),{retryableBeforeDispatch:false});
    let terminalResolve,terminalEvent=null,started=false;
    const terminal=new Promise(resolve=>{terminalResolve=resolve});
    const forward=event=>{if(event?.type==='turn_started')started=true;emit(event);if(claudeRuntime.isTerminalEvent(event)){terminalEvent=event;terminalResolve(event)}};
    const run=async()=>{
      await claudeRuntime.preflight(item.runtimeId);
      const images=item.imageIds?.length?await imageStore?.bind(item.imageIds,{turnId:item.turnId,clientRequestId:item.clientRequestId}):[];
      imageStore?.leaseTurn?.(item.turnId,130000);
      await claudeRuntime.chat({runtimeId:item.runtimeId,prompt:internalPromptFor(item.prompt,images||[]),emit:forward,clientRequestId:item.clientRequestId,turnId:item.turnId,images:images||[],dispatchLease:await dispatchLease()});
    };
    try{
      if(rscCoordinator)await rscCoordinator.submit({clientRequestId:item.clientRequestId,turnId:item.turnId,imageIds:item.imageIds||[],conversationId:item.conversationId},run);else await run();
      await terminal;
    }catch(error){
      if(terminalEvent)return;
      if(!started)claudeRuntime.releaseRequest?.(item.clientRequestId);
      if(!started&&[404,409,503,504].includes(Number(error?.statusCode)))error.retryableBeforeDispatch=true;
      throw error;
    }
  };
  const reconcileInterrupted=async item=>claudeRuntime.recoverInterruptedDelivery?claudeRuntime.recoverInterruptedDelivery({runtimeId:item.runtimeId,turnId:item.turnId,clientRequestId:item.clientRequestId,prompt:internalPromptFor(item.prompt,(item.imageIds||[]).map(imageId=>({imageId}))),createdAt:item.createdAt,dispatchLease:await dispatchLease()}):{state:'delivery_uncertain',code:'RECOVERY_UNSUPPORTED'};
  return createDurableTurnQueue({path,dispatch,canDispatch,reconcileInterrupted,log,...options});
}

export function createDwellServer({claudeRuntime,hookSecret='',frontendDeliverySecret='',ombreService,qiuqiuWorkspace='',validateModelUpstream,imageStore=null,photosStore=null,rscCoordinator=null,rscObservability=null,turnQueue=null,pushStore=null,pushService=null,clientDiagnosticLog=record=>console.info(JSON.stringify(record)) }={}){
  const ombreRoutes=ombreService?createOmbreDashboardRoutes(ombreService):null;
  const photosMcpHandler=photosStore&&imageStore?createPhotosMcpHandler({photosStore,currentTurnId:()=>claudeRuntime?.activeTurnId?.(),readCurrentTurnImage:(imageId,turnId)=>imageStore.readForTurn(imageId,turnId),sendSavedPhoto:(photo,text)=>claudeRuntime.deliverSavedPhoto(photo,text),emitAlbumSaved:photo=>claudeRuntime.emitAlbumSaved(photo)}):null;
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method==='GET'&&req.url==='/api/push/config'){
        res.setHeader('cache-control','no-store');return json(res,200,pushService?.publicConfig?.()||{supported:false,publicKey:null});
      }
      if(['POST','DELETE'].includes(req.method)&&req.url==='/api/push/subscriptions'){
        res.setHeader('cache-control','no-store');if(!sameSiteRequest(req)||req.headers.origin&&req.headers.origin!==requestOrigin(req))return json(res,403,{error:'forbidden'});if(!pushStore||!pushService?.ready)return json(res,503,{error:'push_unavailable'});
        const body=await readSmallJson(req);
        if(req.method==='POST'){if(Object.keys(body).some(key=>!['installationId','subscription'].includes(key)))return json(res,400,{error:'invalid_push_request'});const record=await pushStore.upsert(body);return json(res,201,{ok:true,installationId:record.installationId})}
        if(Object.keys(body).some(key=>!['installationId','endpoint'].includes(key)))return json(res,400,{error:'invalid_push_request'});return json(res,200,{ok:true,removed:await pushStore.remove(body)});
      }
      if(req.method==='POST'&&req.url==='/api/client-diagnostics/notification-resume'){
        res.setHeader('cache-control','no-store');const origin=requestOrigin(req);if(!sameSiteRequest(req)||req.headers.origin!==origin)return json(res,403,{error:'forbidden'});
        const body=await readSmallJson(req,4096);if(!validNotificationResumeDiagnostic(body,origin))return json(res,400,{error:'invalid_notification_resume_diagnostic'});
        clientDiagnosticLog({component:'client_diagnostic',event:'notification_resume',receivedAt:new Date().toISOString(),...body});return json(res,202,{ok:true});
      }
      if(req.method==='POST'&&req.url==='/api/client-diagnostics/pageshow'){
        res.setHeader('cache-control','no-store');const origin=requestOrigin(req);if(!sameSiteRequest(req)||req.headers.origin!==origin)return json(res,403,{error:'forbidden'});
        const body=await readSmallJson(req,4096);if(!validPageshowDiagnostic(body,origin))return json(res,400,{error:'invalid_pageshow_diagnostic'});
        clientDiagnosticLog({component:'client_diagnostic',event:'pageshow_bootstrap_snapshot',receivedAt:new Date().toISOString(),...body});return json(res,202,{ok:true});
      }
      if(req.method==='POST'&&req.url==='/api/internal/frontend-message'){
        if(!loopback(req.socket.remoteAddress)||req.headers.origin)return json(res,403,{ok:false,error:'Forbidden'});
        if(frontendDeliverySecret.length<32||!secretMatches(req.headers['x-frontend-delivery-secret'],frontendDeliverySecret))return json(res,401,{ok:false,error:'Unauthorized'});
        if(!claudeRuntime?.bindFrontendDelivery)return json(res,503,{ok:false,error:'Frontend delivery unavailable'});
        const deliver=claudeRuntime.bindFrontendDelivery();
        // Capture the active turn before awaiting any request bytes.
        req.setEncoding('utf8');let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>131072)return json(res,413,{ok:false,error:'Delivery too large'})}
        let body;try{body=JSON.parse(text)}catch{return json(res,400,{ok:false,error:'Invalid JSON'})}
        return json(res,200,deliver(body,req.headers['x-frontend-delivery-id']));
      }
      if(req.method==='POST'&&req.url==='/api/internal/frontend-image'){
        if(!loopback(req.socket.remoteAddress)||req.headers.origin)return json(res,403,{error:'Forbidden'});
        if(frontendDeliverySecret.length<32||!secretMatches(req.headers['x-frontend-delivery-secret'],frontendDeliverySecret))return json(res,401,{error:'Unauthorized'});
        if(!imageStore||!claudeRuntime?.activeTurnId?.())return json(res,409,{error:'No active frontend turn'});
        const body=await readBody(req); if(Object.keys(body).length!==1||!IMAGE_ID_PATTERN.test(String(body.imageId||'')))return json(res,400,{error:'invalid_image_id'});
        const image=await imageStore.readForTurn(body.imageId,claudeRuntime.activeTurnId());
        res.writeHead(200,{'content-type':image.mime,'content-length':image.data.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(image.data);return;
      }
      if(req.method==='POST'&&req.url==='/api/internal/photos-tool'){
        if(!loopback(req.socket.remoteAddress)||req.headers.origin)return json(res,403,{error:'Forbidden'});
        if(frontendDeliverySecret.length<32||!secretMatches(req.headers['x-frontend-delivery-secret'],frontendDeliverySecret))return json(res,401,{error:'Unauthorized'});
        if(!photosMcpHandler)return json(res,503,{error:'Photos unavailable'});const body=await readBody(req);
        if(Object.keys(body).some(key=>!['name','arguments'].includes(key))||!photosMcpTools.some(tool=>tool.name===body.name))return json(res,400,{error:'Invalid Photos tool'});
        return json(res,200,await photosMcpHandler({name:body.name,arguments:body.arguments||{}}));
      }
      if(req.method==='POST'&&req.url==='/api/internal/claude-code/events'){
        if(!loopback(req.socket.remoteAddress))return json(res,403,{ok:false,error:'Forbidden'});
        if(!secretMatches(req.headers['x-dwell-hook-secret'],hookSecret))return json(res,401,{ok:false,error:'Unauthorized'});
        const body=await readBody(req);
        const result=await claudeRuntime.ingestRaw(body);
        return json(res,200,{ok:true,...result});
      }
      if(req.method==='POST'&&req.url==='/api/internal/claude-code/test-turn'){
        if(!loopback(req.socket.remoteAddress))return json(res,403,{ok:false,error:'Forbidden'});
        if(!secretMatches(req.headers['x-dwell-hook-secret'],hookSecret))return json(res,401,{ok:false,error:'Unauthorized'});
        const body=await readBody(req);
        if(Object.keys(body).length!==1||body.op!=='run_minimal_test')return json(res,400,{ok:false,error:'Invalid diagnostic request'});
        res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-cache',connection:'close'});
        const emit=event=>{writeTurnEvent(res,'ndjson',event);if(claudeRuntime.isTerminalEvent(event))res.end()};
        const lease=rscCoordinator?await rscCoordinator.snapshot():null;
        try{await claudeRuntime.diagnosticChat({runtimeId:'claude-main',prompt:CLAUDE_CHANNEL_TEST_PROMPT,emit,dispatchLease:lease?{sessionId:lease.ownerSessionId,generation:lease.leaseGeneration}:null})}catch(error){if(!error.streamStarted)throw error}
        return;
      }
      const turnStatusMatch=req.method==='GET'&&new URL(req.url,'http://local').pathname.match(/^\/api\/chat\/turn\/([A-Za-z0-9_-]{1,128})\/status$/);
      if(turnStatusMatch){
        res.setHeader('cache-control','no-store');
        const result=claudeRuntime?.turnStatus?.(turnStatusMatch[1]);
        return result?json(res,200,result):json(res,404,{turnId:turnStatusMatch[1],state:'unknown',receivedByRuntime:null});
      }
      const requestRecoveryMatch=req.method==='GET'&&new URL(req.url,'http://local').pathname.match(/^\/api\/chat\/recovery\/by-request\/([^/]+)$/);
      if(requestRecoveryMatch){
        res.setHeader('cache-control','no-store');
        const clientRequestId=decodeURIComponent(requestRecoveryMatch[1]);
        if(!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId))return json(res,400,{status:'INVALID'});
        let result=rscObservability?await rscObservability.recovery(async()=>claudeRuntime?.requestRecovery?.(clientRequestId)||{status:'NOT_FOUND'}):claudeRuntime?.requestRecovery?.(clientRequestId)||{status:'NOT_FOUND'};
        if(result.status==='NOT_FOUND'&&turnQueue)result=turnQueue.recovery(clientRequestId);
        return json(res,result.status==='NOT_FOUND'?404:200,result);
      }
      if(req.method==='GET'&&req.url==='/api/chat/queue/status'){
        res.setHeader('cache-control','no-store');const state=turnQueue?.snapshot?.()||{initialized:false,pending:0,active:0};
        return json(res,200,{initialized:state.initialized,pending:state.pending,active:state.active,oldestPendingAt:state.oldestPendingAt||null});
      }
      const replayUrl=new URL(req.url,'http://local');
      const turnEventsMatch=req.method==='GET'&&replayUrl.pathname.match(/^\/api\/chat\/turn\/([A-Za-z0-9_-]{1,128})\/events$/);
      if(turnEventsMatch){
        res.setHeader('cache-control','no-store');
        if([...replayUrl.searchParams.keys()].some(key=>key!=='afterSeq')||replayUrl.searchParams.getAll('afterSeq').length!==1)return json(res,400,{error:'Invalid replay query'});
        const raw=replayUrl.searchParams.get('afterSeq');
        if(!/^\d+$/.test(raw||''))return json(res,400,{error:'Invalid afterSeq'});
        const afterSeq=Number(raw);
        if(!Number.isSafeInteger(afterSeq)||afterSeq<0)return json(res,400,{error:'Invalid afterSeq'});
        const result=claudeRuntime?.turnEvents?.(turnEventsMatch[1],afterSeq);
        return result?json(res,200,result):json(res,404,{turnId:turnEventsMatch[1],state:'unknown',receivedByRuntime:null,events:[],latestSeq:0,recoverable:false});
      }
      if(req.method==='POST'&&req.url==='/api/chat/stop'){
        if(!claudeRuntime)return json(res,503,{ok:false,error:'Claude tmux runtime 未配置'});
        const result=await claudeRuntime.stop(await readBody(req));
        return json(res,result.ok?200:504,result);
      }
      if(req.method==='POST'&&req.url==='/api/chat/images'){
        if(!imageStore)return json(res,503,{error:'image_upload_unavailable'});
        const files=await receiveImageUpload(req,imageStore.limits);if(files.length>imageStore.limits.maxFiles)return json(res,413,{error:'too_many_images'});
        const rawCapturedAt=String(req.headers['x-image-captured-at']||''),capturedAt=/^\d{12,13}$/.test(rawCapturedAt)?Number(rawCapturedAt):null,sourceType=['camera','upload'].includes(req.headers['x-image-source'])?req.headers['x-image-source']:'upload';
        const images=[];for(const file of files)images.push(await imageStore.add({...file,capturedAt,sourceType}));return json(res,201,{images});
      }
      const chatImageMatch=req.method==='GET'&&new URL(req.url,'http://local').pathname.match(/^\/api\/chat\/images\/(img_[A-Za-z0-9_-]{43})\/(content|thumbnail)$/);
      if(chatImageMatch){if(!imageStore)return json(res,404,{error:'image_not_found'});const image=await imageStore.readPublic(chatImageMatch[1],chatImageMatch[2]);res.writeHead(200,{'content-type':image.mime,'content-length':image.data.length,'cache-control':'private, max-age=300','x-content-type-options':'nosniff'});res.end(image.data);return}
      if(req.method==='POST'&&req.url==='/api/photos/albums'){
        if(!photosStore)return json(res,503,{error:'photos_unavailable'});return json(res,201,await photosStore.createAlbum({...await readBody(req),createdBy:'user'}));
      }
      if(req.method==='GET'&&req.url==='/api/photos/albums'){if(!photosStore)return json(res,503,{error:'photos_unavailable'});return json(res,200,{albums:photosStore.listAlbums()})}
      const photosUrl=new URL(req.url,'http://local');
      if(req.method==='GET'&&photosUrl.pathname==='/api/photos'){
        if(!photosStore)return json(res,503,{error:'photos_unavailable'});const albumId=photosUrl.searchParams.get('albumId');if([...photosUrl.searchParams.keys()].some(key=>!['albumId','limit','offset'].includes(key)))return json(res,400,{error:'invalid_query'});
        return json(res,200,{photos:photosStore.listPhotos({albumId,limit:photosUrl.searchParams.get('limit'),offset:photosUrl.searchParams.get('offset')})});
      }
      if(req.method==='POST'&&req.url==='/api/photos/promote'){
        if(!photosStore)return json(res,503,{error:'photos_unavailable'});const body=await readBody(req);if(Object.keys(body).some(key=>!['imageId','albumId','note','sourceTurnId','sourceMessageId'].includes(key))||!IMAGE_ID_PATTERN.test(String(body.imageId||'')))return json(res,400,{error:'invalid_photo_request'});
        return json(res,201,await photosStore.promote({...body,savedBy:'user'}));
      }
      const attachPhotoMatch=req.method==='POST'&&photosUrl.pathname.match(/^\/api\/photos\/(photo_[A-Za-z0-9_-]{32})\/attach$/);
      if(attachPhotoMatch){if(!photosStore||!imageStore)return json(res,503,{error:'photos_unavailable'});const photo=await photosStore.readPhoto(attachPhotoMatch[1]);return json(res,201,await imageStore.add({data:photo.data,mime:photo.mime,capturedAt:photo.metadata.capturedAt,sourceType:photo.metadata.sourceType}))}
      const photoMatch=req.method==='GET'&&photosUrl.pathname.match(/^\/api\/photos\/(photo_[A-Za-z0-9_-]{32})(?:\/(content|thumbnail))?$/);
      if(photoMatch){if(!photosStore)return json(res,503,{error:'photos_unavailable'});if(!photoMatch[2]){const photo=photosStore.getPhoto(photoMatch[1]);return photo?json(res,200,photo):json(res,404,{error:'photo_not_found'})}const image=await photosStore.readPhoto(photoMatch[1],photoMatch[2]);res.writeHead(200,{'content-type':image.mime,'content-length':image.data.length,'cache-control':'private, max-age=86400','x-content-type-options':'nosniff'});res.end(image.data);return}
      if(req.method==='GET'&&req.url==='/api/runtimes/claude-tmux/status'){
        if(!claudeRuntime)return json(res,200,{enabled:false,state:'disabled'});
        const configuration=claudeRuntime.configuration();
        if(!configuration.enabled)return json(res,200,{...configuration,state:configuration.unsupportedPlatform?'unsupported_platform':'disabled'});
        const status=await claudeRuntime.status();return json(res,200,{...configuration,state:status.state,runtimeId:status.runtime?.runtimeId||configuration.runtimeId,sessionName:status.runtime?.sessionName||'',active:claudeRuntime.hasActiveTurn(),activeTurnId:claudeRuntime.activeTurnId?.()||null});
      }
      if(req.method==='POST'&&req.url==='/api/chat'){
        const body=await readBody(req);
        if(body.config?.runtime!=='claude_tmux')return relay(req,res,false,body,validateModelUpstream);
        if(Object.keys(body).some(key=>!['config','messages','clientRequestId','imageIds'].includes(key)))return json(res,400,{error:'invalid_chat_request'});
        if(!claudeRuntime)return json(res,503,{error:'Claude tmux runtime 未配置'});
        const userMessage=[...(body.messages||[])].reverse().find(message=>message.role==='user')||{};
        const prompt=String(userMessage.content||'');const imageIds=body.imageIds;
        if(imageIds!==undefined&&(!Array.isArray(imageIds)||imageIds.length>4||imageIds.some(id=>!IMAGE_ID_PATTERN.test(String(id||'')))))return json(res,400,{error:'invalid_image_ids'});
        if(!prompt.trim()&&!(imageIds?.length))return json(res,400,{error:'当前 user prompt 或图片不能为空'});
        if(imageIds?.length&&!imageStore)return json(res,503,{error:'image_upload_unavailable'});
        const clientRequestId=/^[A-Za-z0-9_-]{1,128}$/.test(body.clientRequestId||'')?body.clientRequestId:null;
        if(imageIds?.length&&!clientRequestId)return json(res,400,{error:'image_turn_requires_client_request_id'});
        if(turnQueue){
          if(!clientRequestId)return json(res,400,{error:'client_request_id_required'});
          const buffered=[],subscriber={ended:false,emit:event=>buffered.push(event),end:()=>{subscriber.ended=true}};
          const result=await turnQueue.enqueue({clientRequestId,runtimeId:body.config.runtimeId,conversationId:body.config.runtimeId,prompt,imageIds:imageIds||[]},subscriber);
          res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-cache',connection:'keep-alive'});
          subscriber.emit=event=>{if(!res.destroyed&&!res.writableEnded)writeTurnEvent(res,'ndjson',event)};
          subscriber.end=()=>{if(!res.writableEnded)res.end()};
          for(const event of buffered)subscriber.emit(event);if(subscriber.ended)subscriber.end();
          res.once('close',()=>turnQueue.unsubscribe(clientRequestId,subscriber));
          return;
        }
        const turnId=randomUUID();
        const reservation=clientRequestId&&claudeRuntime.reserveRequest?.(clientRequestId);
        if(reservation&&!reservation.created)return json(res,409,{error:'duplicate_client_request'});
        try{
          await claudeRuntime.preflight(body.config.runtimeId);
          const images=imageIds?.length?await imageStore?.bind(imageIds,{turnId,clientRequestId}):[];
          const internalPrompt=internalPromptFor(prompt,images);
          const dispatch=async()=>{res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-cache',connection:'keep-alive'});const client=new AbortController();res.once('close',()=>{if(!res.writableEnded)client.abort()});const emit=event=>{if(res.destroyed||res.writableEnded)return;writeTurnEvent(res,'ndjson',event);if(claudeRuntime.isTerminalEvent(event))res.end()};const lease=rscCoordinator?await rscCoordinator.snapshot():null;try{await claudeRuntime.chat({runtimeId:body.config.runtimeId,prompt:internalPrompt,emit,signal:client.signal,clientRequestId,turnId,images,dispatchLease:lease?{sessionId:lease.ownerSessionId,generation:lease.leaseGeneration}:null})}catch(error){if(!error.streamStarted)throw error}};
          if(rscCoordinator){imageStore?.leaseTurn?.(turnId,130000);await rscCoordinator.submit({clientRequestId,turnId,imageIds:imageIds||[],conversationId:body.config.runtimeId},dispatch)}else await dispatch();
        }catch(error){claudeRuntime.releaseRequest?.(clientRequestId);throw error}
        return;
      }
      if(req.method==='POST'&&req.url==='/api/test')return relay(req,res,true,undefined,validateModelUpstream);
      if(ombreRoutes&&await ombreRoutes(req,res))return;
      if(req.method==='GET'&&req.url==='/api/qiuqiu/readiness'){
        let obDashboardConnected=false;
        if(ombreService?.configured())try{obDashboardConnected=Boolean((await ombreService.status()).connected)}catch{}
        return json(res,200,await qiuqiuReadiness({workspace:qiuqiuWorkspace,ombreConnected:obDashboardConnected}));
      }
      if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
      const pathname=req.url==='/'?'/index.html':new URL(req.url,'http://x').pathname;
      const file=normalize(join(root,pathname));
      if(!file.startsWith(root))return json(res,403,{error:'Forbidden'});
      try{const data=await readFile(file);res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});res.end(data)}catch{json(res,404,{error:'Not found'})}
    }catch(error){if(!res.headersSent)json(res,error.statusCode||500,{error:error.message});else res.end()}
  });
  Object.defineProperty(server,'getRuntimeQuiescenceSnapshot',{value:options=>rscObservability?.snapshot(options)||null});return server;
}

export async function createDefaultClaudeRuntime(config=loadClaudeTmuxConfig(),imageStore=null){
  const transport=process.platform==='linux'?createRootBridgeTransport():createTmuxTransport({binary:config.tmuxBinary,socketName:config.tmuxSocket,submitDelayMs:config.submitDelayMs});
  const registry=createRuntimeRegistry({filePath:config.registryPath,transport});
  const captureRaw=createRawHookCapture({enabled:config.hookCapture,filePath:config.capturePath});
  const ingress=createClaudeIngress({captureRaw,debug:message=>{if(process.env.DWELL_CLAUDE_HOOK_DEBUG==='1')console.error(message)}});
  const runtime=createClaudeTmuxRuntime({config,transport,registry,turnStore:createTurnStore(),ingress,imageStore});
  await runtime.initialize();return runtime;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===normalize(process.argv[1])){
  await loadLocalEnv(new URL('./.env.local',import.meta.url));
  const config=loadClaudeTmuxConfig();
  const imageRoot=process.env.QIUQIU_IMAGE_STORAGE_DIR||fileURLToPath(new URL('./data/images/',import.meta.url));
  const imageStore=createImageStore({rootDir:imageRoot});
  const photosStore=await createPhotosStore({dbPath:process.env.QIUQIU_PHOTOS_DB||fileURLToPath(new URL('./data/photos/photos.sqlite',import.meta.url)),storageDir:process.env.QIUQIU_PHOTOS_STORAGE_DIR||fileURLToPath(new URL('./data/photos/media/',import.meta.url)),imageStore});
  const claudeRuntime=await createDefaultClaudeRuntime(config,imageStore);
  const ombreService=createOmbreDashboardService();
  const allowPrivateForTests=process.env.NODE_ENV==='test'&&process.env.MODEL_UPSTREAM_ALLOW_PRIVATE_FOR_TESTS==='1';
  let rscCoordinator=null;if(process.env.QIUQIU_RSC_STATE_PATH){const rscStateStore=createProductionRscStateStore({path:process.env.QIUQIU_RSC_STATE_PATH});await rscStateStore.load();rscCoordinator=createProductionRscCoordinator({stateStore:rscStateStore})}
  const rscObservability=rscCoordinator?createRuntimeObservability({runtime:claudeRuntime,imageStore,coordinator:rscCoordinator}):null;if(rscObservability)console.info(JSON.stringify({component:'rsc_observability',event:'reconciled',snapshot:await rscObservability.reconcile()}));
  const turnQueue=createClaudeTurnQueue({path:process.env.QIUQIU_TURN_QUEUE_PATH||fileURLToPath(new URL('./data/turn-queue.json',import.meta.url)),claudeRuntime,imageStore,rscCoordinator});await turnQueue.initialize();
  const pushStore=createPushSubscriptionStore({path:process.env.QIUQIU_PUSH_SUBSCRIPTIONS_PATH||fileURLToPath(new URL('./data/push-subscriptions.json',import.meta.url))});await pushStore.initialize();
  const pushService=createPushService({store:pushStore,vapid:{publicKey:process.env.QIUQIU_VAPID_PUBLIC_KEY,privateKey:process.env.QIUQIU_VAPID_PRIVATE_KEY,subject:process.env.QIUQIU_VAPID_SUBJECT}});
  const server=createDwellServer({claudeRuntime,hookSecret:config.hookSecret,frontendDeliverySecret:process.env.DWELL_FRONTEND_DELIVERY_SECRET||'',ombreService,qiuqiuWorkspace:process.env.QIUQIU_WORKSPACE||'',validateModelUpstream:createModelUpstreamPolicy({allowPrivateForTests}),imageStore,photosStore,rscCoordinator,rscObservability,turnQueue,pushStore,pushService});
  server.listen(port,host,()=>console.log(`dwell 已醒来：本机 http://127.0.0.1:${port} · 局域网请使用电脑的 IPv4 地址`));
}
