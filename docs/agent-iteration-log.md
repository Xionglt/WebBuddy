# Agent 项目迭代记录

这个文档用来记录 `multi-functional-agent` 每次重要迭代的背景、改动、验证结果和遗留问题，方便之后复盘为什么这么改、改到了什么程度、下一步该从哪里继续。

## 记录原则

- 每次做完一轮有实际影响的改动后，在最上方追加一条记录。
- 记录目标、实际改动、验证方式、结论和下一步，不只写代码文件列表。
- 不记录 API Key、Cookie、验证码、账号密码、完整简历内容等敏感信息。
- 如果某次运行失败，优先记录 trace 路径、终止原因和可复现命令。
- 如果只是小的格式调整或临时试验，可以合并进相关迭代记录里。

## 记录模板

```md
## YYYY-MM-DD 迭代标题

### 背景

- 为什么要做这次改动。

### 改动

- 改了哪些能力、命令、配置或文档。

### 验证

- 跑过哪些命令。
- 观察到什么结果。

### 结论

- 这次迭代确认了什么。

### 遗留问题 / 下一步

- 还没解决的问题。
- 下一轮建议优先处理什么。
```

## 2026-06-29 Phase 2C ToolExecutionService v1 文档定位

### 背景

- Phase 2B 已经把 `AgentRuntime.run()` 包进 `AgentKernel -> QueryLoop -> runAgentLoop`，但实际工具执行生命周期仍留在 `runAgentLoop` 内。
- Plan 3 需要说明它和 Plan 2 的关系：Plan 2 是运行入口和控制壳，Plan 3 是把单个工具调用的执行层拆成 `ToolExecutionService v1`。

### 改动

- 更新 Phase 2 总纲，补充 `PLAN/phase2/plan3.md` 入口，并明确 Plan 2 / Plan 3 的位置：
  - Plan 2 = 把运行入口包进 Kernel。
  - Plan 3 = 把工具执行从 `runAgentLoop` 拆出去。
- 说明 `ToolExecutionService v1` 只负责已经通过 policy / gate 后的单个工具调用生命周期，包括 timeout、abort-before-execution 和 error normalization。
- 明确边界：`PolicyEngine` 继续负责风险判断，后续 `PermissionEngine` 负责通用许可和确认队列，`HumanGate` 负责人与系统之间的确认交互。
- 更新 package README，补充 Phase 2 Kernel / ToolExecutionService 定位和 Phase 2C 验证命令。

### 验证

- `git diff --check` 通过。

### 结论

- Phase 2C 文档口径收窄为工具执行层 v1，不夸大为完整 pause / resume / retry。
- `ToolExecutionService` 不是 PermissionEngine，也不接管 workflow completion；它只把工具执行结果变得可观察、可归一、可测试。

### 遗留问题 / 下一步

- 继续保持 `runAgentLoop` 兼容入口。
- 后续如果实现 PermissionEngine / WorkflowEngine，需要继续沿用这里定义的边界，不让工具执行层承担任务决策。

## 2026-06-28 Phase 2B AgentKernel Skeleton + QueryLoop

### 改动

- 新增 `AgentKernel`、`QueryLoop`、`TurnStateSnapshot`、`RunController` 和 `TokenBudget` 占位接口。
- `AgentRuntime.run()` 改为委托 `AgentKernel.start()`，但外部仍返回 `agent-runtime-result/v1` / `local-agent-loop`。
- `runAgentLoop` 增加 `abortSignal`，在 loop 启动后、LLM 调用前、工具执行前检查 abort，并把 session final status 写成 `aborted`。
- 新增 `npm run test:kernel`，并接入 `test:mvp`。

### 验证

- `npm run build` 通过。
- `npm run test:kernel` 通过。
- `npm run test:agent-runtime` 通过。
- `npm run test:session` 通过。
- `npm run test:agent-loop` 通过。

### 结论

- Phase 2B 已完成第一版 Kernel 边界，主循环行为保持兼容。
- Kernel 第一版只发实时 lifecycle event，不直接写 session，避免 transcript/event 重复。
- abort 语义当前保证工具执行前停止，不承诺中断正在执行的 Playwright action。

### 遗留问题 / 下一步

- Plan 3 可以在 `QueryLoop` 边界下继续拆 `ToolExecutionService`、tool lifecycle state、timeout/retry/abort 深化。

## 2026-06-28 Phase 2A SessionStore + KernelEvent

### 改动

- 新增 `KernelEvent`、`FileSessionStore`、append-only `transcript.jsonl` / `events.jsonl`、`workflow.json` 和 `SessionRecorder`。
- `runAgentLoop` 现在可选接收 session recorder，记录 user message、assistant message、tool call/result、policy decision、workflow snapshot、final result 和 error。
- SDK/CLI run 会创建 `output/sessions/<sessionId>/`，CLI 结束时打印 session 和 transcript 路径。
- 新增 `npm run test:session`，并接入 `test:mvp`。

### 验证

- `npm run build` 通过。
- `npm run test:session` 通过。
- `npm run test:mvp` 通过。

### 边界

- Session 是恢复事实源，trace 仍是审计/诊断输出。
- runtime/session/context/workflow 不从 `output/traces` 读取恢复状态。

## 2026-06-26 Phase 5B: MVP Packaging 第一版

### 背景

