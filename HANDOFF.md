# 项目交接：dwell 多模型聊天前端

更新时间：2026-09-03（Asia/Shanghai）

本文以当前磁盘上的项目文件和本次实际检查结果为准。当前项目目录：

`C:\Users\HP\Documents\Codex\2026-08-18\https-github-com-xinwithyu-dwell-on\work\chat-frontend`

远端仓库：`https://github.com/Re1823/chat-frontend.git`

需求参考 PDF：`F:\Downloads\from-terminal-to-frontend.pdf`

## 0. 最新暂停点（以本节为准）

更新时间：2026-09-03。本文后续章节保留了最初架构计划和当时的检查记录；若与本节冲突，以本节为准。

### Ombre Brain Dashboard 最新进度（2026-09-03）

- 已新增独立的 `src/ombre-dashboard/service.mjs`、`normalize.mjs`、`routes.mjs`；登录 cookie 缓存、并发 login 去重、401 重登一次、timeout/稳定错误映射和可选 Cloudflare Access service-token header 已由 fake upstream 测试。
- 已提供 `GET /api/ombre-dashboard/status`、`buckets`、`search?q=`、`buckets/:id`，浏览器不会拿到密码、cookie、Access secret 或 raw upstream JSON。
- 已加入原生 Memory 页面：在线状态、数量、All/Dynamic/Permanent/Archived/Pinned、300ms 搜索防抖、卡片列表、先用列表数据打开再异步补全的详情 sheet。
- 已加入 `GET /api/qiuqiu/readiness` 与 `QIUQIU_WORKSPACE`；只返回路径和 `CLAUDE.md` 存在性，不返回内容；Claude Code 固定为 `offline`。
- Dashboard 与未来 MCP 已明确分开。MCP 步骤只记录在 `docs/ombre-dashboard.md`，没有启动 Claude Code，也没有修改 `claude_tmux` core。
- `.env.local` 已作为直接启动时的 gitignored 配置文件；现有 service env 优先。production URL 已切为 `https://www.reesia.xyz`，密码仍只在该本地文件中。
- localhost `http://localhost:18001` 已真实通过 login、session cookie、OB 2.11.0 status、311 条 buckets、search 和 `/api/bucket/:id` detail。
- cloudflared 使用完全相同代码真实通过同一链路；公开入口返回 200，没有 Access redirect/challenge，当前不需要 interactive login 或 Service Token，两个 CF Access env 保持未设置。
- 真实无效 Cookie 已触发 401，随后自动登录并重试成功；真实并发 ensure login 只发起一次登录。
- OB 2.11.0 status 使用 `buckets.dynamic/permanent/archive/total`，列表为数组，详情使用 `content/display_content/metadata`。normalize 已据此兼容，但仍保留旧候选字段。
- `/api/breath-debug` 确认支持；已新增只读稳定路由及 Memory 页内折叠的高级入口，不放聊天主页。
- 自动测试当前为 73/73 通过；阶段开始前的 51 项聊天/provider/streaming/keyboard/toast/tmux 回归全部保留。
- QIUQIU workspace 仍未配置或创建，Claude Code 保持 `offline`；等待后续使用真正的 `CLAUDE.md`。

阶段 0、API runtime/统一事件模型，以及阶段 1 的 Windows + fake runner 实现已经完成。当前主动暂停真实 WSL/Linux Claude Code 采样，因为尚无可用 Claude Code 订阅；不要继续猜测 hook schema，也不要扩展后续功能。

### 已实现并由自动化测试验证

