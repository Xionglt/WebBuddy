# Multi-Functional Agent

面向网页任务的可信执行 Agent 开源项目。用户给定 URL 与自然语言任务后，系统能在受控边界内完成网页检索、浏览、表单填写等操作，并全程可观察、可确认、可复盘。

## 项目结构

```text
multi-functional-agent/
├── configs/
│   └── mcp.playwright.example.json
├── docs/
│   └── architecture/          # 架构设计、RFC、开发计划
├── packages/
│   ├── web-buddy/             # Agent Runtime（CLI + Agent Loop）
│   └── playwright-mcp/        # Playwright MCP Server（浏览器工具）
└── README.md
```

### packages/web-buddy

`web-buddy` 是本项目的 Agent Runtime，基于 Claude Code 恢复源码重构，提供：

- CLI 交互入口
- Agent 循环与工具调用框架
- MCP 集成能力

### packages/playwright-mcp

`playwright-mcp` 是浏览器自动化 MCP Server，提供 ref 驱动的 Playwright 工具：

- `browser_open` / `browser_snapshot`
- `browser_click` / `browser_type` / `browser_select` / `browser_wait`

快速开始：

```bash
# Runtime
cd packages/web-buddy
cp .env.example .env
npm install && npm run build && npm start

# Playwright MCP
cd ../playwright-mcp
npm install && npm run build && npm start
```

MCP 配置示例见 [`configs/mcp.playwright.example.json`](./configs/mcp.playwright.example.json)。

## 路线图

| 阶段 | 目标 |
|------|------|
| 当前 | `web-buddy` Runtime + `playwright-mcp` Phase 1 工具 |
| 近期 | 跑通表单草稿填写闭环，完善 Policy Gate |
| 后续 | 完善 Policy Gate、Trace 回放、多 Agent 协作 |

## 文档

- [网页操作智能体 RFC](./docs/architecture/web-agent-bmad-rfc.md)
- [第一周开发计划](./docs/architecture/web-agent-week1-plan.md)
- [三人任务拆分方案](./docs/architecture/agent-team-split.md)

## License

MIT
