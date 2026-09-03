import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClaudeTmuxConfig } from '../src/config.mjs';

test('tmux stays disabled on Windows and secrets are backend-only configuration',()=>{
  const config=loadClaudeTmuxConfig({CLAUDE_TMUX_ENABLED:'true',DWELL_CLAUDE_HOOK_SECRET:'server-secret',CLAUDE_TMUX_LAUNCH_ARGS_JSON:'["--model","sonnet"]'},'win32');
  assert.equal(config.enabled,false);assert.equal(config.unsupportedPlatform,true);assert.equal(config.hookSecret,'server-secret');assert.deepEqual(config.launchArgs,['--model','sonnet']);
});

test('invalid launch argument configuration is rejected',()=>{
  assert.throws(()=>loadClaudeTmuxConfig({CLAUDE_TMUX_LAUNCH_ARGS_JSON:'{"bad":true}'},'linux'),/字符串数组/);
});

test('an enabled persistent runtime requires a stable backend hook secret',()=>{
  assert.throws(()=>loadClaudeTmuxConfig({CLAUDE_TMUX_ENABLED:'true'},'linux'),/必须配置稳定/);
  assert.equal(loadClaudeTmuxConfig({CLAUDE_TMUX_ENABLED:'true',DWELL_CLAUDE_HOOK_SECRET:'stable'},'linux').enabled,true);
});
