import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port=server.address().port; server.close(() => resolve(port)); });
});

async function startApp(port) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd:new URL('..', import.meta.url),
    env:{...process.env, PORT:String(port), HOST:'127.0.0.1'},
    stdio:['ignore','pipe','pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now()+5000;
  while (!output.includes('dwell 已醒来')) {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    if (Date.now() > deadline) throw new Error(`server start timed out: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return child;
}

const stopApp = child => new Promise(resolve => {
  child.once('exit', resolve);
  child.kill();
});

test('relays all existing provider protocols and preserves the SSE browser contract', async () => {
  const received = [];
  const upstream = http.createServer((req,res) => {
    let raw=''; req.on('data', c => {raw+=c}); req.on('end', () => {
      received.push({url:req.url, headers:req.headers, body:JSON.parse(raw)});
      res.writeHead(200, {'content-type':'text/event-stream'});
      if (req.url.endsWith('/messages')) res.end('data: {"type":"content_block_delta","delta":{"text":"A"}}\n\n');
      else if (req.url.endsWith('/responses')) res.end('data: {"type":"response.output_text.delta","delta":"B"}\n\n');
      else res.end('data: {"choices":[{"delta":{"content":"C"}}]}\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const appPort = await freePort();
  const app = await startApp(appPort);
  try {
    const base = `http://127.0.0.1:${upstreamPort}`;
    const cases = [
      ['anthropic','/v1/messages','A'],
      ['responses','/v1/responses','B'],
      ['chat','/v1/chat/completions','C']
    ];
    for (const [protocol,path,delta] of cases) {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{protocol,base,key:'k',model:'m'},messages:[{role:'system',content:'sys'},{role:'user',content:'hello'}]})});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      const text = await response.text();
      assert.ok(text.includes(`data: {"delta":"${delta}"}`));
      assert.ok(text.includes('data: {"done":true}'));
      assert.equal(received.at(-1).url, path);
    }
    assert.equal(received[0].headers['x-api-key'], 'k');
    assert.equal(received[0].body.system, 'sys');
    assert.deepEqual(received[0].body.messages, [{role:'user',content:'hello'}]);
    assert.equal(received[1].headers.authorization, 'Bearer k');
    assert.equal(received[1].body.store, false);
    assert.equal(received[2].body.messages[0].role, 'system');
  } finally {
    await stopApp(app);
    await close(upstream);
  }
});

test('serves the current frontend and keeps API validation behavior', async () => {
  const appPort = await freePort();
  const app = await startApp(appPort);
  try {
    const home = await fetch(`http://127.0.0.1:${appPort}/`);
    assert.equal(home.status, 200);
    assert.ok((await home.text()).includes('<title>dwell</title>'));
    const invalid = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {error:'请先填写 API Key 和模型名'});
  } finally {
    await stopApp(app);
  }
});

test('offers the unified NDJSON turn event model without removing legacy SSE', async () => {
  const upstream = http.createServer((req,res) => { req.resume(); res.writeHead(200, {'content-type':'text/event-stream'}); res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'); });
  const upstreamPort = await listen(upstream);
  const appPort = await freePort();
  const app = await startApp(appPort);
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({config:{protocol:'chat',base:`http://127.0.0.1:${upstreamPort}`,key:'k',model:'m'},messages:[{role:'user',content:'hello'}]})});
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.type), ['turn_started','segment_delta','segment_done','turn_done']);
    assert.equal(events[1].delta, 'hello');
    assert.ok(events.every(event => event.turnId === events[0].turnId));
  } finally {
    await stopApp(app);
    await close(upstream);
  }
});