- `sync.ps1` 已覆盖 `HANDOFF.md`、`src/`、`hooks/`、`test/`、`docs/`、`.env.example` 和 `data/.gitkeep`；尚未运行同步、提交或推送。
- 原有 Claude API、OpenAI-compatible、ChatGPT、Codex provider 保留；缺少 `config.runtime` 的旧数据继续走 API runtime。
- API runtime 已提取，浏览器使用统一 NDJSON turn events，旧 SSE `delta`/`done` 调用仍兼容。
- 原有 localStorage 键、会话和消息格式保持兼容；修复了刷新时空表单覆盖已保存 provider 配置的问题。
- 新增最小 `claude_tmux` 前端入口、runtime 状态和 busy → stop UI。
- tmux transport 使用 argv runner；prompt 只通过 `load-buffer` stdin 进入，随后 `paste-buffer -p`、延时、Enter 和 cleanup。已 mock 测试中文、多行、Markdown、代码块、引号、`$`、反斜杠、反引号、emoji 和长文本。
- runtime registry 只持久化稳定身份/配置；busy、subscriber、活动 turn 和 stop 状态仅在内存。重启 reconcile 以 tmux session/pane metadata 为准。
- raw hook payload 只进入 `claude-ingress` 版本 adapter，再转换为 canonical frame；frame-buffer、turn-store 和 runtime 不知道 Claude 原始字段名。
- hook 请求串行、canonical frame 排序/去重、snapshot 后缀差分、final/error、单活动 turn、session missing、restart reconcile、Escape stop、`stop_unconfirmed` 和迟到 Stop 收尾均有 mock 测试。
- `/api/internal/claude-code/events` 与普通 Web API 分离，限制 loopback 并校验后端 secret；secret 不进入前端或 localStorage。
- transport hook 短超时、无 stdout、失败 fail-open。raw capture 默认关闭，只在显式开启时写入 gitignored `data/`，并设大小上限。
- Native Windows 禁用真实 tmux runtime；现有 API provider 和全部 mock 测试可继续运行。

### 尚未验证，不能写成确定事实

- Claude 登录、订阅和真实交互式 Claude Code 启动。
- 实际 `claude --version`、`tmux -V`、`uname -a`。
- 当前版本是否提供教程所述 `MessageDisplay` 或等价正文 hook。
- inline `--settings` 的实际 schema，以及原始 hook 的事件名、字段名、delta/snapshot 语义、index/final、Stop/StopFailure 和投递顺序。
- Escape 的真实中断结果与确认事件。
- 真实 tmux 创建、Claude 意外退出、backend 重启重连、登录/trust 提示和浏览器端到端闭环。

教程出现的 `MessageDisplay`、`message_id`、`index`、`delta`、`final`、`session_id`、`Stop`、`StopFailure` 目前都只是 adapter 候选输入。真实环境可用后，应开启一次临时 raw capture，发送“你好”并执行一次停止，记录原始 payload；之后只收紧 adapter 和启动配置，不重构 canonical/runtime/browser 层。

### 当前测试与下一步

收口前完整测试为 36/36 通过，其中原阶段 0 的 11 个测试全部保留并通过，没有通过修改旧预期掩盖破坏性变更。下一步不是继续编码，而是等待 Claude Code 可用；届时先采样版本与原始 hook payload，再决定最小修正。

明确仍不做：thinking、transcript thinking extraction、AskUserQuestion、xterm.js terminal、voice、diary、Telegram、OB/MCP、复杂 session manager、多 tmux runtime 和 systemd 部署。

## 1. 当前状态摘要

- 当前是一个无第三方运行时依赖的 Node.js 18+ 本地 Web 应用。
- 前端是原生 HTML/CSS/JavaScript，保留了已有的单栏聊天壳、移动端布局、多 provider 入口和浏览器本地会话。
- 后端是单文件 `server.mjs`，同时负责静态文件服务、API 转发和流式协议归一化。
- Claude API、OpenAI-compatible 中转站、ChatGPT 对应 API、Codex Responses API 已有配置入口；是否可真实调用取决于用户填写的 API Key、地址和模型名。
- “续窗”已经完成：可从旧会话生成可编辑启动包、保留旧会话、导出 JSON，并把启动包作为新会话的系统背景。
- Claude Code tmux 的应用侧模块与 mock 闭环已实现；真实 Claude/tmux 闭环因订阅和环境不可用而暂停，详见第 0 节。
- 当前存在未提交的阶段 0/阶段 1 工作树改动；不得把后续旧记录误读为当前 Git 状态。

## 2. 当前 Git 状态

检查时工作树在新增本文前是干净的：

```text
## main...origin/main [ahead 2]
```

本地最近提交：

```text
3a42dbd feat: add refined session continuation
bac60b7 feat: merge multi-model dwell chat frontend
ee3bee1 fix: ES5 rewrite, inline onclick, absolute fetch path, window.onerror
```

