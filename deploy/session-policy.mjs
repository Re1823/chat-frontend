export const FRONTEND_PROJECT='/opt/qiuqiu/chat-frontend';
export const ROOT_CLAUDE_MD='/root/CLAUDE.md';
export const ROOT_CLAUDE_MD_PERMISSION='//root/CLAUDE.md';
export const ROOT_WRITE_GUARD='/usr/local/lib/qiuqiu-claude-bridge/deny-root-write-hook.mjs';

const frontendTools=[
  'mcp__qiuqiu-frontend__send_frontend_message',
  'mcp__qiuqiu-frontend__read_time_anchor',
  'mcp__qiuqiu-frontend__read_frontend_image',
  'mcp__qiuqiu-frontend__save_frontend_photo_to_photos',
  'mcp__qiuqiu-frontend__create_photo_album',
  'mcp__qiuqiu-frontend__list_photo_albums',
  'mcp__qiuqiu-frontend__list_photos',
  'mcp__qiuqiu-frontend__read_saved_photo',
  'mcp__qiuqiu-frontend__send_saved_photo_to_frontend'
];

const protectedProjectPaths=[
  `${FRONTEND_PROJECT}/.env*`,
  `${FRONTEND_PROJECT}/.git/**`,
  `${FRONTEND_PROJECT}/.claude/**`,
  `${FRONTEND_PROJECT}/data/**`
];

const protectedHostPaths=[
  '/root/.claude/**',
  '/root/.ssh/**',
  '/root/.config/**',
  '/etc/**',
  '/proc/**',
  '/sys/**',
  '/dev/**'
];

const writeDeniedPaths=[
  '/root/**',
  '/etc/**',
  '/proc/**',
  '/sys/**',
  '/dev/**',
  '/usr/**',
  '/boot/**',
  '/run/**',
  '/var/**',
  '/home/**',
  '/tmp/**',
  ...protectedProjectPaths
];

export function createSessionPolicy(httpHook){
  const allow=[
    'mcp__ombre-brain__*',
    ...frontendTools,
    `Read(${FRONTEND_PROJECT}/**)`,
    `Edit(${FRONTEND_PROJECT}/**)`,
    `Write(${FRONTEND_PROJECT}/**)`,
    `Edit(${ROOT_CLAUDE_MD_PERMISSION})`
  ];
  const deny=[
    'Bash','Agent','NotebookEdit',
    ...protectedHostPaths.map(path=>`Read(${path})`),
    ...protectedProjectPaths.map(path=>`Read(${path})`),
    ...writeDeniedPaths.flatMap(path=>path==='/root/**'
      ? [`Write(${path})`]
      : [`Edit(${path})`,`Write(${path})`])
  ];
  return {
    showThinkingSummaries:true,
    permissions:{defaultMode:'default',allow,deny},
    sandbox:{
      enabled:true,
      autoAllowBashIfSandboxed:false,
      filesystem:{
        allowWrite:[`${FRONTEND_PROJECT}/**`,ROOT_CLAUDE_MD],
        denyWrite:writeDeniedPaths,
        denyRead:[...protectedHostPaths,...protectedProjectPaths]
      }
    },
    hooks:{
      PreToolUse:[{matcher:'Edit|Write|NotebookEdit',hooks:[{type:'command',command:`/usr/bin/node "${ROOT_WRITE_GUARD}"`,timeout:5}]}],
      MessageDisplay:[{hooks:[httpHook]}],
      Stop:[{hooks:[httpHook]}],
      StopFailure:[{hooks:[httpHook]}]
    },
    enabledPlugins:{'telegram@claude-plugins-official':false}
  };
}

export function sessionPolicyEvidence(value){
  const allow=value?.permissions?.allow||[],deny=value?.permissions?.deny||[],filesystem=value?.sandbox?.filesystem||{};
  const requiredAllow=[`Read(${FRONTEND_PROJECT}/**)`,`Edit(${FRONTEND_PROJECT}/**)`,`Write(${FRONTEND_PROJECT}/**)`,`Edit(${ROOT_CLAUDE_MD_PERMISSION})`,'mcp__qiuqiu-frontend__send_frontend_message'];
  const requiredDeny=['Bash','Agent','NotebookEdit','Read(/root/.claude/**)','Read(/root/.ssh/**)','Write(/root/**)'];
  const forbiddenDeny=['Edit(/root/**)',`Edit(!${ROOT_CLAUDE_MD})`];
  const writeGuard=value?.hooks?.PreToolUse?.some(group=>group?.matcher==='Edit|Write|NotebookEdit'&&group?.hooks?.some(hook=>hook?.type==='command'&&hook?.command===`/usr/bin/node "${ROOT_WRITE_GUARD}"`));
  return value?.showThinkingSummaries===true&&value?.alwaysThinkingEnabled===undefined&&value?.permissions?.defaultMode==='default'&&writeGuard===true&&
    requiredAllow.every(rule=>allow.includes(rule))&&requiredDeny.every(rule=>deny.includes(rule))&&!forbiddenDeny.some(rule=>deny.includes(rule))&&
    value?.sandbox?.enabled===true&&value?.sandbox?.autoAllowBashIfSandboxed===false&&
    filesystem.allowWrite?.includes(`${FRONTEND_PROJECT}/**`)&&filesystem.allowWrite?.includes(ROOT_CLAUDE_MD)&&filesystem.denyRead?.includes('/root/.claude/**')&&filesystem.denyWrite?.includes('/root/**');
}
