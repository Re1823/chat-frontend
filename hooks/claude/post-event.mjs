import http from 'node:http';

const debug=process.env.DWELL_CLAUDE_HOOK_DEBUG==='1';
const log=message=>{if(debug)process.stderr.write(`[dwell hook] ${message}\n`)};
const readStdin=()=>new Promise((resolve,reject)=>{let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{raw+=chunk;if(raw.length>2_000_000)reject(new Error('hook payload too large'))});process.stdin.on('end',()=>resolve(raw));process.stdin.on('error',reject)});
const post=(url,secret,payload,timeoutMs)=>new Promise((resolve,reject)=>{
  const target=new URL(url);
  if(target.protocol!=='http:'||!['127.0.0.1','localhost','::1'].includes(target.hostname))return reject(new Error('hook endpoint must be loopback HTTP'));
  const request=http.request(target,{method:'POST',agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload),'x-dwell-hook-secret':secret}},response=>{response.resume();response.once('end',()=>resolve())});
  request.setTimeout(timeoutMs,()=>request.destroy(new Error('hook timeout')));request.once('error',reject);request.end(payload);
});

try{
  const raw=await readStdin();JSON.parse(raw);
  const endpoint=process.env.DWELL_CLAUDE_HOOK_URL||'http://127.0.0.1:4173/api/internal/claude-code/events';
  await post(endpoint,process.env.DWELL_CLAUDE_HOOK_SECRET||'',raw,Math.max(100,Number(process.env.DWELL_CLAUDE_HOOK_TIMEOUT_MS)||750));
}catch(error){log(error.message)}
