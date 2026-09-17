import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('MCP config delegates credential injection to the controlled root launcher',async()=>{
  const config=JSON.parse(await readFile(new URL('../deploy/frontend-message.mcp.json',import.meta.url),'utf8'));
  const helper=config.mcpServers['qiuqiu-frontend'];
  assert.equal(helper.command,'/usr/bin/python3');
  assert.deepEqual(helper.args,['/root/.local/lib/qiuqiu-frontend-message/launch-frontend-message-helper.py']);
  assert.equal(Object.hasOwn(helper.env||{},'DWELL_FRONTEND_DELIVERY_SECRET'),false);
  assert.doesNotMatch(JSON.stringify(config),/\$\{DWELL_FRONTEND_DELIVERY_SECRET\}/);
});

test('root launcher reads only the protected source, validates, injects and execs the helper',async()=>{
  const source=await readFile(new URL('../deploy/launch-frontend-message-helper.py',import.meta.url),'utf8');
  assert.match(source,/SECRET_FILE = "\/etc\/qiuqiu\/chat-frontend\.env"/);
  assert.match(source,/VALID_SECRET\.fullmatch\(value\)/);
  assert.match(source,/environment\[SECRET_NAME\] = secret/);
  assert.match(source,/os\.execve\(NODE, \[NODE, HELPER\], environment\)/);
  assert.doesNotMatch(source,/print\(|secret\}\)|write\([^\n]*secret/);
});

test('all production and RSC starts share the same MCP config path',async()=>{
  const [bridge,shadow]=await Promise.all([
    readFile(new URL('../deploy/bridge.mjs',import.meta.url),'utf8'),
    readFile(new URL('../src/runtimes/rsc/shadow.mjs',import.meta.url),'utf8')
  ]);
  assert.match(bridge,/FRONTEND_MCP_CONFIG='\/root\/\.config\/qiuqiu\/frontend-message\.mcp\.json'/);
  assert.match(bridge,/--mcp-config',FRONTEND_MCP_CONFIG/);
  assert.match(shadow,/--mcp-config',mcpConfigPath/);
});
