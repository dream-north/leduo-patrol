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
- 前端可用 `demo=subagent-tree` 查询参数注入模拟会话，便于验证 SubAgent 树状折叠 UI。

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
