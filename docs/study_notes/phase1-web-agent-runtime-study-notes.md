# Phase 1 学习笔记：从求职 Agent 到本地 Web Agent Runtime

来源：`PLAN/phase1/`

整理日期：2026-06-29

## 1. 这一阶段到底在做什么

`PLAN/phase1` 记录的是项目第一阶段的完整演进：把一个偏“求职投递浏览器 Agent”的项目，逐步整理成一个更通用的本地 Web Agent runtime。

这一阶段没有直接追求“更多网站适配”或“更强自动化”，而是先补平台底座：

- 明确项目主线：`packages/web-buddy` 是自研 local runtime 主线。
- 保留外部 adapter：`packages/claude-code` 只是可选 runtime adapter / 对照路径。
- 建立可观测性：run identity、trace、metrics、agent-state、benchmark。
- 统一工具定义：Tool Catalog、local adapter、MCP adapter。
- 建立网页观察模型：PageState、FormState、ObservationManager。
- 建立上下文系统：ContextManager、Prompt Sections、recent actions、budget。
- 建立 AgentRuntime 外壳：PromptAssembler、StopConditionManager。
- 建立任务状态感：TaskState、WorkflowState、WorkflowTransition。
- 建立安全边界：PolicyEngine、policy audit、safety report。
- 最后做 MVP 包装：demo-research、report:safety、README、Safety Model。

一句话概括：

```text
先让 Web Agent 的运行过程可观察、可度量、可约束、可复盘，
再谈更深的 WorkflowEngine / SkillSystem / 多 Agent。
```

## 2. 第一性原理

这一阶段最核心的第一性原理有四条。

### 2.1 Trace 是证据，不是运行时状态

Trace / metrics / screenshots / safety report 是复盘和审计材料，不应该反过来成为 runtime 的状态源。

正确关系：

```text
Runtime memory / ObservationManager / WorkflowState
  -> 支撑下一步决策

Trace / metrics / artifacts
  -> 支撑复盘、测试、审计、报告
```

这条边界非常重要。如果 runtime 读取 `output/traces` 里的 artifact 来做下一步判断，就会把旁路日志变成隐式数据库，后续会出现状态不一致、恢复语义混乱和难以测试的问题。

### 2.2 上下文不是越长越好，而是 working set 要正确

`context-selection-report.md` 的核心结论是：

```text
复杂 Agent 的关键不是把所有信息都塞进 prompt，
而是维护一个正确、紧凑、足够支持下一步决策的 working set。
```

模型注意力是稀缺资源。网页快照、表单状态、历史动作、简历摘要、安全规则、workflow phase 都有不同半衰期，应该分层进入上下文，而不是线性追加所有消息。

### 2.3 Policy 必须在工具执行前生效

安全不能只靠 prompt 说“不要提交”。真正可靠的边界是：

```text
LLM 提议 tool call
  -> PolicyEngine.evaluate()
  -> allow / gate / block / auto_confirm
  -> HumanGate / ToolExecution
```

PolicyEngine 只判断，不执行工具；HumanGate 只确认或接管，不推理策略。

### 2.4 Workflow 管确定性流程，LLM 管不确定判断

LLM 适合判断页面内容、字段映射、下一步选择；Workflow 适合管理阶段、前置条件、完成条件和敏感 gate。

这一阶段还没有做完整 WorkflowEngine，但已经引入了 `WorkflowState` 作为 runtime working set，为后续 Phase 6 打基础。

## 3. 阶段总架构

第一阶段形成的目标架构是：

```text
User Goal / CLI / Web Console
  -> Workflow / Task State
  -> AgentRuntime
  -> PromptAssembler
  -> ContextManager
  -> LLM Gateway
  -> ToolRegistry / ToolExecutionBoundary
  -> PolicyEngine
  -> Browser Tools
  -> Playwright
  -> Real Web Page

Real Web Page
  -> Observation Tools
  -> ObservationManager
  -> PageState / FormState
  -> ContextManager

Runtime / Policy / Tools
  -> Trace / Metrics / Safety Report
```

当前已经完成的是骨架和第一版能力，不是最终形态。尤其是完整 WorkflowEngine、SkillSystem、统一 ToolExecutionService 还没有做。

## 4. Plan0：主线整理和边界冻结

Plan0 的目标是稳定项目认知和目录边界。

关键判断：

- `web-buddy` 是自研 Web Agent 主线。
- `claude-code` 是外部 runtime adapter，不是项目主心骨。
- 当前阶段不要直接做大重构。
- 先冻结入口、文档、运行路径和验证方式。

学习点：

```text
架构重构前，先把“谁是主线、谁是 adapter、谁是兼容路径”讲清楚。
否则后面每个抽象都会漂。
```

## 5. Plan1：Trace / Metrics / AgentState Baseline

Plan1 是后续所有优化的度量地基。

完成内容：

- 统一 run identity：
  - `runId`
  - `sessionId`
  - `runDir`
  - `traceDir`
