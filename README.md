# web-buddy

`web-buddy` 是一个本地、可审计、安全优先的通用 Web Agent Runtime。它让
LLM 能够理解网页、规划多步任务并通过 Playwright 执行动作，同时用权限策略、
Human Gate、上下文管理、任务图和完整 Trace 控制真实网页操作的风险。

Runtime 本身不绑定某个网站或业务。信息检索、跨页面比较、表单处理、后台事务、
预订流程和招聘辅助都通过同一套 Agent Harness 执行；场景差异由任务 Prompt、
Skill、Policy 和 Workflow 承载。

这个仓库只发布 `packages/web-buddy` 主项目。根目录中的 Docker 与配置文件
用于构建和运行 Web Buddy；本地计划和设计文档不进入远端版本。

## V3.0.0 交付状态

Agent Harness V3 的 M1-M6 技术验收已经完成。源码发布分支为
`cl/personal/web-buddy/kai/v-3.0.0`，同一提交作为 `main` 的 V3 集成基线。
`runWebTask()` 是通用主入口；招聘保留为 deprecated Scenario Adapter，安全、
Control Plane、Multi-Agent、Memory、Public SDK 和 tenant service 继续共用同一
Agent Loop 与 fail-closed 边界。

维护者可用以下命令重放 V3 验收：

```bash
cd packages/web-buddy
npm run typecheck
npm run build
npm run test:mvp
npm run test:release-gate
npm run test:m6-release
```

这里的 `v3.0.0` 表示 Agent Harness 源码交付线。npm manifest 当前仍为
`1.0.0`；在选择 LICENSE、确认发布者权限并重新执行 package smoke 之前，不得
据此发布到公共 npm registry。`PLAN/`、环境变量、本地输出、构建产物和依赖目录
仍按仓库规则排除在 Git 交付之外。

## Public SDK（推荐入口）

Node.js `>=20` 的外部项目只从包根导入稳定 API；`dist/*`、`src/*` 和其他深路径
不属于兼容承诺，也会被 package exports 拒绝。

```bash
npm install @multi-functional-agent/web-buddy
```

```js
import {
  createResearchStarter,
  runWebTask,
} from '@multi-functional-agent/web-buddy'

const input = createResearchStarter({
  schemaVersion: 'research-starter/v1',
  goal: '汇总页面结论并保留当前网页证据。',
  startUrl: 'https://example.com/',
})

const result = await runWebTask(input)
```

稳定入口还提供 `createComparisonStarter()`、`createFormDraftStarter()`、
`createSkillScaffold()`、`createRunClient()` 和 `createApprovalClient()`。公开的
顶层请求、响应与持久资源 envelope 都带 schema version；未知 major 默认拒绝，
而不是静默猜测兼容。

Schema 迁移遵循 fail-closed：公开 DTO 使用显式 `*/v1` 或 `*/v2`；仅对没有
版本字段的已知 legacy session/transcript 提供受限 v1 读取，显式未知版本会被
拒绝。Run revision/attempt、Approval action binding、Artifact owner scope 以及
origin/trust/sensitivity 不会在迁移时被忽略、重新解释或提升权限；需要升级的
数据应由独立迁移工具写入新记录并保留旧记录，而不是由 Runtime 原地猜测。

仓库中的 `examples/research`、`examples/comparison`、`examples/form-draft`
均只使用包根导入。招聘能力是通用 Runtime 上的 Scenario Adapter 示例；
`job-agent` 与 `job-agent-web` 暂时保留兼容 wrapper 并输出 deprecated warning，
新代码应使用 `runWebTask()` 或通用 `web-agent` 入口。

技术打包边界已经过外部 consumer 验证；仓库当前尚未选择并提交开源许可证，
因此不得据此直接发布到公共 npm registry。许可证决策和实际发布仍是独立流程，
不能仅根据 `private=false` 或仓库版本号推断。

## Service 安全边界

Web API 默认先认证再解析业务请求。`WEB_BUDDY_API_TOKEN`，或包含
`token/actorId/tenantId/userId` 的 `WEB_BUDDY_API_TOKENS_JSON`，用于建立精确的
tenant/user scope。Run、Approval、Trace、Artifact 和 Memory 查询都按该 scope
隔离；稳定 mutation API 要求 `expectedRevision` 与 `idempotencyKey`。

