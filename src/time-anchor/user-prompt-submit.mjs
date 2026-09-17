#!/usr/bin/env node
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { recordPrompt } from './core.mjs';

export async function handleUserPromptSubmit(event, options = {}) {
  if (!event || event.hook_event_name !== 'UserPromptSubmit') throw new Error('Time Anchor hook input unavailable');
  if (typeof event.session_id !== 'string' || !event.session_id) throw new Error('Time Anchor session unavailable');
  if (typeof event.prompt !== 'string') throw new Error('Time Anchor prompt unavailable');
  const result = await recordPrompt({
    sessionId: event.session_id,
    prompt: event.prompt,
    instanceKey: options.instanceKey ?? process.env.QIUQIU_TIME_ANCHOR_INSTANCE_KEY,
    baseDir: options.baseDir ?? process.env.QIUQIU_TIME_ANCHOR_STATE_DIR,
    now: options.now ?? new Date(),
    randomQuarter: options.randomQuarter ?? randomInt(4) === 0
  });
  return result.additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.additionalContext } } : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 262144) process.exitCode = 1; });
  process.stdin.on('end', async () => {
    if (process.exitCode) return;
    try {
      const output = await handleUserPromptSubmit(JSON.parse(input));
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch { process.stderr.write('Time Anchor unavailable\n'); }
  });
}