- Phase 5 已经完成 PolicyEngine / policy audit / metrics / safety report 骨架。
- 当前项目能力已经接近通用本地 Web Agent runtime，但 README、demo 和用户入口仍偏 job-only。
- Phase 5B 目标是让新用户不依赖真实招聘网站、账号或验证码，也能在 10 分钟内跑通安全 demo，并看到 trace / metrics / safety report。

### 改动

- 新增 `demo-research`：
  - 在 `packages/web-buddy/src/sdk/orchestrator.ts` 中加入 read-only local fixture 分支。
  - 使用本地 data URL 页面展示产品/文档/FAQ/表格信息。
  - 只做 `browser_snapshot`、结构化页面摘要和截图，不触发登录、验证码、上传或提交。
  - 写出 `research-summary.json` artifact、trace、metrics。
- 新增脚本：
  - `npm run demo:research`
  - `npm run benchmark:research`
  - `npm run report:safety`
  - `packages/web-buddy/scripts/benchmark-research.mjs`
  - `packages/web-buddy/scripts/safety-report.mjs`
- 更新 `test:mvp`，纳入 `benchmark:research`。
- 重写开源入口文档：
  - `README.md` 改为通用 local auditable Web Agent runtime 定位。
  - `packages/web-buddy/README.md` 改为 package 级 runtime / demo / safety / observability 入口。
  - `docs/full-experience-guide.md` 增补 `demo:research`、`report:safety`、metrics / safety report 查看路径。
- 新增 `docs/safety-model.md`：
  - 说明 L0-L4、PolicyEngine 决策、HumanGate 职责、Workflow phase、final submit、login/captcha handoff、raw mode auto-confirm 适用边界、trace artifact 旁路边界。

### 验证

已通过：

```bash
cd packages/web-buddy
npm run build
npm run demo:research
npm run benchmark:research
npm run report:safety
npm run test:mvp
```

`demo:research` 输出示例：

```text
final state : completed
message     : Read-only research demo completed: 4 headings, 3 plan rows, 3 FAQ items.
trace       : ../../output/2026-06-26T08-53-43/trace.jsonl
max risk    : L0
```

`report:safety` 对 latest research benchmark 输出：

```text
status  : completed
summary : Run ended with status completed; 0 high-risk policy decision(s) were recorded.
```

边界检查通过：

```bash
rg -n "page-state-latest|form-state-latest|output/traces|readFileSync|readFile" \
  packages/web-buddy/src/agent \
  packages/web-buddy/src/context \
  packages/web-buddy/src/runtime/local \
  packages/web-buddy/src/tools \
  packages/web-buddy/src/policy \
  packages/web-buddy/src/workflow \
  --glob '*.ts'
```

结果只有 `packages/web-buddy/src/policy/safety-report.ts` 命中 `readFileSync`，符合旁路 safety report 读取 trace artifacts 的边界。

额外检查：

```bash
git diff --check
```

通过。

### 结论

- Phase 5B 已完成第一版 MVP Packaging。
- README 第一屏已从 job-only 调整为 local auditable Web Agent runtime。
- 新用户可以先跑 `demo:form` / `demo:research`，再查看 metrics / safety report，不需要真实招聘网站。
- 求职投递被保留为 flagship workflow，而不是唯一能力。
- `packages/claude-code` 未改。

### 遗留问题 / 下一步

- `demo:research` 当前是确定性本地 fixture，不包含 LLM 总结；后续可在不影响稳定性的前提下增加可选模型总结。
- Web UI 仍主要呈现已有 runtime 面板，后续可把 research demo 和 safety report 入口做进 UI。
- Phase 6 WorkflowEngine / SkillSystem 仍暂缓，等 MVP 包装继续稳定后再启动。

## 2026-06-26 Phase 5: Policy Engine v1 / Policy Audit Skeleton 收尾

### 背景

- Phase 4D 已经具备 WorkflowState / WorkflowTransition / workflow-aware policy，能区分 apply entry 和 final submit。
- 下一步需要把原有 `PolicyDecision helper` 升级为更稳定的 policy boundary，让安全判断具备稳定 reason、ruleId、policyCode，并能进入 trace / metrics / safety report 复盘。

### 改动

- 新增 `packages/web-buddy/src/policy/policy-engine.ts`：
  - 提供 `PolicyEngine.evaluate()`。
  - 保留 `decideToolPolicy()` 兼容 facade。
  - 输出 `schemaVersion`、`policyCode`、`ruleId`、`workflowPhase`、`auditTags`。
- 新增 `packages/web-buddy/src/policy/policy-audit.ts`：
  - 定义 `PolicyAuditEvent`。
  - agent-loop 每次 policy decision 后写出 `policy_decision` trace event。
- 扩展 `packages/web-buddy/src/runtime/local/agent-loop.ts`：
  - 工具执行前调用 policy boundary。
  - gate / blocker / recent action 使用规范化 policy reason。
  - tool span metadata 写入 policy metadata。
- 扩展 metrics：
  - `RunMetrics.policy` 聚合 decisions、allows、gates、blocks、autoConfirms、gateKindCounts、policyCodeCounts、blockedReasonCounts。
- 新增 `packages/web-buddy/src/policy/safety-report.ts`：
  - 从 trace / metrics 旁路生成 safety report v1。
  - 表达 finalSubmitAttempted、finalSubmitBlocked、loginHandoffRequired、captchaHandoffRequired、highRiskActionCount、gateCount。