注意：`origin/main` 是本地已有的远端跟踪记录，本轮没有成功 fetch 网络远端，因此 `ahead 2` 不能单独证明 GitHub 网页上的真实状态。下个会话如要推送，应先安全地 fetch/核对。

该仓库由 Codex 沙箱账号创建，当前沙箱账号运行 Git 会触发 `detected dubious ownership`。只读或提交命令可针对本仓库临时使用：

```powershell
$repo = 'C:/Users/HP/Documents/Codex/2026-08-18/https-github-com-xinwithyu-dwell-on/work/chat-frontend'
git -c safe.directory="$repo" -C "$repo" status
```

不要把 `safe.directory=*` 设为全局通配符。

## 3. 当前文件与职责

```text
chat-frontend/
├─ public/
│  ├─ index.html       # 页面壳、聊天区、设置抽屉、续窗抽屉
│  ├─ style.css        # 桌面/移动端/深色样式
│  └─ app.js           # provider、会话、渲染、流式读取、续窗逻辑
├─ server.mjs          # HTTP 服务、静态资源、API 转发、SSE 归一化
├─ package.json        # 仅 npm start，无第三方依赖
├─ README.md           # 使用说明、安全边界、同步说明
├─ sync.ps1            # 暂存指定文件、提交、rebase、push
└─ HANDOFF.md          # 本交接文档
```

`sync.ps1` 已覆盖 `HANDOFF.md`、`src/`、`hooks/`、`test/`、`docs/`、`.env.example` 和 `data/.gitkeep`，但当前没有运行该脚本。

## 4. 当前前端架构

### 4.1 Provider 配置

`public/app.js` 内置四个 preset：

| id | UI 名称 | 默认协议 | 默认地址/模型 |
|---|---|---|---|
| `claude` | Claude | `anthropic` | Anthropic `/messages` |
| `relay` | 中转站 | `chat` | OpenAI-compatible `/chat/completions` |
| `chatgpt` | ChatGPT | `responses` | OpenAI `/responses` |
| `codex` | Codex | `responses` | OpenAI `/responses` |

每个 provider 的 `base`、`key`、`model`、`protocol`、`system` 保存在浏览器 `localStorage` 的 `dwell.profiles` 中。当前 provider 记录在 `dwell.provider`。

### 4.2 会话与消息

- 会话数组保存在 `localStorage` 的 `dwell.sessions`。
- 当前会话 id 保存在 `dwell.active`。
- 会话对象主要字段：`id`、`title`、`provider`、`created`、`messages`；续窗还会使用 `continuedFrom`、`continuedTo`、`continuedAt`、`bridge`。
- 消息主要字段：`role`、`content`、临时状态 `pending`。
- 所有历史和配置均只在当前浏览器；换手机/清站点数据不会自动恢复。

### 4.3 消息发送与显示

前端把当前会话历史组装为 `{ config, messages }`，POST 到 `/api/chat`。后端把不同上游协议的增量统一成 SSE：

```text
data: {"delta":"..."}

data: {"done":true}
```

前端逐段追加到最后一个 assistant 消息并重绘聊天区。渲染器会先 HTML 转义，再做很轻量的代码块、行内代码和粗体替换。

`AbortController` 已经创建，但目前没有停止按钮，也没有调用 `controller.abort()` 的用户路径；它不是完整的停止功能。

### 4.4 续窗

续窗会：

1. 过滤 `pending`、空消息和以“没接通：”开头的失败消息；
2. 提取首个任务、当前焦点、偏好/决定关键词、最近 12 条有效消息；
3. 生成最多 24,000 字的可编辑启动包；
4. 新建会话并保留原会话；
5. 新会话第一次发送时，把启动包作为 system 消息交给当前 API provider；
6. 支持导出原会话 JSON。

这只是浏览器侧的上下文搬运，不是 Claude Code 长期进程，也不能替代 tmux session。

## 5. 当前后端架构

`server.mjs` 使用 Node 内置模块：

- `GET /` 和静态路径：读取 `public/`。
- `POST /api/test`：向配置的上游发送“只回复 OK”的非流式请求。
- `POST /api/chat`：按 `config.protocol` 选择 Anthropic Messages、OpenAI Responses 或 OpenAI Chat Completions。
- 后端读取上游 SSE，抽取文本 delta，再输出统一 SSE。
- 接口地址只允许 `http:`/`https:`，请求体上限约 2 MB。
- 默认监听 `0.0.0.0:4173`，因此同一局域网手机可访问。

