# web-buddy

`web-buddy` 是一个本地、可审计、安全优先的 Web Agent runtime。它把
Playwright 浏览器工具、LLM tool-calling 循环、页面/表单观察、简历解析、
自主填表规划、人类确认 gate、策略引擎、session/trace/metrics/safety
report 串成一个可以本地运行和复盘的工程。

这个仓库只发布 `packages/web-buddy` 主项目。根目录中的 Docker 与配置文件
用于构建和运行 Web Buddy；本地计划和设计文档不进入远端版本。

## 当前能力概览

核心能力：

- 本地浏览器 runtime：打开页面、截图、结构化 snapshot、点击、输入、选择、
  等待、上传文件、按 label 填字段。
- MCP server：把同一套浏览器能力通过 stdio 暴露给 MCP 客户端。
- 页面观察模型：`PageState`、`FormState`、`FormCoverage`，并写出可复盘
  artifact。
- 自主填表能力：完整简历 `ResumeProfileV2`、`resume_query`、`ask_user`、
  `FieldPlanner`、`FillLedger`、`browser_set_field`、整页表单审计、自定义
  下拉/级联选项探测、写入后回读校验。
- 简历解析：支持 `.pdf`、`.json`、`.txt`；文本 PDF 走 `pdfjs-dist`；v2
  profile 带 confidence/evidence，并有确定性 email/phone 修复。
- 招聘流程辅助：本地 demo-form、read-only research demo、Alibaba 列表/详情
  匹配、真实投递前安全 gate、direct-submit review。
- 安全模型：登录、验证码、上传简历、保存站内简历、最终提交都不是默认自动
  执行动作。
- 可观测性：每次运行写 session、transcript、events、trace、screenshots、
  metrics、risk decisions、safety report。

## 仓库结构

```text
packages/web-buddy/        主项目：runtime、CLI、Web UI、MCP、浏览器工具、测试
output/                    运行产物目录，默认不应提交
tmp/                       demo 简历、临时文件，默认不应提交真实敏感内容
```

`packages/web-buddy/src/` 的主要模块：

```text
agent/          prompt assembly、runtime facade、stop condition
browser/        Playwright 工具实现：open/snapshot/click/type/set-field/upload 等
context/        Prompt sections、ProfileStore、AnswerStore、ContextManager
fill/           FieldPlan、FieldPlanner、FillLedger、normalizers
kernel/         AgentKernel、QueryLoop、RunController
metrics/        metrics schema、writer、aggregate
observation/    PageState、FormState、ObservationManager
permission/     PermissionEngine、ApprovalQueue
policy/         PolicyEngine、ActionIntent、risk decisions、safety report
runtime/local/  本地 agent loop 和 ToolRegistry
sdk/            orchestrator、config、llm、resume、human gate、trace
session/        session store、transcript、restore/completion
tools/          tool catalog、local adapter、MCP adapter、execution service
web/            Web UI server
workflow/       WorkflowState、completion gate、direct-submit/user confirmation
```

## 安全边界

默认原则：runtime 可以观察页面、规划、填写低风险草稿字段，但不会默认完成真实
世界里的敏感动作。

敏感 gate：

- 登录、二维码、短信、验证码：人工处理。
- 上传本地简历：必须确认，并且必须绑定真实上传控件或 `input[type=file]`。
- 保存站内简历/资料：必须确认。
- 最终提交、确认投递、支付、发送、发布：真实外部站点不自动点击。
- Alibaba quota 弹窗，例如“本月能申请 N 个职位，请慎重选择”：按最终投递风险
  看待，不当作普通流程确认。

权限模式：

```text
safe       默认模式。高风险边界询问。
review     可自动放行部分非最终 L3 动作，但敏感 gate 仍保留。
trusted    信任本机调试场景下放行更多非最终流程动作。
autopilot  最宽松的非最终自动化模式；final_submit 仍默认 gated。
```

`HUMAN_GATE_MODE=auto` 只用于非交互测试/自动 handoff，不代表真实最终提交授权。

## 从零开始运行

要求：

- Node.js `>=18`
- npm
- Playwright Chromium，`npm install` 后会通过 `postinstall` 安装

安装：

```bash
git clone https://github.com/Xionglt/multi-functional-agent.git
cd multi-functional-agent/packages/web-buddy
npm install
npm run build
```

最小本地验收，不需要模型 key、不需要账号、不访问真实网站：

```bash
# 稳定离线表单 demo：解析本地简历、打开本地 mock form、填写字段、停在 save/submit 边界
npm run demo:form:offline

# 本地只读 research demo
npm run demo:research

# 为最近一次 run 生成 safety-report.json
npm run report:safety
```

