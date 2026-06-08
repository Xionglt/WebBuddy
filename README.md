# Multi-Functional Agent

面向网页任务的可信执行 Agent 开源项目。用户给定 URL 与自然语言任务后，系统能在受控边界内完成网页检索、浏览、表单填写等操作，并全程可观察、可确认、可复盘。

## 项目结构

```text
multi-functional-agent/
├── docs/
│   └── architecture/          # 架构设计、RFC、开发计划
├── packages/
│   ├── plugin/                # Playwright MCP Server（浏览器自动化）
│   └── web-buddy/             # Agent Runtime（CLI + Agent Loop）
├── package.json               # 统一构建脚本
└── README.md
```

### packages/plugin

Playwright MCP Server，提供 7 个浏览器自动化工具：

| 工具 | 功能 |
|------|------|
| `web_navigate` | 打开网页 |
| `web_screenshot` | 截图（全页/元素） |
| `web_extract` | 提取文本/表格/属性 |
| `web_click` | 点击元素 |
| `web_fill` | 填写表单 |
| `web_wait` | 等待元素出现 |
| `web_wait_for_navigation` | 等待页面跳转 |

### packages/web-buddy

`web-buddy` 是本项目的 Agent Runtime，基于 Claude Code 恢复源码重构，提供：

- CLI 交互入口
- Agent 循环与工具调用框架
- MCP 集成能力（已接入 Playwright MCP，开箱即用）

## 快速开始

```bash
# 1. 安装依赖
cd packages/plugin && npm install
cd ../web-buddy && npm install

# 2. 配置 API Key
cp packages/web-buddy/.env.example packages/web-buddy/.env

# 3. 构建（plugin + web-buddy 一起）
npm run build

# 4. 启动
npm start
```

> 首次启动需构建，之后改了源码才需重新 `npm run build`，日常直接 `npm start`。

## 路线图

| 阶段 | 目标 |
|------|------|
| ~~当前~~ | ~~集成 `web-buddy` Runtime，跑通 CLI 基础能力~~ ✅ |
| ~~近期~~ | ~~接入 Playwright MCP，实现网页表单自动填写~~ ✅ |
| 当前 | 完善 Policy Gate、Trace 回放、多 Agent 协作 |

## 文档

- [网页操作智能体 RFC](./docs/architecture/web-agent-bmad-rfc.md)
- [第一周开发计划](./docs/architecture/web-agent-week1-plan.md)
- [三人任务拆分方案](./docs/architecture/agent-team-split.md)

## License

MIT
