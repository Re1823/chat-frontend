// An approval carries its own durable continuation identity. This coordinator
// only visits approvals marked by the current semantics; it never scans legacy
// approved purchases for execution.
export function createApprovalContinuation({ purchaseStore, executor = null, orderSubmitEnabled = false, workerOnline = () => false, log = () => {} }) {
  if (!purchaseStore) throw new TypeError('purchase_store_required');
  const active = new Set();
  const attempt = async purchaseId => {
    if (active.has(purchaseId)) return { status: 'already_active' };
    active.add(purchaseId);
    try {
      const row = purchaseStore.continuation({ purchaseId });
      if (!row || row.state !== 'approved' || !['queued', 'blocked_by_order_submit_gate', 'claimed'].includes(row.continuation.state)) return { status: 'ineligible' };
      if (!orderSubmitEnabled) {
        await purchaseStore.setContinuationState({ purchaseId, nextState: 'blocked_by_order_submit_gate' });
        return { status: 'blocked_by_order_submit_gate', continuationId: row.continuation.id };
      }
      if (!executor || !workerOnline()) return { status: 'waiting_for_worker', continuationId: row.continuation.id };
      await purchaseStore.setContinuationState({ purchaseId, nextState: 'claimed' });
      // The executor owns the atomic approved -> executing transition and the
      // browser/fingerprint checks. An uncertain submit is never retried here.
      const result = await executor.execute(purchaseId);
      return { status: 'continued', continuationId: row.continuation.id, result };
    } catch (error) {
      log({ event: 'shopping_continuation_stopped', purchaseId, code: error.message });
      return { status: 'stopped', code: error.message };
    } finally { active.delete(purchaseId); }
  };
  const recover = async () => Promise.all(purchaseStore.recoverableContinuations().map(attempt));
  return { attempt, recover };
}
