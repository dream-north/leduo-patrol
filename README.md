# 乐多汪汪队 / leduo-patrol

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

- 前端开发服务运行在自动探测到的可访问内网 IP（优先 `bond* / eth* / ens* / enp*` 网卡）上
- 后端服务运行在 `PORT`（默认 `3001`，端口冲突时会自动递增寻找可用端口）
- 启动日志只打印一个推荐访问地址，避免 `br-*`、`veth*` 等虚拟网卡地址干扰

- 开发模式下 `Access URL` 会优先打印前端 Web 端口（默认 `5173`，可通过 `LEDUO_PATROL_WEB_PORT` 指定），避免误用 server 端口

> 说明：`npm run dev -- --host 0.0.0.0` 不会把参数透传到 `vite`，因为该命令实际启动的是 `concurrently`。本项目会在 `vite.config.ts` 内自动选择一个可访问的内网地址用于开发访问。

生产构建：

```bash
npm run build
npm start
```

> 开发者向的编程与验证测试技巧请见 `AGENTS.md`。

## 可选环境变量

```bash
PORT=3001
LEDUO_PATROL_WEB_PORT=5173
LEDUO_PATROL_APP_NAME=乐多汪汪队
LEDUO_PATROL_WORKSPACE_PATH=/absolute/workspace/path
LEDUO_PATROL_ALLOWED_ROOTS=/absolute/workspace/path,/another/allowed/root
LEDUO_PATROL_SSH_HOST=user@example-host
LEDUO_PATROL_SSH_PATH=/absolute/workspace/path
LEDUO_PATROL_VSCODE_URI=vscode://vscode-remote/ssh-remote+user@example-host/absolute/workspace/path
ANTHROPIC_API_KEY=sk-...
LEDUO_PATROL_ACCESS_KEY=your-fixed-key
LEDUO_PATROL_AGENT_BIN=/absolute/path/to/claude-code-acp
```

如果未设置 `LEDUO_PATROL_VSCODE_URI`，但设置了 `LEDUO_PATROL_SSH_HOST`，服务会自动生成一个 VS Code Remote SSH 链接。  
如果设置了 `LEDUO_PATROL_ALLOWED_ROOTS`，网页中只能连接这些根目录之下的路径；未设置时默认只允许启动命令所在目录。
如果未设置 `LEDUO_PATROL_WORKSPACE_PATH`，默认工作目录为启动命令所在目录（`process.cwd()`），并在启动日志中提示如何通过环境变量修改。
如果未设置 `LEDUO_PATROL_ALLOWED_ROOTS`，默认允许根目录同样为启动命令所在目录，并会在启动日志中提示可配置项。

## 状态持久化

服务会把会话状态写到用户目录下：

```bash
~/.leduo-patrol/state.json
```

其中包含：

- 管理中的会话列表
- 每个会话的工作目录、模式与最近状态
- 浏览器刷新后用于恢复界面的基础数据

## 访问校验 Key

服务启动时会自动生成一次性访问 key，并在控制台打印可直接打开的地址。

- 开发模式（`npm run dev`）下，`Access URL` 默认指向 Web 端口（默认 `5173`）。
- 生产模式（`npm start`）下，Web 由同一个 Express 服务静态托管，因此不会出现独立的 Web 监听端口；`Access URL` 会指向 server 端口。若未找到打包后的 `dist/web` 资源，服务会给出错误提示页与启动日志提示。

浏览器访问、前端 API 请求和 WebSocket 连接都需要携带这个 `key` 参数；未携带或错误会返回 `401 Unauthorized`。

前端页面在检测到 URL 缺少 `key` 或 `key` 失效时，会先展示一个 key 输入页，粘贴后可直接进入控制台。

如需固定 key，可设置：

```bash
LEDUO_PATROL_ACCESS_KEY=your-fixed-key
LEDUO_PATROL_AGENT_BIN=/absolute/path/to/claude-code-acp
```

## 已知限制

- 当前只实现了 Claude Code
- 目前终端能力没有暴露给 ACP client，先聚焦网页指令和确认流

## UI 演示（SubAgent 树状折叠）

可在 URL 上附加 `demo=subagent-tree` 使用前端模拟数据快速查看树状折叠效果：

```bash
http://<host>:5173/?key=<access-key>&demo=subagent-tree
```

该参数只影响前端展示，用于演示 Task/SubAgent 输出的缩进、分组与折叠交互。


## 打包并发布为 npm 包

可以把本项目作为一个可安装的 Node 服务发布：

```bash
npm run build
npm pack
```

`npm pack` 会生成一个 `.tgz` 包，其他人可以这样安装并运行：

```bash
npm install -g ./leduo-patrol-1.0.0.tgz
leduo-patrol
```

如果要发布到 npm registry：

```bash
npm login
npm publish
```

建议发布前先检查打包内容：

```bash
npm pack --dry-run
```
