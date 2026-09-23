export const FRONTEND_PROJECT='/opt/qiuqiu/chat-frontend';

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
    `Write(${FRONTEND_PROJECT}/**)`
  ];
  const deny=[
    'Bash','Agent','NotebookEdit',
    ...protectedHostPaths.map(path=>`Read(${path})`),
    ...protectedProjectPaths.map(path=>`Read(${path})`),
    ...writeDeniedPaths.flatMap(path=>[`Edit(${path})`,`Write(${path})`])
  ];
  return {
    showThinkingSummaries:true,
    permissions:{defaultMode:'default',allow,deny},
    sandbox:{
      enabled:true,
      autoAllowBashIfSandboxed:false,
      filesystem:{
        allowWrite:[`${FRONTEND_PROJECT}/**`],
        denyWrite:writeDeniedPaths,
        denyRead:[...protectedHostPaths,...protectedProjectPaths]
      }
    },
    hooks:{
      MessageDisplay:[{hooks:[httpHook]}],
      Stop:[{hooks:[httpHook]}],
      StopFailure:[{hooks:[httpHook]}]
    },
    enabledPlugins:{'telegram@claude-plugins-official':false}
  };
}

export function sessionPolicyEvidence(value){
  const allow=value?.permissions?.allow||[],deny=value?.permissions?.deny||[],filesystem=value?.sandbox?.filesystem||{};
  const requiredAllow=[`Read(${FRONTEND_PROJECT}/**)`,`Edit(${FRONTEND_PROJECT}/**)`,`Write(${FRONTEND_PROJECT}/**)`,'mcp__qiuqiu-frontend__send_frontend_message'];
  const requiredDeny=['Bash','Agent','NotebookEdit','Read(/root/.claude/**)','Read(/root/.ssh/**)','Edit(/root/**)','Write(/root/**)'];
  return value?.showThinkingSummaries===true&&value?.alwaysThinkingEnabled===undefined&&value?.permissions?.defaultMode==='default'&&
    requiredAllow.every(rule=>allow.includes(rule))&&requiredDeny.every(rule=>deny.includes(rule))&&
    value?.sandbox?.enabled===true&&value?.sandbox?.autoAllowBashIfSandboxed===false&&
    filesystem.allowWrite?.includes(`${FRONTEND_PROJECT}/**`)&&filesystem.denyRead?.includes('/root/.claude/**')&&filesystem.denyWrite?.includes('/root/**');
}
