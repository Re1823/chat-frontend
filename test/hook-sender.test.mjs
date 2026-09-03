import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('transport hook fails open with clean stdout when backend is unavailable',async()=>{
  const child=spawn(process.execPath,['hooks/claude/post-event.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,DWELL_CLAUDE_HOOK_URL:'http://127.0.0.1:1/api/internal/claude-code/events',DWELL_CLAUDE_HOOK_TIMEOUT_MS:'100'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.stdin.end('{"event":"MessageDisplay","delta":"x"}');
  const code=await new Promise(resolve=>child.once('exit',resolve));
  assert.equal(code,0);assert.equal(stdout,'');assert.equal(stderr,'');
});