- 新增/更新测试脚本：
  - `policy-engine-test.mjs`
  - `safety-report-test.mjs`
  - `policy-decision-test.mjs`
  - `metrics-test.mjs`
  - `test:mvp` npm script。

### 验证

已通过：

```bash
cd packages/web-buddy
npm run test:mvp
```

`test:mvp` 覆盖：

```text
context / prompt-sections / metrics / tool-execution / policy / policy-engine
workflow / agent-runtime / agent-runtime-workflow / agent-loop
benchmark:simple / benchmark:complex / tool-catalog / observation / safety-report
```

边界检查通过：

```bash
rg -n "page-state-latest|form-state-latest|output/traces|readFileSync|readFile" \
  packages/web-buddy/src/agent \
  packages/web-buddy/src/context \
  packages/web-buddy/src/runtime/local \
  packages/web-buddy/src/tools \
  packages/web-buddy/src/policy \
  packages/web-buddy/src/workflow \
  --glob '*.ts'
```

结果只有 `safety-report.ts` 命中 `readFileSync`，这是旁路 safety report 读取 trace/metrics 的允许路径；runtime / context / workflow / tools / PolicyEngine 未读取 trace artifacts。

额外检查：

```bash
git diff --check
```

通过。

已知非本轮问题：

```bash
npx tsc --noEmit
```

仍会失败，报错位于既有未触及路径：`src/cli/demo.ts`、`src/sdk/alibaba.ts`、`src/sdk/config.ts`、`src/web/server.ts`。当前仓库默认构建使用 `npm run build` / esbuild，Phase 5 验证以现有脚本为准。

### 结论

- Phase 5 已完成第一版。
- 当前 MVP 已具备：
  - State-aware context：PageState / FormState / TaskState / WorkflowState。
  - Policy boundary：PolicyEngine / HumanGate / policy audit。
  - Observability：Trace / metrics / benchmark / safety report。
- `packages/claude-code` 未改。
- Runtime / policy / context / workflow 没有把 trace artifacts 当运行时状态源。

### 遗留问题 / 下一步

- 下一步进入 Phase 5B: MVP Packaging。
- 优先补：
  - `demo-research`，证明项目不是 job-only。
  - README / Quickstart 通用 Web Agent 定位重写。
  - Safety Model 文档。
  - examples / demo 命名和验证入口整理。
- Phase 6 WorkflowEngine 暂缓，等 MVP 包装和展示路径稳定后再做更深结构改造。

## 2026-06-26 Web Buddy local runtime 真实招聘站投递前流程复盘

### 背景

- 当前用户希望验证的是 `packages/web-buddy` 自研 local runtime，而不是恢复版 `packages/claude-code` adapter。
- 当前 Web UI `http://localhost:5178/` 主按钮实际偏向 `/api/runtime/run`，会启动 Claude adapter 面板；为了确保测试链路正确，本次真实站验证直接调用 `web-buddy` local runtime：

```text
runJobApplicationAgent(mode='fill' / mode='alibaba-apply')
-> runAgentLoop
-> ToolRegistry
-> local Playwright browser tools
```

- 测试目标不是完成最终投递，而是观察真实招聘网站中的投递前流程：

```text
职位列表
-> 职位详情
-> 点击“投递简历”进入申请流程
-> 登录 / 验证码 / 更新站内简历 / 填写表单
-> 最终提交前停止
```

### 改动

- 本次没有改代码。
- 使用一次性安全 gate 做真实站运行验证：
  - 只放行职位详情页上的“投递简历”入口点击。
  - 不放行上传简历、保存简历、最终投递、提交、确认提交等动作。
  - 遇到登录、验证码、短信验证等人类步骤时停止。
- 明确区分了当前测试中的两个入口：
  - `web-buddy` local runtime：CLI / direct node 调用 `runJobApplicationAgent -> runAgentLoop`。
  - 现有 Web UI 主 runtime 面板：偏 Claude adapter，对 local runtime 测试不够直观。

### 验证

- 构建通过：

```bash
cd packages/web-buddy
npm run build
```

- 智谱 GLM 配置可用，模型链路曾在本地 demo 表单中成功驱动 browser tools 填写草稿：

```text
final state : filled
trace       : ../../output/2026-06-25T14-50-05/trace.jsonl
max risk    : L2
```

- 阿里招聘列表页真实站非登录态探测可运行，local runtime 能打开页面、读取页面并安全停在登录/申请前边界：

```text
trace       : ../../output/2026-06-25T14-51-08/trace.jsonl
final state : stopped_at_submit
max risk    : L3
```

- 阿里专用 `alibaba-apply` orchestrator 模式可以抓职位列表并做匹配，但本轮因匹配分不足停在 `no_match`：

```text
trace       : ../../output/manual-local-runtime-2026-06-26T02-48-27-751Z/trace.jsonl
finalState  : no_match
steps       : 6
```

- 通用 `fill` 模式从列表页出发时，local runtime 可以点击职位卡片进入职位详情页；后续一轮因模型请求超时中止：

```text
trace       : ../../output/manual-local-fill-presubmit-2026-06-26T02-49-28-721Z/trace.jsonl
finalState  : blocked
message     : LLM error: Request failed: This operation was aborted
final URL   : https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=100014040009&track_id=...
```

- 直接从职位详情页启动 `fill` 模式后，local runtime 成功点击“投递简历”入口，随后跳转到阿里统一登录页并停止：