当前没有：provider/runtime 接口层、服务端会话库、活动 turn 管理器、tmux 控制、hook 接收器、停止接口、鉴权、自动恢复、结构化事件流、测试目录。

## 6. 已完成的功能

- 保留并整理了已有 dwell 风格聊天页面。
- 桌面端与手机端响应式布局。
- 多 provider 选择和独立配置。
- Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种上游协议。
- 中转站自定义 base URL、模型名和 API Key。
- 流式文字进入现有聊天气泡。
- 浏览器本地会话列表和历史保存。
- 系统提示配置。
- API 连通测试。
- 续窗启动包、编辑、会话关联和 JSON 导出。
- Node 静态服务监听局域网，手机可通过电脑 IPv4 访问。
- `sync.ps1` 基础 Git 同步脚本。

## 7. 尚未完成的功能

### 第一优先级

- 把“provider（模型入口）”与“runtime（运行方式）”分离，同时保持现有 API provider 行为。
- 新增 Claude Code tmux runtime。
- 创建、登记、发现、连接长期 tmux session。
- 安全地把单行/多行消息送入指定 tmux session。
- 通过 Claude Code hooks 把回复流式送入现有聊天 UI。
- 支持 Escape 停止当前回复，但不杀 Claude Code/tmux session。
- 后端/前端重启后 tmux session 继续存活；后端恢复登记和连接。
- 为 CLAUDE.md、MCP 配置和未来 OB 集成预留配置接口。
- 用现有 Codex/中转站 API 保持端到端前端测试能力。
- 补自动化测试和模拟 hook/tmux 测试。

### 第二优先级

- `AskUserQuestion` 结构化问题卡片、回答/拒绝/超时/取消状态机。

### 暂缓

- thinking 展示和 transcript JSONL 深度解析。
- 内置 terminal（xterm.js、WebSocket、node-pty）。
- 复杂工具调用 UI。

## 8. 已确定的 Claude Code tmux 接入方案

### 8.1 原则

- 不推倒前端壳子，不移除现有中转站、ChatGPT/Codex/Claude API provider。
- Claude Code 以交互式 CLI 长驻 tmux；不能把最终架构写成每条消息执行一次 `claude -p`。
- tmux/Claude Code 的生命周期独立于 Node Web 后端；关闭或重启后端不得清理 session。
- 聊天正文唯一主来源是 Claude Code hook POST。`tmux capture-pane` 只用于启动弹窗、登录/信任提示、输入就绪、卡死诊断和崩溃文本判断，绝不抓正文充当回复流。
- transcript JSONL 和 statusLine 是辅助通路，可用于以后补 thinking、上下文用量、`stop_reason` 和 hook 丢失兜底，不是第一阶段正文主通路。

### 8.2 后端分层

建议把当前 `relay()` 提取为 API runtime，并新增统一 runtime 接口：

```text
浏览器聊天 UI
      │
      ▼
统一 Chat/Turn API
      │
      ├─ api runtime
      │    ├─ anthropic
      │    ├─ chat-completions
      │    └─ responses（Codex/其他 OpenAI-compatible）
      │
      └─ claude-code-tmux runtime
           ├─ runtime registry
           ├─ tmux controller
           ├─ active turn store
           ├─ hook ingress
           └─ NDJSON event stream
```

建议统一浏览器收到的事件至少包含：

- `turn_started`
- `segment_delta`
- `segment_done`
- `turn_stopped`
- `turn_error`
- `turn_done`
- 以后追加 `question`、`question_resolved`、`status`、`thinking_delta`。

PDF 推荐聊天响应使用 `application/x-ndjson`，因为需要携带多种事件，而不仅是文字 delta。迁移时可以让 API runtime 把现有上游 SSE 转成统一 NDJSON；如担心一次改动过大，可让前端解析器短期同时兼容旧 SSE 和新 NDJSON，但服务端内部事件模型要统一。

### 8.3 Runtime、会话和 turn 的身份

必须分清三种 id：

