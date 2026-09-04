import net from 'node:net';

export const ROOT_BRIDGE_SOCKET='/run/qiuqiu-claude-bridge/control.sock';
const MAX_RESPONSE_BYTES=64*1024;

const bridgeError=(message,statusCode=502)=>Object.assign(new Error(message),{statusCode});

export function createRootBridgeClient({connect=path=>net.createConnection({path}),timeoutMs=1500}={}){
  return message=>new Promise((resolve,reject)=>{
    const socket=connect(ROOT_BRIDGE_SOCKET);
    let response='',settled=false;
    const fail=error=>{if(settled)return;settled=true;socket.destroy?.();reject(error)};
    socket.setEncoding?.('utf8');
    socket.setTimeout?.(timeoutMs);
    socket.once('connect',()=>socket.end(`${JSON.stringify(message)}\n`));
    socket.on('data',chunk=>{
      response+=chunk;
      if(Buffer.byteLength(response,'utf8')>MAX_RESPONSE_BYTES)fail(bridgeError('root bridge response too large'));
    });
    socket.once('timeout',()=>fail(bridgeError('root bridge timeout',504)));
    socket.once('error',error=>fail(bridgeError(`root bridge unavailable: ${error.message}`,503)));
    socket.once('end',()=>{
      if(settled)return;
      let body;
      try{body=JSON.parse(response.trim())}catch{return fail(bridgeError('root bridge returned malformed JSON'))}
      if(!body||typeof body!=='object'||typeof body.ok!=='boolean')return fail(bridgeError('root bridge returned an invalid response'));
      if(!body.ok)return fail(bridgeError(String(body.error||'root bridge request failed'),Number(body.status)||502));
      settled=true;resolve(body);
    });
  });
}

export function createRootBridgeTransport({request=createRootBridgeClient(),sendRequest=createRootBridgeClient({timeoutMs:5000})}={}){
  return {
    async hasSession(){return Boolean((await request({op:'status'})).running)},
    async inspectSession(){const status=await request({op:'status'});return {exists:Boolean(status.running),alive:Boolean(status.running),panes:[]}},
    async createSession(){const result=await request({op:'ensure'});return {created:Boolean(result.created)}},
    async sendPrompt({turnId,prompt}){await sendRequest({op:'send',turnId,prompt})},
    async interrupt(_sessionName,turnId){if(!turnId)throw bridgeError('turnId is required',400);await request({op:'stop',turnId})},
    async complete(turnId){if(!turnId)throw bridgeError('turnId is required',400);await request({op:'complete',turnId})}
  };
}
