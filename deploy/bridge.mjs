import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir,readFile,readlink,writeFile,rename,chmod,stat } from 'node:fs/promises';
import {createBridgeStopController} from './bridge-stop.mjs';
import { createBridgeActiveTurn } from './bridge-active-turn.mjs';
import { mergeTimeAnchorSettings } from './time-anchor-integration.mjs';
import {createRscBridgeHandoff,dispatchRscBridge} from './rsc-handoff.mjs';
import {targetReadyEvidence,lifecycleFree} from './rsc-activation-safety.mjs';
import {detectWorkspaceTrustGate,classifyStartupScreen,handleManagedStartup} from './rsc-startup-trust.mjs';
import {resolveOwnershipCandidates,captureAndRejectOwnership} from './rsc-shadow-ownership-forensics.mjs';
import {atomicWriteRootRscState} from './rsc-state-file.mjs';
import {normalizeThoughtRecords} from './thought-process.mjs';
import {createSessionPolicy,sessionPolicyEvidence,FRONTEND_PROJECT} from './session-policy.mjs';
import {transcriptTextEvidence,startupLogEvidence,candidateHealthEvidence} from './rsc-runtime-readiness.mjs';
import {createCandidateWatchdog} from './rsc-candidate-watchdog.mjs';
import {captureTranscriptBaseline,deriveRecoveryBaseline,inspectTranscriptAcceptance,isIdleScreenSemantic,negativeAcceptanceDecision,promptDigest} from './delivery-acceptance.mjs';
import {validateDispatchLease} from './dispatch-lease.mjs';
import {prepareShadowCarryover} from '../src/runtimes/rsc/phase2.mjs';
import {createCompactRotationCoordinator,createTranscriptCompactReader} from '../src/runtimes/rsc/compact-rotation.mjs';
import {normalizeProductionRscState} from '../src/runtimes/rsc/production-state.mjs';
import {evaluateCandidateCommit,committedCandidateState} from './rsc-commit-barrier.mjs';
import {productionConversationSnapshot} from '../src/runtimes/production-conversation.mjs';

const SOCKET_FD = 3;
const ALLOWED_UID = 999;
const TMUX = '/usr/bin/tmux';
const CLAUDE = '/usr/bin/claude';
const PYTHON = '/usr/bin/python3';
const TMUX_SOCKET = '/run/qiuqiu-claude-bridge/dwell-frontend.sock';
const SESSION = 'dwell-claude';
const WORKSPACE = '/root';
const OMBRE_ENV_FILE = '/root/.config/qiuqiu/ombre.env';
const HOOK_URL = 'http://127.0.0.1:4173/api/internal/claude-code/events';
const HOOK_SECRET_ENV = 'DWELL_CLAUDE_HOOK_SECRET';
const TIME_ANCHOR_INSTANCE_ENV = 'QIUQIU_TIME_ANCHOR_INSTANCE_KEY';
const TIME_ANCHOR_HOOK = '/root/.local/lib/time-anchor/user-prompt-submit.mjs';
const RSC_STATE_FILE='/opt/qiuqiu/chat-frontend/data/rsc-production-state.json';
const RSC_EVIDENCE_DIR='/root/.local/state/qiuqiu-rsc/evidence';
const FRONTEND_MCP_CONFIG='/root/.config/qiuqiu/frontend-message.mcp.json';
const STARTUP_DEBUG='/root/.local/state/qiuqiu-frontend-message-rollout/startup-debug.log';
const MAX_REQUEST_BYTES = 300 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
let thoughtTurn=null;
const TURN_ID = /^[A-Za-z0-9_.-]{1,120}$/;
const ACCEPTANCE_WINDOW_MS=8000;
const ACCEPTANCE_GRACE_MS=8000;
const ACCEPTANCE_POLL_MS=250;
const PEER_CRED_SCRIPT = [
  'import json,socket,struct',
  's=socket.socket(fileno=3)',
  'pid,uid,gid=struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))',
  'print(json.dumps({"pid":pid,"uid":uid,"gid":gid}))'
].join(';');

const activeTurn = createBridgeActiveTurn();
const lifecycleLog=(event,turnId)=>console.info(JSON.stringify({time:new Date().toISOString(),component:'bridge',event,turnId}));
const stopController=createBridgeStopController({state:activeTurn,log:lifecycleLog,sendEscape:async()=>{
  if(!await hasSession())throw Object.assign(new Error('runtime session is not running'),{status:409});
  await run(TMUX,['-S',TMUX_SOCKET,'send-keys','-t',SESSION,'Escape']);
}});

function sessionSettings() {
  const httpHook = {
    type: 'http',
    url: HOOK_URL,
    timeout: 10,
    headers: { 'x-dwell-hook-secret': `$${HOOK_SECRET_ENV}` },
    allowedEnvVars: [HOOK_SECRET_ENV]
  };
  const currentSettings = createSessionPolicy(httpHook);
  return JSON.stringify(mergeTimeAnchorSettings(currentSettings, { hookCommand: `/usr/bin/node "${TIME_ANCHOR_HOOK}"` }));
}

function run(binary, args, { input, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (code === 0) return resolve(result);
      const error = new Error(result.stderr.trim() || `${binary} exited with code ${code}`);
      Object.assign(error, result);
      reject(error);
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input, 'utf8');
  });
}

function peerCredentials(socket) {
  return new Promise((resolve, reject) => {
    const fd = socket?._handle?.fd;
    if (!Number.isInteger(fd) || fd < 0) return reject(new Error('peer credential fd unavailable'));
    const child = spawn(PYTHON, ['-c', PEER_CRED_SCRIPT], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', fd]
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || 'peer credential probe failed'));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('invalid peer credential result')); }
    });
  });
}

