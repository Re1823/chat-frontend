export const TIME_ANCHOR_TOOL_PERMISSION = 'mcp__qiuqiu-frontend__read_time_anchor';
export const TIME_ANCHOR_HOOK_MARKER = '/time-anchor/user-prompt-submit.mjs';

export function mergeTimeAnchorSettings(source, { hookCommand } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid Claude settings');
  if (typeof hookCommand !== 'string' || !hookCommand.includes(TIME_ANCHOR_HOOK_MARKER)) throw new Error('Invalid Time Anchor hook command');
  const settings = structuredClone(source);
  if (!settings.permissions || typeof settings.permissions !== 'object' || !Array.isArray(settings.permissions.allow) || !Array.isArray(settings.permissions.deny)) throw new Error('Invalid Claude permissions');
  if (!settings.permissions.allow.includes(TIME_ANCHOR_TOOL_PERMISSION)) settings.permissions.allow.push(TIME_ANCHOR_TOOL_PERMISSION);
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('Invalid Claude hooks');
  const groups = Array.isArray(settings.hooks.UserPromptSubmit) ? settings.hooks.UserPromptSubmit : [];
  const retained = groups.filter(group => !group?.hooks?.some(hook => typeof hook?.command === 'string' && hook.command.includes(TIME_ANCHOR_HOOK_MARKER)));
  retained.push({ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] });
  settings.hooks.UserPromptSubmit = retained;
  return settings;
}
