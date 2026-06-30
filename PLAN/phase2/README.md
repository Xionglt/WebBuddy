# Phase 2 Agent Kernel 总纲领

> 本文档是 Phase 2 的主纲领。Phase 1 的历史计划已经归档到 `PLAN/phase1/`。
> Phase 2 对应之前讨论里的“Phase 6 底层能力建设”，目标不是继续堆 Web demo，而是先把 Agent 必需的通用底座补稳。
> 架构图见 `PLAN/phase2/architecture-clear.md`；完整大图见 `PLAN/phase2/architecture.md`。如果 Markdown 预览不渲染 Mermaid，直接用浏览器打开 `PLAN/phase2/architecture.html`。
> 第一份实施计划见 `PLAN/phase2/plan1.md`。第二份实施计划见 `PLAN/phase2/plan2.md`。第三份实施计划见 `PLAN/phase2/plan3.md`。第四份实施计划见 `PLAN/phase2/plan4.md`。
> Plan 2 完成后的通俗解释和架构变化图见 `PLAN/phase2/plan2-completion-explanation.md`。
> Plan 3 完成后的功能、意义和第一性原理沉淀见 `PLAN/phase2/plan3-completion-explanation.md`。
> Plan 4 完成后的 PermissionEngine / ApprovalQueue 集成说明见 `PLAN/phase2/plan4-completion-explanation.md`。
> Plan 5 完成后的 Context Compaction / Run Summary 集成说明见 `PLAN/phase2/plan5-completion-explanation.md`。
> Plan 6 完成后的 WorkflowEngine / Evidence System 集成说明见 `PLAN/phase2/plan6-completion-explanation.md`。
> Plan 7 完成后的 CompletionGate / WorkflowGuard 集成说明见 `PLAN/phase2/plan7-completion-explanation.md`。
> Plan 8 完成后的 UserConfirmEvidence / Resume Completion 集成说明见 `PLAN/phase2/plan8-completion-explanation.md`。
> 第五份实施计划见 `PLAN/phase2/plan5.md`。第六份实施计划见 `PLAN/phase2/plan6.md`。第七份实施计划见 `PLAN/phase2/plan7.md`；多 Agent prompts 见 `PLAN/phase2/plan7-agent-prompts.md`。
> 第八份实施计划见 `PLAN/phase2/plan8.md`；多 Agent prompts 见 `PLAN/phase2/plan8-agent-prompts.md`。

## 1. 阶段定位

当前项目 `packages/web-buddy` 已经具备 Web Agent 的雏形：

- Browser 工具、页面快照、表单快照、引用定位。
- `ContextManager` / `PromptAssembler`。
- `PolicyEngine` / HumanGate / safety report。
- 轻量 `WorkflowState` / `transitionWorkflowState`。
- trace / metrics / demo / benchmark。

但它还不是一个成熟 Agent Runtime。它更像“可审计的 Web 自动化运行器”，还缺 Agent 必需的通用能力：

- 持久会话。
- 可恢复运行。
- 通用权限系统。
- 工具生命周期管理。
- 上下文压缩。
- Workflow 定义与证据系统。
- SkillSystem。
- Memory。
- 命令系统。
- 任务驾驶舱。
- 环境诊断。

`packages/claude-code` 作为对比参照，不是要照搬它的代码，而是学习它的系统结构：

- `query.ts`: Agent 主循环和 turn 状态。
- `Tool.ts`: 统一工具上下文与权限上下文。
- `tools.ts`: 工具注册与基础工具集合。
- `services/tools/*`: 工具调度、并发、streaming tool executor。
- `utils/sessionStorage.ts`: JSONL transcript 与 session 文件。
- `utils/sessionRestore.ts`: 从 transcript 恢复会话状态。
- `services/compact/*`: 上下文压缩。
- `commands.ts`: slash command 与用户操作入口。
- `skills/*` / `plugins/*`: 技能和插件注册。

Phase 2 的核心目标：

> 把项目从 Web 自动化 runtime，升级为可恢复、可确认、可解释、可复用经验的 Agent Kernel。Web 只是第一个垂直执行域，不能成为底层架构的全部。

### 1.1 Plan 2 / Plan 3 / Plan 4 的当前位置

Plan 2、Plan 3 和 Plan 4 是 Phase 2 拆 `runAgentLoop` 的连续步骤，但它们拆的是不同层次：

```text
Plan 2 = 把运行入口包进 Kernel。
Plan 3 = 把工具执行从 runAgentLoop 拆出去。
Plan 4 = 把 Policy 和 Permission 分层。
```

Plan 2 完成后的运行链路是：

```text
AgentRuntime.run()
  -> AgentKernel.start()
    -> QueryLoop.run()
      -> runAgentLoop()
```

也就是说，Plan 2 没有重写主循环，而是先把外部入口、run 生命周期、abort 控制、turn snapshot 和 kernel result 放到稳定边界里。`runAgentLoop` 仍然负责模型调用、工具调用、Policy、HumanGate、workflow transition 和 session recording。

Plan 3 的位置是在这个 wrapper 里面继续拆执行层：

```text
QueryLoop
  -> runAgentLoop
    -> ToolExecutionService
```

Plan 3 不是让 `QueryLoop` 直接调度 tools，也不是重写模型 turn。它只把“policy / gate 已经放行之后，单个工具调用如何执行”从 `runAgentLoop` 里抽成 `ToolExecutionService v1`。

`ToolExecutionService v1` 解决的是工具执行生命周期问题：

- 给单个 tool call 建立 `ToolUseContext`。
- 记录 queued / running / succeeded / failed / cancelled / timed_out 等执行状态。
- 统一 timeout。
- 统一 abort-before-execution。
- 统一 error normalization，把异常、超时、未知工具、失败 observation 归一成稳定结果。
- 保持 `ToolExecutionBoundary`、`AgentRuntimeResult`、session transcript 和模型可见 observation 兼容。

它不解决任务决策问题：

- `PolicyEngine` 仍负责风险判断和 allow / gate / block / auto-confirm 建议。
- `PermissionEngine` 是后续阶段的通用许可和确认队列，不属于 Plan 3 v1。
- `HumanGate` 仍负责和用户确认或 handoff。
- `WorkflowState` / 后续 `WorkflowEngine` 仍负责任务阶段和完成证据。
- `ToolExecutionService` 不决定是否允许执行工具，不写 workflow 结论，也不做自动 retry。

Phase 2C v1 的边界要写窄：

