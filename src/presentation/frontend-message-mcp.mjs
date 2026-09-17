import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateFrontendText } from './frontend-delivery.mjs';
import { readTimeAnchor } from '../time-anchor/core.mjs';
import { photosMcpTools } from '../photos/photos-mcp.mjs';

export function validateFrontendDeliverySecret(value){
  return typeof value==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(value)&&value!=='${DWELL_FRONTEND_DELIVERY_SECRET}'?value:'';
}

export const frontendMessageTool = {
  name: 'send_frontend_message',
  description: '在秋秋 frontend 中主动向小霏发送一条独立消息；每次成功调用立即发送一条。是否调用、发几条、是否再补一句都由你决定，一句就够时只发一句。已通过本工具发送的正文不要再重复作为最终普通回复；真正新的补充仍可正常回复。仅当前 active frontend turn 可用。失败不会自动重试；投递结果不确定时不要盲目重复发送。',
  inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 16384 } }, required: ['text'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
};
export const timeAnchorTool = {
  name: 'read_time_anchor',
  description: 'Read the current conversation’s verified local time facts when real elapsed time may change the meaning of the conversation. Use selectively; rapid continuous chat does not need repeated checks. The tool is read-only and accepts no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};
export const frontendImageTool = {
  name: 'read_frontend_image',
  description: 'Read one image attached to the current active frontend turn. Accepts only its opaque image ID and returns image content; old, foreign, expired, or unbound IDs are rejected.',
  inputSchema: { type: 'object', properties: { imageId: { type: 'string', pattern: '^img_[A-Za-z0-9_-]{43}$' } }, required: ['imageId'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

export function createMcpHandler({ deliver, readAnchor = async () => { throw new Error('Time Anchor unavailable'); }, readFrontendImage = async () => { throw new Error('Frontend image unavailable'); }, runPhotosTool = async () => { throw new Error('Photos unavailable'); } }) {
  let initialized = false;
  const calls = new Map();
  return async request => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (request.id === undefined) return null;
    const result = value => ({ jsonrpc: '2.0', id: request.id, result: value });
    const error = (code, message) => ({ jsonrpc: '2.0', id: request.id, error: { code, message } });
    if (request.method === 'initialize') {
      initialized = true;
      const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return result({ protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'qiuqiu-frontend', version: '1.0.0' } });
    }
    if (!initialized) return error(-32002, 'Initialize first');
    if (request.method === 'ping') return result({});
    if (request.method === 'tools/list') return result({ tools: [frontendMessageTool, timeAnchorTool, frontendImageTool, ...photosMcpTools] });
    if (request.method !== 'tools/call') return error(-32601, 'Method not found');
    const params = request.params;
    if (!params || ![frontendMessageTool.name, timeAnchorTool.name, frontendImageTool.name,...photosMcpTools.map(tool=>tool.name)].includes(params.name) || Object.keys(params).some(k => !['name', 'arguments', '_meta'].includes(k))) return error(-32602, 'Unknown tool or parameters');
    if (params.name === timeAnchorTool.name) {
      if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments) || Object.keys(params.arguments).length) return error(-32602, 'read_time_anchor accepts no arguments');
      try { return result({ content: [{ type: 'text', text: JSON.stringify(await readAnchor()) }] }); }
      catch { return result({ isError: true, content: [{ type: 'text', text: 'Time Anchor unavailable' }] }); }
    }
    if (params.name === frontendImageTool.name) {
      const args = params.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !/^img_[A-Za-z0-9_-]{43}$/.test(String(args.imageId || ''))) return error(-32602, 'read_frontend_image accepts one valid imageId');
      try {
        const image = await readFrontendImage(args.imageId);
        return result({ content: [{ type: 'image', data: image.data.toString('base64'), mimeType: image.mime }] });
      } catch (e) { return result({ isError: true, content: [{ type: 'text', text: e.message || 'Frontend image unavailable' }] }); }
    }
    if (photosMcpTools.some(tool=>tool.name===params.name)) {
      try { return result(await runPhotosTool(params.name,params.arguments||{})); }
      catch (e) { return result({ isError:true,content:[{type:'text',text:e.message||'Photos unavailable'}] }); }
    }
    try { validateFrontendText(params.arguments); } catch (e) { return result({ isError: true, content: [{ type: 'text', text: e.message }] }); }
    const key = JSON.stringify(request.id), fingerprint = JSON.stringify(params.arguments);
    if (calls.has(key)) {
      const prior = calls.get(key);
      return prior.fingerprint === fingerprint ? prior.response : error(-32600, 'Request ID reused with different arguments');
    }
    // Cache the in-flight result too: duplicate protocol requests never append twice.
    const response = (async () => {
      try {
        const receipt = await deliver(params.arguments, randomUUID());
        return result({ content: [{ type: 'text', text: JSON.stringify(receipt) }] });
      } catch (e) {
        return result({ isError: true, content: [{ type: 'text', text: e.message || 'Delivery failed; not automatically retried' }] });
      }
    })();
    calls.set(key, { fingerprint, response });
    if (calls.size > 2048) calls.delete(calls.keys().next().value);
    return response;
  };
}