- 浏览器 `chatSessionId`：当前 UI 会话。
- 服务端 `runtimeId`：一个 Claude Code tmux 实例的稳定登记 id。
- `turnId`：一次用户输入到一次完成/停止的回合 id。

runtime registry 持久化 `runtimeId`、tmux session 名、workspace root、Claude session id、模型/工具/MCP 配置、状态和更新时间。活动 turn 可以以内存为主，但要有最小事件账本，便于后端重启后识别迟到 hook 和恢复状态。

同一个 tmux runtime 第一阶段只允许一个活动 turn；并发发送返回 409，不把两条输入同时塞进一个 TUI。

### 8.4 tmux 创建和长期存活

- 后端启动时运行 `tmux list-sessions`，将仍存在的 session 与 registry 对账，而不是重新启动 Claude Code。
- 创建 session 时在指定 workspace root 启动交互式 `claude`，通过单次会话的 `--settings` 注入 hooks，避免污染用户手工打开的 Claude Code。
- `--system-prompt`/`--system-prompt-file`、`--append-system-prompt`、`--tools`、`--allowedTools`、`--mcp-config` 作为 runtime 配置字段保留，不写死。
- CLAUDE.md 由 workspace/project 自己加载；runtime registry 只记录 workspace 和可选 prompt/config 引用，不复制其内容进浏览器。
- 未来 OB 以独立 context provider/hook 扩展点接入，不耦合 tmux 送信模块。
- Linux systemd 部署时需避免服务重启杀掉 tmux 子进程；PDF 给出的基本方案是 `KillMode=process`。更强隔离可使用独立 tmux socket、独立 unit/slice 和 keeper session。

### 8.5 安全送信

不能把多行文本逐键 `send-keys`，也不能拼进 shell 命令。建议：

1. 校验 `runtimeId`，从服务端 registry 取 session 名，绝不接受前端随意传入 shell 片段；
2. session 名使用严格字符集并通过参数数组传给 `execFile`；
3. workspace root 做真实路径解析和 allowlist 校验；
4. 用 `tmux load-buffer -b <临时名> -` 从 stdin 写入原文，并把 `\r\n`/`\r` 统一为 `\n`；
5. 用 `tmux paste-buffer -p -b <临时名> -t <session>` 按 bracketed-paste 语义粘贴；
6. 等待约 900 ms（做成配置项，最小 250 ms）；
7. 再单独 `tmux send-keys -t <session> Enter`；
8. 最后删除临时 buffer。

这样换行仍是粘贴内容，不会被 CLI 当成多次提交，特殊字符也不会进入 shell 解释。

### 8.6 Hook 回传和顺序恢复

- 通过启动时的 inline `--settings` 注册 Claude Code hooks。
- 第一阶段至少处理 `MessageDisplay`、`Stop`、`StopFailure`、`SessionStart`；`UserPromptSubmit` 为动态上下文预留；工具类 hooks 先只留事件类型，不做复杂 UI。
- hook 脚本从 stdin 读取官方 JSON，POST 到 `/api/internal/claude-code/*`。
- 内部端点只接受 loopback 来源并要求随机 secret header；限制 body 大小并做 schema 校验；成功/失败都必须返回 JSON。
- transport hook 永远不能阻塞 Claude 的正常输出：失败时 fail-open、记录日志并正常退出。
- 同一个 turn 的事件先进入串行 promise chain；再按 `index` 做 reorder buffer，去重迟到/重复帧，等待缺口。
- `MessageDisplay` 可能给累计文本或增量文本。若新文本以前文为前缀，只广播新增后缀；冲突只记日志，不把重复/冲突正文塞进 UI。
- 首行应做短暂缓冲，以过滤控制行；浏览器只接收整理后的 `segment_delta`。
- `Stop` 到达但该 turn 没有正文时，不可默认为空成功，应从 transcript JSONL 尝试恢复最后一条本回合 assistant 正文，并标记 `contentRecovered`。
- 事件另写有大小上限的 append-only JSONL receipt ledger/raw tap，用于对账；日志失败不得影响消息主链路。

重要兼容风险：PDF 使用的 Claude Code 版本和 `MessageDisplay`/`StopFailure` 字段可能比实际安装版本新。开始实现前必须运行 `claude --version`，再以该版本官方 hooks 文档和一次原始事件采样为准；不要只凭 PDF 猜 schema。代码应把 hook event parser 做成版本可容错的 adapter。