```text
trace       : ../../output/manual-local-detail-presubmit-2026-06-26T02-51-16-525Z/trace.jsonl
finalState  : blocked
maxRisk     : L3
result      : redirected to https://mozi-login.alibaba-inc.com/ssoLogin.htm
```

- 本次验证没有上传简历、没有保存简历、没有填写登录信息、没有点击最终提交。

### 结论

- `web-buddy` 自研 local runtime 已经可以在真实招聘网站上完成基础浏览、职位列表读取、职位卡片点击、职位详情页识别和“投递简历”入口点击。
- 当前主要问题不是浏览器工具完全不可用，而是 runtime 的招聘流程语义仍然太粗：
  - “投递简历”在真实流程中通常只是 `apply_entry`，不是最终提交。
  - 登录 / 验证码应该是 `human_handoff` / `pause`，不是整个任务的终止。
  - 保存站内简历、上传简历、最终确认投递需要分成不同风险语义。
- 现在模型经常把“页面上有登录”直接理解成无法继续，或把“投递/Apply”类按钮过早归入最终提交风险。
- 当前可视化测试较慢，原因包括：
  - headful + highlight + slowMo + typeDelay。
  - 每轮 ReAct 都要 LLM 调用、工具调用、snapshot 刷新和上下文重建。
  - 真实站页面文本大，prompt 和上下文容易膨胀。
  - 智谱 Anthropic-compatible 请求在长上下文/多轮后可能出现 timeout / abort。
- 当前浏览器容易关闭，原因是 CLI / Web server 的 session 生命周期偏一次性运行；blocked / login_required 后默认容易 `closeAll()`，不适合真实投递流程中的人工接管。

### 遗留问题 / 下一步

- 下一轮优先不要先做更复杂的填表，而是补 runtime workflow 语义：
  - `apply_entry`
  - `login_handoff`
  - `captcha_handoff`
  - `upload_resume`
  - `save_resume_draft`
  - `final_submit`
- 增加轻量 `WorkflowState` / 扩展 `TaskState`，建议阶段：

```text
selecting_job
job_detail
entering_application
login_required
editing_resume
filling_application
reviewing
ready_for_final_submit
done
blocked
```

- 把登录 / 验证码从 `blocked terminal state` 调整为 `pause/resume handoff`：

```text
browser remains open
user logs in
runtime refreshes PageState/FormState
continue from current workflow phase
```

- 增加 runtime speed profiles：
  - `watch`: headful + highlight + slowMo + screenshots，适合演示。
  - `normal`: headful + minimal highlight，适合真实调试。
  - `fast`: headless/headful 可选 + 精简 context + 最少截图，适合回归。
- 重做 Web UI 时必须显式区分：
  - `Local Runtime`
  - `Claude Adapter`
- Local Runtime Web UI 需要支持：
  - 当前 workflow phase。
  - 当前 gate 类型。
  - 登录/验证码 handoff 后继续。
  - 保持浏览器打开。
  - 最终提交永久保护。
  - trace / screenshot / metrics 查看。

## 2026-06-18 第一版测试通过：初步投递阿里巴巴招聘网站成功

### 背景

- 使用恢复版 Claude Code runtime + Playwright MCP + 智谱 API 跑阿里巴巴招聘网站投递链路。
- 用户完成实际测试后反馈：当前版本可以测试通过，已能初步完成阿里巴巴招聘网站投递目标。

### 改动

- 将当前工作区从 detached HEAD 状态切到正式分支：

```bash
git switch -c '第一版测试通过版<初步投递阿里巴巴招聘网站成功>'
```

### 验证

- 用户侧实际运行投递测试成功。
- 当前分支名已切换为：

```text
第一版测试通过版<初步投递阿里巴巴招聘网站成功>
```

### 结论

- 这是项目的第一版可用里程碑：在阿里巴巴官方招聘网站上，当前 agent 链路已经具备初步投递成功能力。
- 该版本可以作为后续优化岗位匹配、表单稳定性、异常恢复和可观测性的基准版本。

### 遗留问题 / 下一步

- 后续继续观察不同岗位、不同表单、登录状态过期、上传解析失败等场景下的稳定性。
- 下一轮优化建议优先记录失败 trace，并只针对真实失败点增强工具能力或 runtime 恢复能力。

## 2026-06-17 简历解析与复杂表单工具增强

### 背景

- 用户观察到 runtime 已经能登录、找到岗位并进入投递页，但在填写投递表单时报告无法继续。
- 讨论后判断核心原因不是招聘网站没有简历解析能力，而是当前 MCP 工具缺少：
  - 上传本地 PDF 简历的能力。
  - 读取复杂表单字段、必填项和错误提示的能力。
  - 通过 label/附近文本稳定填写字段的能力。
  - 操作自定义下拉、城市、学历、日期等非原生 select 组件的能力。
- 目标仍然是不写阿里专用流程，而是增强通用 runtime 工具，让模型自主执行“上传简历解析 -> 检查表单 -> 修正字段 -> 继续投递”。

### 改动

- 新增 `browser_form_snapshot`：
  - 返回字段 label、placeholder、name/id、当前值、必填、disabled、readonly、invalid、错误提示、附近文本和 select options。
  - 返回上传入口提示和页面可见错误提示。
- 新增 `browser_upload_file`：
  - 支持直接给 `input[type=file]` 设置文件。
  - 支持通过 ref、CSS selector 或可见文本点击上传入口并处理 file chooser。
  - 上传本地文件默认要求 `confirmed=true`。
