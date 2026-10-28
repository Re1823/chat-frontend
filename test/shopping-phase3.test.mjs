import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPurchaseStore, orderFingerprint } from '../src/shopping/purchases.mjs';
import { createAccessOwnerVerifier, createShoppingApprovalApi } from '../src/shopping/approval-api.mjs';
import { createDwellServer } from '../server.mjs';
import { createMcpHandler } from '../src/presentation/frontend-message-mcp.mjs';
import { createShoppingGateway } from '../src/shopping/gateway.mjs';
import { signWorkerMessage } from '../src/shopping/worker-auth.mjs';

const ownerId = 'owner@example.com';
const order = { platform:'taobao', merchant:'得力办公文具', goods:'得力中性笔', sku:'红色1支+笔芯2支 / 0.5mm', skuId:'6261131742582', quantity:1, subtotalMinor:480, shippingMinor:0, discountMinor:62, totalMinor:418, addressLabel:'四川省 成都市 · ****8076', resourceUrl:'https://item.taobao.com/item.htm?id=671224654225', confirmationPage:'https://buy.taobao.com/auction/buy_now.jhtml', category:'physical_goods' };

async function fixtureStore() {
  const path=join(await mkdtemp(join(tmpdir(),'shopping-phase3-')),'purchases.json');
  const settings={path,approvalSecret:'phase3-test-secret-with-at-least-32-characters'};
  const store=createPurchaseStore(settings);await store.load();
  const session=await store.startSession({ownerId,conversationId:'claude-main',workerId:'windows-1',browserContextId:'context-1',profileId:'shopping',pageUrl:order.resourceUrl});
  const created=await store.create({ownerId,conversationId:'claude-main',sessionId:session.sessionId,workerOrder:order});
  return {store,settings,created};
}

test('pending approval survives reload with the same nonce, then approves once',async()=>{
  const {settings,created}=await fixtureStore();
  const recovered=createPurchaseStore(settings);await recovered.load();
  const pending=recovered.listApprovals({ownerId})[0];
  assert.equal(pending.state,'pending_approval');
  assert.equal(pending.approvalNonce,created.approvalNonce);
  assert.equal(pending.snapshot.skuId,order.skuId);
  assert.equal(pending.snapshot.confirmationPage,order.confirmationPage);
  assert.equal(pending.fingerprint,orderFingerprint(pending.snapshot));
  const approved=await recovered.decide({ownerId,purchaseId:pending.purchaseId,sessionId:pending.sessionId,fingerprint:pending.fingerprint,nonce:pending.approvalNonce,decision:'approve'});
  assert.equal(approved.state,'approved');
  assert.equal(recovered.listApprovals({ownerId})[0].approvalNonce,undefined);
  await assert.rejects(recovered.decide({ownerId,purchaseId:pending.purchaseId,sessionId:pending.sessionId,fingerprint:pending.fingerprint,nonce:pending.approvalNonce,decision:'approve'}),/approval_not_pending/);
});

test('approval rejects a snapshot changed after fingerprinting',async()=>{
  const {settings,created}=await fixtureStore();
  const saved=JSON.parse(await readFile(settings.path,'utf8'));
  saved.records[created.purchaseId].snapshot.goods='different product';
  await writeFile(settings.path,JSON.stringify(saved));
  const recovered=createPurchaseStore(settings);await recovered.load();
  await assert.rejects(recovered.decide({ownerId,purchaseId:created.purchaseId,sessionId:created.sessionId,fingerprint:created.fingerprint,nonce:created.approvalNonce,decision:'approve'}),/approval_mismatch/);
});

