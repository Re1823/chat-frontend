const fail=reason=>Object.assign(new Error(reason),{reason});
const strip=value=>String(value??'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'');
const forbidden=/oauth|opening browser|sign[ -]?in|log[ -]?in|account selection|choose (?:an )?account|theme|permission (?:request|prompt|required)|allow this tool|approve tool/i;
export const POST_TRUST_POLL_MS=250,POST_TRUST_DEADLINE_MS=30000,READY_STABILIZATION_MS=1000;

export const MANAGED_TRUST={executable:'/usr/bin/claude',version:'2.1.236',uid:0,home:'/root',workspace:'/root'};

export function detectWorkspaceTrustGate(screen){
 const text=strip(screen),displayedWorkspace=text.match(/Accessing\s+workspace:\s*\n\s*(\/[^\s]+)/i)?.[1],workspace=displayedWorkspace?.replace(/\/+$/,'')||displayedWorkspace;
 const trust=/Quick safety check:\s*Is this a project you created or one you trust\?/i.test(text)&&/Claude Code(?:'ll| will) be able to read, edit, and execute files here\./i.test(text);
 const option=/[❯>]\s*1\.\s*Yes,\s*I\s*trust\s*this\s*folder/i.test(text);
 if(trust&&workspace&&option&&!forbidden.test(text))return {kind:'WORKSPACE_TRUST',workspace,displayedWorkspace,option:1,text};
 if(/Claude Code v2\.1\.236/i.test(text)&&/[❯>]\s*(?:Try\s+["]|$)/im.test(text)&&!forbidden.test(text))return {kind:'READY',text};
 if(!text.trim())return {kind:'STARTING',text};
 return {kind:trust?'AMBIGUOUS_TRUST':'OTHER_INTERACTIVE',text};
}

export function classifyStartupScreen(screen){
 const text=strip(screen),detected=detectWorkspaceTrustGate(text);
 if(detected.kind==='READY')return {kind:'READY',text};
 if(detected.kind==='WORKSPACE_TRUST')return {kind:/[✔✓]/.test(text)?'TRUST_GATE_CONFIRMED':'TRUST_GATE',text};
 if(!text.trim())return {kind:'BLANK_REDRAW',text};
 const gates=[[/oauth/i,'OAUTH'],[/opening browser|sign[ -]?in|log[ -]?in|account selection|choose (?:an )?account/i,'LOGIN'],[/theme/i,'THEME'],[/permission mode/i,'PERMISSION_MODE'],[/permission escalation|allow this tool|approve tool|permission (?:request|prompt|required)/i,'PERMISSION'],[/\bmcp\b/i,'MCP_GATE'],[/resume|continue session/i,'RESUME_CONFIRMATION']];
 for(const [pattern,kind] of gates)if(pattern.test(text))return {kind,interactive:true,text};
 if(/loading|starting|initializing|pressing enter|please wait/i.test(text))return {kind:'TRANSITIONAL_REDRAW',text};
 return {kind:'UNKNOWN',interactive:/\b(?:enter|esc|cancel|continue|select|choose)\b|(?:^|\n)\s*[❯>]?\s*\d+\.\s+/im.test(text),text};
}

const startupFail=reason=>{throw fail(reason)};
export function durableReadyEvidence(transcript={}){
 if(transcript.wrongSessionRecord===true)startupFail('FAILED_TRANSCRIPT_SESSION');
 if(transcript.startupStructureValid===false||transcript.orphanStartupRecord===true)startupFail('FAILED_TRANSCRIPT_STRUCTURE');
 return transcript.parseable===true&&transcript.transcriptWritable===true;
}
export async function waitForPostTrustReady({controller,pollMs=POST_TRUST_POLL_MS,deadlineMs=POST_TRUST_DEADLINE_MS,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),baseline}={}){
 const started=now();let unknown=[],stableSince=null,uiReadyEvidence=false;
 while(now()-started<=deadlineMs){
  const runtime=await controller.runtimeEvidence(),transcript=await controller.transcriptEvidence(),screen=await controller.screen(),semantic=classifyStartupScreen(screen);
  if(runtime.processAlive!==true)startupFail('FAILED_PROCESS_EXIT');
  if(runtime.exactSession!==true)startupFail('FAILED_SESSION_MISMATCH');
  if(runtime.ownershipIntact!==true||runtime.unexpectedClaudeOwner===true||runtime.unexpectedHelperOwner===true)startupFail('FAILED_OWNERSHIP_MISMATCH');
  if(runtime.uid!==0||runtime.home!=='/root'||runtime.canonicalCwd!=='/root')startupFail('FAILED_MANAGED_CONTEXT');
  if(transcript.parseable!==true)startupFail('FAILED_TRANSCRIPT_PARSE');
  if(transcript.user!==baseline.user)startupFail('UNEXPECTED_USER_RECORD');
  if(transcript.assistant!==baseline.assistant)startupFail('UNEXPECTED_ASSISTANT_RECORD');
  if(transcript.compact===true)startupFail('UNEXPECTED_COMPACT');
  uiReadyEvidence ||= semantic.kind==='READY';
  if(['TRUST_GATE','TRUST_GATE_CONFIRMED','BLANK_REDRAW','TRANSITIONAL_REDRAW'].includes(semantic.kind)){unknown=[]}
  else if(['OAUTH','LOGIN','THEME','PERMISSION_MODE','PERMISSION','MCP_GATE','RESUME_CONFIRMATION'].includes(semantic.kind)){startupFail('UNEXPECTED_POST_TRUST_GATE')}
  else {const signature=semantic.text.replace(/\s+/g,' ').trim();unknown=unknown.filter(item=>item.signature===signature);unknown.push({signature,at:now()});if(unknown.length>=3&&unknown.at(-1).at-unknown.at(-3).at>=500&&semantic.interactive)startupFail('UNEXPECTED_POST_TRUST_GATE')}
  const durable=durableReadyEvidence(transcript)&&await controller.readyEvidence(runtime,transcript)===true;
  if(durable){stableSince??=now();if(now()-stableSince>=READY_STABILIZATION_MS)return {state:'READY',semantic,inputCount:1,uiReadyEvidence,stabilizedMs:now()-stableSince}}
  else stableSince=null;
  const remaining=deadlineMs-(now()-started);if(remaining<=0)break;await sleep(Math.min(pollMs,remaining));
 }
 startupFail('FAILED_STARTUP_TIMEOUT');
}

export async function readWorkspaceTrustDiagnostic({machineStatePath='/root/.claude.json',readFileFn}={}){
 try{const state=JSON.parse(await readFileFn(machineStatePath,'utf8'));const value=state?.projects?.['/root']?.hasTrustDialogAccepted;return {readable:true,persisted:value===true,value}}catch{return {readable:false,persisted:false,value:undefined}}
}

export function validateManagedTrustContext(value={}){
 const ok=value.executable===MANAGED_TRUST.executable&&value.version===MANAGED_TRUST.version&&value.managedOperation===true&&value.targetSessionId===value.expectedTargetSessionId&&value.uid===MANAGED_TRUST.uid&&value.home===MANAGED_TRUST.home&&value.canonicalCwd===MANAGED_TRUST.workspace&&value.displayedWorkspace===MANAGED_TRUST.workspace&&value.unexpectedClaudeOwner===false&&value.unexpectedHelperOwner===false;
 if(!ok)throw fail('MANAGED_TRUST_CONTEXT_REJECTED');return true;
}

export async function acceptWorkspaceTrustGate({context,controller}){
 validateManagedTrustContext(context);
 const before=detectWorkspaceTrustGate(await controller.screen());
 if(before.kind!=='WORKSPACE_TRUST'||before.workspace!=='/root'||before.option!==1)throw fail('TRUST_GATE_NOT_EXACT');
 const transcriptBefore=await controller.conversationCounts();const permissionBefore=await controller.permissionFingerprint();
 await controller.confirmSelectedOption();
 const ready=await waitForPostTrustReady({controller,baseline:transcriptBefore,...controller.timing});
 if(await controller.mcpCallCount()!==0)throw fail('TRUST_CALLED_MCP');
 if(await controller.permissionFingerprint()!==permissionBefore)throw fail('TRUST_CHANGED_PERMISSIONS');
 return {state:ready.state,accepted:true,interactionCount:1};
}

export async function handleManagedStartup({context,controller}){
 const initial=await controller.screen(),detected=detectWorkspaceTrustGate(initial),semantic=classifyStartupScreen(initial);
 if(detected.kind!=='WORKSPACE_TRUST'&&/Accessing\s+workspace|project you created|trust this folder/i.test(String(initial)))throw fail('UNEXPECTED_INTERACTIVE_GATE');
 if(detected.kind==='READY'||['BLANK_REDRAW','TRANSITIONAL_REDRAW'].includes(semantic.kind)||(detected.kind!=='AMBIGUOUS_TRUST'&&semantic.kind==='UNKNOWN'&&!semantic.interactive)){
  validateManagedTrustContext({...context,displayedWorkspace:context.displayedWorkspace||context.canonicalCwd});
  const baseline=await controller.conversationCounts(),ready=await waitForPostTrustReady({controller,baseline,...controller.timing});
  return {state:ready.state,accepted:false,interactionCount:0,uiReadyEvidence:ready.uiReadyEvidence};
 }
 if(detected.kind!=='WORKSPACE_TRUST')throw fail('UNEXPECTED_INTERACTIVE_GATE');
 return acceptWorkspaceTrustGate({context:{...context,displayedWorkspace:detected.workspace},controller});
}

export function assertSafeClaudeArgs(args=[]){
 if(args.includes('--dangerously-skip-permissions')||args.includes('--permission-mode'))throw fail('PERMISSION_BOUNDARY_CHANGED');
 if(!args.includes('--strict-mcp-config'))throw fail('STRICT_MCP_REQUIRED');return true;
}