async function hasSession() {
  try {
    await run(TMUX, ['-S', TMUX_SOCKET, 'has-session', '-t', SESSION]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function loadRuntimeEnvironment() {
  const text = await readFile(OMBRE_ENV_FILE, 'utf8');
  const allowed = new Set(['OMBRE_MCP_URL', 'OMBRE_HEADER_1']);
  const values = {};
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !allowed.has(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  for (const key of allowed) if (!values[key]) throw new Error(`required runtime environment missing: ${key}`);
  if (!process.env[HOOK_SECRET_ENV]) throw new Error('required hook secret missing');
  return {
    HOME: '/root',
    USER: 'root',
    LOGNAME: 'root',
    PATH: '/root/.bun/bin:/usr/local/bin:/usr/bin:/bin',
    [HOOK_SECRET_ENV]: process.env[HOOK_SECRET_ENV],
    [TIME_ANCHOR_INSTANCE_ENV]: randomBytes(32).toString('hex'),
    CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    ...values
  };
}

function sessionArgs(resumeSessionId=null){
  const args=['--settings',sessionSettings(),'--add-dir',FRONTEND_PROJECT,'--model','claude-sonnet-4-6','--effort','high','--debug-file',STARTUP_DEBUG,'--mcp-config',FRONTEND_MCP_CONFIG];
  if(resumeSessionId)args.push('--resume',resumeSessionId);
  return args;
}

async function ensureSession() {
  if (await hasSession()) return { created: false };
  const env = await loadRuntimeEnvironment();
  await run(TMUX, ['-S', TMUX_SOCKET, 'new-session', '-d', '-s', SESSION, '-c', WORKSPACE, CLAUDE, ...sessionArgs()], { env });
  return { created: true };
}
const HELPER_SCRIPT='/root/.local/lib/qiuqiu-frontend-message/frontend-message-mcp.mjs';
const TRANSCRIPT_DIR='/root/.claude/projects/-root';
async function panePid(){const result=await run(TMUX,['-S',TMUX_SOCKET,'display-message','-p','-t',SESSION,'#{pane_pid}']);return Number(result.stdout.trim())}
async function processSessionId(){const pid=await panePid(),cmd=(await readFile(`/proc/${pid}/cmdline`)).toString().split('\0'),at=cmd.indexOf('--resume');return at>=0?cmd[at+1]:null}
async function waitUntil(check,timeoutMs=30000){const end=Date.now()+timeoutMs;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,250))}return false}
async function processInfo(pid){try{const [cmd,cwd,env,status]=await Promise.all([readFile(`/proc/${pid}/cmdline`),readlink(`/proc/${pid}/cwd`),readFile(`/proc/${pid}/environ`),readFile(`/proc/${pid}/status`,'utf8')]);return {pid,ppid:Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),uid:Number(status.match(/^Uid:\s+(\d+)/m)?.[1]),cmd:cmd.toString().split('\0').filter(Boolean),cwd,env:env.toString().split('\0')}}catch{return null}}
async function helpersFor(pid){const children=(await run('/usr/bin/pgrep',['-P',String(pid)]).catch(()=>({stdout:''}))).stdout.trim().split(/\s+/).filter(Boolean).map(Number);const found=[];for(const child of children){const info=await processInfo(child);if(info?.cmd.includes(HELPER_SCRIPT))found.push(info)}return found}
async function absent(pid){return !(await processInfo(pid))}
async function stopExactLifecycle(expectedSession){if(!await hasSession())return {claudeAbsent:true,helperAbsent:true,tmuxFree:true,runtimeOwnerCleared:!activeTurn.status().active};const pid=await panePid(),sessionId=await processSessionId();if(sessionId!==expectedSession)throw Object.assign(new Error('managed tmux owner changed'),{status:409});const helpers=await helpersFor(pid);await run(TMUX,['-S',TMUX_SOCKET,'send-keys','-t',SESSION,'-l','/exit']);await run(TMUX,['-S',TMUX_SOCKET,'send-keys','-t',SESSION,'Enter']);const stopped=await waitUntil(async()=>!await hasSession());if(!stopped)throw Object.assign(new Error('lifecycle exit timeout'),{status:504});let helperAbsent=await Promise.all(helpers.map(item=>absent(item.pid))).then(items=>items.every(Boolean));if(!helperAbsent){for(const helper of helpers){const current=await processInfo(helper.pid);if(current?.cmd.includes(HELPER_SCRIPT))process.kill(helper.pid,'SIGTERM')}helperAbsent=await waitUntil(async()=>await Promise.all(helpers.map(item=>absent(item.pid))).then(items=>items.every(Boolean)))}const result={claudeAbsent:await absent(pid),helperAbsent,tmuxFree:!await hasSession(),runtimeOwnerCleared:!activeTurn.status().active};if(!lifecycleFree(result))throw Object.assign(new Error('lifecycle ownership was not released'),{status:504});return result}
async function stopProduction(op){const pid=await panePid(),helpers=await helpersFor(pid),result=await stopExactLifecycle(op.sourceSessionId);return {...result,sourceStopped:true,oldClaudePid:pid,oldHelperPids:helpers.map(item=>item.pid)}}
async function startExact(sessionId){if(await hasSession())throw Object.assign(new Error('runtime session already exists'),{status:409});const env=await loadRuntimeEnvironment(),debugOffset=await stat(STARTUP_DEBUG).then(value=>value.size).catch(()=>0);await run(TMUX,['-S',TMUX_SOCKET,'new-session','-d','-s',SESSION,'-c',WORKSPACE,CLAUDE,...sessionArgs(sessionId)],{env});return {startedAt:Date.now(),debugOffset}}
function settingsEvidence(raw){try{const value=JSON.parse(raw),hooks=value.hooks||{};return {permissionsIntact:sessionPolicyEvidence(value),hooksIntact:['UserPromptSubmit','MessageDisplay','Stop','StopFailure'].every(item=>Array.isArray(hooks[item])&&hooks[item].length)}}catch{return {permissionsIntact:false,hooksIntact:false}}}
async function transcriptEvidence(sessionId){try{return transcriptTextEvidence(await readFile(`${TRANSCRIPT_DIR}/${sessionId}.jsonl`,'utf8'),sessionId).valid}catch{return false}}
async function transcriptStartupCounts(sessionId){
 try{
  const raw=await readFile(`${TRANSCRIPT_DIR}/${sessionId}.jsonl`,'utf8'),base=transcriptTextEvidence(raw,sessionId),lines=base.records||[];
  const counts={user:0,assistant:0,mcp:0,compact:false,compactCount:0,parseable:base.parseable===true,hardFailure:base.hardFailure===true,writeInProgress:base.writeInProgress===true,readinessSubreason:base.reason||null,validSessionTranscript:base.valid===true,validRecordCount:base.recordCount||0,transcriptWritable:true,resumeHistoryInitialized:false,resumeMetadataInitialized:false,modeObserved:false,permissionModeObserved:false,resumeMilestone:false,wrongSessionRecord:base.wrongSessionRecord===true,startupStructureValid:true,orphanStartupRecord:false};
  let historyAt=-1,modeAt=-1,permissionAt=-1,metadataAt=-1,previousUuid=null,chainValid=true;
  for(let index=0;index<lines.length;index++){const row=lines[index];if(row.type==='user'||row.type==='assistant'){counts[row.type]++;if(typeof row.uuid!=='string'||(previousUuid!==null&&row.parentUuid!==previousUuid))chainValid=false;previousUuid=row.uuid||previousUuid}if(row.subtype==='compact_boundary'||row.isCompactSummary){counts.compact=true;counts.compactCount++}const content=row.message?.content;if(Array.isArray(content))counts.mcp+=content.filter(item=>item?.type==='tool_use').length;if(row.type==='file-history-snapshot')historyAt=index;if(['atis-latch','mode','permission-mode'].includes(row.type)){if(row.sessionId!==sessionId)counts.wrongSessionRecord=true;else if(metadataAt<0)metadataAt=index}if(row.type==='mode'&&row.sessionId===sessionId)modeAt=index;if(row.type==='permission-mode'&&row.sessionId===sessionId)permissionAt=index}
  counts.resumeHistoryInitialized=historyAt>=0;counts.resumeMetadataInitialized=metadataAt>=0&&chainValid&&!counts.wrongSessionRecord;counts.modeObserved=modeAt>=0;counts.permissionModeObserved=permissionAt>=0;counts.resumeMilestone=counts.resumeMetadataInitialized&&counts.modeObserved&&counts.permissionModeObserved;counts.orphanStartupRecord=!chainValid;counts.startupStructureValid=chainValid&&!counts.wrongSessionRecord;
  if(counts.hardFailure)counts.readinessSubreason='MALFORMED_STABLE_RECORD';else if(counts.writeInProgress)counts.readinessSubreason='WRITE_IN_PROGRESS';else if(counts.validRecordCount===0)counts.readinessSubreason='WAITING_FOR_TRANSCRIPT';else if(!counts.startupStructureValid)counts.readinessSubreason='WAITING_FOR_VALID_CHAIN';else if(!counts.resumeMilestone||!counts.validSessionTranscript)counts.readinessSubreason='WAITING_FOR_STARTUP_EVIDENCE';else counts.readinessSubreason=null;
  return counts;
 }catch{return {user:0,assistant:0,mcp:0,compact:false,compactCount:0,parseable:true,hardFailure:false,writeInProgress:false,readinessSubreason:'WAITING_FOR_TRANSCRIPT',validSessionTranscript:false,validRecordCount:0,transcriptWritable:false,resumeHistoryInitialized:false,resumeMetadataInitialized:false,modeObserved:false,permissionModeObserved:false,resumeMilestone:false,wrongSessionRecord:false,startupStructureValid:true,orphanStartupRecord:false}}
}
async function startupEvidence(offset=0,screen=''){let debug='';try{const bytes=await readFile(STARTUP_DEBUG);debug=bytes.subarray(Math.min(offset,bytes.length)).toString('utf8')}catch{}return startupLogEvidence(`${debug}\n${screen}`)}
async function allHelpers(){const pids=(await run('/usr/bin/pgrep',['-f',HELPER_SCRIPT]).catch(()=>({stdout:''}))).stdout.trim().split(/\s+/).filter(Boolean).map(Number);const result=[];for(const pid of pids){const info=await processInfo(pid);if(info?.cmd.includes(HELPER_SCRIPT))result.push(info)}return result}
async function activationOwners(owners,pid,operation,phase){const resolved=await resolveOwnershipCandidates({owners,expectedProductionPid:-1,expectedShadowPid:pid});if(!resolved.valid)await captureAndRejectOwnership({owners:[pid,...resolved.unexpected],expectedProductionPid:-1,expectedShadowPid:pid,path:`/root/.local/state/qiuqiu-rsc/diagnostics/${operation.targetSessionId}-activation-ownership.json`,operationId:operation.operationId||operation.targetSessionId,tmux:{socket:TMUX_SOCKET,session:SESSION,phase}});return resolved}
async function inspectStarted(operation,started={}){if(!await hasSession())throw Object.assign(new Error('FAILED_PROCESS_EXIT'),{reason:'FAILED_PROCESS_EXIT'});const emerged=await waitUntil(async()=>{if(!await hasSession())return true;const current=await run(TMUX,['-S',TMUX_SOCKET,'capture-pane','-p','-t',SESSION]).then(r=>r.stdout).catch(()=> '');return detectWorkspaceTrustGate(current).kind!=='STARTING'});if(!emerged)throw Object.assign(new Error('FAILED_STARTUP_TIMEOUT'),{reason:'FAILED_STARTUP_TIMEOUT'});let pid=await panePid(),info=await processInfo(pid),sessionId=await processSessionId(),screen=await run(TMUX,['-S',TMUX_SOCKET,'capture-pane','-p','-t',SESSION]).then(r=>r.stdout).catch(()=>''),trust=detectWorkspaceTrustGate(screen);const version=(await run(CLAUDE,['--version'])).stdout.trim().match(/^(\S+)/)?.[1],allBefore=await allHelpers(),claudePids=(await run('/usr/bin/pgrep',['-x','claude']).catch(()=>({stdout:''}))).stdout.trim().split(/\s+/).filter(Boolean).map(Number),initialOwners=await activationOwners(claudePids,pid,operation,'INITIAL'),countsBefore=await transcriptStartupCounts(operation.targetSessionId),settingsRaw=info?.cmd[info.cmd.indexOf('--settings')+1]||'',debugOffset=started.debugOffset||0;
 const startupController={screen:async()=>run(TMUX,['-S',TMUX_SOCKET,'capture-pane','-p','-t',SESSION]).then(r=>r.stdout),conversationCounts:async()=>{const c=await transcriptStartupCounts(operation.targetSessionId);return {user:c.user,assistant:c.assistant,compactCount:c.compactCount}},permissionFingerprint:async()=>settingsRaw,confirmSelectedOption:async()=>run(TMUX,['-S',TMUX_SOCKET,'send-keys','-t',SESSION,'Enter']),runtimeEvidence:async()=>{if(!await hasSession())return {processAlive:false};const currentPid=await panePid(),current=await processInfo(currentPid),currentSession=await processSessionId(),owners=(await run('/usr/bin/pgrep',['-x','claude']).catch(()=>({stdout:''}))).stdout.trim().split(/\s+/).filter(Boolean).map(Number),resolved=await activationOwners(owners,pid,operation,'DURABLE_READY_POLL'),allCurrentHelpers=await allHelpers();return {processAlive:Boolean(current),exactSession:currentSession===operation.targetSessionId,ownershipIntact:currentPid===pid,unexpectedClaudeOwner:!resolved.valid,unexpectedHelperOwner:allCurrentHelpers.some(item=>item.ppid!==pid),uid:current?.uid,home:current?.env.find(v=>v.startsWith('HOME='))?.slice(5),canonicalCwd:current?.cwd}},transcriptEvidence:async()=>transcriptStartupCounts(operation.targetSessionId),startupEvidence:async()=>startupEvidence(debugOffset,await run(TMUX,['-S',TMUX_SOCKET,'capture-pane','-p','-t',SESSION]).then(r=>r.stdout).catch(()=>'')),readyEvidence:async(_runtime,transcript,startup)=>{const currentPid=await panePid().catch(()=>null),helpers=currentPid?await helpersFor(currentPid):[];return transcript.resumeMilestone===true&&transcript.validSessionTranscript===true&&startup.frontendMcpConnected===true&&helpers.length===1},mcpCallCount:async()=>(await transcriptStartupCounts(operation.targetSessionId)).mcp-countsBefore.mcp};
 await handleManagedStartup({context:{executable:info?.cmd[0],version,managedOperation:true,targetSessionId:sessionId,expectedTargetSessionId:operation.targetSessionId,uid:info?.uid,home:info?.env.find(v=>v.startsWith('HOME='))?.slice(5),canonicalCwd:info?.cwd,displayedWorkspace:trust.workspace,unexpectedClaudeOwner:!initialOwners.valid,unexpectedHelperOwner:allBefore.some(item=>item.ppid!==pid)},controller:startupController});
 pid=await panePid();info=await processInfo(pid);sessionId=await processSessionId();screen=await run(TMUX,['-S',TMUX_SOCKET,'capture-pane','-p','-t',SESSION]).then(r=>r.stdout).catch(()=> '');trust=detectWorkspaceTrustGate(screen);const helpers=await helpersFor(pid),all=await allHelpers(),sessions=(await run(TMUX,['-S',TMUX_SOCKET,'list-sessions','-F','#{session_name}']).catch(()=>({stdout:''}))).stdout.trim().split(/\r?\n/).filter(Boolean),settings=settingsEvidence(info?.cmd[info.cmd.indexOf('--settings')+1]),semantic=classifyStartupScreen(screen),onboarding=['OAUTH','LOGIN','THEME','PERMISSION_MODE','PERMISSION','MCP_GATE','RESUME_CONFIRMATION'].includes(semantic.kind)||(semantic.kind==='UNKNOWN'&&semantic.interactive===true),obConfigured=await loadRuntimeEnvironment().then(()=>true).catch(()=>false),addDirAt=info?.cmd.indexOf('--add-dir')??-1,transcript=await transcriptStartupCounts(operation.targetSessionId),startup=await startupEvidence(debugOffset,screen);const value={claudeAlive:Boolean(info),processStable:true,resumeConfirmed:transcript.resumeMilestone===true,validSessionTranscript:transcript.validSessionTranscript===true,claudePid:pid,resumedSessionId:sessionId,debugOffset,workspaceRoot:info?.cwd===WORKSPACE,projectDirectoryAdded:addDirAt>=0&&info?.cmd[addDirAt+1]===FRONTEND_PROJECT,tmuxIdentity:sessions.length===1&&sessions[0]===SESSION,singleManagedClaude:sessions.length===1&&sessions[0]===SESSION,helperAlive:helpers.length===1,helperPid:helpers[0]?.pid||null,helperParentMatches:helpers.length===1,oldHelperAbsent:all.length===1&&all[0]?.pid===helpers[0]?.pid,helperIdentityMatches:helpers.length===1&&helpers[0].cmd.includes(HELPER_SCRIPT),runtimeConnected:await hasSession(),active:activeTurn.status().active,activeTurnId:activeTurn.status().activeTurnId,frontendMcpConnected:startup.frontendMcpConnected===true,obConfigured,modelExact:info?.cmd.includes('claude-sonnet-4-6')===true,effortHigh:info?.cmd.includes('--effort')===true&&info?.cmd[info?.cmd.indexOf('--effort')+1]==='high',noModelFallback:info?.env.includes('CLAUDE_CODE_NO_MODEL_FALLBACK=1')===true,transcriptParseable:transcript.parseable===true,...settings,claudeMdAvailable:await readFile('/root/CLAUDE.md','utf8').then(()=>true).catch(()=>false),onboardingDetected:onboarding,startupError:startup.fatal===true||/\b(error|fatal)\b/i.test(screen),autoCompacted:transcript.compactCount>countsBefore.compactCount,emptySessionFallback:sessionId!==operation.targetSessionId};const result={...value,ready:targetReadyEvidence(value,operation.targetSessionId)};if(!result.ready)throw Object.assign(new Error(startup.fatalReason||'TARGET_NOT_READY'),{reason:startup.fatalReason||'TARGET_NOT_READY'});return result}
