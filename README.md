# 乐汪队 / leduo-patrol

一个部署在服务器上的 Web 控制台，用来通过 ACP 驱动 Claude Code，并在浏览器里接收执行流、工具调用和权限确认。

## 功能概览

- 支持在同一页面并行管理多个目录会话，每个会话拥有独立时间线、忙碌状态、权限确认与模式状态。
- 支持创建新会话时指定默认模式（如 default / plan / acceptEdits 等），发送消息时也可临时覆盖本次模式。
- 会话状态支持服务端持久化与自动恢复：刷新页面后可继续查看会话列表、时间线窗口与基础状态。
- 支持按窗口展示时间线并分页加载历史记录，避免长会话时前端一次性加载过多数据。
- 工具调用与计划内容会被整理成更可读的时间线条目，支持在详情弹窗查看完整内容。
- Agent 与计划详情支持 Markdown 渲染（包含标题、列表、代码块、行内强调和链接）。
- 待确认的工具调用会集中展示在右侧面板，可直接在 Web 界面批准/拒绝。
- 提供 VS Code Remote SSH 快捷入口（通过环境变量配置）。
- 支持目录浏览接口，并限制在允许的根目录内，避免越权访问。
- 支持会话取消、关闭、恢复与错误态反馈，便于长期运行。

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

- 前端开发服务运行在 `http://localhost:5173`（已监听 `0.0.0.0`，可远程访问）
- 后端服务运行在 `http://localhost:3001`

> 说明：`npm run dev -- --host 0.0.0.0` 不会把参数透传到 `vite`，因为该命令实际启动的是 `concurrently`。本项目已在 `vite.config.ts` 中固定 `host: "0.0.0.0"`，直接 `npm run dev` 即可。

生产构建：

```bash
npm run build
npm start
```

## 测试

```bash
npm test
npm run check
```

当前仓库已提供基于 Node.js 内置 test runner（通过 `tsx --test` 执行）的单元测试，覆盖前端关键纯函数（目录边界、工具摘要、计划提取）以及后端关键逻辑（会话历史窗口、工作区路径安全校验、错误格式化）。

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
LEDUO_PATROL_ACCESS_KEY=your-fixed-key
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
- 每个会话的工作目录、模式与最近状态
- 浏览器刷新后用于恢复界面的基础数据

## 架构

- `server/index.ts`: Express + WebSocket 服务
- `server/acp-session.ts`: ACP client bridge，负责启动 Claude Code ACP agent
- `server/session-manager.ts`: 会话生命周期、时间线窗口、持久化与权限流管理
- `src/App.tsx`: 浏览器控制台

## 访问校验 Key

服务启动时会自动生成一次性访问 key，并在控制台打印可直接打开的地址，例如：

```bash
Access URL: http://localhost:3001/?key=xxxxxxxx
```

浏览器访问、前端 API 请求和 WebSocket 连接都需要携带这个 `key` 参数；未携带或错误会返回 `401 Unauthorized`。

如需固定 key，可设置：

```bash
LEDUO_PATROL_ACCESS_KEY=your-fixed-key
```

## 已知限制

- 当前只实现了 Claude Code
- 目前终端能力没有暴露给 ACP client，先聚焦网页指令和确认流
