import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildConversationState, containsTemporalWording, formatTemporalContext, instanceHash, readTimeAnchor, recordPrompt, sessionHash } from '../src/time-anchor/core.mjs';
import { handleUserPromptSubmit } from '../src/time-anchor/user-prompt-submit.mjs';
import { mergeTimeAnchorSettings } from '../src/time-anchor/integration.mjs';
import { createMcpHandler, frontendImageTool, frontendMessageTool, timeAnchorTool } from '../src/presentation/frontend-message-mcp.mjs';
import { photosMcpTools } from '../src/photos/photos-mcp.mjs';
import { createSessionPolicy } from '../deploy/session-policy.mjs';
import { readFile as readSource } from 'node:fs/promises';

const key = value => String(value).repeat(64).slice(0, 64);
const stateAt = (sessionId, iso, previousState = null) => buildConversationState({ sessionId, previousState, now: new Date(iso) });
const banned = /Asia\/Shanghai|Shanghai|China|\bCST\b|\bUTC\b|\+08:00|offset|timezone|server time|VPS location/i;

test('UTC clock converts directly by 480 minutes without exposing the basis',()=>{
  const state=stateAt('clock','2026-09-09T13:15:00.000Z');
  assert.equal(state.localOffsetMinutes,480);assert.equal(state.localDateTime,'2026-09-09 21:15');
  assert.doesNotMatch(formatTemporalContext({...state,elapsedHuman:'1m'},'ambient'),banned);
});

test('calendar boundaries use the calculated local calendar',()=>{
  let previous=stateAt('same-local','2026-01-01T23:50:00.000Z');
  let current=stateAt('same-local','2026-01-02T00:10:00.000Z',previous);
  assert.equal(current.localDateChanged,false);
  previous=stateAt('cross-local','2026-01-01T15:50:00.000Z');current=stateAt('cross-local','2026-01-01T16:10:00.000Z',previous);
  assert.equal(current.localDateChanged,true);assert.equal(current.localDate,'2026-01-02');
  assert.equal(stateAt('year','2026-12-31T16:05:00.000Z').localDate,'2027-01-01');
  assert.equal(stateAt('leap','2028-02-28T16:05:00.000Z').localDate,'2028-02-29');
});

test('elapsed intervals cover continuous chat, long absence and full-day return',()=>{
  const cases=[
    [10,'10s',false],
    [5*60,'5m',false],
    [2*60*60,'2h',false],
    [8*60*60,'8h',false],
    [24*60*60,'1d',true]
  ];
  for(const [seconds,human,dateChanged] of cases){
    const previous=stateAt(`gap-${seconds}`,'2026-09-09T00:00:00.000Z');
    const current=stateAt(`gap-${seconds}`,new Date(Date.parse('2026-09-09T00:00:00.000Z')+seconds*1000).toISOString(),previous);
    assert.equal(current.elapsedSeconds,seconds);assert.equal(current.elapsedHuman,human);assert.equal(current.localDateChanged,dateChanged);
  }
});

test('hook state hashes only stdin session id and never persists prompt or raw id',async()=>{
  const baseDir=await mkdtemp(join(tmpdir(),'anchor-')),sessionId='raw-session-private',prompt='private prompt body';
  const output=await handleUserPromptSubmit({hook_event_name:'UserPromptSubmit',session_id:sessionId,prompt},{baseDir,instanceKey:key('a'),now:new Date('2026-09-09T13:00:00Z'),randomQuarter:true});
  assert.equal(output,null);
  const files=await readdir(join(baseDir,'conversations'));assert.deepEqual(files,[`${sessionHash(sessionId)}.json`]);
  const raw=await readFile(join(baseDir,'conversations',files[0]),'utf8');assert.doesNotMatch(raw,new RegExp(sessionId));assert.doesNotMatch(raw,new RegExp(prompt));
  if(process.platform!=='win32'){assert.equal((await stat(join(baseDir,'conversations'))).mode&0o777,0o700);assert.equal((await stat(join(baseDir,'conversations',files[0]))).mode&0o777,0o600)}
});

test('real hook stdin fixture stores no message text and exits without visible first-turn context',async()=>{
  const baseDir=await mkdtemp(join(tmpdir(),'anchor-hook-')),sessionId='fixture-session',prompt='fixture secret body';
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/time-anchor/user-prompt-submit.mjs',import.meta.url))],{env:{...process.env,QIUQIU_TIME_ANCHOR_INSTANCE_KEY:key('h'),QIUQIU_TIME_ANCHOR_STATE_DIR:baseDir},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  child.stdin.end(JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:sessionId,prompt,cwd:'/root'}));
  const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0);assert.equal(stdout,'');assert.equal(stderr,'');
  const raw=await readFile(join(baseDir,'conversations',`${sessionHash(sessionId)}.json`),'utf8');assert.doesNotMatch(raw,/fixture-session|fixture secret body/);
});