const rscHandoff=createRscBridgeHandoff({loadOperation:async id=>{const state=normalizeProductionRscState(JSON.parse(await readFile(RSC_STATE_FILE,'utf8')));if(state.operationId!==id||state.operationGeneration!==state.rotationAttemptGeneration)throw Object.assign(new Error('generation mismatch'),{status:409});return state},productionSession:processSessionId,stopOld:stopProduction,startTarget:op=>startExact(op.targetSessionId),inspectTarget:inspectStarted,resumeLastGood:async(op,{afterTargetFailure=false}={})=>{if(afterTargetFailure){const cleanup=await stopExactLifecycle(op.targetSessionId);if(!lifecycleFree(cleanup))throw Object.assign(new Error('target cleanup barrier failed'),{status:504})}const started=await startExact(op.lastGoodSessionId),ready=await inspectStarted({...op,targetSessionId:op.lastGoodSessionId},started);return {sourceReady:ready.ready,...ready}}});
const loadRscState=async()=>normalizeProductionRscState(JSON.parse(await readFile(RSC_STATE_FILE,'utf8')));
const saveRscState=value=>atomicWriteRootRscState(RSC_STATE_FILE,normalizeProductionRscState(value));
const rscLog=value=>console.info(JSON.stringify({time:new Date().toISOString(),component:'rsc_compact',...value}));
async function inspectCandidateHealth(state){const running=await hasSession();let sessionId=null,pid=null,process=null,helpers=[],screen='';if(running){pid=await panePid().catch(()=>null);sessionId=await processSessionId().catch(()=>null);process=pid?await processInfo(pid):null;helpers=pid?await helpersFor(pid):[];screen=await run(TMUX,['-S',TMUX_SOCKET,'capture-pane','-p','-t',SESSION]).then(r=>r.stdout).catch(()=>'')}const transcript=await readFile(`${TRANSCRIPT_DIR}/${state.candidateActiveSessionId}.jsonl`,'utf8').then(text=>transcriptTextEvidence(text,state.candidateActiveSessionId)).catch(()=>({valid:false,reason:'FAILED_TRANSCRIPT_MISSING'})),startup=await startupEvidence(state.candidateDebugOffset||0,screen),turn=activeTurn.get(),released=state.firstRealTurnId?activeTurn.releasedOutcome(state.firstRealTurnId):null;if(turn?.turnId===state.firstRealTurnId&&turn.phase==='delivery_uncertain')return {healthy:false,transcriptStable:false,reason:'FIRST_TURN_DELIVERY_UNCERTAIN'};if(released?.outcome==='delivery_failed')return {healthy:false,transcriptStable:false,reason:released.code||'FIRST_TURN_DELIVERY_NOT_ACCEPTED'};return {...candidateHealthEvidence({running,sessionId,expectedSessionId:state.candidateActiveSessionId,processAlive:Boolean(process),helperAlive:helpers.length===1,transcript,startup}),transcriptStable:transcript.valid===true&&transcript.writeInProgress!==true&&transcript.hardFailure!==true}}
async function waitForCandidateCommitHealth(state,deadlineMs=8000){const deadline=Date.now()+deadlineMs;let health;do{health=await inspectCandidateHealth(state);if(health.healthy!==true||health.transcriptStable===true)return health;await new Promise(resolve=>setTimeout(resolve,250))}while(Date.now()<deadline);return {...health,healthy:false,reason:'FAILED_COMMIT_TRANSCRIPT_STABILITY'}}
async function recoverCandidateFailure(state,reason,subreason=null){const candidate=state.candidateActiveSessionId||state.preparedTargetSessionId,currentTurn=activeTurn.get();if(currentTurn&&['delivery_uncertain','input_submitted','input_submitting'].includes(currentTurn.phase))activeTurn.failDelivery(currentTurn.turnId,reason);else activeTurn.clear();const failedAt=new Date().toISOString(),failure={reason,subreason,failedAt,attemptGeneration:state.rotationAttemptGeneration};const recovering={...state,handoffState:'RECOVER_LAST_GOOD',candidateState:reason==='FAILED_TRANSCRIPT_PARSE'?'FAILED_STARTUP_TRANSCRIPT':'FAILED_READINESS',failedTargetSessionId:candidate,candidateFailure:failure,preparedTargetEvidence:reason==='FAILED_TRANSCRIPT_PARSE'?'FAILED_STARTUP_TRANSCRIPT':'FAILED_READINESS',updatedAt:failedAt,lastRotationFailure:{compactId:state.lastConsumedCompact?.compactId||state.pendingRotation?.compactId||null,...failure}};await saveRscState(recovering);try{const recovered=await rscHandoff.rollback(state.operationId);if(!recovered?.sourceReady)throw new Error('LAST_GOOD_NOT_READY');const now=new Date().toISOString();await saveRscState({...await loadRscState(),currentProductionSessionId:state.lastGoodSessionId,lastGoodSessionId:state.lastGoodSessionId,handoffState:'ACTIVE',candidateActiveSessionId:null,candidateSourceSessionId:null,candidateDebugOffset:null,candidateClaudePid:null,candidateHelperPid:null,pendingRotation:null,lastRotationFailure:{compactId:state.lastConsumedCompact?.compactId||null,...failure},updatedAt:now});return recovered}catch(error){await saveRscState({...await loadRscState(),currentProductionSessionId:state.lastGoodSessionId,lastGoodSessionId:state.lastGoodSessionId,handoffState:'FAILED_SAFE',candidateActiveSessionId:null,candidateSourceSessionId:null,lastRotationFailure:{compactId:state.lastConsumedCompact?.compactId||null,failedAt:new Date().toISOString(),reason:`${reason}; RECOVERY_FAILED`,subreason:String(error.message||error).slice(0,100),attemptGeneration:state.rotationAttemptGeneration},updatedAt:new Date().toISOString()});throw error}}
const candidateWatchdog=createCandidateWatchdog({loadState:loadRscState,inspectCandidate:inspectCandidateHealth,recoverLastGood:recoverCandidateFailure,log:rscLog});
async function rotateForCompact(pending,observedState){
  if(activeTurn.status().active)throw Object.assign(new Error('rotation attempted during active turn'),{status:409});
  observedState=normalizeProductionRscState(observedState);const sourceSessionId=observedState.currentProductionSessionId,generation=observedState.rotationAttemptGeneration+1,operationId=`rscop_generation_${String(generation).padStart(4,'0')}`;
  let state={...observedState,handoffState:'PREPARING',candidateState:'PREPARING',rotationAttemptGeneration:generation,handoffGeneration:generation,operationGeneration:generation,operationId,candidateActiveSessionId:null,candidateSourceSessionId:sourceSessionId,updatedAt:new Date().toISOString()};
  await saveRscState(state);
  try{
    await mkdir(RSC_EVIDENCE_DIR,{recursive:true,mode:0o700});
    const prepared=await prepareShadowCarryover({projectDir:TRANSCRIPT_DIR,sourceSessionId,evidenceDir:RSC_EVIDENCE_DIR});
    state=await loadRscState();
    if(state.pendingRotation?.compactId!==pending.compactId||state.currentProductionSessionId!==sourceSessionId||activeTurn.status().active)throw Object.assign(new Error('rotation ownership changed during prepare'),{status:409});
    state={...state,preparedTargetSessionId:prepared.targetSessionId,preparedTargetEvidence:'PREPARED',handoffState:'ACTIVATING',candidateState:'STARTING',updatedAt:new Date().toISOString()};
    await saveRscState(state);
    const activated=await rscHandoff.activate(operationId);
    if(!targetReadyEvidence(activated.ready,prepared.targetSessionId)){
      await rscHandoff.rollback(operationId);
      throw Object.assign(new Error('target readiness failed'),{status:503});
    }
    const completedAt=new Date().toISOString();
    const next={...await loadRscState(),handoffState:'CANDIDATE_ACTIVE',candidateState:'VALIDATING',candidateActiveSessionId:prepared.targetSessionId,candidateSourceSessionId:sourceSessionId,candidateDebugOffset:activated.ready.debugOffset,candidateClaudePid:activated.ready.claudePid,candidateHelperPid:activated.ready.helperPid,firstRealTurnId:null,pendingRotation:null,lastConsumedCompact:{...pending,consumedAt:completedAt,attemptGeneration:generation,productionGeneration:state.productionGeneration},lastRotationFailure:null,updatedAt:completedAt};
    await saveRscState(next);candidateWatchdog.start();rscLog({event:'rotation_candidate_active',sourceSessionId,targetSessionId:prepared.targetSessionId,generation,compactId:pending.compactId});
    return {status:'CANDIDATE_ACTIVE',sourceSessionId,targetSessionId:prepared.targetSessionId,generation};
  }catch(error){
    const latest=await loadRscState().catch(()=>state);let actual=null;try{actual=await processSessionId()}catch{}
    const safeState=actual===sourceSessionId?'ACTIVE':'FAILED_SAFE',failedAt=new Date().toISOString(),reason=String(error.reason||error.message||'ROTATION_FAILED').slice(0,160),subreason=error.subreason||null,failedTargetSessionId=latest.preparedTargetSessionId!==sourceSessionId?latest.preparedTargetSessionId:null,candidateState=reason==='FAILED_TRANSCRIPT_PARSE'?'FAILED_STARTUP_TRANSCRIPT':'FAILED_READINESS';
    await saveRscState({...latest,currentProductionSessionId:sourceSessionId,lastGoodSessionId:sourceSessionId,handoffState:safeState,candidateState,failedTargetSessionId,candidateFailure:{reason,subreason,failedAt,attemptGeneration:generation},preparedTargetEvidence:candidateState,pendingRotation:{...pending,deferUntilTurnFinished:true},lastRotationFailure:{compactId:pending.compactId,failedAt,reason,subreason,attemptGeneration:generation},updatedAt:failedAt});
    rscLog({event:'rotation_failed',compactId:pending.compactId,sessionId:sourceSessionId,state:safeState,reason:String(error.message||'ROTATION_FAILED').slice(0,160)});throw error;
  }
}
const latestCompact=createTranscriptCompactReader({projectDir:TRANSCRIPT_DIR});
const compactRotation=createCompactRotationCoordinator({loadState:loadRscState,saveState:saveRscState,latestCompact,isActive:()=>activeTurn.status().active,rotate:rotateForCompact,log:rscLog});