- 新增 `browser_fill_by_label`：
  - 通过 label、aria-label、placeholder、name/id、附近表单文本定位字段并填写。
  - 用于 snapshot ref 变化快或字段 ref 难判断的复杂表单。
- 新增 `browser_select_by_text`：
  - 支持原生 `select` 和自定义下拉。
  - 可以通过字段 label 或 ref 打开控件，再点击可见选项文本。
- 将上述工具注册进 Playwright MCP，并加入 Claude runtime allowed tools。
- Prompt 增加表单策略：
  - 进入投递表单后优先寻找上传简历 / 简历解析 / 附件简历 / PDF 上传入口。
  - 上传简历后调用 `browser_form_snapshot` 检查解析结果、必填项和错误提示。
  - 使用 `browser_fill_by_label` 和 `browser_select_by_text` 修正缺失或错误字段。

### 验证

- 构建通过：

```bash
npm run build
```

- TypeScript 检查：

```bash
npx tsc -p tsconfig.json --noEmit
```

结果：仍有若干历史类型错误，分布在 `src/cli/demo.ts`、`src/core/agent-loop.ts`、`src/core/tool-registry.ts`、`src/sdk/alibaba.ts`、`src/sdk/config.ts`、`src/web/server.ts`；本轮新增工具可以通过构建。

- 工具级最小复现通过：
  - 临时页面包含姓名 input、城市 select、简历 file input。
  - `browser_form_snapshot` 识别到 3 个字段和 1 个上传入口。
  - `browser_fill_by_label({ label: '姓名', text: '测试用户' })` 成功。
  - `browser_select_by_text({ label: '期望城市', option: '杭州' })` 成功。
  - `browser_upload_file({ filePath, confirmed: true })` 成功。
- 默认入口 dry-run 通过，allowed tools 已包含：
  - `mcp__playwright__browser_form_snapshot`
  - `mcp__playwright__browser_upload_file`
  - `mcp__playwright__browser_fill_by_label`
  - `mcp__playwright__browser_select_by_text`

```bash
npm run alibaba:apply -- --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --dry-run
```

### 结论

- 本轮补齐了“上传简历解析”和“复杂表单补填”的基础动作能力。
- 这不是阿里专用流程，而是更通用的浏览器 MCP 工具增强。
- 下一次真实运行时，agent 应该能尝试上传 PDF 简历，让网站自动解析，再通过表单快照修正缺失字段。

### 遗留问题 / 下一步

- 自定义城市/日期/级联组件仍可能需要根据真实页面表现继续增强。
- `browser_form_snapshot` 当前返回的是字段摘要，不会创建可复用 ref；后续如果 label 匹配不稳定，可以引入稳定 field refs。
- `browser_upload_file` 对隐藏 file input、复杂上传组件和多文件上传已做基础支持，但真实站点可能还有上传后裁剪、确认、解析进度等步骤，需要通过下一次真实运行日志观察。

## 2026-06-17 非标准岗位 DOM 增加按文本点击工具

### 背景

- 用户登录交接后，第二轮 Claude runtime 仍然停止。
- 最新运行目录 `output/claude-runtime/2026-06-17T12-05-48-253Z` 显示：
  - 第一轮 `AGENT_STATUS=BLOCKED`，原因是短信验证码 / 登录。
  - wrapper 执行人工交接并保存 `manual-handoff-storage-1.json`。
  - 第二轮再次 `AGENT_STATUS=BLOCKED`，原因是模型认为岗位标题可见但不在 `browser_snapshot` refs 中，无法点击进入岗位详情。
- 根因是 `snapshot/builder.ts` 只收集标准交互元素：`a[href]`、`button`、`input`、`role=button/link` 等。阿里岗位卡片可能是普通 `div/span` 加 JS 点击事件，正文能看到标题，但不会被分配 ref。

### 改动

- 新增 MCP 工具 `browser_click_text`：
  - 按页面可见文本点击，不依赖 snapshot ref。
  - 优先选择包含该文本的最近可点击祖先节点：`a`、`button`、`role=button/link`、`onclick`、`cursor:pointer`、`tabIndex>=0`。
  - 支持 `exact`、`nth`、`timeoutMs`、`confirmed`、`highlight`。
  - 对 `投递`、`申请`、`提交` 等提交类文本仍要求 `confirmed=true`。
- 将 `browser_click_text` 注册进 Playwright MCP 工具列表。
- 将 `mcp__playwright__browser_click_text` 加入 Claude runtime allowed tools。
- Prompt 增加指导：当岗位标题 / 列表卡片 / 链接文字在正文中可见但没有 snapshot ref 时，使用 `browser_click_text`，不要因此停止。

### 验证

- 构建通过：

```bash
npm run build
```

- 默认入口 dry-run 通过，allowed tools 已包含 `mcp__playwright__browser_click_text`：

```bash
npm run alibaba:apply -- --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --dry-run
```

- 构建产物确认包含：
  - `packages/web-buddy/dist/browser/click-text.js`
  - `packages/web-buddy/dist/server.js` 中的 `browser_click_text`
- 工具级最小复现通过：在临时页面中创建普通 `div onclick` 岗位标题，`browser_click_text({ text: '大模型语音工程师' })` 可以成功触发点击。

### 结论

