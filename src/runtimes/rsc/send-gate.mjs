const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
export function createRscSendGate({maxQueued=16}={}){
 let blocked=false;const queue=new Map();
 const drain=async route=>{const items=[...queue.values()];queue.clear();blocked=false;for(const item of items)try{item.resolve(await route(item.request))}catch(error){item.reject(error)}return items.length};
 return {
  block(){blocked=true},isBlocked(){return blocked},size(){return queue.size},
  submit(request,route){if(!blocked)return route(request);const id=request?.clientRequestId;if(!/^[A-Za-z0-9_-]{1,128}$/.test(id||''))throw fail('clientRequestId required while carryover is active',400);if(queue.has(id))return queue.get(id).promise;if(queue.size>=maxQueued)throw fail('carryover queue full',503);let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});queue.set(id,{request:{...request,imageIds:[...(request.imageIds||[])]},resolve,reject,promise,queuedAt:new Date().toISOString()});return promise},
  commit(route){return drain(route)},rollback(route){return drain(route)},
  snapshot(){const queued=[...queue.values()];return {state:blocked?'CLOSED':'OPEN',queueDepth:queue.size,oldestQueuedAt:queued.length?queued[0].queuedAt:null,clientRequestIds:[...queue.keys()]}}
 };
}