async function authoritativeDispatchLease(){const state=await loadRscState();return {sessionId:state.candidateActiveSessionId||state.currentProductionSessionId,generation:state.rotationAttemptGeneration}}
async function assertDispatchLease(lease){return validateDispatchLease({provided:lease,expected:await authoritativeDispatchLease(),actualSessionId:await processSessionId()})}
async function transcriptBaseline(sessionId){const path=`${TRANSCRIPT_DIR}/${sessionId}.jsonl`;for(let index=0;index<12;index++){const [buffer,info]=await Promise.all([readFile(path),stat(path)]),baseline=captureTranscriptBaseline({buffer,stat:info,sessionId});if(baseline.valid)return {path,baseline};if(baseline.reason!=='BASELINE_WRITE_IN_PROGRESS')throw Object.assign(new Error(baseline.reason),{status:409,code:baseline.reason});await new Promise(resolve=>setTimeout(resolve,ACCEPTANCE_POLL_MS))}throw Object.assign(new Error('transcript baseline remained incomplete'),{status:409,code:'BASELINE_WRITE_IN_PROGRESS'})}
async function inspectDelivery(turn){const [buffer,info]=await Promise.all([readFile(turn.details.path),stat(turn.details.path)]);return inspectTranscriptAcceptance({baseline:turn.details.baseline,buffer,stat:info,sessionId:turn.details.sessionId,expectedDigest:turn.details.expectedDigest})}
async function idleFrame(){const screen=await run(TMUX,['-S',TMUX_SOCKET,'capture-pane','-p','-t',SESSION]).then(result=>result.stdout).catch(()=>'');const semantic=classifyStartupScreen(screen);return {idle:isIdleScreenSemantic(semantic)}}
async function awaitDeliveryAcceptance(turnId,{windowMs=ACCEPTANCE_WINDOW_MS,graceMs=ACCEPTANCE_GRACE_MS}={}){
  const started=Date.now(),deadline=started+windowMs+graceMs;let last=null;
  while(Date.now()<=deadline){
    const turn=activeTurn.get();if(!turn||turn.turnId!==turnId){const released=activeTurn.releasedOutcome(turnId);return released?.outcome==='delivery_failed'?{deliveryState:'delivery_failed',code:released.code}:{deliveryState:'delivery_uncertain',code:'ACTIVE_LEASE_LOST'}}
    last=await inspectDelivery(turn);
    if(last.state==='input_accepted'){activeTurn.markAccepted(turnId);lifecycleLog('input_accepted',turnId);return {deliveryState:'input_accepted'}}
    if(last.state==='delivery_uncertain'){activeTurn.markUncertain(turnId,last.reason);lifecycleLog('delivery_uncertain',turnId);return {deliveryState:'delivery_uncertain',code:last.reason}}
    if(Date.now()>=started+windowMs&&!last.writeInProgress){const frame=await idleFrame();turn.details.idleCount=frame.idle?(turn.details.idleCount||0)+1:0;const decision=negativeAcceptanceDecision({windowElapsed:true,writeInProgress:last.writeInProgress,idleStableCount:turn.details.idleCount});if(decision.state==='delivery_failed'){activeTurn.failDelivery(turnId,decision.code);if(thoughtTurn?.turnId===turnId)thoughtTurn=null;lifecycleLog('delivery_failed',turnId);return {deliveryState:decision.state,code:decision.code}}}
    await new Promise(resolve=>setTimeout(resolve,ACCEPTANCE_POLL_MS));
  }
  activeTurn.markUncertain(turnId,last?.reason||'ACCEPTANCE_TIMEOUT');lifecycleLog('delivery_uncertain',turnId);return {deliveryState:'delivery_uncertain',code:last?.reason||'ACCEPTANCE_TIMEOUT'};
}
function deliveryStatus(turnId){
  const turn=activeTurn.get();
  if(turn?.turnId===turnId){
    if(['input_accepted','running'].includes(turn.phase))return {deliveryState:'input_accepted'};
    if(turn.phase==='delivery_uncertain')return {deliveryState:'delivery_uncertain',code:turn.uncertainReason||'DELIVERY_UNCERTAIN'};
    return {deliveryState:'input_submitted'};
  }
  const released=activeTurn.releasedOutcome(turnId);
  return {deliveryState:released?.outcome||'unknown',code:released?.code||null};
}
async function sendPrompt(turnId, prompt, lease) {
  if (!await hasSession()) throw Object.assign(new Error('runtime session is not running'), { status: 409 });
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (!prompt.trim() || bytes > MAX_PROMPT_BYTES) throw Object.assign(new Error('invalid prompt'), { status: 400 });
  await assertDispatchLease(lease);
  const ownerSessionId=lease.sessionId,{path,baseline}=await transcriptBaseline(ownerSessionId),expectedDigest=promptDigest(prompt);
  const buffer = `dwell-${turnId}`;
  if(stopController.isPending())throw Object.assign(new Error('stop still in progress'),{status:409});
  if(activeTurn.get()?.turnId===turnId)return deliveryStatus(turnId);
  activeTurn.reserve(turnId,{sessionId:ownerSessionId,path,baseline,expectedDigest,lease});
  const rscState=await loadRscState();if(rscState.candidateActiveSessionId===ownerSessionId&&!rscState.firstRealTurnId)await saveRscState({...rscState,firstRealTurnId:turnId,updatedAt:new Date().toISOString()});
  thoughtTurn={turnId,sessionId:ownerSessionId,path,offset:baseline.offset};
  lifecycleLog('turn_reserved',turnId);
  let loaded = false,pasted = false,submitted = false;
  try {
    await run(TMUX, ['-S', TMUX_SOCKET, 'load-buffer', '-b', buffer, '-'], { input: prompt.replace(/\r\n?/g, '\n') });
    loaded = true;
    await run(TMUX, ['-S', TMUX_SOCKET, 'paste-buffer', '-p', '-b', buffer, '-t', SESSION]);
    pasted = true;
    await new Promise(resolve => setTimeout(resolve, 900));
    await assertDispatchLease(lease);
    await run(TMUX, ['-S', TMUX_SOCKET, 'send-keys', '-t', SESSION, 'Enter']);
    submitted = true;
    activeTurn.markSubmitted(turnId);
    lifecycleLog('input_submitted',turnId);
  } catch (error) {
    if(pasted&&!submitted)await run(TMUX,['-S',TMUX_SOCKET,'send-keys','-t',SESSION,'C-u']).catch(()=>undefined);
    activeTurn.failBeforeSent(turnId);
    const latest=await loadRscState().catch(()=>null);if(latest?.firstRealTurnId===turnId&&latest.candidateActiveSessionId===ownerSessionId)await saveRscState({...latest,firstRealTurnId:null,updatedAt:new Date().toISOString()});
    throw error;
  } finally {
    if (loaded) await run(TMUX, ['-S', TMUX_SOCKET, 'delete-buffer', '-b', buffer]).catch(() => undefined);
  }
  void awaitDeliveryAcceptance(turnId).catch(error=>{
    if(activeTurn.get()?.turnId===turnId){activeTurn.markUncertain(turnId,error?.code||'ACCEPTANCE_RECONCILIATION_FAILED');lifecycleLog('delivery_uncertain',turnId)}
  });
  return {deliveryState:'input_submitted'};
}