如果这三步通过，浏览器、构建、trace、基础安全边界基本可用。

## 模型配置

无模型 key 时，离线 demo 和大量测试仍可跑。`raw`、`fill`、真实站点工作流和
LLM planner 兜底需要支持 tool calling / JSON 输出的模型。

在仓库根目录创建 `.env`，不要提交：

```bash
cd /path/to/multi-functional-agent
touch .env
```

OpenAI-compatible：

```env
MODEL_PROVIDER=openai
MODEL_API_KEY=your_key
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
```

DashScope / Qwen compatible：

```env
MODEL_PROVIDER=openai
DASHSCOPE_API_KEY=your_key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen-plus
MODEL_ENABLE_THINKING=false
```

Anthropic-compatible 或 GLM Anthropic path：

```env
MODEL_PROVIDER=anthropic
ANTHROPIC_AUTH_TOKEN=your_key
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_MODEL=glm-4.7
```

验证模型连通和 tool calling：

```bash
cd packages/web-buddy
npm run test:model
```

如果 `test:model` 因 401、quota、billing、provider overload 失败，这属于外部服务
问题；本地 no-key fixture 仍可继续验收。

## CLI 使用

所有命令从 `packages/web-buddy` 目录运行。

```bash
npm run build
node ./dist/cli/demo.js <command> [options]
```

常用 npm script：

```bash
npm run demo:form          # headful 本地表单 demo
npm run demo:form:offline  # headless/no-key 稳定 QA 路径
npm run demo:research      # 本地只读 research demo
npm run demo:match         # Alibaba read-only match preset
npm run web                # Web UI
npm run report:safety      # 生成 safety-report.json
```

CLI command：

```text
demo-form             本地 mock 申请表，填草稿并停在 submit/save 边界
demo-research         本地只读网页研究 fixture
raw <url>             LLM 直接驱动浏览器，需要模型 key
fill <url>            通用招聘表单填写，需要模型 key，不自动 final-submit
login <url>           打开可见浏览器，人工登录并保存 storage state
match [--list-url]    Alibaba 列表/详情抓取和匹配，read-only
auto-apply <url>      localhost/sandbox 结构化投递 benchmark
alibaba-apply [url]   Alibaba raw runtime 路径，需要模型 key
```

常用参数：

```text
--resume <path>            .pdf/.json/.txt 简历路径
--headful / --headless     是否显示浏览器
--keep-browser-open        结束后保留浏览器
--auto-gate                非交互 gate，用于测试，不代表 final submit 授权
--model-key <key>          覆盖模型 key
--base-url <url>           覆盖模型 endpoint
--model-name <name>        覆盖模型名
--storage-state <path>     Playwright 登录态文件
--prompt <text>            自定义任务 prompt
--permission-mode <mode>   safe/review/trusted/autopilot
--max-pages <n>            列表页/批次数
--max-crawl-jobs <n>       列表阶段最多候选
--max-jobs <n>             详情阶段 Top N
--match-threshold <n>      进入申请流程的最低匹配分
```

## 自主填表能力怎么工作

当前填表链路不是简单的“LLM 看到 label 就乱填”。它分为几层：

1. `browser_form_snapshot` / `browser_form_audit` 观察字段、必填状态、错误文案、
   upload hints、submit candidates 和整页 coverage。
2. `ProfileStore` 保存完整 `ResumeProfileV2`；`resume_query` 可按 section 查询完整
   简历细节。
3. `AnswerStore` 保存 `ask_user` 结果，避免同一字段重复问。
4. `FieldPlanner` 先用确定性 mapper 规划常见字段：
   - 姓名、邮箱、手机、城市
   - 最高学历、工作年限
   - 当前公司、当前职位
   - 技能、项目经历、自我介绍
   - select/radio 的 option fuzzy match
5. 如果字段仍是 `valueSource=none`，且当前 LLM 支持 `generateJson`，LLM fallback 只
   补这些未决字段，不覆盖确定性结果。
6. `browser_set_field` 根据 control kind 写入 text/textarea/native select/custom
   select/cascader/date/radio/checkbox，并立即 readback 校验。
7. `FillLedger` 跟踪 planned/verified/failed/skipped/needs_user/pending_required。
8. Completion gate 在 `agent_done` 前检查：
   - 是否滚动审计到底
   - 是否还有确定必填未填
   - 是否有写入失败
   - 是否还有待问用户信息
   - 如本次任务带简历文件，是否 `currentResumeUploaded=true`

相关测试：

