# dwell · 多模型前端

一个受 `dwell-on-something` 启发的本地优先聊天前端，可接：

- Claude / Claude API（Anthropic Messages）
- OpenAI-compatible 中转站（Chat Completions 或 Responses）
- ChatGPT 对应 API 模型（默认 `chat-latest`）
- Codex 模型（默认 `gpt-5.6-sol`，Responses API）
- Linux/WSL/VPS 中长期运行的交互式 Claude Code tmux runtime（默认关闭）
- Ombre Brain Memory Dashboard（浏览器经 Node 后端只读访问）

## 续窗

长会话右上角提供“续窗”。它会在浏览器本地过滤失败消息，提取当前任务、偏好边界、关键决定和最近 12 条有效消息，生成一份可编辑启动包，再创建轻量新会话。原会话不会覆盖，并可先导出为 JSON；启动包会作为系统背景随新会话的第一条消息发送给当前模型。

## 启动

需要 Node.js 18 或更高版本，无需安装依赖：

```bash
npm start
```

电脑浏览器打开 <http://127.0.0.1:4173>。手机与电脑连接同一 Wi-Fi 后，访问 `http://电脑的局域网IPv4:4173`；Windows 下可通过 `ipconfig` 查看 IPv4 地址。

## 同步到 GitHub

在 PowerShell 中运行 `./sync.ps1`，脚本会暂存本项目已存在的前端、服务端、`src/`、`hooks/`、`test/`、`docs/` 和项目配置文件，然后提交、拉取远端更新并推送到 `main`。运行前仍应检查工作树，确认没有不希望同步的项目文件。

## 测试与流式协议

运行 `npm test` 执行 Node 内置测试，无需安装第三方依赖。测试覆盖现有 provider 请求、流式聊天、续窗和浏览器本地数据格式。

浏览器通过 `/api/chat` 请求 `application/x-ndjson`，接收统一的 turn 事件；未声明该格式的旧客户端仍会收到原有 SSE `delta`/`done` 数据，便于平滑兼容。

## Claude Code tmux runtime

tmux runtime 与现有 API provider 并存，只在 Linux/WSL/VPS 上显式启用。它向长期存在的交互式 Claude Code 发送当前一条新消息，不会每轮执行 `claude -p`，也不会把浏览器历史重新灌入 Claude。

当前 Windows 环境可以运行全部 mock 测试，但不会尝试模拟或启动 tmux。启用前请阅读 [部署与采样说明](docs/claude-tmux-runtime.md)，并在目标环境核对实际 `claude --version`、`tmux -V` 和 hook payload。未经实测的 hook 字段只存在于版本 adapter，不进入核心 runtime。

## Ombre Brain Memory Dashboard

侧栏“记忆”打开原生 Memory 页面。浏览器只访问本项目的 `/api/ombre-dashboard/*`；Dashboard 密码、session cookie 和可选 Cloudflare Access service token 全部只存在 Node 环境。localhost 只用于最短真实验通，正式目标是 Node 后端经 cloudflared/Cloudflare Zero Trust 访问 OB。

配置项和真实验证边界见 [Ombre Dashboard 说明](docs/ombre-dashboard.md)。Dashboard API 与未来 Claude Code 使用的 OB MCP 是两条独立通路；当前不会启动 Claude Code。

## 中转站填写

OpenAI 兼容站通常选择 `OpenAI Chat Completions`，接口地址填到域名或 `/v1` 均可。Anthropic 兼容站选择 `Anthropic Messages`。不同站点的模型名不统一，按站点文档填写。

## 安全边界

API Key 存在当前设备浏览器的 `localStorage`，请求通过电脑上的代理转发，用于个人局域网运行。服务会监听局域网接口，请勿在路由器中把 4173 端口映射到公网，也不要在不可信 Wi-Fi 上运行。ChatGPT Plus/Pro 等订阅不是 OpenAI API 额度，也不能直接作为 API Key 使用。

对话与配置都只保存在当前浏览器。清理站点数据会一并删除。

## 致谢与许可提醒

视觉与产品语气参考了 [xinwithyu/dwell-on-something](https://github.com/xinwithyu/dwell-on-something)。原仓库采用 PolyForm Noncommercial License 1.0.0；若继续直接复用其内容，请遵守原项目的非商业许可。
