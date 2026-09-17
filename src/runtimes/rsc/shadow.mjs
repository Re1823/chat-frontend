import {readFile,realpath} from 'node:fs/promises';
import {assertSafeClaudeArgs,handleManagedStartup,readWorkspaceTrustDiagnostic} from '../../../deploy/rsc-startup-trust.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=reason=>Object.assign(new Error(reason),{reason});
export const RSC_SHADOW_WORKSPACE='/root';
export const RSC_MACHINE_STATE_PATH='/root/.claude.json';

export async function verifyWorkspaceTrust({workspace=RSC_SHADOW_WORKSPACE,machineStatePath=RSC_MACHINE_STATE_PATH,readFileFn=readFile,realpathFn=realpath}={}){
 let canonical;try{canonical=await realpathFn(workspace)}catch{throw fail('SHADOW_WORKSPACE_REJECTED')}
 if(canonical!==RSC_SHADOW_WORKSPACE)throw fail('SHADOW_WORKSPACE_REJECTED');
 const diagnostic=await readWorkspaceTrustDiagnostic({machineStatePath,readFileFn});
 return {workspace:canonical,machineStatePath,workspaceTrustPersisted:diagnostic.persisted,workspaceTrustDiagnostic:diagnostic,shadowPreflightAllowed:true};
}

export async function verifyWorkspaceTrustAfterCleanup(options={}){return verifyWorkspaceTrust(options)}

export async function launchShadowWithTrust({start,...options}={}){
 if(typeof start!=='function')throw new TypeError('start required');
 const trust=await verifyWorkspaceTrust(options);return {trust,result:await start()};
}

export async function handleShadowStartup(options){return handleManagedStartup(options)}

export function workspaceTrustEvidence({acceptedObserved=false,persisted=false}={}){return {workspaceTrustAcceptedObserved:acceptedObserved===true,workspaceTrustPersisted:persisted===true,valid:acceptedObserved===true&&persisted===true}}
export function shadowLaunchSpec({targetSessionId,settingsPath,mcpConfigPath}){if(!uuid.test(targetSessionId))throw new TypeError('invalid target session');const args=['--resume',targetSessionId,'--model','claude-sonnet-4-6','--settings',settingsPath,'--mcp-config',mcpConfigPath,'--strict-mcp-config'];assertSafeClaudeArgs(args);return {socketName:`rsc-shadow-${targetSessionId.slice(0,8)}`,sessionName:`rsc-shadow-${targetSessionId.slice(9,13)}`,cwd:'/root',command:'/usr/bin/claude',args,env:{CLAUDE_CODE_NO_MODEL_FALLBACK:'1'}}}
export function validateShadowObservation(observation,targetSessionId){if(observation?.interactivePrompt)return {valid:false,reason:'UNEXPECTED_INTERACTIVE_PROMPT'};if(observation?.sessionId!==targetSessionId)return {valid:false,reason:observation?.sessionId?'WRONG_SESSION':'EMPTY_SESSION_FALLBACK'};if(observation?.parseError||observation?.parentError||observation?.toolPairError||observation?.autoCompacted)return {valid:false,reason:'SHADOW_RESUME_INVALID'};return {valid:true}}
export async function cleanupShadow(spec,controller){await controller.normalExit(spec);await controller.removeTmux(spec);return controller.inspect(spec)}
export const QIUQIU_FRONTEND_SHADOW_SAFE=false;