- 做 timeout。
- 做 abort-before-execution。
- 做 error normalization。
- 不承诺完整 pause / resume。
- 不承诺自动 retry。
- 不承诺强制中断已经进入 Playwright 的动作。
- 不做并发工具执行、streaming tool output、tool result token budget、PermissionEngine 或 WorkflowEngine。

新增验证入口：

```bash
npm run test:tool-execution-service
```

完整兼容验证仍应覆盖：

```bash
npm run test:tool-execution
npm run test:agent-loop
npm run test:kernel
npm run test:session
npm run test:mvp
```

Plan 4 的位置是在工具执行前继续拆安全和许可边界：

```text
runAgentLoop
  -> PolicyEngine.evaluate()
  -> PermissionEngine.evaluate()
  -> ApprovalQueue.enqueue() if ask
  -> HumanGate.confirm() if ask
  -> ApprovalQueue.resolve()
  -> ToolExecutionService.execute() only if allowed and approved
```

这一步不是让 `QueryLoop` 直接调度 permissions，也不是让 `ToolExecutionService` 变成安全系统。Plan 4 只把现有 gate 语义提升成通用 permission 协议，让每个工具调用在 policy 之后都有一致的 allow / ask / deny 结论。

职责边界要保持清楚：

- `PolicyEngine` 负责风险判断和策略建议，继续输出 allow / gate / block / auto-confirm、risk、policyCode、ruleId 和原因。
- `PermissionEngine` 负责执行许可判断，把 policy recommendation、tool metadata、workflow phase 和安全模式规整成 allow / ask / deny。
- `ApprovalQueue v1` 只保存本次运行内的 pending / resolved approval 状态，供 runtime 和未来 UI 观察；它不判断风险、不调用用户、不执行工具。
- `HumanGate` 仍然负责实际询问用户，并返回 approve / decline / takeover。
- `ToolExecutionService` 仍然只在 permission allow 且必要 approval 通过后执行工具。

Phase 2D / Plan 4 v1 的能力边界也要写窄：

- 只做 allow / ask / deny。
- 只做内存态 `ApprovalQueue v1`，不做持久 approval queue。
- 不做完整 `PermissionStore`，不写入“总是允许”或“本 session 永久允许”规则。
- 不做完整 Task Cockpit UI，只提供未来 UI 可读取的 queue snapshot / events。
- 不改变 `HumanGate.confirm()` 接口，实际询问用户仍由 HumanGate 完成。
- 不改变 final submit 必须人工接管的安全语义。

Plan 4 实现时应新增的验证入口：

```bash
npm run test:permission
npm run test:approval-queue
```

如果 `test:approval-queue` 被合并进 `test:permission`，文档和 package script 要明确说明。完整兼容验证仍应覆盖：

```bash
npm run build
npm run test:agent-loop
npm run test:kernel
npm run test:session
npm run test:mvp
```

## 2. 第一性原理

### 2.1 Agent 不是脚本

脚本的本质是固定流程。Agent 的本质是：

1. 观察当前世界状态。
2. 基于目标和上下文做不确定决策。
3. 调用工具改变世界。
4. 记录结果和证据。
5. 在失败、打断、权限阻塞、上下文过长时恢复。

所以 Agent 底层必须有状态、权限、恢复、压缩和工具生命周期，而不仅是“LLM 选择一个 tool”。

### 2.2 Runtime State 不能依赖 Trace

Trace 是旁路审计，不是运行时数据库。

当前项目已经强调 `ContextManager` 不读取 trace artifacts，这是对的。Phase 2 要继续坚持：

- runtime state 存在 `SessionStore` / `WorkflowStore`。
- trace 只做观测、审计、报告。
- safety report 可以读 trace，但 runtime 不可以通过读 trace 决策。

### 2.3 LLM 负责判断，Kernel 负责秩序

LLM 可以判断下一步做什么，但不能负责整个系统秩序。

Kernel 必须负责：

- turn 生命周期。
- 工具调用队列。
- 权限确认。
- retry / timeout / abort。
- token budget。
- context compaction。
- session persistence。
- workflow transition。
- event streaming。

如果这些逻辑塞进 prompt 或 agent-loop，体验会越来越不可控。

### 2.4 Workflow 定义成功，Policy 定义边界

Workflow 回答：“任务现在在哪一步，怎样算完成，证据是否足够。”

Policy 回答：“这个动作是否允许，是否需要用户确认，风险是什么。”

两者不能混在一起：

- final submit 需要 Workflow 确认证据是否足够。
- final submit 也需要 Policy 确认风险是否可接受。
- UI 负责把确认权交给用户。

### 2.5 Skill 是经验，不是工具

Tool 是可执行动作，例如 click、fill、open、screenshot。

Skill 是可复用操作知识，例如：

- 招聘投递流程。
- 阿里招聘站点特例。
- 表单字段识别策略。
- 登录/CAPTCHA handoff 策略。
- 成功页面证据判断。
- 失败恢复策略。

没有 SkillSystem，Agent 每次都会像第一次上网一样笨。

## 3. 总体目标架构

Phase 2 后的目标结构：

```text
packages/web-buddy/src/
  kernel/
    agent-kernel.ts
    query-loop.ts
    turn-state.ts
    run-controller.ts
    kernel-events.ts
    token-budget.ts

  session/
    session-store.ts
    transcript.ts
    resume.ts
    content-address.ts

  tools/
    tool-contract.ts
    tool-execution-service.ts
    tool-result.ts
    tool-errors.ts
    tool-progress.ts
    registry.ts

  permission/
    permission-engine.ts
    permission-store.ts
    permission-rules.ts
    approval-queue.ts

  workflow/
    workflow-definition.ts
    workflow-engine.ts
    workflow-instance.ts
    workflow-store.ts
    workflow-evidence.ts
    workflow-guards.ts

  skills/
    skill-registry.ts
    skill-loader.ts
    skill-recommender.ts
    skill-context.ts
    builtin/
      job-application/
      alibaba-careers/
      web-research/

  memory/
    memory-store.ts
    memory-extractor.ts
    profile-memory.ts
    project-memory.ts

  commands/
    command-registry.ts
    builtin-commands.ts

  diagnostics/
    doctor.ts
    env-check.ts
    provider-check.ts

  web/
    task-cockpit server and UI integration
```

不是所有文件都要一次建完。Phase 2 要按闭环推进，先让最小 Kernel 可运行，再逐步替换当前 monolithic loop。

## 4. 模块计划

## 4.1 Agent Kernel / Query Loop

