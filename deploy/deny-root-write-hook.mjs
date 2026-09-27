import {realpath} from 'node:fs/promises';
import {posix,resolve as resolveNative} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT_WRITE_DENIED='/root';
export const ROOT_CLAUDE_MD='/root/CLAUDE.md';
const guardedTools=new Set(['Edit','Write','NotebookEdit']);

async function canonicalize(raw,cwd,resolvePath=realpath){
  const lexical=posix.resolve(cwd,raw.replaceAll('\\','/'));
  let existing=lexical;
  const suffix=[];
  while(true){
    try{return posix.join(await resolvePath(existing),...suffix)}catch(error){
      if(error?.code!=='ENOENT'&&error?.code!=='ENOTDIR')throw error;
      const parent=posix.dirname(existing);
      if(parent===existing)return lexical;
      suffix.unshift(posix.basename(existing));
      existing=parent;
    }
  }
}

const inRoot=target=>target===ROOT_WRITE_DENIED||target.startsWith(`${ROOT_WRITE_DENIED}/`);

export async function rootWriteDecision(input,{resolvePath=realpath}={}){
  if(input?.hook_event_name!=='PreToolUse'||!guardedTools.has(input?.tool_name))return {deny:false};
  const key=input.tool_name==='NotebookEdit'?'notebook_path':'file_path';
  const raw=input?.tool_input?.[key];
  if(typeof raw!=='string'||!raw.trim())return {deny:false};
  const cwd=typeof input.cwd==='string'&&input.cwd?input.cwd:'/root';
  const lexical=posix.resolve(cwd,raw.replaceAll('\\','/'));
  const canonical=await canonicalize(raw,cwd,resolvePath);
  if(!inRoot(lexical)&&!inRoot(canonical))return {deny:false,lexical,canonical};
  const allowed=input.tool_name==='Edit'&&lexical===ROOT_CLAUDE_MD&&canonical===ROOT_CLAUDE_MD;
  return {deny:!allowed,allowed,lexical,canonical};
}

async function main(){
  let raw='';
  for await(const chunk of process.stdin)raw+=chunk;
  const input=JSON.parse(raw);
  const decision=await rootWriteDecision(input);
  if(!decision.deny)return;
  process.stderr.write('File modification is denied for this /root path; only Edit on /root/CLAUDE.md is allowed.\n');
  process.exitCode=2;
}

if(fileURLToPath(import.meta.url)===resolveNative(process.argv[1]||''))main().catch(()=>{process.exitCode=2});
