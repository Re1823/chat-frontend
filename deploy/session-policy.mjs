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
  'mcp__qiuqiu-frontend__send_saved_photo_to_frontend',
  'mcp__qiuqiu-frontend__shopping_search',
  'mcp__qiuqiu-frontend__shopping_product',
  'mcp__qiuqiu-frontend__shopping_select',
  'mcp__qiuqiu-frontend__shopping_prepare_purchase',
  'mcp__qiuqiu-frontend__shopping_purchase_status'
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
  "/root/.local/**",
  "/root/.mcp.json",
  "/root/.claude.json",
  "/root/.claude.json.*",
  "/root/.bash*",
  "/root/.profile",
  "/root/.env*",
  '/etc/**',
  '/proc/**',
  '/sys/**',
  '/dev/**'
];

const writeDeniedPaths=[
  ...protectedHostPaths.filter(path=>path.startsWith('/root/')),
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
    'WebFetch',
    "mcp__galatea-garden__*",
    "Bash(TMPDIR=./.tmp node *)",
    "Bash(TMPDIR=./.tmp npm *)",
    "Bash(TMPDIR=./.tmp npx *)",
    "Bash(TMPDIR=./.tmp python *)",
    "Bash(TMPDIR=./.tmp python3 *)",
    "Bash(TMPDIR=./.tmp pip *)",
    "Bash(TMPDIR=./.tmp pip3 *)",
    "Bash(TMPDIR=./.tmp uv *)",
    "Read(//root/**)",
    "Edit(//root/**)",
    "Bash(node *)",
    "Bash(npm *)",
    "Bash(npx *)",
    "Bash(python *)",
    "Bash(python3 *)",
    "Bash(pip *)",
    "Bash(pip3 *)",
    "Bash(uv *)",
    "Bash(git *)",
    "Bash(mkdir *)",
    "Bash(cd *)",
    "Bash(rg *)",
    "Bash(claude mcp add *)",
    "Bash(claude mcp add-json *)",
    "Bash(claude mcp list *)",
    "Bash(claude mcp get *)",
    "Bash(claude mcp remove *)",
    "Bash(claude mcp --help)",
    "Bash(/usr/bin/claude mcp add *)",
    "Bash(/usr/bin/claude mcp add-json *)",
    "Bash(/usr/bin/claude mcp list *)",
    "Bash(/usr/bin/claude mcp get *)",
    "Bash(/usr/bin/claude mcp remove *)",
    "Bash(/usr/bin/claude mcp --help)",

    `Read(/${FRONTEND_PROJECT}/**)`,
    `Edit(/${FRONTEND_PROJECT}/**)`,
    `Write(/${FRONTEND_PROJECT}/**)`,
    `Edit(${ROOT_CLAUDE_MD_PERMISSION})`
  ];
  const deny=[
    'Agent','NotebookEdit',
    ...protectedHostPaths.map(path=>`Read(/${path})`),
    ...protectedProjectPaths.map(path=>`Read(/${path})`),
    ...writeDeniedPaths.flatMap(path=>path==='/root/**'
      ? [`Write(/${path})`]
      : [`Edit(/${path})`,`Write(/${path})`])
  ];
  return {
    showThinkingSummaries:true,
    permissions:{defaultMode:'default',allow,deny},
    sandbox:{
      enabled:true,
      autoAllowBashIfSandboxed:false,
      failIfUnavailable:true,
      allowUnsandboxedCommands:false,
      network:{allowLocalBinding:true,allowedDomains:["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "127.0.0.1:4173"]},
      excludedCommands:["claude mcp add *", "claude mcp add-json *", "claude mcp list *", "claude mcp get *", "claude mcp remove *", "claude mcp --help", "/usr/bin/claude mcp add *", "/usr/bin/claude mcp add-json *", "/usr/bin/claude mcp list *", "/usr/bin/claude mcp get *", "/usr/bin/claude mcp remove *", "/usr/bin/claude mcp --help"],
      filesystem:{
        allowWrite:[`${FRONTEND_PROJECT}/**`,ROOT_CLAUDE_MD,'/root/**'],
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
  const requiredAllow=['mcp__galatea-garden__*','Read(//root/**)','Edit(//root/**)',"Bash(node *)","Bash(npm *)","Bash(npx *)","Bash(python *)","Bash(python3 *)","Bash(pip *)","Bash(pip3 *)","Bash(uv *)","Bash(git *)","Bash(mkdir *)","Bash(cd *)","Bash(rg *)",'WebFetch',`Read(/${FRONTEND_PROJECT}/**)`,`Edit(/${FRONTEND_PROJECT}/**)`,`Write(/${FRONTEND_PROJECT}/**)`,`Edit(${ROOT_CLAUDE_MD_PERMISSION})`,'mcp__qiuqiu-frontend__send_frontend_message'];
  const requiredDeny=['Agent','NotebookEdit','Read(//root/.claude/**)','Read(//root/.ssh/**)','Edit(//root/.claude/**)','Edit(//root/.ssh/**)'];
  const forbiddenDeny=['Bash','Write(//root/**)','Edit(//root/**)',`Edit(!${ROOT_CLAUDE_MD})`];
  const writeGuard=value?.hooks?.PreToolUse?.some(group=>group?.matcher==='Edit|Write|NotebookEdit'&&group?.hooks?.some(hook=>hook?.type==='command'&&hook?.command===`/usr/bin/node "${ROOT_WRITE_GUARD}"`));
  return value?.showThinkingSummaries===true&&value?.alwaysThinkingEnabled===undefined&&value?.permissions?.defaultMode==='default'&&writeGuard===true&&
    requiredAllow.every(rule=>allow.includes(rule))&&requiredDeny.every(rule=>deny.includes(rule))&&!forbiddenDeny.some(rule=>deny.includes(rule))&&
    value?.sandbox?.enabled===true&&value?.sandbox?.autoAllowBashIfSandboxed===false&&
    filesystem.allowWrite?.includes(`${FRONTEND_PROJECT}/**`)&&filesystem.allowWrite?.includes(ROOT_CLAUDE_MD)&&filesystem.denyRead?.includes('/root/.claude/**')&&filesystem.denyWrite?.includes('/root/.claude/**')&&filesystem.allowWrite?.includes('/root/**');
}
