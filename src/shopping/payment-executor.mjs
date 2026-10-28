import { assertPaymentExecutor } from './contracts.mjs';

const fail = code => { throw new Error(code); };
const money = minor => `¥${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

export function createShoppingPaymentExecutor({ purchaseStore, gateway, provider, allowRealPayment = false, allowOrderSubmission = true }) {
  if (!purchaseStore || !gateway || typeof gateway.call !== 'function') throw new TypeError('shopping_executor_configuration_required');
  if (provider) assertPaymentExecutor(provider);
  return {
    async verify() { if (!provider?.verify) fail('payment_provider_unavailable'); return provider.verify(); },
    async execute(purchaseId) {
      const before = purchaseStore.execution({ purchaseId });
      if (before.state !== 'approved') return { state: before.state, paymentStage: before.execution?.publicStage || null };
      if (!allowOrderSubmission) fail('order_submission_disabled');
      if (!gateway.online()) fail('worker_offline');
      const claim = await purchaseStore.claimExecution({ purchaseId });
      if (!claim.claimed) return { state: claim.purchase.state, paymentStage: claim.purchase.paymentStage };
      const record = purchaseStore.execution({ purchaseId });
      let result;
      try {
        result = await gateway.call('submit_approved_order', {
          purchaseId, executionId: claim.executionId, sessionId: record.sessionId,
          expectedContextId: record.session.browserContextId, expectedProfileId: record.session.profileId,
          fingerprint: record.fingerprint, snapshot: record.snapshot,
          approvalNonce: purchaseStore.paymentBinding({purchaseId}).approvalNonce
        }, { timeoutMs: 60_000 });
        if (result?.sessionId !== record.sessionId || result?.executionId !== claim.executionId || typeof result?.cashierUrl !== 'string') fail('order_submit_unverified');
        await purchaseStore.recordCashier({ purchaseId, executionId: claim.executionId, cashierUrl: result.cashierUrl });
      } catch (error) {
        await purchaseStore.executionAttention({ purchaseId, executionId: claim.executionId, stage: 'order_submit_uncertain' });
        throw error;
      }
      if (!allowRealPayment) return { state: 'pending_alipay', paymentStage: 'awaiting_payment' };
      return this.submitPayment(purchaseId);
    },
    async submitPayment(purchaseId) {
      if (!allowRealPayment || !provider) fail('real_payment_disabled');
      const record = purchaseStore.execution({ purchaseId });
      if (record.state !== 'pending_alipay') return { state: record.state, paymentStage: record.execution?.publicStage || null };
      const claim = await purchaseStore.claimPaymentSubmission({ purchaseId, executionId: record.execution.id });
      if (!claim.claimed) return { state: claim.purchase.state, paymentStage: claim.purchase.paymentStage };
      const snapshot = record.snapshot;
      const intentSummary = `服务内容：${snapshot.goods} ${snapshot.sku} ×${snapshot.quantity}，支付金额：${money(snapshot.totalMinor)}，支付对象：${snapshot.merchant}`;
      try {
        const result = await provider.execute({ purchaseId, executionId:record.execution.id, sessionId: record.sessionId, paymentLink: claim.cashierUrl, intentSummary });
        return await purchaseStore.recordPaymentResult({ purchaseId, executionId: record.execution.id, result: result.status, queryCredential: result.queryCredential || null });
      } catch (error) {
        await purchaseStore.executionAttention({ purchaseId, executionId: record.execution.id, stage: 'payment_result_uncertain' });
        throw error;
      }
    },
    async query(purchaseId) {
      if (!provider) fail('payment_provider_unavailable');
      const record = purchaseStore.execution({ purchaseId });
      if (record.state === 'completed' || record.state === 'failed') return { state: record.state, paymentStage: record.execution?.publicStage || null };
      const credential = await purchaseStore.beginReconcile({ purchaseId, executionId: record.execution.id });
      try {
        const result = await provider.query({ purchaseId, executionId:record.execution.id, credential });
        return await purchaseStore.recordPaymentResult({ purchaseId, executionId: record.execution.id, result: result.status });
      } catch (error) {
        await purchaseStore.executionAttention({ purchaseId, executionId: record.execution.id, stage: 'payment_result_uncertain' });
        throw error;
      }
    },
    status(purchaseId) {
      const record = purchaseStore.execution({ purchaseId });
      return { state: record.state, paymentStage: record.execution?.publicStage || null };
    }
  };
}
