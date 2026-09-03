# dwell · 多模型前端

一个受 `dwell-on-something` 启发的本地优先聊天前端，可接：

- Claude / Claude API（Anthropic Messages）
- OpenAI-compatible 中转站（Chat Completions 或 Responses）
- ChatGPT 对应 API 模型（默认 `chat-latest`）
- Codex 模型（默认 `gpt-5.6-sol`，Responses API）

## 续窗

长会话右上角提供“续窗”。它会在浏览器本地过滤失败消息，提取当前任务、偏好边界、关键决定和最近 12 条有效消息，生成一份可编辑启动包，再创建轻量新会话。原会话不会覆盖，并可先导出为 JSON；启动包会作为系统背景随新会话的第一条消息发送给当前模型。

## 启动

需要 Node.js 18 或更高版本，无需安装依赖：

```bash
npm start
```

电脑浏览器打开 <http://127.0.0.1:4173>。手机与电脑连接同一 Wi-Fi 后，访问 `http://电脑的局域网IPv4:4173`；Windows 下可通过 `ipconfig` 查看 IPv4 地址。

## 同步到 GitHub

在 PowerShell 中运行 `./sync.ps1`，脚本只会暂存本项目的前端、服务端入口和说明文件，然后提交、拉取远端更新并推送到 `main`。

## 中转站填写

OpenAI 兼容站通常选择 `OpenAI Chat Completions`，接口地址填到域名或 `/v1` 均可。Anthropic 兼容站选择 `Anthropic Messages`。不同站点的模型名不统一，按站点文档填写。

## 安全边界

API Key 存在当前设备浏览器的 `localStorage`，请求通过电脑上的代理转发，用于个人局域网运行。服务会监听局域网接口，请勿在路由器中把 4173 端口映射到公网，也不要在不可信 Wi-Fi 上运行。ChatGPT Plus/Pro 等订阅不是 OpenAI API 额度，也不能直接作为 API Key 使用。

对话与配置都只保存在当前浏览器。清理站点数据会一并删除。

## 致谢与许可提醒

视觉与产品语气参考了 [xinwithyu/dwell-on-something](https://github.com/xinwithyu/dwell-on-something)。原仓库采用 PolyForm Noncommercial License 1.0.0；若继续直接复用其内容，请遵守原项目的非商业许可。
