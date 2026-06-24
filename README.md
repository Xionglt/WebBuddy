# Multi-Functional Agent（多功能网页操作 Agent）

一个**通用、可视化的网页求职投递 Agent**。给它一个招聘网站和一份简历，它可以复用 Cookie 登录状态，读取网页信息，并由大模型通过工具调用亲自驱动浏览器完成搜索、筛选、填写表单、上传简历和推进投递流程。登录、验证码、上传、保存、提交等敏感步骤都会交给人工确认，运行过程会记录为可复盘的 trace、截图、URL、工具调用和风险等级。

当前项目重点不是写死某一个招聘网站流程，而是构建一个可以泛化到网页操作任务的 Agent runtime：浏览器由 Playwright MCP 控制，模型负责决策，runtime 负责安全边界、上下文、trace、人工交接和后续优化。

> English version is available below. See also the [full experience guide](./docs/full-experience-guide.md).

## 当前能力

- ✅ **Web 控制台**：通过 `npm run web` 打开 Codex 风格的浏览器控制台，可配置模型、上传简历、启动任务、查看事件流、截图和 trace。
- ✅ **通用填表**：任意招聘网站 + 简历 → Cookie 登录 → LLM 自主读取页面并填写表单，不依赖硬编码字段映射。
- ✅ **Cookie 登录复用**：先运行 `login <url>` 手动登录一次，之后 `fill` 可以复用保存的 cookies。
- ✅ **可视化浏览器操作**：支持 headful Chromium、鼠标移动、点击高亮、输入高亮，方便观察 agent 具体做了什么。
- ✅ **简历解析**：支持 PDF 简历，也支持 `.json` / `.txt`，解析为结构化 `ResumeProfile`。
- ✅ **阿里巴巴职位匹配**：可抓取阿里岗位列表和详情，并根据简历做匹配。
- ✅ **Claude Code runtime 阿里投递路径**：`npm run alibaba:apply` 会启动恢复版 Claude Code runtime（`packages/web-buddy`），并把 Playwright 暴露为 MCP server。
- ✅ **Raw 对照路径**：`npm run alibaba:apply:raw` 保留本地 minimal Playwright agent loop，方便和 Claude runtime 做对比。
- ✅ **人工交接**：登录、验证码、扫码、上传、保存、提交等关键步骤都会进入人工确认或人工处理。
- ✅ **运行记录**：每一步操作、截图、URL、风险等级和工具调用记录在 `output/` 下。
- ✅ **安全默认值**：真实 final submit 不会静默自动提交，敏感步骤需要人工确认。

## 项目结构

```text
multi-functional-agent/
├── configs/                       # 配置示例和简历示例
├── docs/                          # 迭代记录、优化方案、完整体验教程
├── packages/
│   ├── web-buddy/                 # 恢复版 Claude Code runtime wrapper
│   └── playwright-mcp/            # Agent engine + Playwright MCP server + CLI
│       ├── src/core/              # agent-loop · tool-registry · page-view · login
│       ├── src/sdk/               # orchestrator · llm · config · trace · human · resume · matcher · alibaba
│       ├── src/cli/demo.ts        # fill / login / match / demo-form
│       └── src/{browser,snapshot,session,policy,tools}
└── output/                        # 运行 trace、截图、保存的 cookies（gitignored）
```

## 快速开始

```bash
cd packages/playwright-mcp
npm install
npm run build

# 1. 启动 Web 控制台（推荐）
npm run web                  # 打开 http://localhost:5178

# 2. 离线 demo（不需要模型 Key）
npm run demo

# 3. 任意网站 + 简历
npm run login -- https://your-recruiting-site.com/
npm run fill -- https://your-recruiting-site.com/apply

# 4. 阿里巴巴职位匹配（只读）
npm run demo:match

# 5. 阿里巴巴官方招聘网站：Claude Code runtime + Playwright MCP
npm run alibaba:apply -- --resume /path/to/resume.pdf

# 6. 本地 raw runtime 对照路径
npm run alibaba:apply:raw -- --resume /path/to/resume.pdf --keep-browser-open
```

