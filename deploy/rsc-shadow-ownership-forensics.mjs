import {open,readFile,readlink,rename,rm,chmod} from 'node:fs/promises';
import {dirname,join} from 'node:path';

const secret=/(oauth|api[_-]?key|bearer|token|credential|cookie|password|secret)/i;
const safeEnv=new Set(['HOME','USER','LOGNAME']);
const text=value=>Buffer.isBuffer(value)?value.toString('utf8'):String(value);
const redactArgv=argv=>argv.map((value,index)=>secret.test(value)||index>0&&secret.test(argv[index-1])?'[REDACTED]':value);
const field=async fn=>{try{return await fn()}catch(error){return {unavailable:error?.code==='ENOENT'?'PROCESS_EXITED_DURING_CAPTURE':String(error?.code||'READ_FAILED')}}};
const statusFields=value=>Object.fromEntries(['Name','State','PPid','Uid','Gid','NSpid'].map(key=>[key,value.match(new RegExp(`^${key}:\\s*(.+)$`,'m'))?.[1]??null]));
const statFields=value=>{const close=value.lastIndexOf(')'),tail=close>=0?value.slice(close+2).split(' '):[];return {pgrp:tail[2]??null,session:tail[3]??null,starttime:tail[19]??null}};

export async function captureProcess(pid,{readFileFn=readFile,readlinkFn=readlink,maxParents=6}={}){
 const one=async current=>{const root=`/proc/${current}`,status=await field(()=>readFileFn(`${root}/status`,'utf8')),stat=await field(()=>readFileFn(`${root}/stat`,'utf8')),environment=await field(()=>readFileFn(`${root}/environ`));const argv=await field(()=>readFileFn(`${root}/cmdline`)),statusText=Buffer.isBuffer(status)||typeof status==='string'?text(status):null,statText=Buffer.isBuffer(stat)||typeof stat==='string'?text(stat):null;const parsedStatus=statusText?statusFields(statusText):status;return {pid:current,comm:typeof parsedStatus==='object'&&'Name'in parsedStatus?parsedStatus.Name:null,exe:await field(()=>readlinkFn(`${root}/exe`)),argv:Buffer.isBuffer(argv)||typeof argv==='string'?redactArgv(text(argv).split('\0').filter(Boolean)):argv,status:parsedStatus,stat:statText?statFields(statText):stat,cwd:await field(()=>readlinkFn(`${root}/cwd`)),cgroup:await field(()=>readFileFn(`${root}/cgroup`,'utf8')).then(v=>Buffer.isBuffer(v)||typeof v==='string'?text(v).trim():v),sessionid:await field(()=>readFileFn(`${root}/sessionid`,'utf8')).then(v=>Buffer.isBuffer(v)||typeof v==='string'?text(v).trim():v),environment:Buffer.isBuffer(environment)||typeof environment==='string'?Object.fromEntries(text(environment).split('\0').filter(Boolean).map(v=>v.split(/=(.*)/s)).filter(([k])=>safeEnv.has(k))):environment};};
 const process=await one(pid),parents=[];let parent=Number(process.status?.PPid);
 for(let depth=0;depth<maxParents&&parent>0;depth++){const item=await one(parent);parents.push(item);const next=Number(item.status?.PPid);if(!next||next===parent)break;parent=next}
 return {...process,parentChain:parents,captureCompleteness:['exe','argv','status','stat','cwd','cgroup'].every(k=>!process[k]?.unavailable)?'COMPLETE':'PARTIAL'};
}

export async function atomicWriteForensics(path,value){const temp=join(dirname(path),`.${process.pid}-${Date.now()}.tmp`),handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();await handle.close();await rename(temp,path);await chmod(path,0o600)}catch(error){await handle.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});throw error}}

export async function captureAndRejectOwnership({owners,expectedProductionPid,expectedShadowPid,path,operationId,tmux,captureProcessFn=captureProcess,writeFn=atomicWriteForensics,now=()=>new Date().toISOString()}={}){
 const unexpected=owners.filter(pid=>pid!==expectedProductionPid&&pid!==expectedShadowPid);if(!unexpected.length)return {unexpected:[],valid:true};
 const processes=[];for(const pid of unexpected)processes.push(await captureProcessFn(pid));
 const evidence={version:1,capturedAt:now(),operationId,expectedProductionPid,expectedShadowPid,tmux,ownershipSnapshot:[...owners],unexpectedPids:unexpected,processes};
 await writeFn(path,evidence);throw Object.assign(new Error('FAILED_OWNERSHIP_MISMATCH'),{reason:'FAILED_OWNERSHIP_MISMATCH',forensicsPath:path});
}

const runtimeArgv=argv=>Array.isArray(argv)&&argv[0]==='/usr/bin/claude'&&argv.includes('--resume');
const unavailable=value=>value&&typeof value==='object'&&typeof value.unavailable==='string';
export async function resolveOwnershipCandidates({owners,expectedProductionPid,expectedShadowPid,sample=captureProcess,delay=ms=>new Promise(r=>setTimeout(r,ms)),delayMs=25,deadlineAt=Infinity,now=Date.now}={}){
 const candidates=owners.filter(pid=>pid!==expectedProductionPid&&pid!==expectedShadowPid),managedChildren=[],unexpected=[],diagnostics=[];
 for(const pid of candidates){
  const first=await sample(pid);if(now()+delayMs>=deadlineAt)throw Object.assign(new Error('FAILED_STARTUP_TIMEOUT'),{reason:'FAILED_STARTUP_TIMEOUT'});await delay(delayMs);const second=await sample(pid);const sameStart=!unavailable(first.stat)&&!unavailable(second.stat)&&first.stat?.starttime===second.stat?.starttime;
  let classification,owner=false;
  if(unavailable(second.status)||second.status?.Name==null)classification='EXITED_DURING_STABILIZATION';
  else if(!sameStart){classification='PID_REUSED_OR_UNSTABLE';owner=true}
  else if(runtimeArgv(second.argv)){classification='CLAUDE_RUNTIME_OWNER';owner=true}
  else {const parent=Number(second.status?.PPid),shadow=second.parentChain?.find(item=>item.pid===expectedShadowPid),sameSession=second.stat?.session===shadow?.stat?.session,samePgrp=second.stat?.pgrp===shadow?.stat?.pgrp,sameCgroup=second.cgroup===shadow?.cgroup;if(parent===expectedShadowPid&&sameSession&&samePgrp&&sameCgroup)classification='MANAGED_CLAUDE_CHILD';else {classification='UNRELATED_OR_AMBIGUOUS_CANDIDATE';owner=true}}
  const item={pid,classification,first,second};diagnostics.push(item);if(owner)unexpected.push(pid);else managedChildren.push(item);
 }
 return {valid:unexpected.length===0,unexpected,managedChildren,diagnostics};
}
