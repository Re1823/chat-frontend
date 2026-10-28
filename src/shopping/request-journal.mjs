import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
export const requestDigest=m=>createHash('sha256').update(JSON.stringify([m.version,m.workerId,m.requestId,m.operation,m.payload])).digest('hex');
export const resultDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Private encrypted operational state, never a log or an authority for order fields.
export function createRequestJournal({path,secret,scope}) {
 const key=createHash('sha256').update(scope+'\0'+secret).digest();let rows={};
 if(existsSync(path)){const box=JSON.parse(readFileSync(path,'utf8'));const d=createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'hex'));d.setAuthTag(Buffer.from(box.tag,'hex'));rows=JSON.parse(Buffer.concat([d.update(Buffer.from(box.data,'base64')),d.final()]).toString());}
 const save=()=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(rows)),c.final()]);mkdirSync(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.'+randomBytes(8).toString('hex')+'.tmp';writeFileSync(temporary,JSON.stringify({iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data:data.toString('base64')}),{mode:0o600});renameSync(temporary,path);};
 return {get:id=>rows[id]&&structuredClone(rows[id]),all:()=>Object.values(rows).map(r=>structuredClone(r)),put(id,row){if(!rows[id]&&Object.keys(rows).length>=10000)throw Error('request_journal_full');rows[id]=structuredClone({...row,requestId:id});save();return this.get(id)}};
}
export function createDurableWorkerExecution({journal,execute}) {
 const active=new Map();
 const run=message=>{
  const digest=requestDigest(message),prior=journal.get(message.requestId);
  if(prior&&prior.digest!==digest)return Promise.reject(Error('request_identity_mismatch'));
  if(active.has(message.requestId))return active.get(message.requestId);
  if(prior?.state==='completed')return Promise.resolve(prior.outcome);
  if(prior)return Promise.resolve({ok:false,code:'worker_result_uncertain'});
  journal.put(message.requestId,{digest,operation:message.operation,state:'accepted',acceptedAt:Date.now()});
  const job=Promise.resolve().then(()=>execute(message.operation,message.payload)).then(data=>({ok:true,data}),cause=>({ok:false,code:/^[A-Za-z0-9_]{1,80}$/.test(cause.message)?cause.message:'worker_failed'})).then(outcome=>{journal.put(message.requestId,{digest,operation:message.operation,state:'completed',outcome,completedAt:Date.now(),acknowledged:false});return outcome}).finally(()=>active.delete(message.requestId));
  active.set(message.requestId,job);return job;
 };
 return {run};
}