test('authenticated PWA API rejects forged mutations and persists reject',async()=>{
  const {store,created}=await fixtureStore();
  const api=createShoppingApprovalApi({purchaseStore:store,verifyOwner:async req=>req.headers['x-test-owner']===ownerId?ownerId:null});
  const server=createDwellServer({shoppingApprovalApi:api});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    const get=async headers=>fetch(`${origin}/api/shopping/approvals`,{headers});
    assert.equal((await get()).status,403);
    const list=await (await get({'x-test-owner':ownerId})).json();
    const pending=list.purchases[0];
    assert.equal(pending.purchaseId,created.purchaseId);
    const url=`${origin}/api/shopping/approvals/${pending.purchaseId}/decision`;
    const headers={'x-test-owner':ownerId,'content-type':'application/json','origin':origin,'sec-fetch-site':'same-origin','x-shopping-user-action':'1'};
    const body={sessionId:pending.sessionId,fingerprint:pending.fingerprint,nonce:pending.approvalNonce,decision:'reject'};
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,origin:'https://evil.example'},body:JSON.stringify(body)})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...body,fingerprint:'wrong'})})).status,409);
    const rejected=await (await fetch(url,{method:'POST',headers,body:JSON.stringify(body)})).json();
    assert.equal(rejected.purchase.state,'rejected');
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({...body,decision:'approve'})})).status,409);
    assert.equal((await (await get({'x-test-owner':ownerId})).json()).purchases[0].state,'rejected');
  }finally{server.close()}
});

test('Cloudflare Access owner verifier validates signature, audience and owner',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'test-key'};
  const now=Date.now(),issuer='https://example.cloudflareaccess.com';
  const verifier=createAccessOwnerVerifier({teamDomain:'example.cloudflareaccess.com',audience:'a'.repeat(32),ownerEmail:ownerId,now:()=>now,fetchImpl:async()=>({ok:true,json:async()=>({keys:[jwk]})})});
  const token=claims=>{const first=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url'),second=Buffer.from(JSON.stringify({iss:issuer,aud:['a'.repeat(32)],email:ownerId,type:'app',iat:Math.floor(now/1000)-10,nbf:Math.floor(now/1000)-10,exp:Math.floor(now/1000)+100,...claims})).toString('base64url');return `${first}.${second}.${sign('RSA-SHA256',Buffer.from(`${first}.${second}`),privateKey).toString('base64url')}`};
  assert.equal(await verifier({headers:{'cf-access-jwt-assertion':token({})}}),ownerId);
  assert.equal(await verifier({headers:{'cf-access-jwt-assertion':token({email:'attacker@example.com'})}}),null);
  assert.equal(await verifier({headers:{'cf-access-jwt-assertion':token({aud:['wrong']})}}),null);
  const signed=token({});
  const [header,payload,signature]=signed.split('.');
  const invalidSignature=`${signature[0]==='A'?'B':'A'}${signature.slice(1)}`;
  assert.equal(await verifier({headers:{'cf-access-jwt-assertion':`${header}.${payload}.${invalidSignature}`}}),null);
});


test('Shopping prepare result sent to Claude omits approval nonce',async()=>{
  const {store,settings}=await fixtureStore();
  const session=await store.startSession({ownerId,conversationId:'claude-main',workerId:'windows-1',browserContextId:'edge-1',profileId:'shopping',pageUrl:order.resourceUrl});
  const secret='worker-test-secret-with-at-least-32-characters';
  const gateway=createShoppingGateway({secret,workerId:'windows-1',replayPath:join(settings.path,'..','replay.json'),purchaseStore:store});
  const send=(operation,payload={},responseTo=null)=>signWorkerMessage({secret,role:'worker',workerId:'windows-1',operation,payload,responseTo});
  gateway.accept(send('poll'));
  const resultPromise=gateway.invokeTool({name:'shopping_prepare_purchase',arguments:{sessionId:session.sessionId},ownerId,conversationId:'claude-main'});
  await new Promise(resolve=>setImmediate(resolve));
  const command=gateway.accept(send('poll'));
  assert.equal(command.operation,'prepare_order');
  gateway.accept(send('result',{ok:true,data:{sessionId:session.sessionId,order}},command.requestId));
  const result=await resultPromise;
  assert.equal(result.state,'pending_approval');
  assert.equal(result.approvalNonce,undefined);
  assert.equal(result.snapshot.totalMinor,418);
});