### 当前状态

当前主循环集中在 `packages/web-buddy/src/runtime/local/agent-loop.ts`：

- 接收 goal、LLM、registry、trace、resume。
- 构造 prompt。
- 调用模型。
- 解析 tool call。
- 做 policy 决策。
- 执行工具。
- 更新 workflow state。
- 写 trace。
- 判断停止。

`AgentRuntime` 只是 facade，仍然委托 `runAgentLoop`。

### Claude Code 参照

`claude-code` 的 `query.ts` 更像真正的 agent kernel：

- 有 turn state。
- 有 streaming tool executor。
- 有 auto compact tracking。
- 有 tool result budget。
- 有 stop hooks。
- 有 queued commands。
- 有 pending tool use summary。
- 有 abort / transition / recovery 逻辑。

### 差异

当前项目缺少：

- 明确的 `TurnState`。
- 明确的 `AgentRunController`。
- 工具调用和模型调用之间的事件协议。
- 中断、恢复、取消。
- token budget 和 tool result budget。
- stop hook / after turn hook。
- tool call 和 workflow transition 的解耦。

### 改动方案

新增 `kernel/`：

- `AgentKernel`: 对外入口，负责 start/resume/stop。
- `QueryLoop`: 内部循环，负责模型 turn 与工具 turn。
- `TurnState`: 当前轮次状态，包含 messages、tool calls、budget、workflow snapshot。
- `AgentRunController`: abort、pause、resume、stop。
- `KernelEvent`: 统一事件流，供 CLI/Web UI/trace 订阅。
- `TokenBudget`: 统计 prompt、completion、tool result、compaction 预算。

迁移策略：

1. 第一版 Kernel 仍可调用现有 `runAgentLoop` 内部逻辑，但事件和状态由 Kernel 接管。
2. 第二步把模型调用、工具执行、workflow transition 从 `runAgentLoop` 拆出。
3. 第三步让 `AgentRuntime` 改为委托 `AgentKernel`。
4. `runAgentLoop` 保留兼容层，直到 CLI/demo 完成迁移。

### 原理

Agent 的核心不是“循环”，而是“可控的 turn 状态机”。只有 Kernel 拥有 turn 状态，后面 session、resume、UI、permission、workflow 才能稳定接入。

### 验收标准

- 可以启动一个 run，获得稳定的 `runId/sessionId`。
- 每一轮模型调用、工具调用、权限阻塞、workflow transition 都产生 `KernelEvent`。
- 可以在工具执行前 abort。
- 可以在 HumanGate 阻塞后 resume。
- CLI/demo 不因为 Kernel 引入而改变外部行为。

## 4.2 Session Store / Transcript / Resume

### 当前状态

当前项目有 trace、metrics、web server 内存 run map，但缺少真正 session store。

问题：

- 运行中断后无法可靠恢复。
- Web UI 刷新后状态主要依赖内存。
- trace 是审计输出，不适合做恢复来源。
- 没有完整 JSONL transcript。
- 没有 session metadata、title、source、createdAt、updatedAt。

### Claude Code 参照

`claude-code` 有完整 session storage：

- session 文件路径。
- JSONL transcript。
- resume loader。
- session restore。
- content replacement。
- file history / attribution。
- subagent transcript。

### 差异

你的项目现在只有“运行痕迹”，没有“会话事实源”。

Trace 记录发生过什么；SessionStore 要记录恢复所需的最小真实状态：

- 用户目标。
- 消息历史。
- 工具调用和工具结果。
- 权限确认结果。
- workflow snapshot。
- evidence。
- 当前阻塞原因。
- resume cursor。

### 改动方案

新增：

- `session/session-store.ts`
- `session/transcript.ts`
- `session/resume.ts`

建议数据形态：

```ts
interface AgentSession {
  sessionId: string
  runId: string
  source: 'cli' | 'web' | 'sdk' | 'benchmark'
  status: 'running' | 'blocked' | 'completed' | 'failed' | 'aborted'
  goal: string
  createdAt: string
  updatedAt: string
  transcriptPath: string
  snapshotPath: string
}

type TranscriptEntry =
  | { type: 'user_message'; content: string; ts: string }
  | { type: 'assistant_message'; content: unknown; ts: string }
  | { type: 'tool_call'; toolCallId: string; name: string; args: unknown; ts: string }
  | { type: 'tool_result'; toolCallId: string; result: unknown; ts: string }
  | { type: 'permission_decision'; decision: unknown; ts: string }
  | { type: 'workflow_snapshot'; snapshot: unknown; ts: string }
  | { type: 'kernel_event'; event: unknown; ts: string }
```

目录建议：

```text
output/sessions/
  <sessionId>/
    session.json
    transcript.jsonl
    workflow.json
    evidence.json
```

### 原理

Agent 的恢复能力来自“append-only transcript + 当前 snapshot”。append-only 保证审计，snapshot 保证恢复效率。

### 验收标准

- 每次运行都生成 session。
- Web UI 刷新后可以从 session 恢复 run 状态。
- HumanGate 阻塞后重启进程仍能看到待确认事项。
- completed/failed/aborted 状态能被持久化。
- trace 删除后 session resume 不受影响。

## 4.3 Tool Contract / Tool Execution Service

### 当前状态

当前有：

- `ToolRegistry`
- `tools/catalog.ts`
- `tools/local-adapter.ts`
- `tools/mcp-adapter.ts`
- `ToolExecutionBoundary`

`ToolExecutionBoundary` 明确不拥有 policy、retry、queue、browser calls。这是边界清楚的优点，但 Phase 2 需要补一个真正执行服务。

### Claude Code 参照

`claude-code` 的关键不是工具数量，而是工具协议：

- `ToolUseContext`
- `ToolPermissionContext`
- `runTools`
- `runToolsSerially`
- `runToolsConcurrently`
- `StreamingToolExecutor`
- tool progress update
- tool error normalization

### 差异

当前项目工具还偏函数式：

- 缺少统一 `ToolUseContext`。
- 缺少工具执行状态：queued/running/succeeded/failed/cancelled/blocked。
- 缺少 timeout / retry / abort。
- 缺少工具结果预算。
- 缺少 progress 事件。
- 缺少 stale reference 自动刷新策略。
- 缺少统一错误分类。

### 改动方案

新增：

- `tools/tool-contract.ts`
- `tools/tool-execution-service.ts`
- `tools/tool-result.ts`
- `tools/tool-errors.ts`
- `tools/tool-progress.ts`

