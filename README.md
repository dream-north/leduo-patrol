# 乐汪队 / leduo-patrol

一个部署在服务器上的 Web 控制台，用来通过 ACP 驱动 Claude Code，并在浏览器里接收执行流、工具调用和权限确认。

## 当前实现

- Web 控制台可向 Claude Code 发送文本指令
- 可在同一页面中并行管理多个服务器目录会话
- 可在网页中指定服务器目录，并在该目录启动独立 Claude Code 会话
- 会话列表、历史时间线和当前详情会持久化到服务器用户目录，并在刷新后自动恢复
- 后端通过 `@zed-industries/claude-code-acp` 启动 Claude Code ACP agent
- 浏览器可实时看到 Claude 的消息、工具调用、计划和错误
- 需要确认的工具调用会在右侧面板弹出，支持在网页中批准或拒绝
- 提供 VS Code Remote SSH 按钮，可直接跳转到远程工作区
- 每个目录会话有独立的消息流、忙碌状态和待确认列表
- 创建会话时可选择默认模式，发送消息时也可临时覆盖模式

## 环境要求

- Node.js 22+
- 已能正常运行 Claude Code
- 服务器环境里已配置 `ANTHROPIC_API_KEY`

## 启动

```bash
npm install
npm run dev
```

默认情况下：

- 前端开发服务运行在 `http://localhost:5173`
- 后端服务运行在 `http://localhost:3001`

生产构建：

```bash
npm run build
npm start
```

## 可选环境变量

```bash
PORT=3001
LEDUO_PATROL_APP_NAME=乐汪队
LEDUO_PATROL_WORKSPACE_PATH=/absolute/workspace/path
LEDUO_PATROL_ALLOWED_ROOTS=/absolute/workspace/path,/another/allowed/root
LEDUO_PATROL_SSH_HOST=user@example-host
LEDUO_PATROL_SSH_PATH=/absolute/workspace/path
LEDUO_PATROL_VSCODE_URI=vscode://vscode-remote/ssh-remote+user@example-host/absolute/workspace/path
ANTHROPIC_API_KEY=sk-...
```

如果未设置 `LEDUO_PATROL_VSCODE_URI`，但设置了 `LEDUO_PATROL_SSH_HOST`，服务会自动生成一个 VS Code Remote SSH 链接。
如果设置了 `LEDUO_PATROL_ALLOWED_ROOTS`，网页中只能连接这些根目录之下的路径；未设置时默认只允许 `LEDUO_PATROL_WORKSPACE_PATH`。

## 状态持久化

服务会把会话状态写到用户目录下：

```bash
~/.leduo-patrol/state.json
```

其中包含：

- 管理中的会话列表
- 每个会话的工作目录、模式、时间线和最近状态
- 浏览器刷新后用于恢复界面的数据

## 架构

- `server/index.ts`: Express + WebSocket 服务
- `server/acp-session.ts`: ACP client bridge，负责启动 Claude Code ACP agent
- `src/App.tsx`: 浏览器控制台

## 已知限制

- 当前只实现了 Claude Code
- 还没有用户鉴权
- 目前终端能力没有暴露给 ACP client，先聚焦网页指令和确认流