完整从零体验教程见：[docs/full-experience-guide.md](./docs/full-experience-guide.md)。

## 配置模型

`fill`、`raw`、`alibaba:apply` 等能力需要支持 tool/function calling 的模型。

复制配置文件：

```bash
cp configs/agent.env.example .env
```

智谱 GLM（Anthropic-compatible）示例：

```env
ANTHROPIC_BASE_URL=https://open.bigmodel.cn
ANTHROPIC_AUTH_TOKEN=你的智谱APIKey
ANTHROPIC_MODEL=glm-4.7
```

OpenAI-compatible 示例：

```env
MODEL_API_KEY=你的APIKey
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
```

注意不要提交 `.env`。真实简历、Cookie、storage state 和验证码信息也不应该提交。

## 常用命令

| 命令 | 作用 | 是否需要模型 Key |
|------|------|------------------|
| `npm run web` | 启动 Web 控制台 | 可选 |
| `npm run demo` | 本地 mock 表单 demo | 否 |
| `login <url>` | 手动登录并保存 cookies | 否 |
| `fill <url>` | 通用招聘网站表单填写 | 是 |
| `raw <url>` | 原始网页操作 agent，让 LLM 自主驱动浏览器 | 是 |
| `npm run alibaba:apply` | Claude Code runtime + Playwright MCP 阿里投递路径 | 是 |
| `npm run alibaba:apply:raw` | 本地 minimal raw Playwright runtime 阿里路径 | 是 |
| `match` | 阿里职位抓取 + 匹配，只读模式 | 可选 |
| `demo-form` | 离线 mock 表单 | 可选 |

## 通用填表是怎么工作的

项目没有给每个网站硬编码字段映射。runtime 会把当前网页转换成紧凑的 LLM 可读页面视图，例如：

```text
[e1] input "姓名 Name" risk=L2
[e4] button "投递申请 Submit" risk=L3
```

模型读取页面视图和简历摘要，然后通过工具调用决定下一步动作，例如：

```text
browser_type ref=e1 text="..."
browser_click ref=e4 confirmed=true
browser_snapshot
```

工具执行后，runtime 把新的页面状态反馈给模型，循环推进直到任务完成、遇到人工阻塞，或需要交给用户处理。

## 安全模型

| 等级 | 含义 | 处理方式 |
|------|------|----------|
| L0-L1 | 页面读取、安全导航 | 自动执行 |
| L2 | 普通表单输入 | 可自动填写 |
| L3 | 提交、投递、申请等高风险按钮 | 需要 `confirmed=true` 和人工 gate |
| L4 | 密码、文件上传等敏感输入 | 始终人工 gate |

五类关键步骤会进入人工确认或人工交接：**登录、验证码、上传、保存、提交**。

## 文档

- [完整体验教程](./docs/full-experience-guide.md)：中英双语，从 clone 仓库到完整体验所有主要功能
- [Web Agent Runtime v1.0.2 优化方案](./docs/web-agent-runtime-optimization-v1.0.2.md)：中英双语，速度、token、上下文、指标和 benchmark 方案
- [Agent 迭代记录](./docs/agent-iteration-log.md)：每轮迭代背景、改动、验证和结论
- [Playwright MCP README](./packages/playwright-mcp/README.md)：架构、CLI、环境变量和脚本说明
- [配置示例](./configs/)：`agent.env.example`、`resume.example.json`
- [Web Agent RFC](./docs/architecture/web-agent-bmad-rfc.md) / [Week-1 Plan](./docs/architecture/web-agent-week1-plan.md)

## 路线图

| 阶段 | 状态 | 目标 |
|------|------|------|
| Phase 1 | ✅ | Playwright MCP 工具、风险分级、导航保护 |
| MVP | ✅ | PDF 简历、阿里抓取匹配、受控填表、trace、demo CLI |
| Generic + Cookie | ✅ | 任意网站 LLM 驱动填表、Cookie 登录、架构重构 |
| Web UI + GLM | ✅ | Web 控制台、智谱/Anthropic-compatible provider、真实 API 验证 |
| v1.0.2 | 🚧 | 指标体系、上下文预算、简历压缩、benchmark 基础设施 |