- 这次中断的直接原因是 MCP 工具只能点击 snapshot ref，无法操作非标准 DOM 中的可见岗位标题。
- 新工具让 runtime 保持原始自主决策，同时补齐浏览器控制层能力。

### 遗留问题 / 下一步

- `browser_click_text` 可能在多个相同文本时点到第一个匹配项；必要时模型可以用 `nth` 选择后续匹配。
- 如果目标页面把岗位标题拆成多个节点，后续可能还需要增加坐标点击或 DOM 候选文本提取工具。

## 2026-06-17 登录阻塞改为人工交接续跑

### 背景

- 用户再次运行后任务中断。
- 最新运行目录 `output/claude-runtime/2026-06-17T11-55-55-998Z` 显示：
  - `exitCode=0`
  - `signal=null`
  - `agent_status=blocked`
- `stdout.log` 显示模型不是崩溃，而是判断阿里招聘需要登录后才能继续投递，于是输出 `AGENT_STATUS=BLOCKED` 并停止。
- 同时发现模型输出中可能复述简历联系方式，需要避免把手机号、邮箱等隐私字段写入 stdout 日志。

### 改动

- Claude runtime prompt 增加隐私约束：最终回答或阶段性总结不要复述用户手机号、邮箱、身份证号、住址等隐私字段。
- wrapper 默认将登录 / 验证码 / 扫码 / 身份验证等 `BLOCKED` 改为人工交接续跑：
  - 打开一个手动浏览器窗口。
  - 等用户完成登录、扫码、验证码或其他人工步骤。
  - 用户回到终端按 Enter。
  - wrapper 保存新的 Playwright storage state。
  - 重新写入 MCP config，并自动启动下一轮 Claude runtime 继续同一任务。
- 新增调试参数：
  - `--no-wait-on-blocked`
  - `--max-blocked-handoffs <n>`，默认 3 次。

### 验证

- 语法检查和默认入口 dry-run 通过：

```bash
node --check scripts/claude-runtime-alibaba.mjs
npm run alibaba:apply -- --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --dry-run
```

- 最小真实连通测试通过：

```bash
node ./scripts/claude-runtime-alibaba.mjs --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --headless --max-turns 6 --max-passes 2 --close-browser-on-exit --no-wait-on-blocked --prompt '安全连通性测试：请只打开目标网站，调用一次 browser_snapshot 确认页面可访问，然后直接总结停止。不要点击任何岗位，不要登录，不要注册，不要收藏，不要投递。最后一行必须输出 AGENT_STATUS=COMPLETED。'
```

- 测试运行目录：
  - `output/claude-runtime/2026-06-17T12-01-20-195Z`
  - `output/claude-runtime/2026-06-17T12-01-26-738Z`

### 结论

- 这次中断的直接原因是模型将“需要登录”判断为人工阻塞，而 wrapper 按 BLOCKED 终止。
- 现在默认不会直接终止，会把登录 / 验证码 / 扫码等人工步骤交给用户处理，然后自动续跑。

### 遗留问题 / 下一步

- 人工交接续跑依赖用户在终端按 Enter；如果从非交互环境运行，wrapper 会等待一段时间后继续。
- storage state 会保存在本次 `output/claude-runtime/<timestamp>/manual-handoff-storage-*.json`，包含登录态 cookie，需要当作敏感本地文件处理。

## 2026-06-17 Claude Print 模式自动续跑

### 背景

- 去掉默认 `--max-turns` 后，真实运行仍然在任务没完成时退出。
- 最近一次运行 `output/claude-runtime/2026-06-17T11-45-17-450Z/run-events.log` 显示 `exitCode=0`、`signal=null`，说明不是崩溃，也不是 turn cap，而是 Claude Code `--print` 模式收到模型最终回答后正常退出。
- 当时 wrapper 没有保存 stdout/stderr，所以无法复盘模型最后具体说了什么。

### 改动

- 在 Claude runtime prompt 中加入终止状态协议：
  - `AGENT_STATUS=COMPLETED`
  - `AGENT_STATUS=BLOCKED`
  - `AGENT_STATUS=INCOMPLETE`
- wrapper 会捕获并实时转发 stdout/stderr，同时保存到每次运行目录：
  - `stdout.log`
  - `stderr.log`
- 如果 Claude CLI `exitCode=0`，但 stdout 中没有 `AGENT_STATUS=COMPLETED` 或 `AGENT_STATUS=BLOCKED`，wrapper 默认自动启动下一轮，把上一轮输出摘要和原始任务继续交给 Claude runtime。
- 新增调试参数：
  - `--no-auto-continue`
  - `--max-passes <n>`

### 验证

- 语法检查、构建和 dry-run 通过：

```bash
node --check scripts/claude-runtime-alibaba.mjs
npm run build
npm --prefix ../claude-code run build
npm run alibaba:apply -- --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --dry-run
```

- 带终止标记的最小真实连通测试通过：

```bash
node ./scripts/claude-runtime-alibaba.mjs --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --headless --max-turns 6 --max-passes 2 --close-browser-on-exit --prompt '安全连通性测试：请只打开目标网站，调用一次 browser_snapshot 确认页面可访问，然后直接总结停止。不要点击任何岗位，不要登录，不要注册，不要收藏，不要投递。最后一行必须输出 AGENT_STATUS=COMPLETED。'
```

