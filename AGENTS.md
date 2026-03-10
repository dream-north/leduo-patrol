# AGENTS.md

本文件面向在本仓库内进行开发/调试的 Agent 或工程师。
用户可见介绍、部署与使用说明请优先查看 `README.md`。

## 编程与代码定位技巧

- 主要入口：
  - `server/index.ts`: Express + WebSocket 服务入口
  - `server/acp-session.ts`: ACP client bridge，负责启动 Claude Code ACP agent
  - `server/session-manager.ts`: 会话生命周期、时间线窗口、持久化与权限流管理
  - `src/App.tsx`: 浏览器控制台主界面
- 前端 `npm run dev` 实际由 `concurrently` 启动前后端；`npm run dev -- --host 0.0.0.0` 不会透传到 vite。

## Demo（SubAgent 树状折叠）维护约定

> 该部分是开发规范；用户向说明不要放在 `README.md`，统一维护在 `AGENTS.md`。

### 1) 使用方式

- 通过 URL 参数启用：`demo=<preset>`
- 当前预设：
  - `subagent-tree`：时间线树状折叠演示
  - `git-diff`：Diff 列表与文件级 Diff 演示
- 示例：

```bash
http://<host>:5173/?key=<access-key>&demo=subagent-tree
http://<host>:5173/?key=<access-key>&demo=git-diff
```

- 该参数只影响前端展示（注入 demo 会话），不影响真实后端会话数据。

### 2) Demo 数据编写规范

- 代码位置：`src/App.tsx` 的 `buildDemoFixtures(...)`（统一维护入口）。
- 约定：所有展示型数据（timeline / diff / 后续新面板）都放入对应 preset 的 fixtures，避免散落在各 UI 逻辑里。
- 目标：稳定演示以下关键视觉行为，避免“只展示 happy path”：
  - Task/SubAgent 起止（running → completed）
  - 至少一层子项缩进
  - 至少一个可折叠节点与子项计数
  - 折叠前后差异明显（便于截图）
- 数据建议：
  - 文案简短（单条 1~2 行），避免截图噪音
  - id/toolCallId 稳定可读（如 `demo-task-1`）
  - 保留一个主 agent 总结节点，展示“子任务回传后”的状态

### 3) 截图与演示流程（每次 UI 变更建议执行）

1. `npm run dev`
2. 打开带 key 的页面并附加 `&demo=subagent-tree`
3. 至少产出两张图：
   - 展开态（expanded）
   - 折叠态（collapsed）
4. 在汇报/PR 描述中附上截图路径或链接

### 4) 何时必须同步维护 demo

- 只要改动涉及以下任一项，就需要同步更新对应 preset 的 demo 数据与截图：
  - 时间线结构（分组/折叠逻辑）
  - 时间线行布局（宽度、缩进、栅格、截断）
  - 折叠控件（文案、图标、交互）
  - SubAgent/Task 识别逻辑
  - Diff 展示交互（分类、文件列表、文件级 diff 呈现）
- 若本次改动不涉及上述内容，可不修改 demo 数据，但仍建议快速回归 demo 页面。

## 验证与测试技巧

- 基础验证命令：

```bash
npm test
npm run check
```

- 测试基于 Node.js 内置 test runner（`tsx --test`），覆盖：
  - 前端关键纯函数（目录边界、工具摘要、计划提取、时间线分组）
  - 后端关键逻辑（会话历史窗口、工作区路径安全校验、错误格式化）
- 若改动涉及可见 UI（样式/组件/交互），建议启动开发环境并截图验证：
  1. `npm run dev`
  2. 打开带 key 的访问地址
  3. 必要时附加 `&demo=subagent-tree` 快速观察树状折叠行为

## 提交前检查建议

1. `npm run check`
2. `npm test`
3. 若有 UI 变更，补充截图与简短验证说明