## License

MIT

---

# English Version

A **generic, visual browser job-application agent**. Give it any recruitment site and a resume; it can reuse saved cookies, read the page, and let an LLM drive the browser through tool calls to search, compare, fill forms, upload a resume, and progress through the application flow. Sensitive steps such as login, captcha, upload, save, and submit are handled through human confirmation or handoff. Runs are recorded as replayable traces with screenshots, URLs, tool calls, and risk tiers.

The project is not intended to hardcode one specific recruiting workflow. The goal is to build a general Web Agent runtime: Playwright MCP controls the browser, the model makes decisions, and the runtime handles safety, context, trace, human handoff, and future performance optimization.

## What Works

- ✅ **Web UI**: `npm run web` opens a Codex-style dashboard for model config, resume upload, live events, screenshots, and traces.
- ✅ **Generic fill**: any recruiting site + resume → cookie login → LLM-driven browser filling, without hardcoded field mapping.
- ✅ **Cookie login**: run `login <url>` once and reuse saved cookies later.
- ✅ **Visual browser actions**: headful Chromium, mouse movement, click highlights, and typing highlights.
- ✅ **Resume parsing**: PDF, `.json`, and `.txt` resumes are parsed into `ResumeProfile`.
- ✅ **Alibaba match**: scrape Alibaba job lists/details and match jobs to the resume.
- ✅ **Claude Code runtime Alibaba runner**: `npm run alibaba:apply` runs the recovered Claude Code runtime (`packages/web-buddy`) with Playwright exposed as MCP.
- ✅ **Raw comparison runner**: `npm run alibaba:apply:raw` keeps the local minimal Playwright agent loop for comparison.
- ✅ **Human-in-the-loop**: login, captcha, QR scan, upload, save, and submit steps are handed to the user.
- ✅ **Trace**: run steps, screenshots, URLs, risk tiers, and tool calls are recorded under `output/`.
- ✅ **Safe defaults**: real final submit is never silently auto-submitted.

## Quick Start

```bash
cd packages/playwright-mcp
npm install
npm run build

# 1. Web UI dashboard
npm run web                  # open http://localhost:5178

# 2. Offline demo, no model key required
npm run demo

# 3. Any site + resume
npm run login -- https://your-recruiting-site.com/
npm run fill -- https://your-recruiting-site.com/apply

# 4. Alibaba read-only match
npm run demo:match

# 5. Alibaba official site: Claude Code runtime + Playwright MCP
npm run alibaba:apply -- --resume /path/to/resume.pdf

# 6. Local raw runtime comparison
npm run alibaba:apply:raw -- --resume /path/to/resume.pdf --keep-browser-open
```

See the full walkthrough: [docs/full-experience-guide.md](./docs/full-experience-guide.md).

## Model Configuration

Copy the example env file:

```bash
cp configs/agent.env.example .env
```

Zhipu GLM example:

```env
ANTHROPIC_BASE_URL=https://open.bigmodel.cn
ANTHROPIC_AUTH_TOKEN=your_zhipu_api_key
ANTHROPIC_MODEL=glm-4.7
```

OpenAI-compatible example:

```env
MODEL_API_KEY=your_api_key
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
```

Do not commit `.env`, cookies, storage state, raw resume content, or verification codes.

## Documentation

- [Full experience guide](./docs/full-experience-guide.md): bilingual setup and walkthrough for trying every major feature
- [Web Agent Runtime v1.0.2 optimization plan](./docs/web-agent-runtime-optimization-v1.0.2.md): bilingual performance, token, context, metrics, and benchmark plan
- [Agent iteration log](./docs/agent-iteration-log.md): iteration notes, run conclusions, and next steps
- [Playwright MCP README](./packages/playwright-mcp/README.md): architecture, CLI, env, and scripts
- [Config examples](./configs/)

## License

MIT
