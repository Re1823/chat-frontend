import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const testImageTool = {
  name: 'test_image_result',
  description: 'Return the fixed Phase 0 visual fixture for MCP image-content compatibility testing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

const fixturePath = fileURLToPath(new URL('../test/fixtures/test-image-result.png', import.meta.url));

export function createImageContentMcpHandler({ loadFixture = () => readFile(fixturePath) } = {}) {
  let initialized = false;
  return async request => {
    const reply = result => ({ jsonrpc: '2.0', id: request?.id ?? null, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id: request?.id ?? null, error: { code, message } });
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(-32600, 'Invalid request');
    if (request.id === undefined) return null;
    if (request.method === 'initialize') {
      initialized = true;
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'qiuqiu-phase0-image', version: '1.0.0' } });
    }
    if (!initialized) return error(-32002, 'Initialize first');
    if (request.method === 'ping') return reply({});
    if (request.method === 'tools/list') return reply({ tools: [testImageTool] });
    if (request.method !== 'tools/call') return error(-32601, 'Method not found');
    const params = request.params;
    if (!params || params.name !== testImageTool.name || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments) || Object.keys(params.arguments).length || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))) return error(-32602, 'test_image_result accepts no arguments');
    try {
      const data = (await loadFixture()).toString('base64');
      return reply({ content: [{ type: 'image', data, mimeType: 'image/png' }] });
    } catch {
      return reply({ isError: true, content: [{ type: 'text', text: 'Phase 0 fixture unavailable' }] });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const handle = createImageContentMcpHandler();
  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 131072) process.exit(1);
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        let response;
        try { response = await handle(JSON.parse(line)); }
        catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }; }
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}