模型凭据只从服务器 Secret Provider（环境变量）注入。Web UI 不接收或持久化
模型 key、resume path 或其他 secret context；模型 endpoint 也不能由普通 tenant
动态改写。服务默认拒绝 localhost/私网目标，本地 fixture 只有在显式设置
`WEB_BUDDY_ALLOW_PRIVATE_NETWORK_FOR_TESTING=true` 时才可访问。

通用 Run 只有在调用方显式请求恢复、服务端重新验证为全 deny 的只读契约、
使用内建 Runtime 且已有有效 durable session 时才能 resume。恢复会增加
run revision/attempt、删除未完成的旧 tool call，并从冻结的 `startUrl` 重新观察；
不会重放最后一个写操作。表单契约、自定义 Runtime driver、非静止 Run 和旧
Approval 都不能借 `restartSafe` 提升权限。

## 场景能力

| 场景 | 可完成的工作 | 默认安全边界 |
| --- | --- | --- |
| 网页研究 | 浏览页面、提取信息、跨页面汇总并生成结构化结论 | 只读，不触发外部写操作 |
| 比较与决策 | 收集候选项、验证硬性条件、记录淘汰原因并选择方案 | 保留证据，不替用户执行支付或最终确认 |
| 通用表单 | 识别字段、生成填写计划、询问缺失信息、写入并回读校验 | 上传、保存和最终提交按风险分级确认 |
| 多步骤网页流程 | 在搜索、详情、编辑、确认等页面间保持任务状态并恢复执行 | 登录、验证码、身份验证转人工处理 |
| 预订与交易前流程 | 比较场地或服务、填写预订草稿、核对价格与条款 | 停在创建订单、签约或支付之前 |
| 招聘辅助 | 岗位研究、匹配、申请表草稿和投递前检查 | 招聘是扩展场景之一，最终投递始终受控 |
| 自定义网站任务 | 使用 Raw Runtime、MCP 或 Skill 接入新的网页任务 | 复用统一 Policy、Permission 和 Trace 机制 |

仓库提供离线 research、通用表单、Venue Booking 和招聘流程作为不同复杂度的
benchmark；它们用于证明 Harness 的跨场景能力，而不是限制 Runtime 的用途。

## Agent Harness 核心能力

- **浏览器执行**：打开页面、结构化 snapshot、截图、点击、输入、选择、等待、
  上传文件，并通过稳定 ref 与操作后校验降低页面漂移影响。
- **自主规划**：本地 ReAct loop、Tool Calling、任务阶段识别、Completion Gate、
  Task Graph、后台任务和 compact/resume。
- **页面与表单理解**：`PageState`、`FormState`、`FormCoverage`、字段规划、
  自定义下拉/级联探测、写入后回读与整页审计。
- **上下文与记忆**：按需选择任务上下文，维护 session、run memory、回答记录和
  artifact 引用，避免把全部历史反复塞给模型。
- **安全治理**：L0-L4 风险分级、Policy、Permission、Human Gate 和
  fail-closed 工具执行；登录、验证码、上传、发布、支付和最终提交均受控。
- **可观测与恢复**：append-only session facts、transcript、events、trace、
  screenshots、metrics、risk decisions 和 safety report。
- **多入口集成**：CLI、Web UI 和 MCP server 共用同一套浏览器工具与安全语义。
- **场景扩展**：通过 Skill、任务 Prompt、站点策略和 Workflow 增加新场景，
  无需替换核心 Runtime。

## 仓库结构

