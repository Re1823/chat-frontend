import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAlipayBotAdapter } from './alipay-bot-adapter.mjs';
import { makeOrderSnapshot, orderFingerprint } from './purchases.mjs';
import { assertOfficialCashierUrl } from './alipay-policy.mjs';
import { signWorkerMessage, createWorkerVerifier } from './worker-auth.mjs';

const fail = code => { throw new Error(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
const fields = ['purchaseId','sessionId','executionId','approvalNonce','fingerprint','snapshot','expectedContextId','expectedProfileId','state','expiresAt','paymentLink','intentSummary','credential','proof'];
const canonical = p => JSON.stringify(fields.filter(k => k !== 'proof').map(k => [k, p[k] ?? null]));
const proof = (secret, p) => createHmac('sha256', secret).update(canonical(p)).digest('hex');
const summary = s => `服务内容：${s.goods} ${s.sku} ×${s.quantity}，支付金额：¥${Math.floor(s.totalMinor / 100)}.${String(s.totalMinor % 100).padStart(2,'0')}，支付对象：${s.merchant}`;

export function sealPaymentRequest(secret, payload, now = Date.now()) {
  const p = { ...payload, expiresAt: now + 30_000 }; return { ...p, proof: proof(secret, p) };
}
export function validatePaymentRequest(secret, p, operation, now = Date.now()) {
  if (!p || Object.keys(p).some(k => !fields.includes(k)) || !uuid(p.purchaseId) || !uuid(p.sessionId) || !uuid(p.executionId) || !/^[a-f0-9]{64}$/.test(p.proof || '') || !/^[a-f0-9]{64}$/.test(p.fingerprint || '') || typeof p.approvalNonce !== 'string' || p.approvalNonce.length < 32 || p.approvalNonce.length > 128 || !p.expectedContextId || !p.expectedProfileId) fail('payment_binding_rejected');
  if (!Number.isSafeInteger(p.expiresAt) || p.expiresAt <= now || p.expiresAt > now + 30_000) fail('payment_request_expired');
  if (!timingSafeEqual(Buffer.from(p.proof,'hex'), Buffer.from(proof(secret,p),'hex'))) fail('payment_proof_rejected');
  const snapshot = makeOrderSnapshot(p.snapshot);
  if (orderFingerprint(snapshot) !== p.fingerprint || !['pending_alipay','reconciling'].includes(p.state)) fail('payment_binding_rejected');
  if (operation === 'payment_execute') {
    if (p.state !== 'pending_alipay' || p.credential !== undefined || assertOfficialCashierUrl(p.paymentLink) !== p.paymentLink || p.intentSummary !== summary(snapshot)) fail('payment_material_rejected');
  } else if (operation === 'payment_query') {
    if (p.paymentLink !== undefined || p.intentSummary !== undefined || !p.credential || Object.keys(p.credential).sort().join(',') !== 'kind,value' || !['shortUrl','outShakeNo'].includes(p.credential.kind) || typeof p.credential.value !== 'string' || p.credential.value.length > 8192) fail('payment_material_rejected');
  } else fail('payment_operation_rejected');
  return snapshot;
}

export function createRemotePaymentProvider({ gateway, purchaseStore, secret }) {
  const binding = purchaseId => purchaseStore.paymentBinding({ purchaseId });
  return {
    execute({ purchaseId, executionId, sessionId, paymentLink, intentSummary }) {
      const b = binding(purchaseId);
      if (b.executionId !== executionId || b.sessionId !== sessionId) fail('payment_binding_rejected');
      return gateway.call('payment_execute', sealPaymentRequest(secret,{...b,paymentLink,intentSummary}), { timeoutMs: 60_000 });
    },
    query({ purchaseId, executionId, credential }) {
      const b = binding(purchaseId);
      if (b.executionId !== executionId || JSON.stringify(credential) !== JSON.stringify(purchaseStore.execution({purchaseId}).execution.queryCredential)) fail('payment_binding_rejected');
      return gateway.call('payment_query', sealPaymentRequest(secret,{...b,credential}), { timeoutMs: 60_000 });
    },
    verify() { return gateway.call('payment_provider_verify', {}, { timeoutMs: 60_000 }); }
  };
}

export function createWindowsPaymentProvider({ secret, ledgerPath, validateBrowserBinding, allowRealPayment = false, verificationOnly = false, home = process.env.USERPROFILE, run = null }) {
  const root = join(home,'.openclaw-autoclaw','alipay-bot-cli');
  const executable = join(root,'bin','alipay-bot.exe');
  const expectedHash = 'da2b632e275ee2f4af7ba714ee5f5238738931e637e83a8764022f091a08fa28';
  let serial = Promise.resolve();
  const identity = async () => {
    const manifest = JSON.parse(await readFile(join(root,'runtime','version.json'),'utf8'));
    const bytes = await readFile(executable), runtime = await readFile(join(root,'runtime','alipay-bot.exe'));
    if (manifest.packageName !== 'alipay-bot-cli' || manifest.version !== '0.4.5' || manifest.fullVersion !== '0.4.5' || manifest.target !== 'windows-amd64' || manifest.binary !== 'alipay-bot.exe' || digest(bytes) !== expectedHash || !bytes.equals(runtime)) fail('payment_cli_identity_rejected');
    return {version:'0.4.5',sha256:expectedHash};
  };
  const load = async () => { try { return JSON.parse(await readFile(ledgerPath,'utf8')); } catch(e) { if(e.code === 'ENOENT') return {}; throw e; } };
  const save = async ledger => { await mkdir(dirname(ledgerPath),{recursive:true}); const tmp = ledgerPath+'.tmp'; await writeFile(tmp,JSON.stringify(ledger),{mode:0o600}); await rename(tmp,ledgerPath); };
  const bot = createAlipayBotAdapter({command:executable,run});
  const sanitize = result => {
    if (!result || Object.keys(result).some(k=>!['status','queryCredential'].includes(k)) || !['pending','processing','paid','failed'].includes(result.status) || JSON.stringify(result).length > 9000) fail('payment_result_rejected');
    return result;
  };
  const handle = async (operation,p) => {
    if (operation === 'payment_provider_verify') {
      if (!verificationOnly || !p || Object.keys(p).length) fail('payment_verification_rejected');
      const id = await identity();
      const env = Object.fromEntries(['PATH','HOME','USER','LANG','LC_ALL','XDG_CONFIG_HOME','XDG_DATA_HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
      const r = spawnSync(executable,['--version'],{env,encoding:'utf8',windowsHide:true,timeout:10_000,maxBuffer:4096});
      if (r.status !== 0 || !r.stdout.includes('0.4.5')) fail('payment_cli_unavailable');
      const fake = createAlipayBotAdapter({run:async args=>args[0] === 'query-payment-status' ? '✓ 支付已完成' : '✓ 支付待确认 https://u.alipay.com/fixture'});
      const pending = await fake.execute({sessionId:'11111111-1111-4111-8111-111111111111',paymentLink:'https://cashier.alipay.com/fixture',intentSummary:'服务内容：fixture，支付金额：¥0.01，支付对象：fixture'});
      const paid = await fake.query({credential:pending.queryCredential});
      const snap = makeOrderSnapshot({platform:'taobao',merchant:'fixture',goods:'fixture',sku:'fixture',skuId:'fixture',quantity:1,subtotalMinor:1,shippingMinor:0,discountMinor:0,totalMinor:1,addressLabel:'fixture',resourceUrl:'https://item.taobao.com/item.htm?id=123456789',confirmationPage:'https://buy.taobao.com/auction/buy_now.jhtml',category:'physical_goods'});
      const base = {purchaseId:randomUUID(),sessionId:randomUUID(),executionId:randomUUID(),approvalNonce:'verification-only-approval-receipt-32-characters',fingerprint:orderFingerprint(snap),snapshot:snap,expectedContextId:'fixture',expectedProfileId:'fixture',state:'pending_alipay',paymentLink:'https://cashier.alipay.com/fixture',intentSummary:summary(snap)};
      const req = sealPaymentRequest(secret,base), guards = {};
      const rejects = async (name, fn) => { try { await fn(); guards[name]=false; } catch { guards[name]=true; } };
      const verify = createWorkerVerifier({secret,workerId:'payment-fixture',expectedRole:'vps',seen:new Map()});
      const msg = signWorkerMessage({secret,role:'vps',workerId:'payment-fixture',operation:'payment_execute',payload:req});
      await rejects('unauthorized',()=>verify({...msg,signature:'0'.repeat(64)}));
      await rejects('expired',()=>validatePaymentRequest(secret,req,'payment_execute',req.expiresAt));
      verify(msg); await rejects('replayed',()=>verify(msg));
      await rejects('arbitraryArgs',()=>validatePaymentRequest(secret,{...req,args:['--help']},'payment_execute'));
      await rejects('fingerprint',()=>validatePaymentRequest(secret,sealPaymentRequest(secret,{...base,fingerprint:'0'.repeat(64)}),'payment_execute'));
      let fakeCalls=0;
      const fixtureLedger = join(dirname(ledgerPath),'provider-verification-'+base.executionId+'.json');
      const fixtureProvider = createWindowsPaymentProvider({secret,home,ledgerPath:fixtureLedger,allowRealPayment:true,validateBrowserBinding:async q=>{if(q.purchaseId!==base.purchaseId||q.sessionId!==base.sessionId)fail('payment_browser_binding_rejected');},run:async args=>{if(args[0]==='query-payment-status')return '✓ 支付已完成';fakeCalls++;return '✓ 支付待确认 https://u.alipay.com/fixture';}});
      await rejects('wrongPurchase',()=>fixtureProvider.handle('payment_execute',sealPaymentRequest(secret,{...base,purchaseId:randomUUID()})));
      const first=await fixtureProvider.handle('payment_execute',req),second=await fixtureProvider.handle('payment_execute',sealPaymentRequest(secret,base));
      guards.idempotent=fakeCalls===1&&JSON.stringify(first)===JSON.stringify(second);
      guards.redacted=Object.keys(first).sort().join(',')==='queryCredential,status'&&JSON.stringify(first).length<9000;
      const {paymentLink:_link,intentSummary:_summary,...queryBase}=base;
      const queried=await fixtureProvider.handle('payment_query',sealPaymentRequest(secret,{...queryBase,state:'reconciling',credential:first.queryCredential}));
      await rm(fixtureLedger,{force:true});
      if(Object.values(guards).some(v=>!v))fail('payment_verification_failed');
      return {verified:true,...id,guards,fakeMapping:pending.status === 'pending' && paid.status === 'paid' && queried.status === 'paid',realPaymentEnabled:allowRealPayment,browserActions:0,paymentInvocations:0};
    }
    validatePaymentRequest(secret,p,operation);
    if (!allowRealPayment || verificationOnly) fail('real_payment_disabled');
    await validateBrowserBinding(p,operation);
    await identity();
    const ledger = await load();
    const requestHash = digest(JSON.stringify([p.purchaseId,p.sessionId,p.executionId,p.approvalNonce,p.fingerprint,p.paymentLink,p.intentSummary]));
    if (operation === 'payment_execute') {
      const previous = ledger[p.executionId];
      if (previous) {
        if (previous.requestHash !== requestHash) fail('payment_idempotency_mismatch');
        if (!previous.result) fail('payment_execution_uncertain');
        return previous.result;
      }
      ledger[p.executionId] = {requestHash}; await save(ledger);
      const result = sanitize(await bot.execute({sessionId:p.sessionId,paymentLink:p.paymentLink,intentSummary:p.intentSummary}));
      ledger[p.executionId].result = result; await save(ledger); return result;
    }
    const previous = ledger[p.executionId];
    if (!previous?.result?.queryCredential || JSON.stringify(previous.result.queryCredential) !== JSON.stringify(p.credential)) fail('payment_query_binding_rejected');
    return sanitize(await bot.query({credential:p.credential}));
  };
  return { handle(operation,p) { const job = serial.then(()=>handle(operation,p)); serial = job.catch(()=>{}); return job; } };
}
