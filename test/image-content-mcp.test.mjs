import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createImageContentMcpHandler, testImageTool } from '../fixtures/image-content-mcp.mjs';

test('Phase 0 image MCP lists one zero-argument read-only tool and returns true ImageContent', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const handle = createImageContentMcpHandler({ loadFixture: async () => png });
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const listed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools, [testImageTool]);
  const called = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'test_image_result', arguments: {} } });
  assert.deepEqual(called.result.content, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
  assert((await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'test_image_result', arguments: { path: '/tmp/x' } } })).error);
});

test('Phase 0 image MCP stdio transport exposes and returns the fixed PNG fixture', async () => {
  const server = fileURLToPath(new URL('../fixtures/image-content-mcp.mjs', import.meta.url));
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => errors += chunk);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  for (const request of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'test_image_result', arguments: {} } }
  ]) child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  assert.equal(await exit, 0, errors);
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses[1].result.tools, [testImageTool]);
  const image = responses[2].result.content[0];
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.data, 'base64').subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
});