建议接口：

```ts
interface ToolUseContext {
  sessionId: string
  runId: string
  turnId: string
  toolCallId: string
  abortSignal: AbortSignal
  emit: (event: KernelEvent) => void
  requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>
  getWorkflowSnapshot: () => WorkflowSnapshot | undefined
  addEvidence: (evidence: WorkflowEvidence) => void
}

interface ToolExecutionService {
  execute(call: ToolCall, context: ToolUseContext): Promise<ToolExecutionResult>
}
```

迁移方式：

1. 包一层现有 `ToolRegistry.execute`。
2. 加入 timeout、abort、event。
3. 加入 error normalization。
4. 加入 retry policy。
5. 加入 tool result budget。
6. 再逐步支持并发或串行策略。

### 原理

工具不是普通函数。工具是 Agent 对外部世界的写操作，必须被生命周期管理、权限管理和证据系统包住。

### 验收标准

- 每个工具调用都有唯一 `toolCallId`。
- 工具执行状态可被 UI 实时展示。
- 工具 timeout 会产生可恢复错误。
- 用户 abort 能中断等待中的工具。
- 工具失败后 Kernel 能决定 retry、handoff 或停止。

## 4.4 Permission Engine / Human Gate

### 当前状态

当前有 `PolicyEngine` 和 HumanGate，主要围绕 Web 风险：

- allow
- gate
- block
- auto-confirm
- final submit
- login/captcha
- raw mode

这是 Web 安全的基础，但不是完整权限系统。

### Claude Code 参照

`claude-code` 有更通用的权限层：

- 工具调用前统一 `canUseTool`。
- config allow/deny/ask。
- dangerous bash permission detection。
- auto mode 降级。
- permission queue。
- 不同来源权限规则。
- UI 中的确认请求。

### 差异

当前项目缺：

- 权限来源：default/config/session/user/policy。
- 权限持久化：本次允许/总是允许/拒绝。
- 权限队列。
- 权限模式：ask/auto/deny/readonly/dangerous。
- 权限解释：为什么这个动作需要确认。
- 权限与 workflow evidence 的联合判断。

### 改动方案

长期目标会新增：

- `permission/permission-engine.ts`
- `permission/permission-store.ts`
- `permission/permission-rules.ts`
- `permission/approval-queue.ts`

Plan 4 / Phase 2D v1 只落第一层边界：`permission-engine.ts`、`permission-rules.ts`、`approval-queue.ts` 和类型定义。持久 `permission-store.ts`、跨进程恢复、remembered permission rules 和完整权限配置文件留到后续计划。

保留 `PolicyEngine`，但调整职责：

- `PolicyEngine`: 计算风险和策略建议。
- `PermissionEngine`: 决定本次请求是 allow、ask 还是 deny。
- `HumanGate`: 负责和用户交互。

建议决策结构：

```ts
interface PermissionDecision {
  action: 'allow' | 'ask' | 'deny'
  source: 'policy' | 'user' | 'session_rule' | 'config_rule' | 'default'
  risk: 'low' | 'medium' | 'high' | 'critical'
  reason: string
  rememberable: boolean
}
```

### 原理

Policy 是“风险判断”，Permission 是“执行许可”。HumanGate 是“把决定权交还给人”。三者必须分层。

### 验收标准

- final submit、文件上传、外部导航等动作都走同一权限入口。
- v1 至少能用内存 `ApprovalQueue` 表达 pending / resolved 待确认项。
- 用户确认结果写入 session transcript/events。
- 权限拒绝后 workflow 进入 blocked，而不是假装完成。
- safety report 能列出权限来源和用户确认。

Plan 4 v1 不要求完整 Task Cockpit UI，不要求持久 permission store，也不要求“总是允许”或“本 session 永久允许”规则生效。

## 4.5 Context Budget / Compaction

### 当前状态

当前 `ContextManager` 能从 observation memory 构造上下文，避免读取 trace artifacts。这是正确地基。

但还缺：

- 长任务历史压缩。
- token budget 策略。
- tool result budget。
- 压缩后的 resume summary。
- 压缩质量验证。

### Claude Code 参照

`claude-code` 有 compact service：

- 自动 compact tracking。
- post compact messages。
- session memory compact。
- slash command compact。
- compact 后清理缓存。

### 差异

当前项目是“当前页面上下文管理”，不是“完整对话上下文管理”。

Web Agent 的长任务会出现：

- 多页跳转。
- 多次失败尝试。
- 多次表单修正。
- 登录中断。
- 用户确认后继续。

没有 compaction，模型会丢失关键事实或被无关 history 淹没。

### 改动方案

新增：

- `kernel/token-budget.ts`
- `context/compaction.ts`
- `context/run-summary.ts`

压缩内容必须包含：

- 用户目标。
- 当前 workflow phase。
- 已完成步骤。
- 当前页面状态摘要。
- 关键证据。
- 已失败尝试。
- 用户确认和拒绝。
- 下一步建议。

禁止包含：

- 全量 DOM。
- 大段 trace。
- 无关工具噪声。

### 原理

Context 不是越多越好。Agent 需要的是“当前决策所需 working set”。Transcript 用于审计，Context 用于决策，两者不能混同。

### 验收标准

- 超过 token 阈值时自动 compact。
- compact 后 session 仍可 resume。
- compact summary 写入 session，而不是 trace。
- 至少有测试证明关键 evidence 不会在 compact 后丢失。

## 4.6 Workflow Engine / Evidence System

### 当前状态

当前有轻量 `WorkflowState` 和 `transitionWorkflowState`。

优点：

- 已经能表达 apply entry、final submit 等阶段。
- Policy 可以感知 workflow phase。

缺点：

- 没有 `WorkflowDefinition`。
- 没有 `WorkflowInstance`。
- 没有持久化。
- 没有 evidence model。
- 没有 guard。
- 没有 resume point。
- 没有完整 success/failure 判定。

### Claude Code 参照

`claude-code` 不完全是工作流产品，但它有成熟的任务状态思想：

- todo/task update。
- query state。
- session restore。
- permission gate。
- command control。

你的项目更需要显式 Workflow，因为 Web 任务天然有阶段和成功证据。

### 差异

当前 Workflow 是“启发式状态更新”，不是“可执行工作流实例”。

### 改动方案

新增：

- `workflow/workflow-definition.ts`
- `workflow/workflow-engine.ts`
- `workflow/workflow-instance.ts`
- `workflow/workflow-store.ts`
- `workflow/workflow-evidence.ts`
- `workflow/workflow-guards.ts`

