import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareShadowCarryover} from '../src/runtimes/rsc/phase2.mjs';
import {validateTarget} from '../src/runtimes/rsc/validator.mjs';
import {targetReadyEvidence} from '../deploy/rsc-activation-safety.mjs';
import {waitForPostTrustReady} from '../deploy/rsc-startup-trust.mjs';
import {transcriptTextEvidence,startupLogEvidence,candidateHealthEvidence} from '../deploy/rsc-runtime-readiness.mjs';
import {createCandidateWatchdog} from '../deploy/rsc-candidate-watchdog.mjs';
import {createSessionPolicy,sessionPolicyEvidence,FRONTEND_PROJECT} from '../deploy/session-policy.mjs';

const source='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
const row=(type,text,parentUuid=null)=>({parentUuid,isSidechain:false,userType:'external',cwd:'/root',sessionId:source,version:'2.1.236',gitBranch:'',type,message:{role:type,content:[{type:'text',text}]},uuid:crypto.randomUUID(),timestamp:'2026-09-24T00:00:00.000Z'});
const ready=(over={})=>({claudeAlive:true,processStable:true,resumeConfirmed:true,validSessionTranscript:true,resumedSessionId:target,workspaceRoot:true,projectDirectoryAdded:true,tmuxIdentity:true,singleManagedClaude:true,helperAlive:true,helperParentMatches:true,oldHelperAbsent:true,helperIdentityMatches:true,runtimeConnected:true,frontendMcpConnected:true,modelExact:true,effortHigh:true,noModelFallback:true,transcriptParseable:true,permissionsIntact:true,hooksIntact:true,claudeMdAvailable:true,obConfigured:true,active:false,activeTurnId:null,onboardingDetected:false,startupError:false,autoCompacted:false,emptySessionFallback:false,...over});

test('1-byte newline transcript is invalid but retryable',()=>{const value=transcriptTextEvidence('\n',target);assert.equal(value.valid,false);assert.equal(value.hardFailure,false);assert.equal(value.reason,'WAITING_FOR_TRANSCRIPT');assert.equal(value.recordCount,0)});
test('zero target records are invalid',()=>assert.deepEqual(validateTarget([],{targetSessionId:target,targetTokens:30000,estimatedTokens:0}),{valid:false,reason:'TARGET_EMPTY'}));
test('compact with no safe post-boundary turn cannot create a candidate',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rsc-g4-')),projectDir=join(root,'project'),evidenceDir=join(root,'evidence');await mkdir(projectDir);await mkdir(evidenceDir);
  const user=row('user','before compact'),assistant=row('assistant','done',user.uuid),compact={parentUuid:assistant.uuid,isSidechain:false,userType:'external',cwd:'/root',sessionId:source,version:'2.1.236',gitBranch:'',type:'system',subtype:'compact_boundary',uuid:crypto.randomUUID(),timestamp:'2026-09-24T00:00:01.000Z'};
  await writeFile(join(projectDir,`${source}.jsonl`),[user,assistant,compact].map(JSON.stringify).join('\n')+'\n');
  await assert.rejects(prepareShadowCarryover({projectDir,sourceSessionId:source,evidenceDir,targetSessionId:target}),/TARGET_EMPTY/);
  await assert.rejects(access(join(projectDir,`${target}.jsonl`)));
});
test('No conversation found is a fatal resume failure',()=>{const value=startupLogEvidence('[ERROR] No conversation found with session ID: '+target);assert.equal(value.fatal,true);assert.equal(value.fatalReason,'FAILED_RESUME_NOT_FOUND')});
test('spawned helper without handshake cannot become ready',()=>{const value=ready({frontendMcpConnected:false});assert.equal(targetReadyEvidence(value,target),false);assert.equal(candidateHealthEvidence({running:true,sessionId:target,expectedSessionId:target,processAlive:true,helperAlive:true,transcript:{valid:true},startup:{fatal:false,frontendMcpConnected:false}}).reason,'FAILED_MCP_NOT_CONNECTED')});
test('readiness timeout is a hard failure',async()=>{let now=0;const controller={runtimeEvidence:async()=>({processAlive:true,exactSession:true,ownershipIntact:true,unexpectedClaudeOwner:false,unexpectedHelperOwner:false,uid:0,home:'/root',canonicalCwd:'/root'}),transcriptEvidence:async()=>({parseable:true,transcriptWritable:true,resumeMilestone:true,startupStructureValid:true,wrongSessionRecord:false,orphanStartupRecord:false,user:1,assistant:1,compactCount:0}),startupEvidence:async()=>({fatal:false,frontendMcpConnected:false,frontendMcpDisconnected:false}),screen:async()=>'',readyEvidence:async()=>false};await assert.rejects(waitForPostTrustReady({controller,baseline:{user:1,assistant:1,compactCount:0},pollMs:100,deadlineMs:300,now:()=>now,sleep:async ms=>{now+=ms}}),error=>error.reason==='FAILED_STARTUP_TIMEOUT')});
test('candidate death before first real turn rolls back to lastGood and aligns state',async()=>{let state={handoffState:'CANDIDATE_ACTIVE',candidateActiveSessionId:target,lastGoodSessionId:source,currentProductionSessionId:source},runtimeSession=target,recovered=0;const watchdog=createCandidateWatchdog({loadState:async()=>state,inspectCandidate:async()=>({healthy:false,reason:'FAILED_PROCESS_EXIT'}),recoverLastGood:async(current,reason)=>{recovered++;runtimeSession=current.lastGoodSessionId;state={...current,currentProductionSessionId:current.lastGoodSessionId,lastGoodSessionId:current.lastGoodSessionId,handoffState:'ACTIVE',candidateActiveSessionId:null,failureReason:reason}},setTimer:()=>0,clearTimer:()=>{}});await watchdog.checkNow();assert.equal(recovered,1);assert.equal(runtimeSession,source);assert.equal(state.currentProductionSessionId,runtimeSession);assert.equal(state.handoffState,'ACTIVE')});
test('production launch policy has exact thinking and project access settings',()=>{const policy=createSessionPolicy({type:'http',url:'http://127.0.0.1/hook'});assert.equal(policy.showThinkingSummaries,true);assert.equal(Object.hasOwn(policy,'alwaysThinkingEnabled'),false);for(const tool of ['Read','Edit','Write'])assert(policy.permissions.allow.includes(`${tool}(${FRONTEND_PROJECT}/**)`));for(const tool of ['Bash','Agent','NotebookEdit'])assert(policy.permissions.deny.includes(tool));assert.equal(sessionPolicyEvidence(policy),true)});
