import net from 'node:net';

export const ROOT_BRIDGE_SOCKET='/run/qiuqiu-claude-bridge/control.sock';
const MAX_RESPONSE_BYTES=64*1024;
const MAX_THOUGHT_RESPONSE_BYTES=256*1024;

const bridgeError=(message,statusCode=502)=>Object.assign(new Error(message),{statusCode});

export function createRootBridgeClient({connect=path=>net.createConnection({path}),timeoutMs=1500,maxResponseBytes=MAX_RESPONSE_BYTES}={}){
  return message=>new Promise((resolve,reject)=>{
    const socket=connect(ROOT_BRIDGE_SOCKET);
    let response='',settled=false;
    const fail=error=>{if(settled)return;settled=true;socket.destroy?.();reject(error)};
    socket.setEncoding?.('utf8');
    socket.setTimeout?.(timeoutMs);
    socket.once('connect',()=>socket.end(`${JSON.stringify(message)}\n`));
    socket.on('data',chunk=>{
      response+=chunk;
      if(Buffer.byteLength(response,'utf8')>maxResponseBytes)fail(bridgeError('root bridge response too large'));
    });
    socket.once('timeout',()=>{const error=bridgeError('root bridge timeout',504);error.code='BRIDGE_TIMEOUT';error.deliveryUncertain=true;fail(error)});
    socket.once('error',error=>fail(bridgeError(`root bridge unavailable: ${error.message}`,503)));
    socket.once('end',()=>{
      if(settled)return;
      let body;
      try{body=JSON.parse(response.trim())}catch{return fail(bridgeError('root bridge returned malformed JSON'))}
      if(!body||typeof body!=='object'||typeof body.ok!=='boolean')return fail(bridgeError('root bridge returned an invalid response'));
      if(!body.ok){const error=bridgeError(String(body.error||'root bridge request failed'),Number(body.status)||502);if(body.code)error.code=String(body.code);return fail(error)}
      settled=true;resolve(body);
    });
  });
}

export function createRootBridgeTransport({request=createRootBridgeClient(),sendRequest=createRootBridgeClient({timeoutMs:25000}),thoughtRequest=createRootBridgeClient({timeoutMs:5000,maxResponseBytes:MAX_THOUGHT_RESPONSE_BYTES})}={}){
  const operationId=value=>{if(!/^[A-Za-z0-9_-]{16,128}$/.test(value||''))throw bridgeError('invalid carryover operation',400);return value};
  return {
    async hasSession(){return Boolean((await request({op:'status'})).running)},
    async inspectSession(){const status=await request({op:'status'});return {exists:Boolean(status.running),alive:Boolean(status.running),active:status.active===true,activeTurnId:status.activeTurnId||null,panes:[]}},
    async createSession(){const result=await request({op:'ensure'});return {created:Boolean(result.created)}},
    async sendPrompt({turnId,prompt,dispatchLease}){return await sendRequest({...{op:'send',turnId,prompt},...(dispatchLease===undefined?{}:{lease:dispatchLease})})},
    async deliveryStatus(turnId){return await sendRequest({op:'delivery_status',turnId})},
    async recoverDelivery({turnId,prompt,createdAt,dispatchLease}){return await sendRequest({op:'recover_delivery',turnId,prompt,createdAt,lease:dispatchLease})},
    async thoughtSnapshot(turnId){return thoughtRequest({op:'thought_snapshot',turnId})},
    async interrupt(_sessionName,turnId){if(!turnId)throw bridgeError('turnId is required',400);return await request({op:'stop',turnId})},
    async complete(turnId,terminalType='turn_done'){if(!turnId)throw bridgeError('turnId is required',400);if(!['turn_done','turn_error','turn_stopped'].includes(terminalType))throw bridgeError('invalid terminal type',400);await sendRequest({op:'complete',turnId,terminalType})},
    async activateCarryover(id){return request({op:'activate_carryover',operationId:operationId(id)})},
    async rollbackCarryover(id){return request({op:'rollback_carryover',operationId:operationId(id)})}
  };
}