### 8.7 停止当前回复

- 前端 busy 时发送按钮变成暂停键；busy 状态按 Enter 也调用停止，不发送新消息。
- `POST /api/chat/stop` 携带稳定的 `runtimeId`/`turnId`，服务端验证其确实属于当前活动 turn。
- 若没有活动 turn，返回 404。
- 第二阶段若存在 AskUserQuestion，先把该 turn 的 pending question 置为 cancelled。
- 对指定 tmux session 执行 `send-keys Escape`，不能发送 Ctrl-C；Ctrl-C 可能结束进程和长期会话。
- 随后终止本地轮询/超时控制器，但不杀 tmux 和 Claude Code。
- 最多等待约 2 秒确认 runtime inactive；超时返回“已请求暂停，但尚未确认”，不自动重试。
- 停止是请求，不是必然成功；UI 必须保留已经收到的部分文字并显示明确状态。

### 8.8 重启与恢复

- 浏览器重启：浏览器会话仍来自 localStorage；tmux runtime 由服务端 registry 重新映射。
- 后端重启：重新扫描 tmux sessions；不发送 kill，不把 runtime 当作需清理的 child process。
- hook 在后端短暂不可用时 fail-open；receipt/补偿层通过 transcript 尝试补回本回合正文。
- 对“后端重启时仍在等待的 AskUserQuestion”，第二阶段应直接标为 failed，而不是假装恢复一个已经断开的长 HTTP 请求。

### 8.9 AskUserQuestion（第二优先级）

使用 `PreToolUse` 且 matcher 仅匹配 `AskUserQuestion`：

- hook 长 POST 到内部接口并等待；服务端创建持久 pending question，向聊天流发送 `question` 卡片事件。
- 用户 answer/decline 后，服务端 resolve pending promise。
- answered 时 hook 输出 `permissionDecision: allow` 和完整 `updatedInput`；必须保留原 `questions`，`answers` 的 key 必须是原问题全文，多选值保持数组。
- 状态机：`pending -> answered | declined | expired | cancelled | failed`。
- 以 `toolUseId` 幂等；相同 id/相同 payload 返回同一问题卡，不同 payload 返回 409。
- 答案必须按服务端持久化的原始选项校验，不信任前端。
- 超时建议：用户 600s、脚本 watchdog 615s、Claude hook 630s、turn deadline 动态延长。
- 此 hook 必须 fail-closed：异常时明确 deny，避免终端里出现网页用户永远看不到的问题面板。

## 9. 建议新增/修改的文件

为避免把所有职责继续堆进 `server.mjs`，建议以“小模块、不过度框架化”为原则：

```text
server.mjs                         # 保留入口；改为路由与模块装配
src/config.mjs                     # 端口、内部 secret、路径、tmux 参数
src/http.mjs                       # JSON body、错误、NDJSON 输出工具
src/providers/api-runtime.mjs      # 提取现有 Anthropic/OpenAI 转发逻辑
src/runtimes/runtime-registry.mjs  # runtime 配置持久化和发现
src/runtimes/claude-tmux.mjs       # 创建/检测/送信/Escape，不处理 UI
src/turns/turn-store.mjs           # 活动 turn、AbortController、订阅者
src/turns/frame-buffer.mjs         # index 排序、去重、后缀差分
src/hooks/claude-ingress.mjs       # 内部 hook 路由、验证和事件转换
hooks/claude/post-event.mjs        # 通用 hook POST 客户端
hooks/claude/message-display.mjs   # 正文 hook 入口
hooks/claude/session-events.mjs    # Stop/StopFailure/SessionStart
data/.gitkeep                      # 目录占位；真实 registry/log 不提交
test/frame-buffer.test.mjs
test/api-runtime.test.mjs
test/claude-tmux.test.mjs
test/chat-stream.test.mjs
.env.example                       # 不含真实 secret
.gitignore                         # 忽略 data 状态、日志、secret
docs/claude-tmux-runtime.md        # 部署和故障恢复说明
```

现有文件的改动范围：