建议结构：

```ts
interface WorkflowDefinition {
  id: string
  name: string
  steps: WorkflowStep[]
  successCriteria: WorkflowGuard[]
  failureCriteria: WorkflowGuard[]
}

interface WorkflowStep {
  id: string
  phase: string
  objective: string
  requiredEvidence?: string[]
  allowedTools?: string[]
  riskLevel?: 'low' | 'medium' | 'high'
}

interface WorkflowEvidence {
  id: string
  type: 'page' | 'form' | 'user_confirm' | 'tool_result' | 'screenshot' | 'policy'
  summary: string
  source: string
  confidence: 'low' | 'medium' | 'high'
  ts: string
}
```

优先内置三个 workflow：

- `job-application`
- `web-research`
- `generic-browser-task`

### 原理

LLM 不能自己定义“完成”。它可以判断证据，但任务是否完成必须由 WorkflowEngine 和 evidence 共同决定。

### 验收标准

- final submit 前必须有 required evidence。
- 没有成功证据时不能 optimistic complete。
- 登录/CAPTCHA 会进入 blocked/handoff。
- workflow snapshot 持久化到 session。
- safety report 能读取 workflow evidence 生成结论。

## 4.7 SkillSystem

### 当前状态

当前没有真正 SkillSystem。站点逻辑和任务逻辑散落在 orchestrator、demo、prompt、workflow transition 中。

问题：

- 经验不能复用。
- 新任务需要改代码。
- prompt 变长。
- 站点特例越来越难维护。

### Claude Code 参照

`claude-code` 的技能/命令/插件体系体现了 progressive disclosure：

- 先列技能元信息。
- 需要时查看技能详情。
- 技能可以贡献命令、工具或上下文。
- 启动时注册 bundled skills。

### Hermes 参照

Hermes 的 skills 更接近 agent 自我改进：

- `skills_list`
- `skill_view`
- `skill_manage`
- agent 能沉淀经验。

### 差异

当前项目没有：

- skill metadata。
- skill loading。
- skill recommendation。
- skill context injection。
- skill call trace。
- skill version。
- skill tests。

### 改动方案

新增：

- `skills/skill-registry.ts`
- `skills/skill-loader.ts`
- `skills/skill-recommender.ts`
- `skills/skill-context.ts`

技能目录：

```text
packages/web-buddy/skills/
  job-application/
    SKILL.md
    workflow.json
    examples/
    tests/

  alibaba-careers/
    SKILL.md
    selectors.md
    recovery.md
    evidence.md

  web-research/
    SKILL.md
    workflow.json
```

推荐策略：

- 按 user goal。
- 按 domain。
- 按 page type。
- 按 workflow phase。
- 按 historical success。

### 原理

Skill 是 Agent 的“操作记忆”。它不应该一股脑塞进 system prompt，而应该按需加载。

### 验收标准

- `skills_list` 能列出可用技能。
- `skill_view` 能读取技能详情。
- job application 任务会推荐 `job-application`。
- 阿里招聘域名会推荐 `alibaba-careers`。
- 技能注入被 trace/session 记录。

## 4.8 Memory

### 当前状态

当前简历解析、匹配、任务上下文都是一次性使用。没有长期记忆层。

缺少：

- 用户偏好。
- 项目偏好。
- 站点经验。
- 失败经验。
- 历史成功策略。

### Claude Code / Hermes 参照

Claude Code 有用户上下文、项目上下文、session history。Hermes 有更明显的 memory guidance 和 session DB。

### 改动方案

新增：

- `memory/memory-store.ts`
- `memory/memory-extractor.ts`
- `memory/profile-memory.ts`
- `memory/project-memory.ts`

Memory 类型：

- `profile`: 用户长期偏好，例如投递偏好、地区、薪资、避免公司。
- `project`: 当前项目配置和约束。
- `site`: 网站特例和历史失败点。
- `task`: 某个 workflow 的短期总结。

第一版只做显式写入，不做自动乱写：

- 用户确认后保存。
- run 完成后提取候选 memory。
- UI 展示候选，让用户接受。

### 原理

Memory 是高风险能力。写入必须可解释、可删除、可确认。不要让模型偷偷“记住”用户敏感信息。

### 验收标准

- 可以列出 memory。
- 可以删除 memory。
- 可以在 prompt 中注入被允许的 memory。
- 敏感信息默认不自动长期保存。

## 4.9 Commands / Control Plane

### 当前状态

当前主要通过 CLI demo 和 Web server API 操作。缺少统一命令系统。

### Claude Code 参照

`claude-code` 有 `commands.ts`：

- slash command。
- command registry。
- 动态命令。
- skill/plugin command。
- compact/resume/permissions/doctor 等控制入口。

### 改动方案

新增：

- `commands/command-registry.ts`
- `commands/builtin-commands.ts`

第一批命令：

- `/resume`
- `/sessions`
- `/compact`
- `/permissions`
- `/skills`
- `/memory`
- `/doctor`
- `/trace`
- `/workflow`
- `/stop`

Web UI 不一定显示斜杠命令，但后端应该共享同一 command registry。

### 原理

Agent 产品必须有控制面。用户不能只靠自然语言让 Agent 自己管理自己。

### 验收标准

- CLI 和 Web API 能调用同一 command handler。
- `/resume` 能恢复最近 session。
- `/permissions` 能查看待确认和历史确认。
- `/doctor` 能输出环境诊断。

## 4.10 Task Cockpit UI

### 当前状态

当前 Web UI 更偏日志和运行结果，不是任务驾驶舱。

已有问题文档指出：

- high-risk confirmation 不够清晰。
- completion evidence 不够明显。
- run history 不够完整。
- heartbeat 不够稳定。
- resume-first 体验不足。
- optimistic completion 风险。
- real-submit 与 demo mode 区分不够。

### Claude Code 参照

Claude Code 的 TUI 价值不是样式，而是持续暴露：

- 当前状态。
- 工具进度。
- 权限确认。
- 中断。
- resume。
- diagnostics。
- session preview。

### 改动方案

Phase 2 UI 只做“任务驾驶舱”，不是营销页：

主视图：

- 当前目标。
- 当前 workflow phase。
- 当前正在执行的 tool。
- 待确认队列。
- 关键 evidence。
- blockers。
- 最近 sessions。
- continue/resume/stop。
- demo mode / real mode 强标识。

事件来源：

- `KernelEvent`
- `WorkflowSnapshot`
- `PermissionQueue`
- `SessionStore`

