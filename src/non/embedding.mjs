// Qiuqiu Phase 2B provider choice: SiliconFlow OpenAI-compatible BAAI/bge-m3.
// This module has no OB storage, environment reads, or automatic network work.
export const NON_EMBEDDING_MODEL = 'BAAI/bge-m3';
export const NON_EMBEDDING_DIM = 1024;
export const NON_EMBEDDING_BASE_URL = 'https://api.siliconflow.cn/v1';

export function validateNonEmbedding(vector) {
  if (!Array.isArray(vector) || vector.length !== NON_EMBEDDING_DIM ||
      !vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new TypeError('NON_EMBEDDING_INVALID_VECTOR');
  }
  return vector;
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length ||
      !left.every(value => typeof value === 'number' && Number.isFinite(value)) ||
      !right.every(value => typeof value === 'number' && Number.isFinite(value))) return 0;
  let dot = 0, leftSquared = 0, rightSquared = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftSquared += left[index] * left[index];
    rightSquared += right[index] * right[index];
  }
  return leftSquared && rightSquared ? dot / Math.sqrt(leftSquared * rightSquared) : 0;
}

export function createBgeM3Client({apiKey, baseUrl = NON_EMBEDDING_BASE_URL, timeoutMs = 120_000, transport = fetch} = {}) {
  if (typeof apiKey !== 'string' || !apiKey || typeof baseUrl !== 'string' || !baseUrl ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof transport !== 'function') {
    throw new TypeError('NON_EMBEDDING_CONFIG_REQUIRED');
  }
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
  return Object.freeze({
    async embed(input) {
      if (typeof input !== 'string' || !input.trim()) throw new TypeError('NON_EMBEDDING_INPUT_REQUIRED');
      const response = await transport(endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
        body: JSON.stringify({model: NON_EMBEDDING_MODEL, input}),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response?.ok) throw new Error('NON_EMBEDDING_PROVIDER_FAILED');
      const payload = await response.json();
      return validateNonEmbedding(payload?.data?.[0]?.embedding);
    }
  });
}
