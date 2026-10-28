import {createRequestJournal,createDurableWorkerExecution,resultDigest} from './request-journal.mjs';
import { createWorkerVerifier, signWorkerMessage } from './worker-auth.mjs';
import { createReplayStore } from './replay-store.mjs';
import { WORKER_OPERATIONS } from './contracts.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runShoppingWorkerClient({ endpoint, secret, workerId, replayPath, execute, accessClientId, accessClientSecret, fetchImpl = fetch, stop = () => false, onStatus = () => {}, pollDelayMs = 1500 }) {
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/.test(endpoint)) throw new TypeError('secure_gateway_endpoint_required');
  const verifyVps = createWorkerVerifier({ secret, workerId, expectedRole: 'vps', seen: createReplayStore(replayPath) });
  const journal=createRequestJournal({path:replayPath+'.requests',secret,scope:'worker-requests'});
  const durable=createDurableWorkerExecution({journal,execute});
  const base = endpoint.replace(/\/$/, '');
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) throw new TypeError('incomplete_access_credentials');
  const post = async (path, message) => {
    const headers = { 'content-type': 'application/json' };
    if (accessClientId) { headers['CF-Access-Client-Id'] = accessClientId; headers['CF-Access-Client-Secret'] = accessClientSecret; }
    const response = await fetchImpl(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(35_000) });
    if (!response.ok) throw new Error('gateway_unavailable');
    return response.json();
  };
  const deliver=async row=>{
    const result=signWorkerMessage({secret,role:'worker',workerId,operation:'result',responseTo:row.requestId,payload:row.outcome});
    const ack=verifyVps(await post('/worker/result',result));
    if(ack.operation!=='idle'||ack.payload?.ok!==true||ack.payload.responseTo!==row.requestId||ack.payload.resultDigest!==resultDigest(row.outcome))throw Error('result_ack_invalid');
    journal.put(row.requestId,{...row,acknowledged:true});
  };
  while (!stop()) {
    let stage='result_return',requestId=null,operation=null;
    try {
      // Re-send only completed results; never re-dispatch an accepted operation.
      for(const row of journal.all().filter(r=>r.state==='completed'&&!r.acknowledged)){requestId=row.requestId;operation=row.operation;await deliver(row);}
      stage='poll';
      const poll = signWorkerMessage({ secret, role: 'worker', workerId, operation: 'poll', payload: {} });
      const message = await post('/worker/poll', poll);
      const verified = verifyVps(message);
      if (verified.operation === 'idle') { onStatus({ state: 'ready', operation: 'idle', authenticated: true }); await sleep(pollDelayMs); continue; }
      if (!WORKER_OPERATIONS.includes(verified.operation)) throw new Error('worker_operation_rejected');
      requestId=verified.requestId;operation=verified.operation;stage='execute';
      const outcome=await durable.run({...message,...verified});
      stage='result_return';
      const row=journal.get(requestId);
      if(row?.state!=='completed')throw Error('worker_result_uncertain');
      await deliver(row);
      onStatus({ state: 'ready', operation: verified.operation, result: outcome.ok ? 'ok' : outcome.code });
    } catch (cause) {
      onStatus({ state: 'disconnected', stage, requestId, operation, error: /^(gateway_unavailable|worker_result_uncertain|worker_message_replayed|worker_message_rejected|request_identity_mismatch|result_ack_invalid)$/.test(cause.message)?cause.message:'worker_transport_failed' });
      await sleep(pollDelayMs);
    }
  }
}