### 原理

Agent 体验差通常不是模型差，而是用户不知道它在做什么、为什么停、是否真的完成。Cockpit 的目标是把不确定性变成可见状态。

### 验收标准

- 刷新页面后仍能看到当前 session。
- 有明确“等待用户确认”的状态。
- final submit 前显示 evidence 和风险。
- 完成后显示成功证据，而不是只显示 done。
- stop 后 session 状态变为 aborted。

## 4.11 Config / Doctor / Provider Setup

### 当前状态

当前有基本 config 和 model gateway，但缺系统诊断。

缺少：

- provider key 检查。
- Playwright/browser 可用性检查。
- output 目录权限检查。
- model 配置检查。
- MCP/plugin 配置检查。
- demo/real mode 检查。

### Claude Code 参照

Claude Code 启动流程很重，但值得学习：

- settings。
- auth。
- permissions。
- plugins。
- skills。
- MCP。
- diagnostics。
- feature flags。

### 改动方案

新增：

- `diagnostics/doctor.ts`
- `diagnostics/env-check.ts`
- `diagnostics/provider-check.ts`

检查项：

- Node version。
- package build。
- Playwright browser。
- model env。
- output writable。
- sessions writable。
- skills readable。
- permission config valid。

### 原理

Agent 产品的失败很多不是推理失败，而是环境失败。Doctor 能把不可见环境问题变成可操作信息。

### 验收标准

- `npm run doctor` 输出结构化诊断。
- Web UI 能显示 doctor summary。
- 缺 key、缺 browser、目录不可写时给出明确建议。

## 4.12 Observability / Trace / Metrics

### 当前状态

Trace 和 metrics 已经是当前项目比较好的部分。

需要调整的是定位：

- trace 继续做审计。
- metrics 继续做报告。
- 不让 runtime 读取 trace。
- session/workflow 才是状态事实源。

### 改动方案

扩展 trace event：

- `kernel_turn_start`
- `kernel_turn_end`
- `tool_queued`
- `tool_started`
- `tool_progress`
- `tool_completed`
- `tool_failed`
- `permission_requested`
- `permission_resolved`
- `workflow_evidence_added`
- `session_resumed`
- `context_compacted`

Safety report 增加：

- session id。
- workflow final status。
- evidence summary。
- permission summary。
- blocked reason。
- resume count。

### 原理

Observability 是看见系统，不是驱动系统。

### 验收标准

- 删除 trace 后 session 仍能 resume。
- 删除 session 后 trace 仍能用于审计，但不能 resume。
- report 能解释每次 high-risk action 为什么发生。

## 4.13 Eval / Benchmark

### 当前状态

已有 demo、benchmark、safety report，这是好基础。

缺少的是 Agent Kernel 级别 eval：

- resume eval。
- permission eval。
- compaction eval。
- workflow evidence eval。
- tool timeout eval。
- UI state eval。

### 改动方案

新增 benchmark：

- `benchmark:session-resume`
- `benchmark:permission-gate`
- `benchmark:workflow-evidence`
- `benchmark:compaction`
- `benchmark:tool-timeout`

每个 benchmark 输出：

- pass/fail。
- session artifacts。
- trace artifacts。
- safety summary。
- regression hints。

### 原理

Agent 的质量不能只看一次成功。要看中断、恢复、拒绝、失败、压缩后的行为。

### 验收标准

- 每个核心能力都有最小 benchmark。
- CI 或本地 `test:mvp` 能覆盖核心回归。
- 失败时能定位是 kernel、tool、workflow、permission 还是 context。

## 4.14 Plugin / MCP Extension

### 当前状态

当前工具体系可以接本地/MCP adapter，但还不是完整插件生命周期。

### Claude Code 参照

Claude Code 的 plugin 不是只提供工具，还可能提供：

- commands。
- skills。
- agents。
- MCP config。
- hooks。

### Phase 2 策略

不要过早做大插件市场。

先定义内部扩展接口：

```ts
interface AgentExtension {
  id: string
  tools?: ToolDefinition[]
  skills?: SkillDefinition[]
  commands?: CommandDefinition[]
  workflows?: WorkflowDefinition[]
}
```

### 原理

插件系统必须建立在稳定 Kernel、Session、Permission、Tool contract 之后。否则插件只是把混乱扩散出去。

### 验收标准

- 内置 job application 可以作为 extension 注册。
- extension 不能绕过 PermissionEngine。
- extension 工具执行进入 session/trace。

## 4.15 Multi-Agent / Delegation

### 当前状态

目前几乎没有多 Agent。

### 判断

Phase 2 不优先做复杂多 Agent。原因：

- 当前单 Agent Kernel 还不稳。
- session/resume/permission/skill 还没成型。
- 多 Agent 会放大状态和权限复杂度。

### 最小准备

只在类型上预留：

- `agentId`
- `parentSessionId`
- `childSessionId`
- `delegationReason`

### 原理

多 Agent 是放大器，不是地基。地基不稳时，多 Agent 只会放大不可控。

## 5. 实施顺序

## 5.1 Phase 2A: SessionStore + Kernel Events

目标：

- 建立 session 事实源。
- 建立 KernelEvent。
- 让当前 run 能写 transcript。

改动：

- 新增 `session/session-store.ts`。
- 新增 `session/transcript.ts`。
- 新增 `kernel/kernel-events.ts`。
- 在现有 `runAgentLoop` 旁路写 session，不改变行为。

验收：

- 每次 demo 都生成 `output/sessions/<sessionId>`。
- transcript 包含 user、assistant、tool_call、tool_result、workflow_snapshot。
- 删除 trace 后 session 文件仍完整。

## 5.2 Phase 2B: AgentKernel Skeleton

目标：

- 引入 `AgentKernel`。
- `AgentRuntime` 委托 Kernel。
- 保持 demo 兼容。

改动：

- 新增 `kernel/agent-kernel.ts`。
- 新增 `kernel/query-loop.ts`。
- 新增 `kernel/turn-state.ts`。
- `AgentRuntime.run()` 调用 `AgentKernel.run()`。

验收：

- `npm run build`。
- 原 demo 和 benchmark 仍能跑。
- KernelEvent 能被 Web server 转发。

## 5.3 Phase 2C: ToolExecutionService + ToolUseContext

目标：

- 工具调用进入统一生命周期。
- v1 只承诺 timeout、abort-before-execution 和 error normalization。
- 保持现有 `runAgentLoop`、PolicyEngine、HumanGate、workflow transition、session transcript 和模型 observation 兼容。

