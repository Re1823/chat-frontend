import { spawn } from 'node:child_process';

const fail = code => { throw new Error(code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_NO = /^\d{10}8282\d{18}$/;
const officialShortUrl = value => {
  let url;
  try { url = new URL(value); } catch { fail('payment_query_credential_rejected'); }
  if (url.protocol !== 'https:' || url.username || url.password || !/(?:^|\.)alipay\.(?:com|cn)$/.test(url.hostname) || url.href.length > 8192) fail('payment_query_credential_rejected');
  return url.href;
};

export function parseAlipayBotOutput(operation, output) {
  const text = String(output || '').trim();
  if (!text || text.length > 65_536) fail('payment_output_unrecognized');
  if (operation === 'submit') {
    if (text.includes('✓ 支付成功')) return { status: 'paid' };
    if (text.includes('✗ 支付失败')) return { status: 'failed' };
    if (!text.includes('✓ 支付待确认') && !text.includes('⏳ 支付处理中')) fail('payment_output_unrecognized');
    const orderNumber = text.match(/(?<!\d)\d{10}8282\d{18}(?!\d)/)?.[0];
    if (orderNumber) return { status: 'pending', queryCredential: { kind: 'outShakeNo', value: orderNumber } };
    const links = [...text.matchAll(/https:\/\/[^\s<>"')]+/g)].map(match => match[0].replace(/[，。.,;]+$/, ''));
    const short = links.find(link => { try { officialShortUrl(link); return true; } catch { return false; } });
    if (!short) fail('payment_query_credential_missing');
    return { status: 'pending', queryCredential: { kind: 'shortUrl', value: officialShortUrl(short) } };
  }
  if (operation === 'query') {
    if (text.includes('✓ 支付已完成')) return { status: 'paid' };
    if (text.includes('✓ 支付状态同步中')) return { status: 'processing' };
    if (text.includes('✗ 支付已关闭')) return { status: 'failed' };
    fail('payment_query_uncertain');
  }
  fail('payment_operation_rejected');
}

export function createAlipayBotAdapter({ command = 'alipay-bot', run = null, timeoutMs = 45_000 } = {}) {
  const invoke = run || ((args) => new Promise((resolve, reject) => {
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 65_536) child.kill(); });
    child.stderr.on('data', chunk => { error += chunk.toString('utf8'); if (error.length > 16_384) child.kill(); });
    child.on('error', cause => { clearTimeout(timer); reject(Object.assign(new Error('alipay_bot_unavailable'), { cause })); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error('alipay_bot_failed')); else resolve(output); });
  }));
  return {
    async execute({ sessionId, paymentLink, intentSummary }) {
      if (!UUID.test(sessionId || '') || !/^https:\/\//.test(paymentLink || '') || typeof intentSummary !== 'string' || !/^服务内容：.+，支付金额：¥\d+\.\d{2}，支付对象：.+$/.test(intentSummary) || intentSummary.length > 600) fail('invalid_payment_intent');
      return parseAlipayBotOutput('submit', await invoke(['submit-payment', '--session-id', sessionId, '--payment-link', paymentLink, '--intent-summary', intentSummary]));
    },
    async query({ credential }) {
      if (!credential || !['outShakeNo', 'shortUrl'].includes(credential.kind)) fail('payment_query_credential_rejected');
      const args = credential.kind === 'outShakeNo'
        ? (ORDER_NO.test(credential.value || '') ? ['query-payment-status', '--out-shake-no', credential.value] : fail('payment_query_credential_rejected'))
        : ['query-payment-status', '-p', officialShortUrl(credential.value)];
      return parseAlipayBotOutput('query', await invoke(args));
    }
  };
}