- 测试运行目录：
  - `output/claude-runtime/2026-06-17T11-52-52-060Z`
  - `output/claude-runtime/2026-06-17T11-52-52-696Z`
- `run-events.log` 已记录：
  - `agent_status=completed`
  - `stop reason=completed`

### 结论

- 这次调整解决的是 Claude Code `--print` 模式“模型给了阶段性 final 就退出”的问题。
- 这仍然不是阿里投递业务流程限制，而是外层 runtime 对非交互 CLI 的续跑机制。

### 遗留问题 / 下一步

- 自动续跑跨进程时，浏览器 MCP server 可能重新启动，页面状态不一定完全保留；续跑 prompt 会要求必要时重新打开目标网站并继续。
- 如果真实运行再次停止，可以直接查看 `run-events.log`、`stdout.log`、`stderr.log` 判断原因。

## 2026-06-17 Claude Runtime 不中途截断调整

### 背景

- 用户再次真实运行后观察到任务未完成就中断。
- 现有 Claude runtime wrapper 默认传入 `--max-turns 80`，而 Claude Code 非交互模式到达该 turn 数后会 early exit，容易造成“还没投递完就停”的体验。

### 改动

- `packages/web-buddy/scripts/claude-runtime-alibaba.mjs` 默认不再传 `--max-turns`，让 Claude Code runtime 自己持续推进，直到模型完成、遇到人工阻塞或进程级错误。
- `--max-turns <n>` 保留为可选调试参数；`--max-turns 0`、`none`、`unlimited` 都会被视为不设上限。
- 浏览器默认保持打开，新增 `--close-browser-on-exit` / `--no-keep-browser-open` 用于短测试时关闭窗口。
- 每次运行新增 `run-events.log`，只记录启动命令、turn cap、浏览器保留设置、退出码和 signal，不默认记录完整简历内容。

### 验证

- 默认入口 dry-run 通过，并确认不再包含 `--max-turns`：

```bash
npm run alibaba:apply -- --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --dry-run
```

- 最小真实连通测试通过。该测试显式使用 `--max-turns 6` 和 `--close-browser-on-exit`，只用于验证 wrapper 仍可调用模型和 MCP：

```bash
node ./scripts/claude-runtime-alibaba.mjs --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --headless --max-turns 6 --close-browser-on-exit --prompt '安全连通性测试：请只打开目标网站，调用一次 browser_snapshot 确认页面可访问，然后直接总结停止。不要点击任何岗位，不要登录，不要注册，不要收藏，不要投递。'
```

- 测试运行目录：
  - `output/claude-runtime/2026-06-17T11-42-48-461Z`
  - `output/claude-runtime/2026-06-17T11-42-48-919Z`

### 结论

- 这次调整解决的是外层 runtime turn cap 导致的强制中断问题。
- 如果之后仍然停止，需要优先查看对应运行目录里的 `run-events.log`，区分是模型主动结束、API 错误、MCP 错误还是人工登录 / 验证阻塞。

### 遗留问题 / 下一步

- 未给真实投递任务增加业务流程限制，仍保持 Claude runtime 自主操作。
- 长任务不再有默认 turn cap，可能消耗更多 token；调试时可以手动加 `--max-turns <n>`。

## 2026-06-17 Claude Code Runtime 接入 Playwright MCP

### 背景

- 用户希望先不继续优化本地简化版 raw agent，而是把当前阿里投递命令切到恢复出来的 `packages/claude-code` Claude Code runtime 上，观察更接近原始 Claude Code agent 的自主表现。
- 目标是保留“模型自主完成投递目标”的实验形态，不加入固定岗位筛选、固定点击路径或业务流程限制。

### 改动

- 新增 `packages/web-buddy/scripts/claude-runtime-alibaba.mjs`，作为 Claude Code runtime 接入层：
  - 启动 `packages/claude-code/dist/cli.js`。
  - 将 `packages/web-buddy/dist/server.js` 暴露为 MCP browser server。
  - 读取简历文件并在运行时传给模型。
  - 支持 `--env-file`、`--resume`、`--prompt`、`--max-turns`、`--headless/--headful`、`--dry-run`、`--stream-json` 等参数。
  - 默认只保存脱敏后的 `prompt.redacted.txt`，避免把完整简历内容写进运行目录。
  - 真实运行时通过 stdin 把完整 prompt 传给 Claude CLI，避免简历正文出现在子进程命令参数中。
- 将 `packages/web-buddy` 的默认 `npm run alibaba:apply` 改为 Claude Code runtime 路径。
- 保留旧的本地简化 raw agent 入口为 `npm run alibaba:apply:raw`，方便对比。
- 增加 `npm run alibaba:claude` 作为 Claude runtime 实验入口别名。
- 更新根 README 和 `packages/web-buddy/README.md`，说明新旧两条运行路径。
- 修复恢复源码中的运行时缺失模块：
  - 新增 `packages/claude-code/src/utils/filePersistence/types.ts`。
  - 该模块只补齐 file persistence 启动所需的类型和常量，避免 runtime 启动时报 `DEFAULT_UPLOAD_CONCURRENCY` 缺失。

### 验证

- 安装依赖：

```bash
npm install
npm --prefix ../claude-code install
```

- 构建通过：

```bash
npm run build
npm --prefix ../claude-code run build
```

- dry-run 通过，生成 MCP 配置和脱敏提示词，不实际调用模型：