改动：

- 新增 `tools/tool-contract.ts`。
- 新增 `tools/tool-execution-service.ts`。
- 现有 `ToolExecutionBoundary` 变成兼容 facade 或被替换。

验收：

- 每次工具调用有 queued/running/succeeded/failed/cancelled/timed_out 状态。
- timeout 有明确 `FAILED (TOOL_TIMEOUT)` observation 和 normalized error。
- abort-before-execution 不调用工具。
- 普通成功 observation 和已有 `FAILED (...)` observation 不被改写。
- policy / HumanGate / final submit 行为不变。
- `npm run test:tool-execution-service` 作为新增 service-level 验证入口。

不做：

- 不做完整 pause / resume。
- 不做自动 retry。
- 不做并发工具执行。
- 不做 streaming tool output。
- 不引入 PermissionEngine 或 WorkflowEngine。

## 5.4 Phase 2D: PermissionEngine

目标：

- 把 Policy 和 Permission 分层。
- 建立第一版待确认队列。
- 继续让 HumanGate 负责实际询问用户。

改动：

- 新增 `permission/*`。
- `PolicyEngine.evaluate()` 继续产出风险和策略建议。
- `PermissionEngine` 决定 allow / ask / deny。
- `ApprovalQueue v1` 保存运行期 pending / resolved approval。
- `runAgentLoop` 在 policy 之后、HumanGate 和工具执行之前接入 permission。

验收：

- final submit 前必须进入 permission。
- upload、高风险 click、login/captcha handoff 进入同一 permission audit。
- 用户确认结果写 session transcript/events。
- 拒绝后 workflow blocked。
- `HumanGate` 接口不变，仍负责实际询问用户。
- `ToolExecutionService` 不新增 permission 职责。
- `npm run test:permission` 通过。
- `npm run test:approval-queue` 通过，或明确包含在 `test:permission` 中。

不做：

- 不做完整 Task Cockpit UI。
- 不做持久 permission store。
- 不做跨进程 pending approval 恢复。
- 不做 remembered permission rules。

## 5.5 Phase 2E: Context Compaction

当前状态：已完成。Plan 5 已把 deterministic Context Compaction v1 接入 `runAgentLoop`，并完成 package scripts、session/event additive 兼容、agent-loop 集成测试和 MVP 回归入口更新。

目标：

- 长任务可以压缩上下文。
- compact summary 可审计、可恢复，且不依赖 trace artifacts。

改动：

- 新增 `context/compaction.ts`。
- 新增 `context/run-summary.ts`。
- 新增 `kernel/token-budget.ts`。
- `runAgentLoop` 支持可选 `contextBudget` / `contextCompactor`，未设置 `maxInputTokens` 时只估算、不自动 compact。
- session transcript 支持 `context_compaction` entry。
- session events 支持 `token_budget_updated` / `context_compacted`。
- `test:mvp` 已包含 `test:token-budget` 和 `test:context-compaction`。

验收：

- 构造长 transcript 后能 compact。
- compact 后保留 goal、workflow phase/blocker、latest page/form、permission/approval、安全 notes 和下一步 hints。
- compact 后 loop 仍能继续执行工具。
- direct `runAgentLoop` 不传 `contextBudget` 时保持兼容。
- `AgentRuntimeResult` schema、tool schema、`ToolExecutionService`、`PermissionEngine` 职责不变。
- runtime/session/context 不读取 `output/traces`、`page-state-latest.json`、`form-state-latest.json`。

完成说明：

- `PLAN/phase2/plan5-completion-explanation.md`

## 5.6 Phase 2F: WorkflowEngine + Evidence

当前状态：已完成。Plan 6 已新增 `WorkflowDefinition`、`EvidenceStore v1`、`WorkflowEngine v1`，并接入 session audit、context compaction 和 `runAgentLoop`。

目标：

- 从轻量 WorkflowState 升级到 WorkflowEngine v1。
- 用 evidence 解释任务阶段、阻塞原因和 completion criteria。

改动：

- 新增 `workflow/workflow-definition.ts`。
- 新增 `workflow/workflow-engine.ts`。
- 新增 `workflow/workflow-evidence.ts`。
- 新增 transcript entry：`workflow_evidence` / `workflow_evaluation`。
- 新增 session events：`workflow_evidence_recorded` / `workflow_evaluated`。
- `ContextCompactor` 保留 evidence / completion summary。
- `runAgentLoop` 在初始 context、permission/gate、工具执行、agent_done 和 context refresh 后调用 WorkflowEngine。
- `transitionWorkflowState` 继续作为 compatibility helper。

验收：

- job application workflow 有定义。
- `EvidenceStore` 支持 add/list/byKind/snapshot，且避免外部 mutation。
- `WorkflowEngine` 输出 matched/missing criteria、blockers、evidence ids。
- final submit approve 后仍不执行 submit tool。
- agent_done 的 missing completion evidence 会进入 `workflow_evaluation`。
- compaction 保留 evidence summary，但不保留 raw evidence data payload。
- runtime workflow/context/session 不读取 `output/traces`、`page-state-latest.json`、`form-state-latest.json`。

已知边界：

- Plan 6 v1 让 optimistic complete 的 missing criteria 可见、可审计，但为了兼容还没有把所有 missing criteria 强制变成 runtime blocked。后续可用 CompletionGate / WorkflowGuard 收紧。

完成说明：

- `PLAN/phase2/plan6.md`
- `PLAN/phase2/plan6-completion-explanation.md`

## 5.7 Phase 2G: CompletionGate / WorkflowGuard v1

当前状态：已完成。Plan 7 已新增 `CompletionGate v1`，并把 WorkflowEngine 的 `missingCriteria` 接入 `agent_done` 后的 runtime 完成裁决。本次审查补齐了 `AgentRuntime` / `AgentKernel` 层对 Plan 7 blocked 语义的测试契约。

目标：

- 让 WorkflowEngine 的 `missingCriteria` 真正影响 runtime 最终完成状态。
- 把 `agent_done blocked=false` 从“模型提议完成”升级为“Runtime 根据 evidence 裁决完成”。

改动：

- 新增 `workflow/completion-gate.ts`。
- 新增 transcript entry：`completion_gate`。
- 新增 session event：`completion_gate_evaluated`。
- `runAgentLoop` 在 `agent_done` 后调用 CompletionGate。
- 缺 required evidence 时，runtime final status 应为 blocked。