test('exact instance pointers isolate sessions and there is no newest-file fallback',async()=>{
  const baseDir=await mkdtemp(join(tmpdir(),'anchor-')),now=new Date('2026-09-09T13:05:00Z');
  await recordPrompt({sessionId:'one',prompt:'a',instanceKey:key('a'),baseDir,now:new Date('2026-09-09T13:00:00Z')});
  await recordPrompt({sessionId:'two',prompt:'b',instanceKey:key('b'),baseDir,now:new Date('2026-09-09T13:04:00Z')});
  assert.equal((await readTimeAnchor({instanceKey:key('a'),baseDir,now})).snapshotAge,'5m');
  assert.equal((await readTimeAnchor({instanceKey:key('b'),baseDir,now})).snapshotAge,'1m');
  await assert.rejects(readTimeAnchor({instanceKey:key('c'),baseDir,now}),/unavailable/);
});

test('reader rejects corrupted, mismatched and stale instance association',async()=>{
  const baseDir=await mkdtemp(join(tmpdir(),'anchor-')),instanceKey=key('d');
  await recordPrompt({sessionId:'one',prompt:'a',instanceKey,baseDir,now:new Date('2026-09-09T13:00:00Z')});
  const pointer=join(baseDir,'instances',`${instanceHash(instanceKey)}.json`);
  await writeFile(pointer,'{broken','utf8');await assert.rejects(readTimeAnchor({instanceKey,baseDir,now:new Date('2026-09-09T13:01:00Z')}),/unavailable/);
  await recordPrompt({sessionId:'one',prompt:'a',instanceKey,baseDir,now:new Date('2026-09-09T13:00:00Z')});
  await assert.rejects(readTimeAnchor({instanceKey,baseDir,now:new Date('2026-09-09T14:00:01Z')}),/unavailable/);
  const value=JSON.parse(await readFile(pointer,'utf8'));value.currentPromptUtc='2026-09-09T12:59:00.000Z';await writeFile(pointer,JSON.stringify(value));
  await assert.rejects(readTimeAnchor({instanceKey,baseDir,now:new Date('2026-09-09T13:01:00Z')}),/unavailable/);
  await recordPrompt({sessionId:'one',prompt:'a',instanceKey,baseDir,now:new Date('2026-09-09T13:00:00Z')});
  await writeFile(join(baseDir,'conversations',`${sessionHash('one')}.json`),'{broken','utf8');
  await assert.rejects(readTimeAnchor({instanceKey,baseDir,now:new Date('2026-09-09T13:01:00Z')}),/unavailable/);
});

test('anchor decisions cover first, short, long, local-date and explicit wording',async()=>{
  const baseDir=await mkdtemp(join(tmpdir(),'anchor-')),instanceKey=key('e');
  let result=await recordPrompt({sessionId:'s',prompt:'hello',instanceKey,baseDir,now:new Date('2026-09-09T10:00:00Z'),randomQuarter:true});assert.equal(result.additionalContext,null);
  result=await recordPrompt({sessionId:'s',prompt:'again',instanceKey,baseDir,now:new Date('2026-09-09T10:00:10Z'),randomQuarter:false});assert.equal(result.additionalContext,null);assert.equal(result.state.elapsedSeconds,10);
  result=await recordPrompt({sessionId:'s',prompt:'今晚继续',instanceKey,baseDir,now:new Date('2026-09-09T12:00:10Z'),randomQuarter:false});assert.match(result.additionalContext,/2h/);
  result=await recordPrompt({sessionId:'s',prompt:'今晚继续',instanceKey,baseDir,now:new Date('2026-09-09T16:01:00Z'),randomQuarter:false});assert.match(result.additionalContext,/calendar date has changed/);
  result=await recordPrompt({sessionId:'s',prompt:'今晚继续',instanceKey,baseDir,now:new Date('2026-09-09T16:02:00Z'),randomQuarter:false});assert.match(result.additionalContext,/temporal wording/);
  for(const word of ['今天','昨天','明天','刚才','早上','上午','中午','下午','晚上','今晚','凌晨','一会儿','过会儿'])assert.equal(containsTemporalWording(word),true);
});

test('all hook context and reader output pass the hard privacy boundary',async()=>{
  const baseDir=await mkdtemp(join(tmpdir(),'anchor-')),instanceKey=key('f');
  await recordPrompt({sessionId:'s',prompt:'one',instanceKey,baseDir,now:new Date('2026-09-09T10:00:00Z')});
  const second=await recordPrompt({sessionId:'s',prompt:'two',instanceKey,baseDir,now:new Date('2026-09-09T13:12:00Z')});
  const reader=await readTimeAnchor({instanceKey,baseDir,now:new Date('2026-09-09T13:12:05Z')});
  assert.doesNotMatch(second.additionalContext,banned);assert.doesNotMatch(JSON.stringify(reader),banned);
  for(const forbidden of ['currentPromptUtc','sessionHash','statePath','filename','prompt','transcript'])assert.equal(Object.hasOwn(reader,forbidden),false);
  assert.deepEqual(Object.keys(reader),['localDateTime','userPromptLocal','previousUserPromptLocal','elapsedSincePreviousTurn','snapshotAge','localDateChanged','temporalCortex']);
});

