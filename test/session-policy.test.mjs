import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionPolicy,sessionPolicyEvidence,FRONTEND_PROJECT} from '../deploy/session-policy.mjs';

const policy=createSessionPolicy({type:'http',url:'http://127.0.0.1/hook'});

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

test('dangerous tools and sensitive paths remain denied',()=>{
  for(const tool of ['Bash','Agent','NotebookEdit'])assert.ok(policy.permissions.deny.includes(tool));
  for(const rule of ['Read(/root/.claude/**)','Read(/root/.ssh/**)','Read(/etc/**)','Edit(/root/**)','Write(/root/**)',`Read(${FRONTEND_PROJECT}/.env*)`,`Write(${FRONTEND_PROJECT}/.git/**)`])assert.ok(policy.permissions.deny.includes(rule),rule);
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
