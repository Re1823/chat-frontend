import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const truthy=value=>/^(1|true|yes)$/i.test(String(value||''));

export function loadClaudeTmuxConfig(env=process.env,platform=process.platform){
  const requested=truthy(env.CLAUDE_TMUX_ENABLED);
  const enabled=requested&&platform!=='win32';
  if(enabled&&!env.DWELL_CLAUDE_HOOK_SECRET)throw new Error('启用 Claude tmux runtime 时必须配置稳定的 DWELL_CLAUDE_HOOK_SECRET');
  let launchArgs=[];
  if(env.CLAUDE_TMUX_LAUNCH_ARGS_JSON){const parsed=JSON.parse(env.CLAUDE_TMUX_LAUNCH_ARGS_JSON);if(!Array.isArray(parsed)||parsed.some(value=>typeof value!=='string'))throw new Error('CLAUDE_TMUX_LAUNCH_ARGS_JSON 必须是字符串数组');launchArgs=parsed}
  return {
    requested,
    enabled,
    unsupportedPlatform:requested&&platform==='win32',
    autoCreate:truthy(env.CLAUDE_TMUX_AUTO_CREATE),
    runtimeId:env.CLAUDE_TMUX_RUNTIME_ID||'claude-main',
    sessionName:env.CLAUDE_TMUX_SESSION||'dwell-claude',
    workspace:env.CLAUDE_TMUX_WORKSPACE||'',
    tmuxBinary:env.CLAUDE_TMUX_BINARY||'tmux',
    tmuxSocket:env.CLAUDE_TMUX_SOCKET||'',
    claudeBinary:env.CLAUDE_CODE_BINARY||'claude',
    launchArgs,
    submitDelayMs:Math.max(250,Number(env.CLAUDE_TMUX_SUBMIT_DELAY_MS)||900),
    stopTimeoutMs:Math.max(1,Number(env.CLAUDE_TMUX_STOP_TIMEOUT_MS)||2000),
    hookSecret:env.DWELL_CLAUDE_HOOK_SECRET||randomBytes(32).toString('hex'),
    hookCapture:truthy(env.DWELL_CLAUDE_HOOK_CAPTURE),
    registryPath:env.CLAUDE_TMUX_REGISTRY_PATH||fileURLToPath(new URL('../data/claude-tmux-runtime.json',import.meta.url)),
    capturePath:env.DWELL_CLAUDE_HOOK_CAPTURE_PATH||fileURLToPath(new URL('../data/hook-capture.jsonl',import.meta.url))
  };
}