验收：

- `agent_done blocked=false` 但缺 required evidence 时不再 completed。
- final submit approve 后仍不执行 submit tool。
- no-tool-call 结束分支保持兼容。
- `AgentRuntimeResult` / `AgentLoopResult` schema 不变。
- CompletionGate 不执行工具、不调用 HumanGate、不读取 trace artifacts。

计划：

- `PLAN/phase2/plan7.md`
- `PLAN/phase2/plan7-agent-prompts.md`

完成说明：

- `PLAN/phase2/plan7-completion-explanation.md`

## 5.8 Phase 2H: UserConfirmEvidence + Resume Completion v1

当前状态：已完成。Plan 8 已把“缺少 `user_confirm` 被 blocked 的 session”接成安全闭环：从 session transcript 恢复事实、由显式用户确认入口生成 `user_confirm` evidence，再通过 WorkflowEngine + CompletionGate 重新裁决 completed / blocked。

目标：

- 从 session transcript 恢复 workflow evidence / evaluation / completion gate / final result。
- 提供显式用户确认入口，生成可信 `user_confirm` evidence。
- 对 blocked session 重新跑 WorkflowEngine + CompletionGate。
- 满足 criteria 时推进到 completed，不满足时保持 blocked。

改动：

- 新增 `session/session-restore.ts`。
- 新增 `workflow/user-confirmation.ts`。
- 新增 `workflow/completion-resume.ts`。
- 新增 `session/session-completion.ts`。
- 新增 transcript entry：`user_confirmation`。
- 新增 session events：`session_restored` / `user_confirmed` / `session_completion_rechecked`。
- 新增测试入口：`test:session-restore` / `test:user-confirmation` / `test:completion-resume` / `test:session-completion`。
- `test:workflow` 覆盖 user confirmation 和 completion resume；`test:session` 覆盖 restore 和 session completion；`test:mvp` 包含 Plan 8 回归链。

验收：

- `user_confirm` 只能来自显式用户确认入口，不能由 LLM/tool 伪造。
- blocked session 缺 `user_confirm` 时 recheck 仍 blocked。
- blocked session 补 `user_confirm` 后，criteria 满足才 completed。
- final submit blocker 不会被 user confirmation 绕过。
- runtime/session/restore 不读取 trace artifacts。

计划：

- `PLAN/phase2/plan8.md`
- `PLAN/phase2/plan8-agent-prompts.md`

完成说明：

- `PLAN/phase2/plan8-completion-explanation.md`

## 5.9 Phase 2I: SkillSystem v1

目标：

- 把任务经验从代码/prompt 中抽为技能。

改动：

- 新增 `skills/*`。
- 新建 `packages/web-buddy/skills/job-application/SKILL.md`。
- 新建 `packages/web-buddy/skills/alibaba-careers/SKILL.md`。
- 新建 `packages/web-buddy/skills/web-research/SKILL.md`。

验收：

- skills list/view 可用。
- 任务启动时能推荐技能。
- 技能注入写入 session 和 trace。

## 5.10 Phase 2J: Task Cockpit

目标：

- Web UI 从日志页升级为任务驾驶舱。

改动：

- Web server 读取 SessionStore。
- 前端展示 workflow、permission、evidence、events、sessions。
- 支持 resume/stop/approve/reject。

验收：

- 刷新页面不丢状态。
- 能继续 blocked session。
- final submit 前 UI 展示证据和风险。

## 5.11 Phase 2K: Doctor + Eval

目标：

- 建立环境诊断和底座回归测试。

改动：

- 新增 `diagnostics/*`。
- 新增 benchmark scripts。
- 更新 `test:mvp`。

验收：

- doctor 能检查关键环境。
- session resume、permission gate、compaction、workflow evidence 都有 benchmark。

## 6. 不做什么

Phase 2 明确不做：

- 不继续扩展更多招聘网站作为主目标。
- 不做大型插件市场。
- 不做复杂多 Agent。
- 不把 trace 当状态数据库。
- 不把 Skill 全量塞进 system prompt。
- 不让 PermissionEngine 直接执行工具。
- 不让 WorkflowEngine 直接绕过 Policy/Permission。
- 不复制 Claude Code 的全部 TUI 和代码结构。

## 7. 与当前文件的迁移关系

| 当前模块 | Phase 2 目标 |
|---|---|
| `runtime/local/agent-loop.ts` | 逐步拆分到 `kernel/query-loop.ts`、`tools/tool-execution-service.ts`、`workflow/workflow-engine.ts` |
| `agent/agent-runtime.ts` | 变成 `AgentKernel` facade |
| `tools/tool-execution.ts` | 升级或替换为 `ToolExecutionService` |
| `policy/policy-engine.ts` | 保留为风险判断层 |
| `sdk/human.ts` | 接入 `PermissionEngine` 和 `ApprovalQueue` |
| `workflow/workflow-state.ts` | 演进为 `WorkflowInstance` snapshot |
| `workflow/workflow-transition.ts` | 逐步降级为兼容 helper |
| `context/context-manager.ts` | 继续负责当前 working set，不负责 transcript |
| `agent-trace/*` | 继续负责审计和观测，不参与 runtime state |
| `web/server.ts` | 从内存 run map 迁移到 SessionStore |
| `sdk/orchestrator.ts` | 逐步瘦身，任务流程转移到 Workflow/Skill |

## 8. 完成后的体验目标

Phase 2 完成后，用户体验应该变成：

1. 用户发起任务。
2. 系统创建 session。
3. UI 显示目标、阶段、工具进度。
4. Agent 按 workflow 执行。
5. 高风险动作进入确认队列。
6. 用户确认或拒绝。
7. Agent 继续或进入 blocked。
8. 中断/刷新/重启后可以 resume。
9. 完成时展示 evidence，而不是只说 done。
10. 失败时展示 blockers 和下一步恢复建议。

这就是当前项目和成熟 Agent 产品之间最关键的差距。

## 9. Phase 2 成功标准

Phase 2 不以“多跑了几个网站”为成功标准。

成功标准是：

- 一个 run 可持久化。
- 一个 blocked run 可恢复。
- 一个 high-risk action 可确认、可拒绝、可审计。
- 一个长任务可压缩上下文后继续。
- 一个 workflow completion 有证据。
- 一个 task skill 可被发现、加载、注入、记录。
- Web UI 能解释 Agent 当前在做什么、为什么停、怎样继续。

当这些能力成立后，再扩展更多网站、更多任务、更多插件才有意义。