test('MCP reader has zero args, is read-only, and returns only filtered facts',async()=>{
  const payload={localDateTime:'2026-09-09 21:15',userPromptLocal:'2026-09-09 21:14',previousUserPromptLocal:'2026-09-09 18:02',elapsedSincePreviousTurn:'3h 12m',snapshotAge:'2s',localDateChanged:false,temporalCortex:'Update understanding naturally.'};
  const handle=createMcpHandler({deliver:async()=>({ok:true,messageId:'x'}),readAnchor:async()=>payload});
  await handle({jsonrpc:'2.0',id:1,method:'initialize'});
  const tools=(await handle({jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools;
  assert.deepEqual(tools,[frontendMessageTool,timeAnchorTool,frontendImageTool,...photosMcpTools]);assert.deepEqual(timeAnchorTool.inputSchema,{type:'object',properties:{},additionalProperties:false});assert.equal(timeAnchorTool.annotations.readOnlyHint,true);
  assert((await handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_time_anchor',arguments:{path:'/tmp'}}})).error);
  assert((await handle({jsonrpc:'2.0',id:31,method:'tools/call',params:{name:'read_time_anchor'}})).error);
  const response=await handle({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'read_time_anchor',arguments:{}}});assert.deepEqual(JSON.parse(response.result.content[0].text),payload);assert.doesNotMatch(response.result.content[0].text,banned);
});

test('real stdio MCP reads only its exact synthetic instance pointer',async()=>{
  const baseDir=await mkdtemp(join(tmpdir(),'anchor-mcp-')),instanceKey=key('i');
  await recordPrompt({sessionId:'mcp-session',prompt:'first',instanceKey,baseDir,now:new Date(Date.now()-1000)});
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/presentation/frontend-message-mcp.mjs',import.meta.url))],{env:{...process.env,DWELL_FRONTEND_DELIVERY_SECRET:'x'.repeat(32),QIUQIU_TIME_ANCHOR_INSTANCE_KEY:instanceKey,QIUQIU_TIME_ANCHOR_STATE_DIR:baseDir},stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);
  for(const request of [{jsonrpc:'2.0',id:1,method:'initialize',params:{}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_time_anchor',arguments:{}}}])child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();await new Promise(resolve=>child.on('close',resolve));
  const messages=output.trim().split('\n').map(JSON.parse),payload=JSON.parse(messages[1].result.content[0].text);
  assert.equal(messages[1].result.isError,undefined);assert.doesNotMatch(JSON.stringify(payload),banned);assert.equal(payload.userPromptLocal.length,16);
});

test('production settings preserve hooks and controlled project permissions without frontend or bridge time metadata',async()=>{
  const bridge=await readSource(new URL('../deploy/bridge.mjs',import.meta.url),'utf8');
  const frontend=await readSource(new URL('../public/app.js',import.meta.url),'utf8');
  const existing=createSessionPolicy({type:'http',url:'fixed'});
  const hookCommand='/usr/bin/node "/root/.local/lib/time-anchor/user-prompt-submit.mjs"';
  const merged=mergeTimeAnchorSettings(existing,{hookCommand});
  for(const event of ['MessageDisplay','Stop','StopFailure','UserPromptSubmit'])assert.ok(Array.isArray(merged.hooks[event]));
  for(const event of ['MessageDisplay','Stop','StopFailure'])assert.deepEqual(merged.hooks[event],existing.hooks[event]);
  assert.deepEqual(merged.permissions.deny,existing.permissions.deny);assert.equal(merged.permissions.defaultMode,'default');assert.deepEqual(merged.enabledPlugins,existing.enabledPlugins);
  for(const denied of ['Bash','NotebookEdit','Agent'])assert.ok(merged.permissions.deny.includes(denied));
  for(const allowed of ['Read(/opt/qiuqiu/chat-frontend/**)','Edit(/opt/qiuqiu/chat-frontend/**)','Write(/opt/qiuqiu/chat-frontend/**)'])assert.ok(merged.permissions.allow.includes(allowed));
  assert.equal(merged.showThinkingSummaries,true);assert.equal(Object.hasOwn(merged,'alwaysThinkingEnabled'),false);
  assert.ok(merged.permissions.allow.includes('mcp__qiuqiu-frontend__read_time_anchor'));
  const mergedAgain=mergeTimeAnchorSettings(merged,{hookCommand});
  assert.equal(mergedAgain.permissions.allow.filter(value=>value==='mcp__qiuqiu-frontend__read_time_anchor').length,1);
  assert.equal(mergedAgain.hooks.UserPromptSubmit.filter(group=>group.hooks?.some(hook=>hook.command===hookCommand)).length,1);
  assert.match(bridge,/\.\/time-anchor-integration\.mjs/);
  assert.match(bridge,/\/root\/\.local\/lib\/time-anchor\/user-prompt-submit\.mjs/);
  assert.doesNotMatch(frontend,/clientTimeZone|resolvedOptions\(\)\.timeZone|timeZoneMetadata/);
  assert.doesNotMatch(bridge,/clientTimeZone|timeZoneMetadata|timezone passthrough/i);
});