- 生成默认运行产物：
  - `trace.jsonl`
  - `summary.json`
  - `run-manifest.json`
  - `metrics.json`
  - `agent-state.json`
- Web UI 能展示 metrics。
- 建立 `benchmark-simple` 最小回归闭环。

为什么先做这个：

如果没有稳定 metrics，就无法回答：

- 是否更快？
- 是否更安全？
- 是否减少 token？
- 是否提高表单完成率？
- 是否引入回归？

学习点：

```text
Agent 项目不能只靠“看起来跑了”判断质量。
必须先有 run identity 和 metrics，否则后续优化都是凭感觉。
```

## 6. Plan2：Tool Unification / Observation Model

Plan2 做了两个底座：工具定义统一和网页观察模型。

完成内容：

- Tool Catalog v1：
  - 工具名称
  - 参数 schema
  - 风险等级
  - 工具分类
  - local / MCP 可用性
- local adapter / MCP adapter：
  - 定义层统一
  - 执行层暂不统一
- Observation Model v1：
  - `PageState`
  - `FormState`
  - `ObservationManager`
- metrics 增加 tool category 维度。
- benchmark-simple 断言 observation artifacts。

重要边界：

```text
Plan2 只做定义层工具统一，
不做完整 ToolExecutionService，
不重写 local/MCP 执行调度。
```

学习点：

工具平台要分层推进。先统一“工具是什么”，再统一“工具怎么执行”。如果一开始就重写执行层，风险会非常高。

## 7. Plan3：ContextManager / Prompt Sections

Plan3 解决的是模型上下文组织问题。

完成内容：

- `ObservationProvider`
- `ContextSnapshot`
- `PromptSection`
- `ContextManager`
- prompt section 预算控制
- resume summary 抽取
- recent actions
- agent-loop 接入 context

严格边界：

```text
ContextManager 只能读取 ObservationManager / ObservationProvider 的内存态，
不能读取 trace artifacts。
```

Prompt 开始从“线性消息追加”转为“结构化 section”：

```text
TASK
SAFETY_RULES
RESUME_SUMMARY
CURRENT_PAGE_STATE
CURRENT_FORM_STATE
RECENT_ACTIONS
BLOCKERS
```

学习点：

```text
好的 Agent 上下文不是聊天记录拼接，
而是面向下一步决策的状态切片。
```

## 8. Plan4 / Phase 4A：AgentRuntime Skeleton

Plan4 不是重写 agent-loop，而是先加一层兼容 facade。

完成内容：

- `AgentRuntime`
- `AgentRuntimeInput`
- `AgentRuntimeResult`
- `AgentRuntimeEvent`
- `PromptAssembler`
- `StopConditionManager`

关键设计：

```text
AgentRuntime.run()
  -> 仍然委托 runAgentLoop()
```

为什么这样做：

- `agent-loop.ts` 刚接入 ContextManager，行为需要稳定。
- 直接抽完整 runtime controller 风险太大。
- 先让未来接口形状出现，再逐步迁移内部实现。

学习点：

```text
大型重构可以先做 facade。
先稳定外部接口，再逐步移动内部逻辑。
```

## 9. Plan5 / Phase 4B：Context Metrics / Freshness / TaskState

Plan5 聚焦上下文质量的可度量性。

完成内容：

- Context Selection Metrics：
  - contextBuilds
  - contextChars
  - contextTruncations
  - section chars
  - recentActionsIncluded
- Freshness Metadata：
  - PageState age
  - FormState age
- Prompt priority tests
- Minimal TaskState
- complex local benchmark

为什么重要：

后续如果引入 ToolExecutionService / PolicyEngine，出现行为退化时，需要知道问题来自：

- 工具执行？
- 状态过期？
- prompt 截断？
- 任务阶段错误？
- 模型判断？

学习点：

```text
Context 优化必须可观测。
否则 prompt 改动只是在调玄学。
```

## 10. Plan6 / Phase 4C：Tool Execution Boundary / Policy Skeleton

Plan6 开始把工具执行和安全判断从 agent-loop 中抽出边界。

完成内容：

- `ToolExecutionBoundary` v1
- `PolicyDecision` helper v1
- freshness-aware high-risk cue
- agent-loop 最小接入

重要边界：

```text
ToolExecutionBoundary 第一版只提供稳定调用边界，
内部仍委托 ToolRegistry.run()。

PolicyDecision helper 第一版只做轻量判断，
不做策略 DSL。
```

学习点：

抽象边界的第一版不一定要很强。只要调用点稳定，后续就能逐步替换内部实现。

## 11. Plan7 / Phase 4D：Workflow State / Runtime Controller Skeleton

Plan7 解决的是任务阶段感。

完成内容：

- `WorkflowState`
- `WorkflowPhase`
- `WorkflowTransition`
- `WORKFLOW_STATE` prompt section
- workflow-aware PolicyDecision
- agent-loop workflow working set
- AgentRuntime result 带 workflow-aware 信息

第一版 workflow phase：

```text
observing
selecting_job
job_detail
entering_application
login_required
captcha_required
editing_resume
filling_application
reviewing
ready_for_final_submit
done
blocked
```

