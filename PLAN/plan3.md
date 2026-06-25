# Next Stage Plan and Agent Prompt: ContextManager / Prompt Sections

日期：2026-06-25

## 1. 阶段定位

阶段名称：

```text
ContextManager / Prompt Sections
```

上一阶段已经完成：

```text
Tool Catalog
local adapter / MCP adapter
PageState / FormState
ObservationManager
observation trace artifacts
metrics tool category
benchmark-simple assertions
```

本阶段不要急着做 AgentRuntime 大重构、Skill、Memory、多 Agent、真实网站适配或统一 ToolExecutionService，而是把 Web Agent 的上下文组织补稳：

```text
ObservationManager 内存态 PageState / FormState
  -> ContextManager
  -> Prompt Sections
  -> agent-loop messages
```

阶段目标：

> 让进入模型的上下文从“拼接 snapshot 文本和历史 messages”升级为“按稳定 section 组织的当前任务状态、页面状态、表单状态、最近动作和安全约束”。

也就是从：

```text
system prompt 手写字符串
user message 塞 pageView 文本
tool observation 直接追加到 messages
```

升级为：

```text
ContextSnapshot
PromptSection[]
预算控制
结构化 PageState/FormState 摘要
最近动作摘要
稳定安全规则
```

---

## 2. 为什么这个阶段优先

Plan2 已经解决了 Agent 的三个底座：

- 工具能力边界：`src/tools/catalog.ts`。
- 结构化观察：`src/observation/*`。
- 可验证结果：trace artifacts / metrics / benchmark-simple。

下一步真正影响 Agent 决策质量的不是继续加工具，而是解决：

- 模型每一轮应该看到哪些信息？
- PageState / FormState 如何进入 prompt？
- 已填字段和缺失字段如何避免被 pageView 文本淹没？
- 最近动作如何帮助模型避免重复操作？
- 安全规则如何保持稳定，不被动态页面文本污染？

如果不做 ContextManager，Agent loop 会继续依赖 messages 线性追加：

```text
snapshot text -> tool result text -> updated snapshot text -> more text
```

这会导致长任务中上下文越来越乱，模型难以区分：

- 当前事实。
- 历史事实。
- 安全规则。
- 任务目标。
- 页面噪声。

---

## 3. 本阶段严格边界

必须遵守：

1. 不做 AgentRuntime 大重构。
2. 不做 Skill / Memory / 多 Agent。
3. 不做真实网站适配。
4. 不改 `packages/claude-code` 内部逻辑。
5. 不破坏现有 CLI / Web UI / MCP 工具名。
6. 不引入单一 `ToolExecutionService`。
7. 不重写 local/MCP 的执行调度。
8. 不让 trace artifacts 成为主流程状态源。
9. 不把 ContextManager 设计成长期记忆系统。
10. 不让 prompt sections 无限增长；第一版必须有预算和截断。

### 3.1 Trace 解耦硬边界

本阶段最重要的架构边界：

```text
主流程状态源：
  ObservationManager / ObservationProvider / session memory

旁路输出：
  trace.jsonl
  spans/events
  page-state-latest.json
  form-state-latest.json
  metrics.json
  agent-state.json
```

禁止：

```text
ContextManager -> readFileSync(output/traces/.../form-state-latest.json)
ContextManager -> read trace artifacts 作为运行时上下文
```

允许：

```text
benchmark / Web UI / tests / replay -> 读取 trace artifacts
```

推荐依赖方向：

```text
browser_snapshot / browser_form_snapshot
        |
        v
ObservationManager 内存态
        |
        +--> ContextManager / Prompt Sections
        |
        +--> best-effort trace artifact writer
```

一句话：

> ContextManager 读 ObservationManager，不读 trace 文件。trace 是镜像，不是状态数据库。

---

## 4. 当前基础

当前可复用基础：

- `packages/web-buddy/src/observation/observation-manager.ts`
  - 内存态 `getPageState(sessionId)` / `getFormState(sessionId)`。
  - best-effort 写 `page-state-latest.json` / `form-state-latest.json`。
- `packages/web-buddy/src/observation/page-state.ts`
  - `PageState` v1。
- `packages/web-buddy/src/observation/form-state.ts`
  - `FormState` v1，已包含 `fields[].options?`、`uploadHints?`、`visibleErrors?`。