```bash
node ./scripts/claude-runtime-alibaba.mjs --resume '/path/to/resume.pdf' --dry-run
```

- 最小真实连通性测试通过：

```bash
node ./scripts/claude-runtime-alibaba.mjs --env-file '/path/to/.env' --resume '/path/to/resume.pdf' --headless --max-turns 6 --prompt '安全连通性测试：请只打开目标网站，调用一次 browser_snapshot 确认页面可访问，然后直接总结停止。不要点击任何岗位，不要登录，不要注册，不要收藏，不要投递。'
```

- 测试运行目录：
  - `output/claude-runtime/2026-06-17T11-33-00-055Z`
  - `output/claude-runtime/2026-06-17T11-35-46-962Z`

### 结论

- 当前默认阿里投递命令已经不是之前的本地简化 raw agent，而是恢复版 Claude Code runtime + Playwright MCP。
- 这条链路已经验证可以实际调用模型、打开阿里招聘页面、获取页面快照并正常退出。
- `packages/claude-code` 恢复源码仍可能存在少量缺失文件或运行期兼容问题；这次遇到并修复了 file persistence 的 `types.ts` 缺失。

### 遗留问题 / 下一步

- 下一步可以跑一次非安全提示词的真实投递观察，看 Claude runtime 在没有固定流程限制时会如何搜索、筛选和处理登录 / 表单。
- 如果继续出现 runtime 级别的缺失模块，需要逐个补齐恢复源码缺口，并记录对应错误和修复。
- 依赖安装后 npm 报告了若干安全漏洞，当前没有执行自动修复，避免引入额外不可控变更。

## 2026-06-17 原始 Playwright Agent 投递实验

### 背景

- 目标是绕开原先 web 端和硬编码投递流程，直接使用当前本地 runtime + Playwright 浏览器能力，让大模型基于简历和自然语言目标自主完成阿里官方招聘网站的岗位查找与投递。
- 用户希望观察“最原始的 agent 现在能做到什么程度”，因此不希望加入固定的岗位筛选、匹配、投递流程限制。

### 改动

- 新增 `raw <url>` 运行模式，用于让 LLM 直接驱动浏览器完成目标。
- 将 `alibaba-apply` 快捷命令改为走 raw agent，不再默认走旧的阿里岗位爬取 / 匹配 / 固定投递流程。
- 调整 raw 模式系统提示词，去掉面向求职投递的固定流程约束，让模型可以自主搜索、筛选、点击、填写、上传、保存或提交。
- raw 模式下绕过原先对高风险点击的额外确认门槛，避免 runtime 自己阻止模型执行投递相关按钮。
- 添加浏览器可视化辅助：
  - 浏览器默认非 headless。
  - 支持运行结束后保留浏览器窗口。
  - 页面上显示虚拟鼠标指针，点击和输入前会移动到目标元素附近。
- 增加浏览器超时配置：
  - `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS=90000`
  - `PLAYWRIGHT_ACTION_TIMEOUT_MS=20000`
- 将 `AGENT_MAX_STEPS` 调整为 50，用于避免 agent 无限循环。
- 将智谱模型从 `glm-5.1` 调整到 `glm-4.7`，规避当时 `glm-5.1` 返回 529 过载的问题。

### 验证

- `npm run build` 通过。
- `npm run test:agent-loop` 通过。
- `node dist/cli/demo.js --help` 可以看到 `raw <url>` 和 `alibaba-apply [url]` 命令。
- 最小 raw 打开页面测试通过：

```bash
PLAYWRIGHT_KEEP_BROWSER_OPEN=false PLAYWRIGHT_HEADLESS=true node ./dist/cli/demo.js raw 'https://talent-holding.alibaba.com/off-campus/position-list?lang=zh' --resume '/path/to/resume.pdf' --prompt '打开当前页面，确认页面能访问，然后立刻调用 agent_done，总结一句话即可，不要点击任何岗位。'
```

- 真实 raw 投递实验 trace：
  - `output/2026-06-17T09-19-54/trace.jsonl`
  - `output/2026-06-17T09-19-54/summary.json`

### 结论

- 这次运行不是 fatal error，也不是浏览器或模型接口直接崩溃，而是 agent 跑满 50 步预算后停止：

```text
Reached step budget (50) without agent_done.
```

- 当前原始 agent 可以打开阿里招聘页面、点击筛选项、进入登录 / 注册页面、回到岗位列表并继续操作。
- 但它还不能稳定完成“找合适岗位并投递”的完整目标。主要问题是：
  - 页面变化后，模型会继续使用已经失效的元素引用。
  - 搜索框或筛选控件失效后，模型容易反复对同一个旧 ref 输入。
  - 登录 / 注册流程判断能力弱，容易偏离投递目标。
  - 缺少失败后的自动恢复机制，导致原地打转直到耗尽步数。

### 遗留问题 / 下一步

- 优先增强 runtime 层，而不是增加阿里投递业务流程限制：
  - 当 `browser_click` / `browser_type` 遇到 stale ref、元素不存在或页面快照失效时，自动重新抓取 snapshot 并反馈给模型。
  - 在工具结果里更清楚地告诉模型当前页面状态和失败原因。
  - 保持 raw agent 自主决策，但提升浏览器操作失败后的恢复能力。
- 可以考虑把 `AGENT_MAX_STEPS` 临时提高到 100 做观察，但这只能延长运行时间，不能根本解决 stale ref 和目标偏移问题。