- `public/app.js`：把 provider 配置和 runtime 配置分开；提取流式事件 reducer；增加 stop；保留现有会话/续窗/渲染。
- `public/index.html`：增加 Claude Code tmux provider/runtime 设置字段和暂停按钮状态，不重做页面。
- `public/style.css`：只补 runtime 状态、暂停态和后续问题卡样式。
- `server.mjs`：抽出旧 relay，接入统一路由和 runtime registry。
- `package.json`：增加 `test`/开发脚本；第一阶段尽量继续只用 Node 内置模块。
- `README.md`：补 Linux/WSL 部署、安全和恢复说明。
- `sync.ps1`：改为覆盖所有新源码/文档，避免漏同步。

文件名可在实现时微调，但职责边界不应重新揉回单文件。

## 10. 实施顺序与验收点

### 阶段 0：基线保护

1. 为现有 API 请求构造、三种流式解析和静态服务补测试。
2. 记录当前浏览器数据格式，保证升级不清空会话。
3. 用现有 Codex/中转站配置验证旧路径。

验收：现有 provider 的设置、测试、发送、流式显示和续窗行为不变。

### 阶段 1：Provider/Runtime 解耦

1. 把 `relay()` 提取成 `api-runtime`。
2. 定义统一 turn event schema 和 NDJSON writer/parser。
3. API runtime 将现有 SSE 转为统一事件；前端使用一个事件 reducer。

验收：不需要 Claude 订阅，也能通过 Codex/中转站完成真实端到端流式对话；UI 外观不变。

### 阶段 2：tmux 控制与持久 runtime

1. 增加 registry、session 名/路径校验、tmux discover/create/status。
2. 实现 `load-buffer -> paste-buffer -p -> delay -> Enter`。
3. 实现 Escape 中断和“一 session 一活动 turn”。
4. 用 fake tmux 可执行文件记录参数，做离线安全测试。

验收：在没有 Claude 订阅时，模拟交互式进程也能验证多行输入、session 复用、后端重启后重新发现和 Escape 不杀 session。

### 阶段 3：Hook 主通路

1. 启动 session 时注入 inline hooks。
2. 增加 loopback + secret 的内部端点。
3. 完成按 turn 串行、frame reorder、去重、后缀差分、NDJSON 推送。
4. 用 fixture 模拟乱序、重复、累计文本、Stop 丢正文和 hook 失败。

验收：完全不抓 pane 正文，仅靠模拟 hook 事件即可让回复流式进入现有聊天气泡。

### 阶段 4：前端 tmux provider 与停止体验

1. 设置页新增 Claude Code tmux，配置 runtime/workspace/session。
2. 会话绑定 `runtimeId`。
3. busy 时发送键切换为暂停；Enter 停止，Shift+Enter 仍换行。
4. 展示 connected/busy/stopped/error/reconnecting 状态。

验收：API providers 和 tmux runtime 可以并存切换；停止只终止本回合，不终止长期 session。

### 阶段 5：恢复与加固

1. receipt ledger、日志轮转、transcript 最小兜底。
2. 后端重启恢复、迟到事件、断流重连。
3. 版本能力检测、错误诊断和部署文档。

### 阶段 6：AskUserQuestion

按第 8.9 节实现，独立验收；thinking、terminal、复杂工具 UI 继续不做。

## 11. 离线测试方案

Claude Code 订阅当前不能用于测试，因此第一阶段不能依赖真实 Claude：

- 继续用现有 Codex/中转站验证浏览器到统一聊天流的真实路径。
- fake API server 分别模拟 Anthropic、Responses、Chat Completions 的分片和错误。
- fake tmux 程序记录 argv/stdin，验证没有 shell 拼接，换行和特殊字符原样进入 buffer。
- fake interactive CLI 在 tmux 中回显状态，验证 session 长驻和 Escape；若环境没有 tmux，则先用进程 adapter fixture。
- hook fixtures 模拟 `MessageDisplay` 乱序 index、重复帧、累计文本、缺帧、Stop、StopFailure。
- 重启测试：启动 runtime、重启 Node、扫描 registry/session、确认 tmux 进程仍在。
- 浏览器手测：桌面与手机分别验证发送、断网、停止、切 provider、刷新、续窗。

## 12. 当前运行方式与本轮检查结果

运行：

```powershell
cd 'C:\Users\HP\Documents\Codex\2026-08-18\https-github-com-xinwithyu-dwell-on\work\chat-frontend'
npm start
```