- `packages/web-buddy/src/runtime/local/page-view.ts`
  - 现有 LLM 可读 snapshot 文本。
- `packages/web-buddy/src/runtime/local/agent-loop.ts`
  - 当前 prompt 构造和 messages 管理入口。
- `packages/web-buddy/src/sdk/trace.ts`
  - trace / metrics / agent-state 旁路输出。
- `packages/web-buddy/scripts/benchmark-simple.mjs`
  - 已断言最终 PageState/FormState artifacts 与字段值。

---

## 5. 目标设计

### 5.1 ObservationProvider

新增一个很薄的接口，让 ContextManager 不直接绑定具体单例：

```ts
export interface ObservationProvider {
  getPageState(sessionId: string): PageState | undefined
  getFormState(sessionId: string): FormState | undefined
}
```

第一版由现有 `observationManager` 实现即可，不需要复杂依赖注入。

### 5.2 ContextSnapshot

新增：

```text
packages/web-buddy/src/context/types.ts
```

建议第一版：

```ts
export interface ContextSnapshot {
  schemaVersion: 'context-snapshot/v1'
  sessionId: string
  goal: string
  page?: PageState
  form?: FormState
  resumeSummary: string
  recentActions: ContextAction[]
  safetyNotes: string[]
  blockers: string[]
  updatedAt: string
}
```

第一版不要做长期历史，不要做 Memory。

### 5.3 PromptSection

新增：

```text
packages/web-buddy/src/context/prompt-sections.ts
```

建议：

```ts
export interface PromptSection {
  id: string
  title: string
  priority: number
  content: string
  tokensApprox?: number
}
```

第一版 section：

```text
SYSTEM_ROLE
SAFETY_RULES
TASK
RESUME_SUMMARY
CURRENT_PAGE_STATE
CURRENT_FORM_STATE
RECENT_ACTIONS
NEXT_ACTION_RULES
```

### 5.4 ContextManager

新增：

```text
packages/web-buddy/src/context/context-manager.ts
```

职责：

- 从 `ObservationProvider` 读取当前 PageState/FormState。
- 从 agent-loop 提供的 goal/resume/recent actions 构造 ContextSnapshot。
- 把 ContextSnapshot 转成 PromptSection[]。
- 按预算输出 system/user prompt 片段。

不负责：

- 读取 trace artifacts。
- 执行工具。
- 做 policy gate。
- 存长期 memory。
- 管 workflow。

### 5.5 预算控制

新增：

```text
packages/web-buddy/src/context/budget.ts
```

第一版只做字符预算即可，不需要 token 精确估算。

建议默认：

```text
maxPromptChars: 12000
maxPageTextChars: 1200
maxFormFields: 40
maxRecentActions: 8
maxSectionChars: 3000
```

---

## 6. 实施步骤

### 6.1 新增 context 模块

新增文件：

```text
packages/web-buddy/src/context/types.ts
packages/web-buddy/src/context/budget.ts
packages/web-buddy/src/context/prompt-sections.ts
packages/web-buddy/src/context/context-manager.ts
```

要求：

- ContextManager 默认读取 `observationManager` 的内存态。
- 支持传入 mock `ObservationProvider`，方便测试。
- 不从 `output/traces` 读任何文件。

### 6.2 抽出 resume summary

当前 `agent-loop.ts` 里有 `resumeBrief(profile)`。

本阶段可选择：

- 保留原函数，只让 ContextManager 接收 `resumeSummary`。
- 或移动到 `context/prompt-sections.ts` 做纯函数。

建议第一版保守：

```text
不大搬迁，只新增复用 helper。
```

### 6.3 接入 agent-loop

轻改 `packages/web-buddy/src/runtime/local/agent-loop.ts`。

当前：

```text
buildSystemPrompt(goal, resume, extraContext, safetyMode)
firstView = pageView(snapshot)
user message = firstView + instructions
```

目标：

```text
contextManager.buildSnapshot(...)
buildPromptSections(context)
system message = stable sections
user message = current page/form context + instruction
```

保留：

- 现有 ReAct loop。
- 现有 tool call 执行。
- 现有 gate。
- 现有 pageView fallback。
- 现有 `runAgentLoop` 对外接口。

