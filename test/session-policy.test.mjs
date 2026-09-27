import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createSessionPolicy,sessionPolicyEvidence,FRONTEND_PROJECT,ROOT_CLAUDE_MD,ROOT_CLAUDE_MD_PERMISSION,ROOT_WRITE_GUARD} from '../deploy/session-policy.mjs';
import {rootWriteDecision} from '../deploy/deny-root-write-hook.mjs';

const policy=createSessionPolicy({type:'http',url:'http://127.0.0.1/hook'});
const hookPath=fileURLToPath(new URL('../deploy/deny-root-write-hook.mjs',import.meta.url));

const runHook=input=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[hookPath],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);
  child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
  child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  child.stdin.end(JSON.stringify(input));
});

test('future sessions enable thinking summaries without enabling always-thinking',()=>{
  assert.equal(policy.showThinkingSummaries,true);
  assert.equal(Object.hasOwn(policy,'alwaysThinkingEnabled'),false);
});

test('frontend project Read Edit and Write are explicitly allowed',()=>{
  for(const tool of ['Read','Edit','Write'])assert.ok(policy.permissions.allow.includes(`${tool}(${FRONTEND_PROJECT}/**)`));
  assert.equal(policy.permissions.defaultMode,'default');
  assert.equal(policy.permissions.allow.includes('Edit'),false);
  assert.equal(policy.permissions.allow.includes('Write'),false);
});

test('only root CLAUDE.md receives an explicit edit and sandbox write exception',()=>{
  assert.equal(ROOT_CLAUDE_MD_PERMISSION,'//root/CLAUDE.md');
  assert.ok(policy.permissions.allow.includes(`Edit(${ROOT_CLAUDE_MD_PERMISSION})`));
  assert.equal(policy.permissions.allow.includes(`Edit(${ROOT_CLAUDE_MD})`),false);
  assert.equal(policy.permissions.deny.includes('Edit(/root/**)'),false);
  assert.equal(policy.permissions.deny.includes(`Edit(!${ROOT_CLAUDE_MD})`),false);
  assert.ok(policy.permissions.deny.includes('Write(/root/**)'));
  assert.ok(policy.sandbox.filesystem.allowWrite.includes(ROOT_CLAUDE_MD));
  assert.ok(policy.sandbox.filesystem.denyWrite.includes('/root/**'));
  assert.equal(policy.permissions.allow.includes('Edit(/root/**)'),false);
  assert.equal(policy.permissions.allow.includes('Write(/root/**)'),false);
  assert.ok(policy.hooks.PreToolUse.some(group=>group.matcher==='Edit|Write|NotebookEdit'&&group.hooks.some(hook=>hook.command===`/usr/bin/node "${ROOT_WRITE_GUARD}"`)));
});

test('root guard allows only Edit on canonical root CLAUDE.md',async()=>{
  const identity=async value=>value;
  assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name:'Edit',cwd:'/root',tool_input:{file_path:'/root/CLAUDE.md'}},{resolvePath:identity})).deny,false);
  assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name:'Edit',cwd:'/root',tool_input:{file_path:'/root/notes.md'}},{resolvePath:identity})).deny,true);
  assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name:'Write',cwd:'/root',tool_input:{file_path:'/root/CLAUDE.md'}},{resolvePath:identity})).deny,true);
  assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name:'NotebookEdit',cwd:'/root',tool_input:{notebook_path:'/root/book.ipynb'}},{resolvePath:identity})).deny,true);
});

test('root guard command reads hook JSON from stdin without a numeric-fd error',async()=>{
  const result=await runHook({hook_event_name:'PreToolUse',tool_name:'Read',cwd:'/root',tool_input:{file_path:'/root/CLAUDE.md'}});
  assert.deepEqual(result,{code:0,stdout:'',stderr:''});
});

test('root guard rejects traversal duplicate slash and symlink resolution bypasses',async()=>{
  const identity=async value=>value;
  assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name:'Edit',cwd:'/opt/qiuqiu/chat-frontend',tool_input:{file_path:'../../../root/other.md'}},{resolvePath:identity})).deny,true);
  assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name:'Edit',cwd:'/root',tool_input:{file_path:'/root//other.md'}},{resolvePath:identity})).deny,true);
  const symlink=async value=>value==='/opt/qiuqiu/chat-frontend/root-link/secret.md'?'/root/secret.md':value;
  assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name:'Edit',cwd:'/root',tool_input:{file_path:'/opt/qiuqiu/chat-frontend/root-link/secret.md'}},{resolvePath:symlink})).deny,true);
  const targetSymlink=async value=>value==='/root/CLAUDE.md'?'/etc/passwd':value;
  assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name:'Edit',cwd:'/root',tool_input:{file_path:'/root/CLAUDE.md'}},{resolvePath:targetSymlink})).deny,true);
});

test('root guard leaves project Edit and Write unchanged',async()=>{
  const identity=async value=>value;
  for(const tool_name of ['Edit','Write'])assert.equal((await rootWriteDecision({hook_event_name:'PreToolUse',tool_name,cwd:'/root',tool_input:{file_path:'/opt/qiuqiu/chat-frontend/README.md'}},{resolvePath:identity})).deny,false);
});

test('dangerous tools and sensitive paths remain denied',()=>{
  for(const tool of ['Bash','Agent','NotebookEdit'])assert.ok(policy.permissions.deny.includes(tool));
  for(const rule of ['Read(/root/.claude/**)','Read(/root/.ssh/**)','Read(/etc/**)','Write(/root/**)',`Read(${FRONTEND_PROJECT}/.env*)`,`Write(${FRONTEND_PROJECT}/.git/**)`])assert.ok(policy.permissions.deny.includes(rule),rule);
});

test('filesystem sandbox mirrors the project and host boundaries',()=>{
  assert.equal(policy.sandbox.enabled,true);
  assert.equal(policy.sandbox.autoAllowBashIfSandboxed,false);
  assert.ok(policy.sandbox.filesystem.allowWrite.includes(`${FRONTEND_PROJECT}/**`));
  assert.ok(policy.sandbox.filesystem.denyRead.includes('/root/.claude/**'));
  assert.ok(policy.sandbox.filesystem.denyWrite.includes('/root/**'));
});

test('all existing frontend MCP capabilities stay available',()=>{
  for(const name of ['send_frontend_message','read_time_anchor','read_frontend_image','save_frontend_photo_to_photos','create_photo_album','list_photo_albums','list_photos','read_saved_photo','send_saved_photo_to_frontend'])assert.ok(policy.permissions.allow.includes(`mcp__qiuqiu-frontend__${name}`),name);
  assert.equal(sessionPolicyEvidence(policy),true);
});
