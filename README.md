# Multi-Functional Agent

面向网页任务的可信执行 Agent 开源项目。用户给定 URL 与自然语言任务后，系统能在受控边界内完成网页检索、浏览、表单填写等操作，并全程可观察、可确认、可复盘。

## 项目结构

```text
multi-functional-agent/
├── docs/
│   └── architecture/          # 架构设计、RFC、开发计划
├── packages/
│   └── web-buddy/             # Agent Runtime（CLI + Agent Loop）
└── README.md
```

### packages/web-buddy

`web-buddy` 是本项目的 Agent Runtime，基于 Claude Code 恢复源码重构，提供：

- CLI 交互入口
- Agent 循环与工具调用框架
- MCP 集成能力（后续将接入 Playwright MCP 服务）

快速开始：

```bash
cd packages/web-buddy
cp .env.example .env   # 填入你的 API Key
npm install
npm run build
npm start
```

## 路线图

| 阶段 | 目标 |
|------|------|
| 当前 | 集成 `web-buddy` Runtime，跑通 CLI 基础能力 |
| 近期 | 接入 Playwright MCP，实现网页表单自动填写 |
| 后续 | 完善 Policy Gate、Trace 回放、多 Agent 协作 |

## 文档

- [网页操作智能体 RFC](./docs/architecture/web-agent-bmad-rfc.md)
- [第一周开发计划](./docs/architecture/web-agent-week1-plan.md)
- [三人任务拆分方案](./docs/architecture/agent-team-split.md)

## License

MIT
