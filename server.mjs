import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
const json = (res, status, data) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
const readBody = req => new Promise((resolve, reject) => { let s=''; req.on('data', c => { s += c; if (s.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch(e) { reject(e); } }); });
const cleanBase = v => String(v || '').replace(/\/+$/, '');
const safeBase = raw => {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('只支持 http/https 接口');
  return u.toString().replace(/\/+$/, '');
};

function openAIRequest(cfg, messages, stream) {
  const base = safeBase(cleanBase(cfg.base || 'https://api.openai.com/v1'));
  const useResponses = cfg.protocol === 'responses';
  const url = base + (base.endsWith('/v1') ? '' : '/v1') + (useResponses ? '/responses' : '/chat/completions');
  const body = useResponses
    ? { model: cfg.model, input: messages.map(m => ({ role:m.role, content:m.content })), stream, store:false }
    : { model: cfg.model, messages, stream };
  return { url, init: { method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${cfg.key}` }, body:JSON.stringify(body) } };
}

function anthropicRequest(cfg, messages, stream) {
  const base = safeBase(cleanBase(cfg.base || 'https://api.anthropic.com'));
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const body = { model:cfg.model, max_tokens:4096, stream, messages:messages.filter(m => m.role !== 'system') };
  if (system) body.system = system;
  return { url: base + (base.endsWith('/v1') ? '' : '/v1') + '/messages', init:{ method:'POST', headers:{ 'content-type':'application/json', 'x-api-key':cfg.key, 'anthropic-version':'2023-06-01' }, body:JSON.stringify(body) } };
}

async function relay(req, res, test=false) {
  try {
    const { config:cfg, messages=[] } = await readBody(req);
    if (!cfg?.key || !cfg?.model) return json(res, 400, { error:'请先填写 API Key 和模型名' });
    const sample = test ? [{role:'user', content:'只回复 OK'}] : messages;
    const call = cfg.protocol === 'anthropic' ? anthropicRequest(cfg, sample, !test) : openAIRequest(cfg, sample, !test);
    const upstream = await fetch(call.url, call.init);
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 3000);
      return json(res, upstream.status, { error:`上游 ${upstream.status}`, detail });
    }
    if (test) {
      const data = await upstream.json();
      return json(res, 200, { ok:true, model:data.model || cfg.model });
    }
    res.writeHead(200, { 'content-type':'text/event-stream; charset=utf-8', 'cache-control':'no-cache', connection:'keep-alive' });
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
          const d = JSON.parse(raw); let delta='';
          if (cfg.protocol === 'anthropic') delta = d.type === 'content_block_delta' ? d.delta?.text || '' : '';
          else if (cfg.protocol === 'responses') delta = d.type === 'response.output_text.delta' ? d.delta || '' : '';
          else delta = d.choices?.[0]?.delta?.content || '';
          if (delta) res.write(`data: ${JSON.stringify({delta})}\n\n`);
        } catch {}
      }
    }
    res.write('data: {"done":true}\n\n'); res.end();
  } catch (e) { if (!res.headersSent) json(res, 500, {error:e.message}); else res.end(); }
}

const server = http.createServer(async (req,res) => {
  if (req.method === 'POST' && req.url === '/api/chat') return relay(req,res,false);
  if (req.method === 'POST' && req.url === '/api/test') return relay(req,res,true);
  if (req.method !== 'GET') return json(res,405,{error:'Method not allowed'});
  const pathname = req.url === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname;
  const file = normalize(join(root, pathname));
  if (!file.startsWith(root)) return json(res,403,{error:'Forbidden'});
  try { const data = await readFile(file); res.writeHead(200, {'content-type':mime[extname(file)] || 'application/octet-stream'}); res.end(data); }
  catch { json(res,404,{error:'Not found'}); }
});
server.listen(port, host, () => {
  console.log(`dwell 已醒来：本机 http://127.0.0.1:${port} · 局域网请使用电脑的 IPv4 地址`);
});