```text
packages/web-buddy/        主项目：runtime、CLI、Web UI、MCP、浏览器工具、测试
output/                    运行产物目录，默认不应提交
tmp/                       上传文件与运行临时数据，默认不应提交真实敏感内容
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

默认原则：Runtime 可以观察页面、规划并执行低风险中间步骤，但不会默认完成会
创建真实外部后果的敏感动作。

敏感 gate：

- 登录、二维码、短信、验证码：人工处理。
- 上传本地文件或向网站披露个人数据：必须确认，并绑定真实上传控件。
- 保存资料、创建订单、发送消息、发布内容、签约或支付：按外部影响分级确认。
- 最终提交、确认投递和付款等不可轻易撤销的动作：真实外部站点不自动点击。
- 登录、配额确认、协议确认等改变后续权限或权益的页面，不作为普通导航处理。

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

- Node.js `>=20`
- npm
- Playwright Chromium，`npm install` 后会通过 `postinstall` 安装

安装：

```bash
git clone https://github.com/Xionglt/WebBuddy.git
cd WebBuddy/packages/web-buddy
npm install
npm run build
```

最小本地验收，不需要模型 key、不需要账号、不访问真实网站：

```bash
# 稳定离线表单 demo：读取结构化用户资料、填写本地 mock form、停在 save/submit 边界
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
cd /path/to/WebBuddy
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
export WEB_BUDDY_API_TOKEN="$(openssl rand -hex 32)"
npm run web                # 认证后的 Web UI；页面输入同一个 token
npm run report:safety      # 生成 safety-report.json
```

CLI command：

```text
demo-form             本地 mock 表单，填草稿并停在 submit/save 边界
demo-research         本地只读网页研究 fixture
raw <url>             通用网页任务，LLM 直接规划并驱动浏览器，需要模型 key
fill <url>            通用表单理解与填写，需要模型 key，不自动 final-submit
login <url>           打开可见浏览器，人工登录并保存 storage state
match [--list-url]    列表/详情抓取与匹配示例，默认使用 Alibaba skill，read-only
auto-apply <url>      localhost/sandbox 多步骤表单 benchmark
alibaba-apply [url]   招聘场景扩展示例，需要模型 key
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

## 通用表单能力怎么工作

当前填表链路不是简单的“LLM 看到 label 就乱填”。它分为几层：

1. `browser_form_snapshot` / `browser_form_audit` 观察字段、必填状态、错误文案、
   upload hints、submit candidates 和整页 coverage。
2. `ProfileStore` 保存结构化用户资料；招聘场景可以加载 `ResumeProfileV2`，并用
   `resume_query` 按 section 查询细节。
3. `AnswerStore` 保存 `ask_user` 结果，避免同一字段重复问。
4. `FieldPlanner` 先用确定性 mapper 规划常见字段，具体字段集合由场景决定：
   - 姓名、邮箱、手机、城市
   - 公司、部门、联系人与基础资料
   - 日期、时间、人数、预算与业务选项
   - 招聘场景中的学历、经历、技能和项目等扩展字段
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

## 结构化资料与简历输入

通用网页任务可以直接使用 Prompt 和 `ask_user` 提供信息。需要导入结构化个人资料
时，当前内置的招聘 Profile Provider 支持：

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
export WEB_BUDDY_API_TOKEN="$(openssl rand -hex 32)"
npm run web
```

打开：

```text
http://localhost:5178
```

Web UI 是认证后的通用 Harness 控制台。启动后在页面输入同一个 service token，
即可查看由 Public SDK/API 创建的通用 Run，以及 durable task list、Approval
inbox、Trace、Artifact 和控制操作。页面上的 Raw/Match 新建预设目前仍走带
deprecation 语义的 recruiting compatibility adapter；它们不代表第二套 Agent
Loop。模型 endpoint 和 credential 只读自服务器配置；页面不接收模型密钥、
resume path 或资料上传。`npm run web` 只构建并启动 Web Buddy 自有 Runtime。

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

## 场景示例：Alibaba / 真实招聘站点流程

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
export WEB_BUDDY_API_TOKEN="$(openssl rand -hex 32)"
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

Compose 在 token 缺失时会拒绝启动，容器 healthcheck 也使用同一 token 访问
`/api/config`。可将 token 和模型 key 放根目录 `.env`，但不要写进镜像或提交。

## MCP Server

build 后，MCP stdio entry：

```bash
cd packages/web-buddy
npm run build
node ./dist/server.js
```

默认 MCP compatibility surface 只暴露观察类工具：

```text
browser_snapshot
browser_form_snapshot
browser_form_audit
browser_inspect_options
browser_wait
browser_screenshot
```

导航、点击、输入、选择、上传和最终提交不会通过 MCP 绕过本地 Agent Loop 的
TaskPolicy/Human Gate；这类 MCP 调用 fail-closed。完整浏览器写能力只由单一
browser writer 的本地 runtime 持有。本地 runtime 还提供：

```text
resume_query
ask_user
plan_form_fill
agent_done
```

浏览器顶层导航按完整 origin（scheme/host/port）绑定。HTTP 3xx 会停在第一跳并
要求显式导航到下一 URL；跨 origin click/popup 在目标网络请求前阻断。

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