async function recoverDelivery(message){
  await assertDispatchLease(message.lease);const sessionId=message.lease.sessionId,path=`${TRANSCRIPT_DIR}/${sessionId}.jsonl`,[buffer,info]=await Promise.all([readFile(path),stat(path)]),baseline=deriveRecoveryBaseline({buffer,stat:info,sessionId,createdAt:message.createdAt});if(!baseline.valid)throw Object.assign(new Error(baseline.reason),{status:409});
  if(activeTurn.get()&&activeTurn.get().turnId!==message.turnId)throw Object.assign(new Error('active turn already exists'),{status:409});
  if(!activeTurn.get()){activeTurn.reserve(message.turnId,{sessionId,path,baseline,expectedDigest:promptDigest(message.prompt),lease:message.lease});activeTurn.markSubmitted(message.turnId)}
  return awaitDeliveryAcceptance(message.turnId,{windowMs:0,graceMs:2000});
}

async function commitCandidateAfterRealTurn(turn,terminalType){const state=await loadRscState();if(!state.candidateActiveSessionId)return false;const actual=await processSessionId(),health=await waitForCandidateCommitHealth(state),decision=evaluateCandidateCommit({state,turn,terminalType,actualSessionId:actual,health});if(!decision.allowed){await recoverCandidateFailure(state,terminalType==='turn_done'?'FAILED_COMMIT_BARRIER':'FAILED_FIRST_REAL_TURN',decision.reasons.join(','));return false}const latest=await loadRscState();if(latest.operationId!==state.operationId||latest.rotationAttemptGeneration!==state.rotationAttemptGeneration||latest.candidateActiveSessionId!==state.candidateActiveSessionId)throw Object.assign(new Error('candidate commit CAS changed'),{status:409});await saveRscState(committedCandidateState(latest));candidateWatchdog.stop();return true}
async function completeTurn(turnId,terminalType) {
  const turn=activeTurn.get();
  if(!turn||turn.turnId!==turnId)throw Object.assign(new Error('active turn does not match'),{status:409});
  activeTurn.complete(turnId);
  lifecycleLog('complete',turnId);
  await commitCandidateAfterRealTurn(turn,terminalType);
  if(thoughtTurn?.turnId===turnId)thoughtTurn=null;
  void compactRotation.turnFinished().catch(error=>rscLog({event:'turn_finished_rotation_error',reason:String(error.message||error).slice(0,160)}));
}