访问：

- 本机：`http://127.0.0.1:4173/`
- 手机：同一 Wi-Fi 下访问 `http://电脑局域网IPv4:4173/`

本轮实际执行并通过：

```text
node --check server.mjs       通过
node --check public/app.js    通过
临时端口 127.0.0.1:4187 启动  通过
GET /                         200，包含 <title>dwell</title>
GET /not-found                404
```

未执行真实模型请求，因为没有使用用户 API Key。

## 13. 已知问题与风险

1. **tmux 环境未就绪**：当前 Windows 找不到原生 `tmux`；`wsl.exe --status` 在本次沙箱中返回 `E_ACCESSDENIED`。推荐让 Node 后端、tmux 和 Claude Code 全部运行在同一个 WSL2/Linux 环境。不要默认采用“Windows Node 通过 `wsl.exe bash -lc` 拼命令控制 tmux”，那会扩大路径、转义、权限和存活问题。
2. **Git ownership**：普通 Git 命令可能因 dubious ownership 失败，见第 2 节。
3. **远端状态未实时核验**：本地显示 ahead 2，但没有成功 fetch 后重新比较。
4. **无服务端鉴权**：服务监听 `0.0.0.0`，适合可信局域网，不可直接暴露公网。新增 tmux runtime 后风险更高，必须限制 workspace、runtime 操作和内部 hook 路由。
5. **配置/聊天只存 localStorage**：清站点数据即丢失；手机和电脑不共享。
6. **API Key 在浏览器保存**：虽不落服务端，仍会随请求传到本机后端；同机恶意脚本或浏览器环境可能读取。当前不是多用户系统。
7. **上游取消不完整**：浏览器断开后，后端没有显式把 abort 传给上游 fetch；未来 API runtime 应处理请求关闭。
8. **SSE 解析较简化**：逐行解析只识别 `data:`，没有完整处理所有 SSE 边界；统一事件层应补测试。
9. **请求体超限处理粗糙**：超过约 2 MB 直接 `req.destroy()`，调用方可能拿不到结构化 413。
10. **输入 URL 可形成 SSRF 面**：虽然只允许 http/https，但未禁止 loopback、内网元数据地址等。个人本机模式可接受但必须在文档中明确；若未来多用户/公网部署要做 allowlist。
11. **无删除/重命名会话 UI**：当前会话只能新建和续窗，不能管理历史。
12. **轻量 Markdown 非完整解析器**：目前适合基本显示，不支持完整 GFM；不要在 tmux 接入时顺手扩大范围。
13. **`sync.ps1` 会漏新文件**：见第 3 节，实施前先修。
14. **Claude hook schema 版本敏感**：必须按实际 `claude --version` 采样验证，尤其是 PDF 中的 `MessageDisplay`、`StopFailure`、`turn_id`、`index`、`delta`、`final`。

## 14. 下一会话的第一批任务

下一个 Codex 会话应先做以下工作，并继续遵守“不要推倒重做”：

1. 读取本文件、`README.md`、`server.mjs`、`public/app.js`、`public/index.html`、`public/style.css`。
2. 确认部署选择：推荐 WSL2/Linux 同侧运行 Node + tmux + Claude Code；若用户坚持 Windows Node 跨 WSL 控制，必须先单独设计边界。
3. 检查实际 `claude --version`、`tmux -V` 和该版本 hooks 原始事件；当前机器未能在本沙箱完成这一步。
4. 先提交/备份本交接文档，并核对 GitHub 远端真实提交状态。
5. 从“阶段 0：基线保护”开始，不要直接写 tmux 大模块。
6. 第一笔业务改动只做 API runtime 提取和测试，确保 Codex/中转站仍能工作。
7. 每阶段单独提交并给出可复现验收结果；不要等全部完成才测试。

## 15. 本轮明确没有做的事

- 没有实现或启动 Claude Code tmux runtime。
- 没有修改 `server.mjs`、`public/*`、`package.json`、`README.md` 或 `sync.ps1`。
- 没有安装依赖。
- 没有使用或保存用户 API Key。
- 没有推送 GitHub。
- 没有继续开发 AskUserQuestion、thinking、terminal 或工具 UI。