```bash
npm run test:resume-query
npm run test:ask-user-flow
npm run test:field-planner
npm run test:form-audit
npm run test:inspect-options
npm run build && node ./scripts/set-field-test.mjs
npm run test:completion-gate
npm run test:agent-runtime-workflow
```

## 简历输入

支持：

- `.pdf`
- `.json`
- `.txt`

示例：

```bash
cd packages/web-buddy
npm run fill -- https://your-recruiting-site.example/apply --resume /absolute/path/resume.pdf
npm run test:resume-ingest
```

注意：

- 文本 PDF 效果最好。
- 扫描版/图片型 PDF 可能只得到 sparse text 和 warnings。
- JSON 可以是 legacy `ResumeProfile` 或 `resume-profile/v2`。
- 不要提交真实简历、raw resume text、cookies、storage state 或模型 key。

## Web UI

```bash
cd packages/web-buddy
npm run web
```

打开：

```text
http://localhost:5178
```

Web UI 用于配置模型、上传简历、跑 demo/fill workflow、查看事件、截图、trace 和
metrics。`npm run web` 只构建并启动 Web Buddy 自有 runtime。

### 单 runtime 版本说明

仓库不再捆绑外部 agent runtime。对应的 adapter 源码、`/api/runtime/*` Web
接口以及旧的 `alibaba:apply` 命令均已移除。Alibaba 场景请使用
`npm run alibaba:apply:raw`；Web 控制台提供 `Web Buddy Raw` 和
`Web Buddy Match` 两种入口。模型配置仍支持 Anthropic-compatible API，
这与是否捆绑外部 runtime 无关。

## 输出产物

运行产物默认写到仓库根目录 `output/`：

```text
output/sessions/<sessionId>/session.json
output/sessions/<sessionId>/transcript.jsonl
output/sessions/<sessionId>/events.jsonl
output/sessions/<sessionId>/workflow.json
output/<runId>/trace.jsonl
output/<runId>/summary.json
output/<runId>/shot-*.png
output/traces/<sessionId>/run-manifest.json
output/traces/<sessionId>/metrics.json
output/traces/<sessionId>/agent-state.json
output/traces/<sessionId>/safety-report.json
output/traces/<sessionId>/artifacts/page-state-latest.json
output/traces/<sessionId>/artifacts/form-state-latest.json
output/traces/<sessionId>/artifacts/risk-decisions.json
output/traces/<sessionId>/artifacts/job-candidates-coarse.json
output/traces/<sessionId>/artifacts/job-candidates-final.json
output/traces/<sessionId>/artifacts/direct-submit-review.json
```

`output/sessions` 是 session/transcript/event 记录；`output/traces` 和
`output/<runId>` 主要用于审计、复盘和报告。代码不能把 trace artifact 当运行时
状态来源。

## Alibaba / 真实招聘站点流程

推荐顺序：

```bash
cd packages/web-buddy

# 1. 先人工登录，保存 cookies/storage state
npm run login -- https://talent-holding.alibaba.com/

# 2. 只读匹配，不进入投递
npm run demo:match -- \
  --resume /absolute/path/resume.pdf \
  --max-pages 5 \
  --max-crawl-jobs 100 \
  --max-jobs 10 \
  --match-threshold 0.45

# 3. 真实 apply 前必须确认 safety checklist
MODEL_API_KEY=your_key npm run alibaba:apply:raw -- \
  --resume /absolute/path/resume.pdf \
  --headful \
  --keep-browser-open \
  --permission-mode safe
```

真实阿里 E2E 前检查：

- 已人工登录，不自动处理账号、密码、短信码、验证码。
- 本次简历路径明确出现在 context/trace 中。
- 上传只绑定真实上传控件或 `input[type=file]`。
- 上传后有 `currentResumeUploaded=true` 或等价页面证据。
- 已运行整页 `browser_form_audit`，`formCoverage.scrolledBottom=true`。
- `FillLedger.pendingRequired=0`、`failed=0`、`needsUser=0`。
- 自定义下拉/级联选项已通过 `browser_inspect_options` 或页面观察确认。
- quota 弹窗按 `final_submit` 风险处理。
- 保存 trace、session transcript、final screenshot、page/form artifacts。

## 测试矩阵

快速 QA：

```bash
cd packages/web-buddy
npm run build
npm run test:prompt-sections
npm run test:observation
npm run test:policy-engine
npm run test:completion-gate
npm run test:agent-runtime-workflow
npm run test:resume-query
npm run test:ask-user-flow
npm run test:field-planner
npm run test:form-audit
npm run test:inspect-options
npm run build && node ./scripts/set-field-test.mjs
npm run demo:form:offline
```

更完整的维护者回归：

