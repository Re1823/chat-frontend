// Phase 1 contracts. Browser and payment capabilities are intentionally absent.
const string = (maxLength = 256) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

export const shoppingMcpTools = Object.freeze([
  { name: 'shopping_search', description: 'Search Taobao or Tmall products.', inputSchema: object({ query: string(120), page: { type: 'integer', minimum: 1, maximum: 5 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['query']) },
  { name: 'shopping_product', description: 'Read a product and its available choices.', inputSchema: object({ productId: string(128) }) },
  { name: 'shopping_select', description: 'Select a SKU, quantity, and listed offer in the active shopping session.', inputSchema: object({ sessionId: string(80), productId: string(128), skuId: string(128), quantity: { type: 'integer', minimum: 1, maximum: 20 }, offerId: string(128) }, ['sessionId', 'productId', 'skuId', 'quantity']) },
  { name: 'shopping_prepare_purchase', description: 'Prepare one physical-goods order for PWA approval. Never pays.', inputSchema: object({ sessionId: string(80) }) },
  { name: 'shopping_purchase_status', description: 'Read the public state of one purchase.', inputSchema: object({ purchaseId: string(80) }) }
].map(tool => Object.freeze({ ...tool, annotations: { readOnlyHint: ['shopping_search', 'shopping_product', 'shopping_purchase_status'].includes(tool.name), destructiveHint: false, openWorldHint: true } })));

// inspect_current_page is an internal, disabled-by-default development operation.
// It is intentionally absent from shoppingMcpTools.
export const WORKER_OPERATIONS = Object.freeze(['search', 'product', 'select', 'prepare_order', 'session_status', 'inspect_current_page', 'submit_approved_order', 'approved_order_status', 'payment_execute', 'payment_query', 'payment_provider_verify']);
export const SHOPPING_TRANSPORT = Object.freeze({ version: 1, direction: 'windows_outbound', maxSkewMs: 60_000, maxBodyBytes: 32_768, responseTimeoutMs: 30_000 });
export const SHOPPING_APPROVAL_API = Object.freeze({ list: 'GET /api/shopping/approvals', decide: 'POST /api/shopping/approvals/:purchaseId/decision' });

// The implementation supplies this interface later. It is never an MCP tool.
export function assertPaymentExecutor(executor) {
  if (!executor || typeof executor.execute !== 'function' || typeof executor.query !== 'function') throw new TypeError('payment_executor_required');
  return executor;
}