### 6.4 recent actions

第一版 recent actions 不需要从 trace 文件读。

在 agent-loop 内维护内存数组：

```ts
const recentActions: ContextAction[] = []
```

每次工具执行后追加：

```text
step
toolName
category
risk
status
brief observation
url
```

ContextManager 从该数组取最近 N 条。

### 6.5 Observation refresh 关系

不要新增“ContextManager 自己刷新页面”的行为。

刷新仍然由现有工具触发：

- `browser_snapshot` 刷新 PageState。
- `browser_form_snapshot` 刷新 FormState。
- final observation refresh 保持在 orchestrator 的最终边界。

ContextManager 只读取当前内存态；如果没有 PageState/FormState，就使用 pageView fallback。

### 6.6 测试

新增：

```text
packages/web-buddy/scripts/context-manager-test.mjs
packages/web-buddy/scripts/prompt-sections-test.mjs
```

可选更新 `package.json`：

```json
"test:context": "npm run build && node ./scripts/context-manager-test.mjs",
"test:prompt-sections": "npm run build && node ./scripts/prompt-sections-test.mjs"
```

测试必须覆盖：

- ContextManager 从 mock ObservationProvider 获取 PageState/FormState。
- ContextManager 不需要 trace artifact 文件。
- Prompt sections 顺序稳定。
- FormState 的 `filledFields`、`missingRequired`、`submitCandidates` 进入 prompt。
- page text / fields / recent actions 受预算控制。
- benchmark-simple 仍通过。

---

## 7. 验收标准

必须满足：

1. `npm run build` 通过。
2. `npm run test:tool-catalog` 通过。
3. `npm run test:observation` 通过。
4. 新增 context / prompt sections 测试通过。
5. `npm run test:agent-loop` 通过。
6. `npm run benchmark:simple` 通过。
7. agent-loop 仍不读 trace artifacts。
8. ContextManager 有测试证明可以使用 mock ObservationProvider，而不是文件系统。
9. Prompt 中包含当前 PageState/FormState 摘要。
10. Prompt 不无限追加完整 snapshot。

建议额外检查：

```bash
rg -n "page-state-latest|form-state-latest|output/traces|readFileSync" packages/web-buddy/src/context packages/web-buddy/src/runtime/local
```

预期：

```text
ContextManager / agent-loop 不读取 trace artifact 文件。
```

---

## 8. 风险与控制

| 风险 | 影响 | 控制方式 |
| --- | --- | --- |
| ContextManager 读 trace artifacts | trace 变成状态数据库，主流程被旁路输出影响 | 硬性禁止；只依赖 ObservationProvider |
| Prompt sections 过度设计 | Plan3 变成 AgentRuntime 重构 | 只接 agent-loop prompt 构造，不抽 LoopController |
| 上下文压缩过狠 | 模型丢关键字段 | benchmark + prompt sections 测试覆盖 filled/missing/submit |
| recent actions 变成长记忆 | 上下文膨胀 | 只保留最近 N 条，不落盘，不跨 run |
| 打破现有 prompt 行为 | demo-form / benchmark 退化 | 保留 pageView fallback，先小步接入 |
| 安全规则被动态内容污染 | 模型误点 submit | SAFETY_RULES section 固定且高优先级 |

---

## 9. 本阶段不做

明确不做：

- AgentRuntime facade。
- ToolExecutionService。
- PolicyEngine extraction。
- WorkflowEngine。
- Skill System。
- Memory。
- 多 Agent。
- 真实网站适配。
- Claude Code runtime 内部修改。
- Web UI 大改。
- trace artifacts 作为 runtime state source。

---

## 10. 给 Codex 的执行 Prompt