```bash
npm run test:mvp
```

常用专项：

```bash
npm run test:model
npm run test:resume
npm run test:resume-ingest
npm run test:matcher
npm run test:tool-catalog
npm run test:tool-execution
npm run test:tool-execution-service
npm run test:permission-engine
npm run test:permission-modes
npm run test:direct-submit-flow
npm run test:safety-report
npm run test:session
npm run benchmark:simple
npm run benchmark:complex
npm run benchmark:research
```

## Docker / Compose

如果你想把 Node、Playwright Chromium、系统依赖和 Web UI 封起来：

```bash
docker compose build
docker compose up agent
```

打开：

```text
http://localhost:5178
```

容器内跑检查：

```bash
docker compose run --rm agent npm --prefix packages/web-buddy run demo:research
docker compose run --rm agent npm --prefix packages/web-buddy run test:e2e-auto-apply
docker compose run --rm agent node packages/web-buddy/dist/cli/demo.js demo-form --headless --auto-gate
docker compose run --rm agent npm --prefix packages/web-buddy run report:safety
```

模型 key 放根目录 `.env`，不要写进镜像或提交。

## MCP Server

build 后，MCP stdio entry：

```bash
cd packages/web-buddy
npm run build
node ./dist/server.js
```

可用浏览器工具来自 `src/tools/catalog.ts`，包括：

```text
browser_open
browser_snapshot
browser_form_snapshot
browser_form_audit
browser_inspect_options
browser_click
browser_click_text
browser_type
browser_fill_by_label
browser_select
browser_select_by_text
browser_set_field
browser_wait
browser_screenshot
browser_upload_file
```

本地 runtime 还有只在 local loop 暴露的工具：

```text
resume_query
ask_user
plan_form_fill
agent_done
```

## 交给其它 AI 的执行清单

如果你要把这个仓库交给另一个 AI，让它按下面顺序做：

1. 进入 `packages/web-buddy`。
2. 跑 `npm install`，再跑 `npm run build`。
3. 跑 `npm run demo:form:offline`，确认本地表单 demo 能停在 save/submit 边界。
4. 跑快速 QA 矩阵里的测试。
5. 如果需要真实模型，先配置根目录 `.env`，再跑 `npm run test:model`。
6. 如果需要真实招聘站点，先用 `npm run login -- <site>` 人工登录。
7. 真实投递前复核本 README 的“安全边界”，确认 final submit 和
   quota 弹窗依然会触发人工确认。
8. 所有运行结果看 `output/`；不要提交 `.env`、`output/`、cookies、真实简历或
   storage state。

## 常见问题

### demo-form 为什么停在 save？

这是预期行为。保存/提交相邻动作是高风险边界，本地 demo 用它证明 runtime 不会
静默提交。

### `npm run test:model` 失败，但本地 demo 通过，说明什么？

说明本地 runtime 可用，外部模型 provider 当前不可用、配置错误、额度不足或
不支持需要的调用格式。先修 `.env` 或 provider，再跑真实 LLM workflow。

### 表单字段没有填满怎么办？

看 `form-state-latest.json`、`FILL_PLAN`、`FillLedger`：

- 需要更多简历细节时，模型应调用 `resume_query`。
- 简历里没有且不能推断时，模型应调用 `ask_user`。
- 没有整页 coverage 时，应先调用 `browser_form_audit`。
- 自定义下拉不确定时，应调用 `browser_inspect_options`。

### 真实网站出现 direct-submit review 是失败吗？

不一定。很多招聘站点没有真正可填的表单，只显示在线简历、协议勾选和最终投递
按钮。runtime 会生成 `direct-submit-review.json` 并停在最终提交前，这是安全边界。

### 可以让它自动最终提交吗？

真实外部站点不建议，也不是默认能力。只有 localhost/sandbox benchmark 或显式 SDK
级 override 才能放宽。普通 CLI/env 的 permission mode 不会自动放行 final submit。

## 维护注意事项

- 优先保持 `packages/web-buddy` 的本地 no-key demo 和核心回归稳定。
- 新增工具必须进 `tools/catalog.ts`，并覆盖 local/MCP adapter 边界。
- 新增高风险动作必须走 PolicyEngine/PermissionEngine/HumanGate。
- 不要让 runtime 从 trace artifact 反读状态。
- 不要把真实账号、cookies、验证码、简历原文、模型 key 写入 git。
- 修改填表能力时至少跑：

```bash
npm run build
npm run test:field-planner
npm run test:form-audit
npm run test:inspect-options
npm run test:completion-gate
npm run test:agent-runtime-workflow
npm run demo:form:offline
```