export function createLocalDelivery(secret, fetchImpl = fetch) {
  return async (body, requestId) => {
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('Frontend delivery credential unavailable');
    const response = await fetchImpl('http://127.0.0.1:4173/api/internal/frontend-message', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-frontend-delivery-secret': secret, 'x-frontend-delivery-id': requestId },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Frontend delivery rejected (${response.status}); not automatically retried`);
    const receipt = await response.json();
    if (receipt?.ok !== true || typeof receipt.messageId !== 'string') throw new Error('Unconfirmed delivery; do not blindly resend');
    return receipt;
  };
}

export function createLocalImageReader(secret, fetchImpl = fetch) {
  return async imageId => {
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('Frontend image credential unavailable');
    const response = await fetchImpl('http://127.0.0.1:4173/api/internal/frontend-image', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-frontend-delivery-secret': secret }, body: JSON.stringify({ imageId })
    });
    if (!response.ok) throw new Error(`Frontend image rejected (${response.status})`);
    const mime = response.headers.get('content-type')?.split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new Error('Frontend image returned an invalid type');
    return { data: Buffer.from(await response.arrayBuffer()), mime };
  };
}

export function createLocalPhotosClient(secret, fetchImpl=fetch){return async(name,args)=>{if(typeof secret!=='string'||secret.length<32)throw new Error('Photos credential unavailable');const response=await fetchImpl('http://127.0.0.1:4173/api/internal/photos-tool',{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json','x-frontend-delivery-secret':secret},body:JSON.stringify({name,arguments:args})});const body=await response.json();if(!response.ok)throw new Error(body.error||`Photos rejected (${response.status})`);return body}}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deliverySecret=validateFrontendDeliverySecret(process.env.DWELL_FRONTEND_DELIVERY_SECRET);
  if(!deliverySecret){process.stderr.write('frontend helper credential unavailable\n');process.exit(78)}
  const handle = createMcpHandler({
    deliver: createLocalDelivery(deliverySecret),
    readAnchor: () => readTimeAnchor({ instanceKey: process.env.QIUQIU_TIME_ANCHOR_INSTANCE_KEY, baseDir: process.env.QIUQIU_TIME_ANCHOR_STATE_DIR }),
    readFrontendImage: createLocalImageReader(deliverySecret),
    runPhotosTool: createLocalPhotosClient(deliverySecret)
  });
  let buffer = '', chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 131072) { process.stderr.write('MCP input limit exceeded\n'); process.exit(1); }
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        let response;
        try { response = await handle(JSON.parse(line)); }
        catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }; }
        if (response) process.stdout.write(JSON.stringify(response) + '\n');
      });
    }
  });
}