```text
你现在在 /Users/sunqiankai/开源项目/multi-functional-agent。

当前阶段是 ContextManager / Prompt Sections v1。

上一阶段已经完成：
- Tool Catalog
- local adapter / MCP adapter
- PageState / FormState
- ObservationManager
- observation trace artifacts
- metrics tool category
- benchmark-simple assertions

本阶段目标：
建立轻量 ContextManager 和 Prompt Sections，让 agent-loop 能基于 ObservationManager 内存态 PageState/FormState、任务目标、简历摘要、最近动作和安全规则构造稳定 prompt。

严格遵守：
1. 不要做 AgentRuntime 大重构。
2. 不要做 Skill / Memory / 多 Agent。
3. 不要做真实网站适配。
4. 不要改 packages/claude-code 内部逻辑。
5. 不要破坏现有 CLI / Web UI / MCP 工具名。
6. 不要引入 ToolExecutionService。
7. 不要重写 local/MCP 工具执行调度。
8. ContextManager 不允许读取 trace artifacts。
9. trace artifacts 只能作为 Web UI / benchmark / debug / replay 的旁路输出。
10. 主流程上下文只能来自 ObservationProvider / ObservationManager 内存态和 agent-loop 内存态 recent actions。

你需要完成：

一、检查当前基础
- 阅读 packages/web-buddy/src/runtime/local/agent-loop.ts
- 阅读 packages/web-buddy/src/runtime/local/page-view.ts
- 阅读 packages/web-buddy/src/observation/observation-manager.ts
- 阅读 packages/web-buddy/src/observation/page-state.ts
- 阅读 packages/web-buddy/src/observation/form-state.ts
- 阅读 packages/web-buddy/src/sdk/orchestrator.ts
- 阅读 packages/web-buddy/scripts/benchmark-simple.mjs

二、新增 Context 模块
- 新增 packages/web-buddy/src/context/types.ts
- 新增 packages/web-buddy/src/context/budget.ts
- 新增 packages/web-buddy/src/context/prompt-sections.ts
- 新增 packages/web-buddy/src/context/context-manager.ts

三、ContextManager v1
- 定义 ObservationProvider 接口。
- 默认使用 observationManager 作为 provider。
- 构造 ContextSnapshot。
- ContextSnapshot 至少包含：
  - schemaVersion
  - sessionId
  - goal
  - page
  - form
  - resumeSummary
  - recentActions
  - safetyNotes
  - blockers
  - updatedAt
- 不读取任何 trace artifact 文件。

四、Prompt Sections v1
- 定义 PromptSection。
- 生成稳定 sections：
  - SYSTEM_ROLE
  - SAFETY_RULES
  - TASK
  - RESUME_SUMMARY
  - CURRENT_PAGE_STATE
  - CURRENT_FORM_STATE
  - RECENT_ACTIONS
  - NEXT_ACTION_RULES
- 有字符预算和截断。

五、接入 agent-loop
- 保留 runAgentLoop 对外接口。
- 保留现有 tool execution / gate / trace 行为。
- 用 ContextManager/Prompt Sections 生成 system/user context。
- 每次工具调用后维护 recentActions 内存数组。
- 不从 trace artifacts 读取上下文。
- 保留 pageView fallback。

六、测试
- 新增 packages/web-buddy/scripts/context-manager-test.mjs
- 新增 packages/web-buddy/scripts/prompt-sections-test.mjs
- 如新增 npm script，更新 package.json。
- 测试必须证明：
  - ContextManager 能从 mock ObservationProvider 获取 PageState/FormState。
  - ContextManager 不依赖 trace artifact 文件。
  - Prompt sections 顺序稳定。
  - filledFields / missingRequired / submitCandidates 进入 prompt。
  - long page text / recent actions 会被预算控制。

七、验证
在 packages/web-buddy 下运行：
- npm run build
- npm run test:tool-catalog
- npm run test:observation
- npm run test:context
- npm run test:prompt-sections
- npm run test:agent-loop
- npm run benchmark:simple

最终回复包含：
- 改了哪些模块。
- 新增了哪些文件。
- 如何保证 ContextManager 没有读 trace artifacts。
- 运行了哪些命令。
- 哪些通过，哪些没跑或失败。
- 下一阶段是否可以进入 AgentRuntime Skeleton。
```

---

## 11. 下一阶段预期

如果本阶段完成，可以进入：

```text
AgentRuntime Skeleton
```

进入条件：

- agent-loop 的 prompt/context 组织已通过 ContextManager / Prompt Sections 接管。
- ContextManager 不依赖 trace artifacts。
- PageState/FormState 能稳定进入 prompt。
- recentActions 有预算控制。
- benchmark-simple 和 agent-loop 测试不退化。
- 仍保留 `runAgentLoop` 兼容入口。