async function thoughtSnapshot(turnId){if(!thoughtTurn||thoughtTurn.turnId!==turnId)throw Object.assign(new Error('thought turn does not match'),{status:409});const bytes=await readFile(thoughtTurn.path),cursor=bytes.length;const tail=bytes.subarray(Math.min(thoughtTurn.offset,cursor)).toString('utf8'),lines=tail.split(/\r?\n/).filter(Boolean),records=[];for(const line of lines){try{const value=JSON.parse(line);if(value.sessionId===thoughtTurn.sessionId||value.session_id===thoughtTurn.sessionId)records.push(value)}catch{}}return {version:1,cursor,...normalizeThoughtRecords(records)}}

async function productionConversation(){
  const state=await loadRscState(),ownerSessionId=state.candidateActiveSessionId||state.currentProductionSessionId;
  if(!ownerSessionId||!await hasSession())return {available:false,messages:[]};
  const actualSessionId=await processSessionId().catch(()=>null);
  if(actualSessionId!==ownerSessionId)return {available:false,messages:[]};
  const evidence=await readFile(`${TRANSCRIPT_DIR}/${ownerSessionId}.jsonl`,'utf8').then(text=>transcriptTextEvidence(text,ownerSessionId)).catch(()=>null);
  if(!evidence||evidence.hardFailure||!evidence.parseable||!evidence.valid||!evidence.records?.length)return {available:false,messages:[]};
  return productionConversationSnapshot(evidence.records);
}

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function dispatch(message) {
  if (message.op === 'status') {
    if (!exactFields(message, ['op'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    const running = await hasSession();
    if (!running) activeTurn.clear();
    return { ok: true, running, ...activeTurn.status(), session: SESSION };
  }
  if (message.op === 'ensure') {
    if (!exactFields(message, ['op'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    const result = await ensureSession();
    return { ok: true, running: true, created: result.created, session: SESSION };
  }
  if (message.op === 'send') {
    if (!exactFields(message, ['op', 'turnId', 'prompt','lease'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    if (!TURN_ID.test(String(message.turnId || '')) || typeof message.prompt !== 'string') throw Object.assign(new Error('invalid request'), { status: 400 });
    return { ok: true,...await sendPrompt(message.turnId, message.prompt,message.lease) };
  }
  if(message.op==='delivery_status'){
    if(!exactFields(message,['op','turnId'])||!TURN_ID.test(String(message.turnId||'')))throw Object.assign(new Error('invalid request'),{status:400});
    return {ok:true,...deliveryStatus(message.turnId)};
  }
  if(message.op==='recover_delivery'){
    if(!exactFields(message,['op','turnId','prompt','createdAt','lease'])||!TURN_ID.test(String(message.turnId||''))||typeof message.prompt!=='string'||typeof message.createdAt!=='string')throw Object.assign(new Error('invalid request'),{status:400});
    return {ok:true,...await recoverDelivery(message)};
  }
  if (message.op === 'stop') {
    if (!exactFields(message, ['op', 'turnId'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    if (!TURN_ID.test(String(message.turnId || ''))) throw Object.assign(new Error('invalid request'), { status: 400 });
    return {ok:true,...await stopController.stop(message.turnId)};
  }
  if (message.op === 'complete') {
    if (!exactFields(message, ['op', 'turnId','terminalType'])) throw Object.assign(new Error('unknown fields'), { status: 400 });
    if (!TURN_ID.test(String(message.turnId || ''))||!['turn_done','turn_error','turn_stopped'].includes(message.terminalType)) throw Object.assign(new Error('invalid request'), { status: 400 });
    await completeTurn(message.turnId,message.terminalType);
    return { ok: true };
  }
  if(message.op==='thought_snapshot'){
    if(!exactFields(message,['op','turnId'])||!TURN_ID.test(String(message.turnId||'')))throw Object.assign(new Error('invalid request'),{status:400});
    return {ok:true,...await thoughtSnapshot(message.turnId)};
  }
  if(message.op==='production_conversation'){
    if(!exactFields(message,['op']))throw Object.assign(new Error('unknown fields'),{status:400});
    return {ok:true,...await productionConversation()};
  }
  if(message.op==='activate_carryover'||message.op==='rollback_carryover')return dispatchRscBridge(message,rscHandoff);
  throw Object.assign(new Error('unknown op'), { status: 400 });
}

const isClientDisconnect = error => ['EPIPE', 'ECONNRESET'].includes(error?.code);

function reply(socket, value) {
  if (socket.destroyed || !socket.writable) return false;
  try {
    socket.end(JSON.stringify(value) + '\n', error => {
      if (!error) return;
      if (isClientDisconnect(error)) return process.stderr.write(`bridge client disconnected: ${error.code}\n`);
      socket.destroy(error);
    });
    return true;
  } catch (error) {
    if (isClientDisconnect(error)) {
      process.stderr.write(`bridge client disconnected: ${error.code}\n`);
      return false;
    }
    throw error;
  }
}

const server = net.createServer({ allowHalfOpen: true }, socket => {
  let raw = '';
  let rejected = false;
  socket.on('error', error => {
    if (isClientDisconnect(error)) process.stderr.write(`bridge client disconnected: ${error.code}\n`);
    else process.stderr.write(`bridge connection error: ${error.message}\n`);
  });
  socket.setEncoding('utf8');
  socket.setTimeout(130000, () => socket.destroy());
  peerCredentials(socket).then(credentials => {
    if (credentials.uid !== ALLOWED_UID) {
      rejected = true;
      reply(socket, { ok: false, status: 403, error: 'forbidden' });
      return;
    }
    socket.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
        rejected = true;
        reply(socket, { ok: false, status: 413, error: 'request too large' });
      }
    });
    socket.on('end', async () => {
      if (rejected) return;
      try {
        const message = JSON.parse(raw);
        reply(socket, await dispatch(message));
      } catch (error) {
        reply(socket, { ok: false, status: error.status || 400, error: error.message || 'invalid request', code:error.code||null });
      }
    });
  }).catch(() => {
    rejected = true;
    reply(socket, { ok: false, status: 403, error: 'peer verification failed' });
  });
});

server.on('error', error => {
  process.stderr.write(`bridge error: ${error.message}\n`);
  process.exitCode = 1;
});

server.listen({ fd: SOCKET_FD },()=>{
  void compactRotation.reconcile().catch(error=>rscLog({event:'reconciliation_failed',reason:String(error.message||error).slice(0,160)}));
  void loadRscState().then(state=>{if(state.handoffState==='CANDIDATE_ACTIVE'&&state.candidateActiveSessionId)candidateWatchdog.start()}).catch(error=>rscLog({event:'candidate_watchdog_init_failed',reason:String(error.message||error).slice(0,160)}));
  const observer=setInterval(()=>void compactRotation.observe().catch(error=>rscLog({event:'observer_failed',reason:String(error.message||error).slice(0,160)})),1000);
  observer.unref?.();
});
