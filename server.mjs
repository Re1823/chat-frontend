import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createApiRequest, extractTextDelta } from './src/providers/api-runtime.mjs';
import { turnEvent, writeTurnEvent } from './src/turns/events.mjs';
import { loadClaudeTmuxConfig } from './src/config.mjs';
import { createTmuxTransport } from './src/runtimes/tmux-transport.mjs';
import { createRuntimeRegistry } from './src/runtimes/runtime-registry.mjs';
import { createTurnStore } from './src/turns/turn-store.mjs';
import { createClaudeIngress } from './src/hooks/claude-ingress.mjs';
import { createRawHookCapture } from './src/hooks/raw-capture.mjs';
import { createClaudeTmuxRuntime } from './src/runtimes/claude-tmux.mjs';
import { createOmbreDashboardService } from './src/ombre-dashboard/service.mjs';
import { createOmbreDashboardRoutes } from './src/ombre-dashboard/routes.mjs';
import { qiuqiuReadiness } from './src/readiness.mjs';
import { loadLocalEnv } from './src/local-env.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
const json = (res, status, data) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
const readBody = req => new Promise((resolve, reject) => { let s=''; req.on('data', c => { s += c; if (s.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch(e) { reject(e); } }); });
async function relay(req, res, test=false, suppliedBody) {
  try {
    const { config:cfg, messages=[] } = suppliedBody||await readBody(req);
    if (!cfg?.key || !cfg?.model) return json(res, 400, { error:'请先填写 API Key 和模型名' });
    const sample = test ? [{role:'user', content:'只回复 OK'}] : messages;
    const call = createApiRequest(cfg, sample, !test);
    const upstream = await fetch(call.url, call.init);
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 3000);
      return json(res, upstream.status, { error:`上游 ${upstream.status}`, detail });
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
  } catch (e) { if (!res.headersSent) json(res, 500, {error:e.message}); else res.end(); }
}

const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address||'');
const secretMatches=(actual,expected)=>{
  const a=Buffer.from(String(actual||'')),b=Buffer.from(String(expected||''));
  return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);
};

export function createDwellServer({claudeRuntime,hookSecret='',ombreService,qiuqiuWorkspace='' }={}){
  const ombreRoutes=ombreService?createOmbreDashboardRoutes(ombreService):null;
  return http.createServer(async(req,res)=>{
    try{
      if(req.method==='POST'&&req.url==='/api/internal/claude-code/events'){
        if(!loopback(req.socket.remoteAddress))return json(res,403,{ok:false,error:'Forbidden'});
        if(!secretMatches(req.headers['x-dwell-hook-secret'],hookSecret))return json(res,401,{ok:false,error:'Unauthorized'});
        const body=await readBody(req);
        const result=await claudeRuntime.ingestRaw(body);
        return json(res,200,{ok:true,...result});
      }
      if(req.method==='POST'&&req.url==='/api/chat/stop'){
        if(!claudeRuntime)return json(res,503,{ok:false,error:'Claude tmux runtime 未配置'});
        const result=await claudeRuntime.stop(await readBody(req));
        return json(res,result.ok?200:504,result);
      }
      if(req.method==='GET'&&req.url==='/api/runtimes/claude-tmux/status'){
        if(!claudeRuntime)return json(res,200,{enabled:false,state:'disabled'});
        const configuration=claudeRuntime.configuration();
        if(!configuration.enabled)return json(res,200,{...configuration,state:configuration.unsupportedPlatform?'unsupported_platform':'disabled'});
        const status=await claudeRuntime.status();return json(res,200,{...configuration,state:status.state,runtimeId:status.runtime?.runtimeId||configuration.runtimeId,sessionName:status.runtime?.sessionName||''});
      }
      if(req.method==='POST'&&req.url==='/api/chat'){
        const body=await readBody(req);
        if(body.config?.runtime!=='claude_tmux')return relay(req,res,false,body);
        if(!claudeRuntime)return json(res,503,{error:'Claude tmux runtime 未配置'});
        const prompt=[...(body.messages||[])].reverse().find(message=>message.role==='user')?.content;
        if(!String(prompt||'').trim())return json(res,400,{error:'当前 user prompt 不能为空'});
        await claudeRuntime.preflight(body.config.runtimeId);
        res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-cache',connection:'keep-alive'});
        const emit=event=>{writeTurnEvent(res,'ndjson',event);if(claudeRuntime.isTerminalEvent(event))res.end()};
        try{await claudeRuntime.chat({runtimeId:body.config.runtimeId,prompt,emit})}catch(error){if(!error.streamStarted)throw error}
        return;
      }
      if(req.method==='POST'&&req.url==='/api/test')return relay(req,res,true);
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
}

export async function createDefaultClaudeRuntime(config=loadClaudeTmuxConfig()){
  const transport=createTmuxTransport({binary:config.tmuxBinary,socketName:config.tmuxSocket,submitDelayMs:config.submitDelayMs});
  const registry=createRuntimeRegistry({filePath:config.registryPath,transport});
  const captureRaw=createRawHookCapture({enabled:config.hookCapture,filePath:config.capturePath});
  const ingress=createClaudeIngress({captureRaw,debug:message=>{if(process.env.DWELL_CLAUDE_HOOK_DEBUG==='1')console.error(message)}});
  const runtime=createClaudeTmuxRuntime({config,transport,registry,turnStore:createTurnStore(),ingress});
  await runtime.initialize();return runtime;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===normalize(process.argv[1])){
  await loadLocalEnv(new URL('./.env.local',import.meta.url));
  const config=loadClaudeTmuxConfig();
  const claudeRuntime=await createDefaultClaudeRuntime(config);
  const ombreService=createOmbreDashboardService();
  const server=createDwellServer({claudeRuntime,hookSecret:config.hookSecret,ombreService,qiuqiuWorkspace:process.env.QIUQIU_WORKSPACE||''});
  server.listen(port,host,()=>console.log(`dwell 已醒来：本机 http://127.0.0.1:${port} · 局域网请使用电脑的 IPv4 地址`));
}