最关键的收益：

```text
Apply / 投递入口
  !=
最终提交 / final submit
```

系统开始能结合 workflow phase 区分“进入申请流程”和“最终提交动作”。

学习点：

```text
同一个按钮文本在不同任务阶段风险不同。
风险判断不能只看 DOM 文本，也要看 workflow phase。
```

## 12. Plan8 / Phase 5：Policy Engine v1 / Policy Audit

Plan8 把 policy helper 升级为更正式的 PolicyEngine。

完成内容：

- `PolicyEngine.evaluate()`
- `decideToolPolicy()` compatibility facade
- Policy rules v1
- `PolicyAuditEvent`
- `policy_decision` trace event
- metrics policy aggregation
- safety report v1 helper
- `test:mvp`

Policy 决策：

```text
allow
gate
block
auto_confirm
```

Policy 输出：

```text
policyCode
ruleId
reason
riskLevel
gateKind
workflowPhase
auditTags
requiresFreshContext
```

学习点：

```text
安全系统需要稳定 reason 和 audit code。
否则 trace 里只有“blocked”是不够复盘的。
```

## 13. Plan9 / Phase 5B：MVP Packaging

Plan9 做的是开源 MVP 包装，不是继续扩 DSL，也不是重写 workflow。

完成内容：

- `demo-research`
- `benchmark:research`
- `report:safety`
- `docs/safety-model.md`
- README / Quickstart 重写
- demo-form / demo-research / job-application 三类示例定位
- `test:mvp` 纳入 research benchmark

核心目标：

```text
让新用户在 10 分钟内看懂项目定位，
跑通一个安全 demo，
看到 trace / metrics / safety report。
```

重要定位变化：

```text
求职投递是 flagship workflow，
不是项目唯一目标。
```

学习点：

技术能力做完，不等于 MVP 可用。开源用户首先需要清楚入口、可运行 demo、安全边界和验证方式。

## 14. 第一阶段沉淀出的工程模式

### 14.1 先观测，再优化

没有 trace / metrics / benchmark 之前，不要做大规模 agent 重构。

### 14.2 先定义层统一，再执行层统一

Tool Catalog 先统一工具 contract。完整 ToolExecutionService 可以后置。

### 14.3 先 facade，再替换内部

AgentRuntime 第一版只是包装 `runAgentLoop`，但它让未来架构有了稳定入口。

### 14.4 Context 是结构化状态，不是聊天记录

PageState、FormState、TaskState、WorkflowState 分别回答不同问题：

- PageState：当前页面是什么？
- FormState：当前表单是什么？
- TaskState：任务目标和阶段是什么？
- WorkflowState：流程推进到了哪里？

### 14.5 Policy 是执行前边界

Prompt 可以提醒模型，但不能替代工具执行前的硬边界。

### 14.6 WorkflowState 是过渡方案

当前 WorkflowState 是 runtime working set，不是完整 WorkflowEngine。它解决阶段感，但还不能解决持久恢复、复杂条件、证据闭环和多 workflow 定义。

### 14.7 Demo 是产品能力的一部分

`demo-research` 的价值不只是展示“还能读网页”，而是证明项目不是 job-only，并提供无账号、无验证码、无真实网站依赖的安全入口。

## 15. 当前还没有完成什么

第一阶段刻意没有做这些：

- 完整 WorkflowEngine
- WorkflowDefinition
- WorkflowStore
- SkillSystem
- Memory
- 多 Agent
- 完整 ToolExecutionService
- 统一 local/MCP 执行调度
- 多用户 Server / Worker / Queue
- 真实自动登录
- 验证码自动处理
- 真实最终提交自动化

这些不是忘了做，而是为了控制阶段风险。

## 16. 对后续 Phase 6 的启发

第一阶段已经把 Phase 6 的前置条件准备好了：

- 有 PageState / FormState
- 有 ContextManager
- 有 TaskState
- 有 WorkflowState
- 有 PolicyEngine
- 有 trace / metrics / safety report
- 有 benchmark

Phase 6 真正要解决的是：

```text
不要让 LLM 自己“感觉任务完成了”，
而是让 Workflow 明确规定任务如何开始、如何推进、哪里必须确认、
什么证据才算完成、失败后如何恢复。
```

建议 Phase 6 重点：

- `WorkflowDefinition`
- `WorkflowInstance`
- `WorkflowStore`
- `WorkflowEngine`
- workflow guards
- workflow evidence
- resumable blocked / incomplete state
- final submit hard gate
- success evidence verification

## 17. 一句话复盘

第一阶段不是在“多写几个浏览器工具”，而是在给 Web Agent 建一条可靠地基：

```text
可观察 -> 可度量 -> 可组织上下文 -> 可抽象 runtime ->
可判断任务阶段 -> 可执行前决策 -> 可审计复盘 -> 可给新用户运行
```

这条链路完成后，项目才有资格进入真正的 WorkflowEngine / SkillSystem 阶段。
