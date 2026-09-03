const cleanBase = value => String(value || '').replace(/\/+$/, '');

export function safeBase(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http/https 接口');
  return url.toString().replace(/\/+$/, '');
}

export function openAIRequest(config, messages, stream) {
  const base = safeBase(cleanBase(config.base || 'https://api.openai.com/v1'));
  const useResponses = config.protocol === 'responses';
  const url = base + (base.endsWith('/v1') ? '' : '/v1') + (useResponses ? '/responses' : '/chat/completions');
  const body = useResponses
    ? { model:config.model, input:messages.map(message => ({role:message.role, content:message.content})), stream, store:false }
    : { model:config.model, messages, stream };
  return { url, init:{method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${config.key}`}, body:JSON.stringify(body)} };
}

export function anthropicRequest(config, messages, stream) {
  const base = safeBase(cleanBase(config.base || 'https://api.anthropic.com'));
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const body = { model:config.model, max_tokens:4096, stream, messages:messages.filter(message => message.role !== 'system') };
  if (system) body.system = system;
  return { url:base + (base.endsWith('/v1') ? '' : '/v1') + '/messages', init:{method:'POST', headers:{'content-type':'application/json', 'x-api-key':config.key, 'anthropic-version':'2023-06-01'}, body:JSON.stringify(body)} };
}

export function createApiRequest(config, messages, stream) {
  return config.protocol === 'anthropic'
    ? anthropicRequest(config, messages, stream)
    : openAIRequest(config, messages, stream);
}

export function extractTextDelta(protocol, frame) {
  if (protocol === 'anthropic') return frame.type === 'content_block_delta' ? frame.delta?.text || '' : '';
  if (protocol === 'responses') return frame.type === 'response.output_text.delta' ? frame.delta || '' : '';
  return frame.choices?.[0]?.delta?.content || '';
}
