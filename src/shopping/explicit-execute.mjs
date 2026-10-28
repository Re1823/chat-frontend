import {timingSafeEqual} from 'node:crypto';
import {createWorkerVerifier} from './worker-auth.mjs';
import {createReplayStore} from './replay-store.mjs';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createExplicitShoppingExecute({secret,workerId,replayPath,purchaseStore,executor,enabled=false,ownerId,now=Date.now}) {
 const verify=createWorkerVerifier({secret,workerId,expectedRole:'vps',seen:createReplayStore(replayPath),now});
 return async message=>{
  const request=verify(message);
  if(!enabled||!executor)throw Error('order_submission_disabled');
  if(request.operation!=='execute_approved_purchase')throw Error('execute_request_rejected');
  const p=request.payload;
  if(!p||Array.isArray(p)||Object.keys(p).sort().join(',')!=='approvalId,approvalNonce,fingerprint,purchaseId,sessionId')throw Error('execute_request_rejected');
  if(!/^[0-9a-f-]{36}$/.test(p.purchaseId)||p.approvalId!==p.purchaseId)throw Error('execute_binding_rejected');
  const binding=purchaseStore.explicitExecutionBinding({purchaseId:p.purchaseId});
  if(binding.ownerId!==ownerId||!['purchaseId','approvalId','sessionId','fingerprint','approvalNonce'].every(k=>equal(binding[k],p[k])))throw Error('execute_binding_rejected');
  return executor.execute(p.purchaseId);
 };
}
