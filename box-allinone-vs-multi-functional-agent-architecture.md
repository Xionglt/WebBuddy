## box-allinone 与 Web Buddy Agent Harness 架构对比及演进设计

> **当前定位说明（2026-07）**：Web Buddy 已定位为面向多场景网页任务的通用
> Web Agent Runtime。本文保留招聘流程作为复杂业务 Skill 和 benchmark 案例，
> 但招聘不是 Runtime 的产品边界。文中部分“缺少/目标态”描述来自早期架构分析，
> 当前实现状态应以根目录 `README.md` 和实际代码为准。

### 0. 文档目标

本文档用于系统性对比 `box-allinone` 与 Web Buddy 在 Agent 架构上的差异，并说明
Web Buddy 如何在保持浏览器执行优势的同时，形成可承载多类网页任务的 Agent
Harness。

本文主要回答四个问题：

- **二者在 Agent 架构上有什么本质区别？**
- **通用 Agent 平台与浏览器 Agent Harness 的职责边界是什么？**
- **Web Buddy 如何通过 Runtime、Skill、Workflow 与 Policy 支持多种网页场景？**
- **Web Buddy 还应从哪些模块、机制和工程体系上继续演进？**

本文采用如下 Agent Harness 分析框架：

```text
Agent Harness
= Agent Loop
+ Tools
+ Observation
+ Action Interfaces
+ Context
+ Memory
+ Knowledge / Skills
+ Planning / Workflow
+ Permission / Safety
+ Runtime
+ Trace / Evaluation
```

---

## 1. 总体结论

### 1.1 一句话结论

**`box-allinone` 是通用 Agent 平台，Web Buddy 是以浏览器为核心执行环境的通用 Web Agent Harness。**

二者都属于 Agent Harness，但它们构造的“世界模型”不同：

```text
box-allinone 构造的是：软件工程与生产力任务世界
Web Buddy 构造的是：可观察、可操作、可治理的网页任务世界
```

更具体地说：

```text
box-allinone
= 通用 Agent Loop
+ 多模型适配
+ 多 Agent 模式
+ 文件 / Shell / LSP / MCP / Skill 工具系统
+ 上下文压缩
+ 长期记忆
+ 技能系统
+ Server / CLI / Desktop 多入口
+ 安全治理
+ 观测与成本体系
```

```text
Web Buddy
= 本地 Agent Loop 与异步任务编排
+ Playwright / MCP 浏览器工具
+ Page / Form Observation
+ Context Selection / Compaction / Session
+ Policy / Permission / Human Gate
+ Workflow / Completion Gate
+ Skill 与场景扩展
+ Trace / Metrics / Safety Report
```

因此，`box-allinone` 更像覆盖软件工程与生产力工具的通用平台底座；Web Buddy
则专注于浏览器这一执行环境，但可以承载网页研究、比较决策、表单处理、预订准备、
招聘辅助和自定义站点流程等多种业务场景。

---

## 2. 核心差异总览

| 维度 | `box-allinone` | `multi-functional-agent` |
|---|---|---|
| **架构类型** | 平台级 Agent 系统 | 通用 Web Agent Harness |
| **主要场景** | 编程、问答、规划、技能调用、知识库、桌面/服务端集成 | 网页研究、比较决策、表单、预订、招聘辅助、自定义网页流程 |
| **核心环境** | 本地项目、代码库、文件系统、Shell、LSP、MCP、技能、知识库 | 浏览器页面、DOM、表单、URL、Cookie、截图 |
| **Agent Loop** | 通用多模式 Agent Loop | 浏览器 ReAct Loop + 异步 Task Graph |
| **工具体系** | 大而全，可扩展，支持 MCP 和 Skills | 小而深，集中在 Playwright 浏览器工具 |
| **上下文管理** | Token 预算、摘要、归档、会话持久化 | Context Selection、分层压缩、artifact 外置与 compact/resume |
| **长期记忆** | 有 Memory / Memory Index / 知识库类能力 | Session facts、Run Memory 与任务恢复；长期语义知识仍可增强 |
| **规划能力** | Ask / Craft / Plan 模式与 task/subagent 能力 | ReAct、Task Graph、后台任务、Workflow 与 Completion Gate |
| **安全体系** | 通用工具安全、URL 安全、泄漏检测、审批 | 浏览器动作风险等级 L0-L4 + human gate |
| **可观测性** | 平台日志、遥测、成本、测试体系 | session、trace、metrics、screenshot、risk decision 与 safety report |
| **产品化程度** | 高，偏完整产品平台 | 中，偏可审计的 Web Runtime 与多场景工程基线 |

---

## 3. 项目定位对比

### 3.1 `box-allinone` 的定位

`box-allinone` 更像一个完整的 Agent 产品大仓，其中 `cocode` 是核心 Agent 引擎。

它包含的典型能力包括：

- **模型适配层**
  - OpenAI
  - Claude
  - Venus
  - Taiji
  - model alias
  - model pool
  - message sanitizer

- **Agent 编排层**
  - BaseAgent
  - CraftAgent
  - AskAgent
  - PlanAgent
  - AgentFactory
  - AgentRegistry
  - configurable agent
  - subagent

- **上下文系统**
  - ContextBuilder
  - token counter
  - summarizer
  - history archive
  - project scanner
  - tool output filer

- **工具系统**
  - file
  - search
  - command
  - web
  - LSP
  - MCP
  - task
  - skill
  - automation
  - knowledge
  - media
  - integration

- **技能系统**
  - skill registry
  - skill loader
  - skill executor
  - skill recommender
  - skill safety checker
  - skill encryption

- **规则与知识**
  - rules
  - memory client
  - meta store
  - knowledge integration

- **服务化能力**
  - CLI
  - Server mode
  - session pool
  - HTTP API
  - approval manager

- **工程基础设施**
  - persistence
  - config schema
  - telemetry
  - process sandbox
  - error recovery
  - streaming
  - security hooks

所以，`box-allinone` 的核心不是“某个 Agent 能做什么任务”，而是：

> **它提供了一整套可以承载多类 Agent、多类工具、多类任务、多类入口的 Agent 平台底座。**

### 3.2 `multi-functional-agent` 的定位

项目核心集中在 `packages/web-buddy`，面向需要网页观察、推理、操作和风险控制的
多步骤任务。

它包含的典型能力包括：

- **浏览器工具**
  - browser open
  - browser snapshot
  - click
  - type
  - select
  - screenshot
  - upload file

- **Agent Loop**
  - 浏览器 ReAct 循环
  - 基于页面 snapshot 观察
  - LLM 选择工具
  - 工具结果回写给模型
  - 根据 step budget 停止

- **页面观察**
  - PageView
  - Snapshot builder
  - Ref resolver
  - Risk detector

- **任务编排**
  - raw
  - fill
  - match
  - demo-form
  - demo-research
  - Task Graph / background tasks
  - compact / resume / cancel

- **多场景能力**
  - 网页研究与结构化总结
  - 候选项比较、约束验证与决策支持
  - 通用表单规划、填写和回读校验
  - 预订或交易前流程
  - 招聘研究、匹配与申请草稿等领域 Skill
  - 自定义 Prompt / Skill / Workflow 扩展

- **安全与人工确认**
  - 风险等级 L0-L4
  - HumanGate
  - navigation guard
  - final submit gate

- **Trace**
  - JSONL trace
  - screenshot path
  - summary
  - max risk
  - task status

它当前的优势非常明确：

> **让 LLM 通过 Playwright 在真实网页上稳定执行多步骤任务，并用
> snapshot/ref/context/task graph/policy/gate/trace 保证可控性。**

这是一种典型的 Web Agent Harness。

它的边界也很明确：它不追求覆盖文件、Shell、IDE 等所有执行环境，而是把浏览器
任务的可靠执行、安全治理、上下文管理和场景扩展做深。

---

## 4. Agent Loop 对比

### 4.1 `box-allinone` 的 Agent Loop

`box-allinone` 的 Agent Loop 是通用型的，可以服务多种 Agent 模式。

典型流程如下：

```text
用户输入
  ↓
创建 Agent
  ↓
构建 system prompt
  ↓
构建上下文
  ↓
选择工具
  ↓
调用模型
  ↓
解析 tool call
  ↓
执行工具
  ↓
把工具结果写回 messages
  ↓
继续循环或输出最终答案
  ↓
保存 session
```

它面向的是通用生产力任务，而不是某个单一环境。

### 4.2 `multi-functional-agent` 的 Agent Loop

`multi-functional-agent` 的核心循环是浏览器场景下的 ReAct Loop。

典型流程如下：

```text
打开网页或使用已有页面
  ↓
browser_snapshot 获取页面视图
  ↓
构造 system prompt + resume brief + task
  ↓
LLM 选择浏览器工具
  ↓
ToolRegistry 执行工具
  ↓
如果风险高，HumanGate 确认
  ↓
如果页面变化，刷新 snapshot
  ↓
把 observation 回填给模型
  ↓
直到 agent_done / blocked / maxSteps
```

这个循环非常适合网页操作，但通用性不足。

### 4.3 差异总结

| 维度 | `box-allinone` | `multi-functional-agent` |
|---|---|---|
| **Loop 目标** | 通用任务执行 | 浏览器网页操作 |
| **Loop 输入** | 用户消息、项目上下文、工具、规则、记忆 | 目标网页、简历、页面 snapshot、任务 prompt |
| **Loop 输出** | 文本、文件修改、命令结果、任务状态 | 表单填写结果、网页状态、trace、summary |
| **停止条件** | 模型最终回答、工具循环结束、会话保存 | agent_done、human gate 阻塞、step budget |
| **模式扩展** | AgentFactory + AgentRegistry | AgentMode 分支 + orchestrator preset |

### 4.4 优化建议

`multi-functional-agent` 应该把当前的单体浏览器循环拆成更通用的 Agent Runtime：

```text
AgentRuntime
├── LoopController
├── PromptAssembler
├── ContextManager
├── ToolRouter
├── PermissionManager
├── ObservationManager
├── MemoryManager
├── TraceManager
└── StopConditionManager
```

当前一个 loop 中混杂了：

- prompt 构造
- resume brief 组装
- 首次 snapshot
- LLM 调用
- tool call 执行
- gate 判断
- trace 记录
- observation 截断
- pageChanged 后刷新
- done/blocked 判断

这些都应该拆成独立模块，形成可扩展的 Agent Core。

---

## 5. Tools 工具体系对比

### 5.1 `box-allinone` 的工具体系

`box-allinone` 的工具系统接近完整 coding agent / productivity agent 工具平台。

它有：

- 工具注册表
- 工具执行服务
- 工具路由
- 工具参数校验
- 工具 hooks
- 安全 hooks
- MCP 工具
- 内置工具
- 技能工具
- 按需暴露工具

这说明它的工具系统不是简单 map，而是一个完整执行层。

### 5.2 `multi-functional-agent` 的工具体系

`multi-functional-agent` 的工具定义很简洁，当前主要围绕浏览器：

- browser_open
- browser_snapshot
- browser_click
- browser_type
- browser_select
- browser_wait
- browser_screenshot
- agent_done

当前工具抽象具有以下优点：

- 工具 schema 清晰
- 能直接转 function calling schema
- 风险可以按工具或元素动态解析
- MCP server 和 Agent loop 可以共用工具定义

但当前也存在明显不足：

- 工具种类太少
- 工具没有分类
- 没有工具路由
- 没有渐进式工具加载
- 没有工具权限策略层
- 没有工具版本管理
- 没有工具 marketplace / skill 化
- 工具执行前后 hook 较弱
- 工具缺少统一 validator / sanitizer / audit metadata

### 5.3 优化建议：从 ToolRegistry 升级到 Tool Platform

建议从：

```text
ToolRegistry = Map<string, ToolDef>
```

升级为：

```text
ToolPlatform
├── ToolRegistry
├── ToolRouter
├── ToolExecutionService
├── ToolValidator
├── ToolPermissionResolver
├── ToolHookChain
├── ToolResultNormalizer
├── ToolCatalog
├── McpToolAdapter
└── SkillToolAdapter
```

### 5.4 建议新增工具分类

#### Browser Tools

```text
browser_open
browser_snapshot
browser_click
browser_type
browser_select
browser_wait
browser_screenshot
browser_upload_file
browser_download_file
browser_scroll
browser_hover
browser_press_key
browser_back
browser_forward
browser_reload
browser_extract_links
browser_extract_table
browser_get_cookies
browser_set_cookies
```

#### Web Data Tools

```text
web_extract_job_list
web_extract_form_schema
web_extract_profile_fields
web_extract_product_info
web_extract_table
web_extract_article
```

#### File Tools

```text
file_read
file_write
file_search
file_list
file_upload_prepare
file_convert
```

#### Knowledge Tools

```text
knowledge_search
knowledge_add
knowledge_get_profile
knowledge_get_preference
knowledge_update_preference
```

#### Memory Tools

```text
memory_recall
memory_write
memory_summarize_run
memory_update_user_profile
memory_get_site_strategy
```

#### Human Tools

```text
human_confirm
human_takeover
human_input
human_review_form
human_select_option
human_resume_control
```

#### Evaluation Tools

```text
eval_check_form_completeness
eval_check_policy_risk
eval_compare_job_match
eval_score_action_plan
```

### 5.5 工具执行链建议

当前工具执行链大致是：

```text
registry.resolveRisk
  ↓
gate.confirm
  ↓
registry.run
  ↓
trace.record
```

建议演进为：

```text
ToolCall
  ↓
ToolValidator
  ↓
ToolPermissionResolver
  ↓
ToolHookChain.beforeExecute
  ↓
ToolExecutionService
  ↓
ToolHookChain.afterExecute
  ↓
ToolResultNormalizer
  ↓
ObservationCompressor
  ↓
TraceManager
```

这样可以支持：

- 参数校验
- 权限检查
- 风险识别
- 敏感信息脱敏
- 工具结果压缩
- 失败重试
- fallback
- 审计日志
- 成本统计

---

## 6. Observation 对比

### 6.1 `box-allinone` 的观察对象

`box-allinone` 观察的是软件工程环境：

- 当前项目结构
- 文件内容
- 搜索结果
- Shell 输出
- Git 状态
- LSP 诊断
- 规则文件
- 技能说明
- 历史会话
- 知识库
- 记忆

它的核心是把工程世界转换为模型可消费的上下文。

### 6.2 `multi-functional-agent` 的观察对象

`multi-functional-agent` 观察的是网页：

- URL
- 页面标题
- DOM 元素
- 元素 ref
- 元素文本
- 表单字段
- button / input / select
- 风险等级
- 截图
- 页面变化

这种 ref-based observation 非常适合 Web Agent。

示例：

```text
[e1] input "姓名 Name" risk=L2
[e2] input "邮箱 Email" risk=L2
[e3] button "保存草稿 Save draft" risk=L2
[e4] button "投递申请 Submit application" risk=L3
```

### 6.3 当前不足

`multi-functional-agent` 的 observation 主要是即时页面状态，缺少更高层抽象：

- 没有持久的 page state model
- 没有 form schema model
- 没有 site model
- 没有 user journey model
- 没有 task progress model
- 没有 semantic page memory
- 没有跨页面信息融合
- 没有从 trace 中总结经验

### 6.4 优化建议：建立多层 Observation Model

```text
ObservationManager
├── RawObservation
│   ├── DOM snapshot
│   ├── screenshot
│   ├── URL
│   └── cookies/session info
├── StructuredObservation
│   ├── interactive elements
│   ├── forms
│   ├── tables
│   ├── links
│   └── modals
├── SemanticObservation
│   ├── page type
│   ├── task stage
│   ├── risk summary
│   ├── available actions
│   └── blockers
└── HistoricalObservation
    ├── previous pages
    ├── repeated elements
    ├── failed actions
    └── site-specific lessons
```

建议定义标准 `PageState`：

```ts
interface PageState {
  sessionId: string
  url: string
  title?: string
  pageType:
    | 'login'
    | 'job_list'
    | 'job_detail'
    | 'application_form'
    | 'confirmation'
    | 'captcha'
    | 'unknown'
  elements: PageElement[]
  forms: FormSchema[]
  risks: RiskSummary
  blockers: Blocker[]
  screenshotPath?: string
  capturedAt: string
}
```

对于求职类 Agent，建议定义 `FormState`：

```ts
interface FormState {
  formId: string
  fields: FormFieldState[]
  requiredFields: string[]
  filledFields: string[]
  missingRequiredFields: string[]
  uncertainFields: string[]
  submitCandidates: PageElement[]
  saveCandidates: PageElement[]
  completenessScore: number
}
```

这样模型不只是看到“页面上有什么”，还可以知道：

- 哪些字段已填
- 哪些必填字段未填
- 哪些字段不确定
- 当前是否可以保存
- 是否接近最终提交
- 是否需要人工确认

---

## 7. Context Management 对比

### 7.1 `box-allinone`

`box-allinone` 有比较成熟的上下文管理：

- token 预算
- 自动摘要
- 历史归档
- 工具输出归档
- 项目扫描
- 上下文 builder
- LLM summarizer
- session persistence
- 渐进式工具暴露

这是长期运行 Agent 必须具备的能力。

### 7.2 `multi-functional-agent`

`multi-functional-agent` 当前主要依赖 messages 数组维护上下文，并对工具 observation 做简单截断。

这对短任务足够，但不适合长任务。

当任务变复杂时，会遇到：

- 页面 snapshot 太长
- trace 太长
- 岗位列表太多
- 多页面信息难以保留
- LLM 忘记早期目标
- 重复做同样动作
- 无法跨 session 恢复
- 无法基于历史经验优化
- 无法根据 token budget 动态裁剪

### 7.3 优化建议：建立 Context Manager

```text
ContextManager
├── MessageStore
├── TokenBudgetManager
├── ObservationCompressor
├── HistorySummarizer
├── ToolOutputFiler
├── GoalStateTracker
├── WorkingMemory
├── LongTermMemoryInjector
└── PromptSectionAssembler
```

上下文可以分层为：

```text
Prompt Context
├── System Instructions
├── Safety Policy
├── User Goal
├── User Profile / Resume
├── Current Task State
├── Current Page State
├── Relevant Memory
├── Relevant Skill
├── Available Tools
├── Recent Steps
└── Compressed History
```

建议新增 `TaskState`：

```ts
interface TaskState {
  goal: string
  mode: string
  stage:
    | 'init'
    | 'login'
    | 'search'
    | 'match'
    | 'open_form'
    | 'fill_form'
    | 'review'
    | 'submit_gate'
    | 'done'
    | 'blocked'
  progress: string[]
  openQuestions: string[]
  blockers: string[]
  lastAction?: string
  nextSuggestedActions: string[]
}
```

### 7.4 上下文压缩策略

| 上下文类型 | 保留方式 |
|---|---|
| 当前页面 snapshot | 原文保留 |
| 上一页 snapshot | 摘要保留 |
| 早期工具 observation | 摘要或归档 |
| 截图路径 | 保留路径，不塞图片内容 |
| 岗位列表 | Top N 原文 + 其余摘要 |
| 用户简历 | 结构化保留 |
| 用户偏好 | 长期记忆检索注入 |
| 失败动作 | 保留为 warnings |
| 已确认安全决策 | 保留 gate history |

---

## 8. Memory 对比

### 8.1 `box-allinone`

`box-allinone` 有记忆相关能力，例如：

- agent memory file
- session memory hook
- memory index
- memory client
- meta store
- 知识库/长期记忆服务

它可以把用户偏好、历史经验、项目知识沉淀下来。

### 8.2 `multi-functional-agent`

`multi-functional-agent` 当前的持久化主要是：

- trace JSONL
- screenshots
- summary
- cookies / storage state
- resume file
- run output

这些不是严格意义上的长期语义记忆。

它能记住：

```text
这个浏览器登录过
这次任务做了哪些步骤
最后截图是什么
```

但它还不能很好地记住：

```text
用户偏好什么岗位
用户不想去哪些城市
哪些网站上次失败了
某网站投递流程有什么坑
某个字段应该怎么填
用户对薪资/行业/公司规模有什么偏好
```

### 8.3 优化建议：建立四类记忆

#### User Memory

记录用户长期偏好：

```ts
interface UserMemory {
  userId: string
  jobPreferences: {
    desiredRoles: string[]
    undesiredRoles: string[]
    cities: string[]
    industries: string[]
    companySizes: string[]
    salaryExpectation?: string
    remotePreference?: string
  }
  applicationPreferences: {
    allowAutoSubmit: boolean
    requireReviewBeforeSubmit: boolean
    preferredResumeVersion?: string
    coverLetterStyle?: string
  }
}
```

#### Site Memory

记录网站经验：

```ts
interface SiteMemory {
  domain: string
  loginFlow?: string
  commonSelectors: Record<string, string>
  knownBlockers: string[]
  submitRiskPattern: string[]
  formFieldMappings: Record<string, string>
  lastSuccessfulStrategy?: string
}
```

#### Task Memory

记录任务历史：

```ts
interface TaskMemory {
  taskId: string
  goal: string
  status: 'success' | 'blocked' | 'failed'
  summary: string
  keySteps: string[]
  blockers: string[]
  learnedLessons: string[]
}
```

#### Experience Memory

记录可复用经验：

```ts
interface ExperienceMemory {
  id: string
  scenario: string
  problem: string
  solution: string
  confidence: number
  sourceRunId: string
}
```

### 8.4 记忆写入流程

```text
任务开始
  ↓
memory_recall：注入用户偏好、网站经验
  ↓
任务执行
  ↓
记录关键事件
  ↓
任务结束
  ↓
memory_summarize_run
  ↓
提取偏好 / 经验 / 失败原因
  ↓
memory_write
```

需要注意，不能什么都写进长期记忆。建议加一层 `MemoryPolicy`：

```text
MemoryPolicy
├── 是否长期有效？
├── 是否用户明确表达偏好？
├── 是否包含敏感信息？
├── 是否可从任务复盘中抽象出经验？
├── 是否需要用户确认？
└── 是否已有冲突记忆？
```

---

## 9. Knowledge / Skills 对比

### 9.1 `box-allinone`

`box-allinone` 的 Skill 系统是平台级能力：

- skill loader
- skill registry
- skill recommender
- skill executor
- skill safety checker
- skill encryption

这意味着新能力可以以 Skill 的方式被加载、推荐和执行。

### 9.2 `multi-functional-agent`

当前的知识主要来自：

- 简历文件
- 简历解析结果
- 岗位列表
- 岗位详情
- 当前网页内容
- Alibaba 特定逻辑
- 用户 task prompt

它还没有真正的 Skill 体系。

像 Alibaba 招聘网站逻辑，本质上已经是“技能”，但目前更接近硬编码在 SDK 里的流程。

### 9.3 当前问题

随着支持的网站变多，会出现：

- orchestrator 越来越臃肿
- 每个网站逻辑混在一起
- 难以热插拔
- 难以版本管理
- 难以测试
- 难以给模型按需加载
- 难以维护 site-specific prompt
- 难以沉淀网站策略

### 9.4 优化建议：引入 Web Skill System

建议把站点能力抽象为 `WebSkill`：

```ts
interface WebSkill {
  id: string
  name: string
  version: string
  domainPatterns: string[]
  description: string

  detect(ctx: SkillDetectContext): Promise<SkillDetectResult>
  getPrompt(ctx: SkillContext): Promise<string>
  getTools(ctx: SkillContext): ToolDef[]
  getPolicies(ctx: SkillContext): PolicyRule[]
  getWorkflows(ctx: SkillContext): WorkflowDef[]
}
```

示例目录：

```text
skills/
└── alibaba-career/
    ├── skill.json
    ├── prompt.md
    ├── tools.ts
    ├── workflows.ts
    ├── policies.ts
    ├── extractors.ts
    └── tests/
```

Skill 推荐流程：

```text
当前 URL / 页面内容 / 用户任务
  ↓
SkillDetector
  ↓
匹配 domainPatterns / 页面特征
  ↓
SkillRecommender
  ↓
加载相关 Skill prompt/tools/policies
  ↓
注入 Agent Loop
```

这样 `multi-functional-agent` 就可以从：

```text
一个写死 Alibaba 的求职 Agent
```

变成：

```text
一个支持多网站、多行业、多任务的 Web Agent 平台
```

---

## 10. Planning / Workflow 对比

### 10.1 `box-allinone`

`box-allinone` 有更完整的任务与规划能力：

- PlanAgent
- task command
- subagent command
- TDD 工作流
- 会话管理
- 可恢复任务
- server execution

### 10.2 `multi-functional-agent`

`multi-functional-agent` 当前任务模式包括：

```text
raw
fill
match
alibaba-apply
demo-form
auto-apply
```

这些模式本质是 preset workflow。

当前流程大致是：

```text
选择 mode
  ↓
解析简历
  ↓
打开目标网站
  ↓
可选：登录
  ↓
可选：抓岗位
  ↓
可选：匹配岗位
  ↓
打开表单
  ↓
运行 LLM Agent Loop 填表
  ↓
保存 trace
```

这对求职投递很清晰，但还不是通用任务系统。

### 10.3 当前问题

- orchestrator 文件过大，职责太多
- 模式分支越来越复杂
- workflow 不能声明式配置
- 没有任务 DAG
- 没有任务暂停/恢复
- 没有任务重试策略
- 没有子任务分派
- 没有任务状态机持久化
- 没有 planner / executor 分离

### 10.4 优化建议：引入 Task Planner + Workflow Engine

建议拆成：

```text
TaskSystem
├── TaskPlanner
├── WorkflowEngine
├── TaskStateStore
├── StepExecutor
├── RetryPolicy
├── HumanHandoffManager
├── TaskScheduler
└── TaskReporter
```

将 `alibaba-apply` 变成声明式 workflow：

```yaml
id: alibaba-apply
name: Alibaba Apply Workflow
steps:
  - id: parse_resume
    action: resume.parse
  - id: open_job_list
    action: browser.open
  - id: scrape_jobs
    action: skill.alibaba.scrape_job_list
  - id: match_jobs
    action: matcher.rank
  - id: open_detail
    action: browser.open
  - id: enter_apply_flow
    action: skill.alibaba.enter_apply
    gate: high_risk_action
  - id: login_if_needed
    action: human.login
    when: page.type == login
  - id: fill_form
    action: agent.loop
  - id: review
    action: human.review
  - id: stop_before_submit
    action: agent.done
```

任务状态机可以设计为：

```text
created
  ↓
planning
  ↓
running
  ↓
waiting_human
  ↓
running
  ↓
reviewing
  ↓
completed / blocked / failed / cancelled
```

Planner / Executor 建议分离：

```text
Planner Agent
负责：拆解任务、选择 workflow、制定计划、评估风险

Executor Agent
负责：执行具体浏览器动作、工具调用、填表

Reviewer Agent
负责：检查结果、识别风险、决定是否交给人
```

---

## 11. Permission / Safety 对比

### 11.1 `box-allinone`

`box-allinone` 安全体系偏通用：

- tool security hook
- url check hook
- leak detection hook
- approval manager
- command/file/network 权限
- server auth / IP filter
- skill safety checker

### 11.2 `multi-functional-agent`

`multi-functional-agent` 的安全设计非常贴合网页操作。

当前风险等级：

```ts
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
```

风险含义可以概括为：

- `L0`：纯读取
- `L1`：低风险导航
- `L2`：普通输入
- `L3`：提交、申请、发送等高风险动作
- `L4`：密码、验证码、身份、支付、敏感上传

这套设计非常适合 Web Agent。

### 11.3 当前不足

- 风险策略散落在工具和 loop 中
- gate 策略不够可配置
- 缺少组织级 policy
- 缺少用户级 policy
- 缺少 domain-specific policy
- 缺少审计报告
- 缺少安全策略测试
- 缺少可解释的 risk reason
- 缺少风险豁免机制
- 缺少“允许自动执行但事后审计”的中间策略

### 11.4 优化建议：升级为 Policy Engine

```text
PolicyEngine
├── RiskClassifier
├── PermissionResolver
├── HumanGateManager
├── PolicyStore
├── AuditLogger
├── DomainPolicy
├── UserPolicy
├── OrganizationPolicy
└── PolicyTestRunner
```

Policy Rule 示例：

```yaml
id: never-auto-submit-external-job
scope: browser_click
when:
  element.text matches: ["提交", "投递", "Submit", "Apply"]
  url.host not in: ["localhost", "127.0.0.1"]
risk: L3
action: require_human_approval
reason: External final application submission requires human review.
```

用户级安全偏好：

```ts
interface UserSafetyPreference {
  allowAutoFill: boolean
  allowAutoSaveDraft: boolean
  allowAutoSubmit: boolean
  requireReviewBeforeUpload: boolean
  requireReviewBeforeExternalNavigation: boolean
  blockedDomains: string[]
  allowedDomains: string[]
}
```

每次任务结束应生成安全报告：

```text
Safety Report
├── maxRiskReached
├── riskyActions
├── humanGateDecisions
├── blockedActions
├── autoApprovedActions
├── finalSubmitAttempted
└── sensitiveFieldsTouched
```

---

## 12. Runtime / Deployment 对比

### 12.1 `box-allinone`

`box-allinone` 是多入口、多服务架构：

- CLI
- macOS 桌面端
- HTTP Server
- gateway
- proxy service
- backend
- memory service
- cost dashboard
- browser extension
- E2E tests

这说明它不是单个工具，而是产品系统。

### 12.2 `multi-functional-agent`

`multi-functional-agent` 当前主要是：

- Node / TypeScript package
- Playwright runtime
- MCP server
- Web dashboard
- CLI / demo
- trace output

它的部署形态更轻。

### 12.3 平台化需要补齐的能力

如果要做成更像 `box-allinone` 的平台，需要补：

- 多用户
- 多 session
- 任务队列
- 后台执行
- 权限管理
- API 服务
- 数据库
- 任务状态持久化
- trace 查询
- 用户配置
- 成本统计
- worker pool
- 浏览器池
- sandbox
- health check
- metrics

### 12.4 建议平台化运行架构

```text
multi-functional-agent-platform
├── apps/
│   ├── cli
│   ├── web-dashboard
│   └── desktop
├── services/
│   ├── agent-server
│   ├── browser-worker
│   ├── memory-service
│   ├── skill-service
│   ├── trace-service
│   ├── policy-service
│   └── scheduler
├── packages/
│   ├── agent-core
│   ├── browser-tools
│   ├── tool-runtime
│   ├── workflow-engine
│   ├── memory-client
│   ├── skill-runtime
│   ├── policy-engine
│   └── trace-sdk
└── storage/
    ├── postgres
    ├── sqlite
    ├── object-storage
    └── vector-db
```

运行时数据流：

```text
用户创建任务
  ↓
Agent Server
  ↓
Task Queue
  ↓
Browser Worker 获取任务
  ↓
Agent Runtime 执行
  ↓
Trace Service 记录
  ↓
Memory Service 写入经验
  ↓
Web Dashboard 实时展示
  ↓
Human Gate 需要时请求用户确认
  ↓
任务完成 / 阻塞 / 失败
```

---

## 13. Trace / Evaluation 对比

### 13.1 `box-allinone`

`box-allinone` 的评估与观测更偏平台：

- 日志
- telemetry
- metrics
- 成本
- CI
- E2E
- 覆盖率

### 13.2 `multi-functional-agent`

`multi-functional-agent` 的 trace 很贴合浏览器任务。

它通常记录：

- step
- timestamp
- phase
- action
- url
- risk
- screenshotPath
- observation
- status
- summary
- maxRiskReached

这是非常好的基础。

### 13.3 当前不足

- trace 主要是记录，不是评估
- 缺少自动质量评分
- 缺少任务成功率统计
- 缺少模型比较
- 缺少工具失败率
- 缺少网站维度分析
- 缺少 replay
- 缺少 regression test
- 缺少 benchmark dataset

### 13.4 优化建议：从 Trace 升级到 EvalOps

```text
EvalOps
├── TraceRecorder
├── TraceViewer
├── ReplayRunner
├── TaskEvaluator
├── RegressionSuite
├── ModelComparison
├── SiteBenchmark
├── SafetyEvaluator
└── CostAnalyzer
```

建议评估指标：

| 指标 | 含义 |
|---|---|
| `task_success_rate` | 任务完成率 |
| `blocked_rate` | 阻塞率 |
| `human_gate_count` | 人工确认次数 |
| `avg_steps` | 平均步骤数 |
| `tool_failure_rate` | 工具失败率 |
| `stale_ref_rate` | ref 失效率 |
| `form_completion_score` | 表单完成度 |
| `risk_exposure_score` | 风险暴露分 |
| `time_to_complete` | 完成耗时 |
| `model_cost` | 模型成本 |
| `browser_error_rate` | 浏览器错误率 |
| `site_success_rate` | 按网站统计成功率 |

Trace Replay 对 Web Agent 特别重要：

```text
trace.jsonl + screenshots + page snapshots
  ↓
Trace Replay Viewer
  ↓
可视化每一步：
  - 模型想了什么
  - 调用了哪个工具
  - 页面怎么变了
  - 为什么触发 gate
  - 哪里失败
```

---

## 14. `multi-functional-agent` 当前优点

### 14.1 Ref-based 页面操作设计很好

让模型通过 `[e1]`、`[e2]` 这样的 ref 操作页面，比直接让模型写 selector 更安全。

优点：

- 减少 CSS selector 幻觉
- 降低 DOM 复杂度
- 易于风险标注
- 易于审计
- 易于刷新 snapshot
- 易于跨站点泛化

这个设计应该继续强化。

### 14.2 Risk Level + Human Gate 很适合 Web Agent

`L0-L4` 风险模型非常贴合网页任务，尤其适合处理：

- 最终提交
- 文件上传
- 登录
- 验证码
- 身份信息
- 支付
- 外部网站写操作

建议保留并平台化。

### 14.3 Trace + Screenshot 对网页任务非常关键

浏览器 Agent 不像代码 Agent，只看文本日志很难判断发生了什么。

`multi-functional-agent` 记录截图路径和 trace JSONL，是非常好的方向。

建议继续发展成完整 Trace Viewer / Replay。

### 14.4 ToolRegistry 简洁清晰

当前工具抽象很小，但方向正确。

未来可以在不破坏当前设计的基础上增加：

- validator
- hook chain
- policy resolver
- result normalizer
- audit metadata

### 14.5 Orchestrator 已经有 workflow 意识

虽然 orchestrator 现在偏大，但它已经抽象出了多种任务模式。

这说明项目已经意识到不同任务需要不同流程。下一步应该把这种流程从代码分支升级为 workflow engine。

---

## 15. `multi-functional-agent` 当前短板

### 15.1 缺少平台级 Agent Core

当前核心是浏览器 Agent loop，不是通用 Agent runtime。

应该抽象出：

```text
AgentCore
├── AgentRuntime
├── AgentDefinition
├── AgentRegistry
├── AgentFactory
├── AgentMode
└── AgentLifecycle
```

### 15.2 缺少上下文管理系统

现在主要依赖 messages 数组和 observation 截断。长任务一定会遇到上下文膨胀问题。

### 15.3 缺少长期记忆

当前 trace 不是 memory。需要把任务经验、用户偏好、网站策略沉淀为可检索记忆。

### 15.4 缺少 Skill 机制

站点逻辑目前容易硬编码。支持更多网站后必须 Skill 化。

### 15.5 Orchestrator 职责过重

当前 orchestrator 同时负责：

- config
- resume
- browser env
- login
- mode branch
- scrape
- match
- gate
- agent loop
- fallback
- trace finalize

建议拆分为 workflow engine 和独立 step。

### 15.6 缺少任务状态持久化

现在每次 run 是一个过程，缺少：

- pause
- resume
- checkpoint
- retry
- cancel
- schedule
- multi-run tracking

### 15.7 多 Agent 协作仍需产品化

当前已经具备 Task Graph、后台任务、只读子 Agent、通知队列、租约恢复和取消语义。
后续重点不是把 Runtime 绑定到固定 Agent 名称，而是把这些能力产品化为稳定的
Research、Comparison、Form、Safety Review 等可组合角色，并补齐统一 Cockpit、
成本治理和跨进程恢复体验。

### 15.8 缺少模型 / 工具成本治理

平台化后必须知道：

- 每个任务花了多少 tokens
- 哪个模型成功率高
- 哪个网站最耗时
- 哪个工具失败率高
- 哪个 prompt 效果好

### 15.9 缺少测试与基准集

Web Agent 很容易被页面变化打断。必须要有：

- mock site
- replay test
- fixture pages
- skill tests
- policy tests
- regression suite

---

## 16. `multi-functional-agent` 目标架构设计

### 16.1 目标定位

Web Buddy 的当前定位是：

> **一个以浏览器为核心执行环境、通过 Skill 与 Workflow 承载多种场景的通用
> Web Agent Runtime。**

目标形态：

```text
Web Agent Platform
= 通用 Agent Runtime
+ 浏览器工具系统
+ Web Skill 生态
+ 长期记忆
+ Workflow Engine
+ Human Gate
+ Trace / EvalOps
+ 多用户任务服务
```

### 16.2 目标架构图

```text
┌──────────────────────────────────────────────────────────┐
│                    User Interfaces                        │
│        CLI / Web Dashboard / Desktop / API / MCP          │
├──────────────────────────────────────────────────────────┤
│                    Agent Server                           │
│   Task API │ Session API │ Trace API │ Skill API │ Gate API│
├──────────────────────────────────────────────────────────┤
│                    Agent Runtime                          │
│ AgentFactory │ AgentRegistry │ LoopController │ Planner   │
│ ContextManager │ PromptAssembler │ StopConditionManager    │
├──────────────────────────────────────────────────────────┤
│                    Workflow System                        │
│ WorkflowEngine │ TaskStateStore │ Scheduler │ Checkpoint   │
├──────────────────────────────────────────────────────────┤
│                    Tool Platform                          │
│ ToolRegistry │ ToolRouter │ ExecutionService │ HookChain    │
│ BrowserTools │ FileTools │ WebTools │ MemoryTools │ MCPTools │
├──────────────────────────────────────────────────────────┤
│                    Knowledge & Skills                     │
│ SkillRegistry │ SkillLoader │ SkillRecommender │ Policies   │
│ SiteSkills │ FormSkills │ JobSkills │ UserProfileSkills    │
├──────────────────────────────────────────────────────────┤
│                    Memory System                          │
│ UserMemory │ SiteMemory │ TaskMemory │ ExperienceMemory    │
│ VectorSearch │ Summary │ Preference Store                  │
├──────────────────────────────────────────────────────────┤
│                    Safety & Governance                    │
│ RiskClassifier │ PolicyEngine │ HumanGate │ AuditLogger    │
├──────────────────────────────────────────────────────────┤
│                    Observation Layer                      │
│ PageSnapshot │ FormState │ PageState │ Screenshot │ Replay │
├──────────────────────────────────────────────────────────┤
│                    Runtime Infrastructure                 │
│ BrowserPool │ WorkerPool │ Queue │ DB │ Object Storage      │
├──────────────────────────────────────────────────────────┤
│                    EvalOps / Telemetry                    │
│ TraceRecorder │ TraceViewer │ EvalRunner │ Metrics │ Cost   │
└──────────────────────────────────────────────────────────┘
```

---

## 17. 模块级重构建议

### 17.1 拆分 Agent Loop

建议拆成：

```text
src/agent/
├── runtime.ts
├── loop-controller.ts
├── prompt-assembler.ts
├── context-manager.ts
├── stop-condition.ts
├── agent-definition.ts
├── agent-registry.ts
└── agents/
    ├── browser-agent.ts
    ├── job-application-agent.ts
    ├── form-fill-agent.ts
    └── raw-browser-agent.ts
```

职责变化：

| 当前职责 | 未来位置 |
|---|---|
| runAgentLoop | AgentRuntime.run |
| buildSystemPrompt | PromptAssembler |
| resumeBrief | ProfileContextProvider |
| 初始 snapshot | ObservationManager |
| tool call 执行 | ToolExecutionService |
| gate 判断 | PolicyEngine / HumanGateManager |
| trace 记录 | TraceHook |
| messages 管理 | ContextManager |
| done / blocked 判断 | StopConditionManager |

### 17.2 拆分 Orchestrator

建议拆成：

```text
src/workflows/
├── workflow-engine.ts
├── workflow-definition.ts
├── workflow-registry.ts
├── task-state-store.ts
├── steps/
│   ├── parse-resume-step.ts
│   ├── open-url-step.ts
│   ├── ensure-login-step.ts
│   ├── scrape-jobs-step.ts
│   ├── match-jobs-step.ts
│   ├── open-form-step.ts
│   ├── run-agent-loop-step.ts
│   └── finalize-step.ts
└── presets/
    ├── raw.workflow.ts
    ├── fill.workflow.ts
    ├── match.workflow.ts
    ├── alibaba-apply.workflow.ts
    ├── auto-apply.workflow.ts
    └── demo-form.workflow.ts
```

### 17.3 重构工具系统

```text
src/tools/
├── registry.ts
├── router.ts
├── execution-service.ts
├── validator.ts
├── hook-chain.ts
├── result-normalizer.ts
├── browser/
├── file/
├── web/
├── memory/
├── human/
├── eval/
└── mcp/
```

### 17.4 新增 Skill 系统

```text
src/skills/
├── skill-definition.ts
├── skill-registry.ts
├── skill-loader.ts
├── skill-recommender.ts
├── skill-executor.ts
├── skill-policy.ts
└── builtin/
    ├── alibaba-career/
    ├── generic-job-board/
    ├── linkedin/
    ├── boss-zhipin/
    └── greenhouse/
```

### 17.5 新增 Memory 系统

```text
src/memory/
├── memory-client.ts
├── memory-store.ts
├── memory-policy.ts
├── memory-summarizer.ts
├── retrievers/
│   ├── user-memory-retriever.ts
│   ├── site-memory-retriever.ts
│   ├── task-memory-retriever.ts
│   └── experience-memory-retriever.ts
└── writers/
    ├── preference-writer.ts
    ├── site-strategy-writer.ts
    └── run-summary-writer.ts
```

### 17.6 新增 Policy Engine

```text
src/policy/
├── policy-engine.ts
├── risk-classifier.ts
├── permission-resolver.ts
├── audit-logger.ts
├── human-gate-manager.ts
├── rules/
│   ├── browser-action.rules.ts
│   ├── form-submit.rules.ts
│   ├── upload.rules.ts
│   └── login.rules.ts
└── tests/
```

### 17.7 新增 Trace / EvalOps

```text
src/eval/
├── trace-recorder.ts
├── trace-viewer-model.ts
├── replay-runner.ts
├── evaluator.ts
├── metrics.ts
├── benchmark.ts
├── model-comparison.ts
└── safety-evaluator.ts
```

---

## 18. 多 Agent 协作设计

如果要像 `box-allinone` 一样更强，`multi-functional-agent` 可以引入多 Agent 架构。

### 18.1 求职场景多 Agent 拆分

```text
Job Search Agent
负责：搜索职位、抓取职位列表

Job Match Agent
负责：根据简历和偏好打分排序

Company Research Agent
负责：调研公司背景、业务、口碑

Resume Tailor Agent
负责：针对岗位优化简历 / cover letter

Browser Execution Agent
负责：真实网页操作

Form Fill Agent
负责：字段映射、表单填写

Safety Review Agent
负责：提交前审查、敏感动作识别

Human Liaison Agent
负责：向用户请求确认、总结需要人工处理的问题
```

### 18.2 多 Agent 调度架构

```text
User Goal
  ↓
Coordinator Agent
  ↓
Task Planner
  ↓
分派子任务：
  ├── Search Agent
  ├── Match Agent
  ├── Research Agent
  ├── Browser Agent
  ├── Review Agent
  └── Human Agent
  ↓
汇总结果
  ↓
最终报告 / 浏览器状态 / 待确认事项
```

---

## 19. 平台化后可支持的 Agent 类型

### 19.1 Job Application Agent

当前已有基础。

能力：

- 读取简历
- 搜索岗位
- 匹配岗位
- 填写申请表
- 停在提交前
- 记录 trace
- 记住用户偏好

### 19.2 Web Form Agent

通用表单 Agent：

- 报销单
- 申请单
- 注册表
- 问卷
- CRM 表单
- SaaS 后台配置

### 19.3 Web Research Agent

浏览器调研 Agent：

- 打开多个网页
- 抽取信息
- 对比结果
- 生成结构化报告
- 保存来源 trace

### 19.4 Shopping / Booking Agent

购物或预订 Agent：

- 搜索商品 / 航班 / 酒店
- 对比价格
- 检查约束
- 停在付款前
- human gate 确认

### 19.5 Admin Console Agent

后台管理 Agent：

- 登录管理后台
- 查找用户
- 修改配置
- 导出数据
- 高风险操作审批

### 19.6 QA / Web Testing Agent

自动网页测试 Agent：

- 执行测试用例
- 观察页面变化
- 截图
- 发现 bug
- 生成报告

---

## 20. 分阶段落地路线图

### Phase 1：核心解耦，先把架构拆干净

目标：

> 从“能跑”变成“结构清晰、可扩展”。

建议做：

- 拆分 Agent Loop
  - PromptAssembler
  - ContextManager
  - LoopController
  - ToolExecutionService
  - PermissionManager

- 拆分 Orchestrator
  - workflow presets
  - workflow steps
  - task state

- 强化 ToolRegistry
  - validator
  - hook
  - tool categories

验收标准：

- Agent Loop 不再承担所有职责
- 每个模块可以单测
- 原有 fill / raw / demo-form 模式继续可用
- trace 不丢失

### Phase 2：上下文与任务状态

目标：

> 让 Agent 能做更长任务，并知道自己做到哪一步。

建议做：

- 新增 TaskState
- 新增 ContextManager
- 新增 ObservationCompressor
- 新增 FormState
- 新增 PageState
- 将当前页面状态和任务状态注入 prompt

验收标准：

- 长表单不会轻易上下文爆炸
- Agent 能总结已填字段和未填字段
- 页面变化后状态可追踪
- step budget 触发时能给出可继续的状态摘要

### Phase 3：Skill 化站点逻辑

目标：

> 从 Alibaba 单点逻辑变成多站点能力框架。

建议做：

- 新增 SkillRegistry
- 新增 SkillLoader
- 新增 SkillRecommender
- 把 Alibaba 逻辑改造成 alibaba-career skill
- 新增 generic-job-board skill
- workflow 支持 skill 注入

验收标准：

- 新增一个站点不需要改 orchestrator 主逻辑
- skill 能贡献 prompt / tools / policies / workflows
- skill 有独立测试

### Phase 4：Memory 系统

目标：

> 让 Agent 记住用户偏好、网站经验和失败教训。

建议做：

- 新增 MemoryStore
- 新增 memory_recall
- 新增 memory_write
- 任务结束自动总结经验
- 用户偏好进入长期记忆
- site-specific strategy 进入站点记忆

验收标准：

- 第二次访问同一网站能利用上次经验
- 用户岗位偏好能影响匹配
- 阻塞原因能沉淀为经验
- 敏感信息不会误写入长期记忆

### Phase 5：Policy Engine 平台化

目标：

> 从局部 human gate 升级为完整安全治理。

建议做：

- 新增 PolicyEngine
- 新增 RiskClassifier
- 新增 AuditLogger
- 支持用户级 / 站点级 / 组织级 policy
- 支持 policy tests
- 生成 safety report

验收标准：

- L3/L4 操作都有可解释 risk reason
- 每次 human gate 都可审计
- 可以按 domain 配置安全策略
- 外部最终提交默认不可自动执行

### Phase 6：Server / Worker / Queue

目标：

> 从本地单任务 runtime 升级为可服务化平台。

建议做：

- 新增 agent server
- 新增 task queue
- 新增 browser worker
- 新增 task state database
- 新增 trace API
- Web dashboard 实时展示任务进度
- 支持 pause / resume / cancel

验收标准：

- 可以同时跑多个任务
- 每个任务有独立 session
- 浏览器上下文隔离
- 任务中断后可恢复
- human gate 可以通过 Web UI 确认

### Phase 7：EvalOps 与 Benchmark

目标：

> 让 Agent 可持续优化，而不是只靠人工观察。

建议做：

- trace viewer
- replay runner
- mock sites
- regression suite
- task evaluator
- model comparison
- tool failure metrics
- cost analyzer

验收标准：

- 每次改 prompt / tool / policy 都能跑回归
- 能比较不同模型的成功率
- 能统计不同网站的失败原因
- 能复盘每一步浏览器动作

---

## 21. 推荐最终目录结构

```text
packages/web-agent-core/
├── src/
│   ├── agent/
│   │   ├── runtime.ts
│   │   ├── loop-controller.ts
│   │   ├── agent-definition.ts
│   │   ├── agent-registry.ts
│   │   ├── prompt-assembler.ts
│   │   └── context-manager.ts
│   ├── tools/
│   │   ├── registry.ts
│   │   ├── router.ts
│   │   ├── execution-service.ts
│   │   ├── hook-chain.ts
│   │   └── browser/
│   ├── observation/
│   │   ├── page-state.ts
│   │   ├── form-state.ts
│   │   ├── snapshot-builder.ts
│   │   └── compressor.ts
│   ├── workflows/
│   │   ├── workflow-engine.ts
│   │   ├── workflow-registry.ts
│   │   ├── task-state-store.ts
│   │   └── presets/
│   ├── skills/
│   │   ├── skill-definition.ts
│   │   ├── skill-registry.ts
│   │   ├── skill-loader.ts
│   │   └── builtin/
│   ├── memory/
│   │   ├── memory-store.ts
│   │   ├── memory-policy.ts
│   │   └── memory-summarizer.ts
│   ├── policy/
│   │   ├── policy-engine.ts
│   │   ├── risk-classifier.ts
│   │   └── audit-logger.ts
│   ├── trace/
│   │   ├── trace-recorder.ts
│   │   ├── trace-viewer.ts
│   │   └── replay.ts
│   ├── eval/
│   │   ├── evaluator.ts
│   │   ├── benchmark.ts
│   │   └── metrics.ts
│   └── model/
│       ├── llm-gateway.ts
│       ├── adapter.ts
│       └── model-router.ts
```

---

## 22. 从 `box-allinone` 借鉴的关键能力

### 22.1 必须借鉴

- **Agent Registry**
  - 支持多个 Agent 类型，而不是只有一个 browser loop。

- **Tool Router**
  - 不要一次性暴露所有工具，根据任务阶段暴露合适工具。

- **Context Builder**
  - 建立 token budget、摘要、历史归档。

- **Skill System**
  - 把站点逻辑从硬编码变成可加载 skill。

- **Memory System**
  - 沉淀用户偏好、网站经验、任务经验。

- **Hook Chain**
  - tool / model / context / memory / policy 都要有生命周期 hook。

- **Server Mode**
  - 支持多用户、多任务、后台运行。

- **Telemetry / Cost**
  - 统计模型成本、任务成功率、工具失败率。

- **Subagent**
  - 复杂任务拆给不同 Agent。

### 22.2 不必完全照搬

`box-allinone` 是 coding agent 平台，`multi-functional-agent` 不需要完全复制：

- 代码 LSP 体系
- 文件编辑工具全套能力
- coding-specific prompt
- TDD workflow
- 代码仓库扫描
- 大量工程命令

`multi-functional-agent` 更应该保留自己的特色：

- 浏览器真实操作
- 页面 snapshot
- DOM ref
- screenshot
- risk level
- human takeover
- trace replay

---

## 23. 关键架构原则

### 23.1 不要把浏览器 Agent 做成一堆 if/else

当前 AgentMode 分支还能接受，但未来继续加网站和任务会膨胀。

应该迁移到：

```text
Workflow + Skill + Policy + Tool
```

而不是：

```text
if mode === xxx
```

### 23.2 不要让 LLM 负责所有状态管理

LLM 擅长推理，不擅长可靠记忆状态。

应该让系统维护：

- task state
- page state
- form state
- memory
- policy decisions
- tool results

然后把必要摘要给模型。

### 23.3 保留 Web Agent 的独特优势

不要为了像 `box-allinone` 而丢掉自己的强项。

`multi-functional-agent` 的核心差异化能力应该是：

- Playwright 真实执行
- DOM ref 操作
- 页面 snapshot
- 截图复盘
- human takeover
- 风险分级
- Web workflow

这些比普通 coding agent 更适合网页自动化。

### 23.4 平台化不是简单加功能，而是抽象边界

最重要的不是加多少工具，而是拆清楚边界：

```text
Agent Runtime 不关心具体网站
Workflow 不关心具体工具实现
Skill 不关心模型调用细节
Policy 不关心业务流程
Memory 不关心 UI
Trace 不影响执行逻辑
```

### 23.5 所有高风险行为必须可解释、可审计、可回放

Web Agent 比 coding agent 更容易触发现实世界后果。

所以安全设计要遵循：

```text
Risk classified
→ Policy checked
→ Human gate if needed
→ Decision recorded
→ Trace replayable
→ Final report generated
```

---

## 24. 最重要的十条优化建议

### 1. 把 `runAgentLoop` 升级成通用 `AgentRuntime`

不要让 Agent Loop 同时承担 prompt、context、tool、gate、trace。

### 2. 把 `orchestrator` 拆成 Workflow Engine

把 mode 分支拆成声明式 workflow。

### 3. 引入 `ContextManager`

解决长任务、多页面、多 observation 的上下文膨胀问题。

### 4. 引入 `MemoryStore`

把用户偏好、网站经验、任务经验沉淀下来。

### 5. 把 Alibaba 逻辑 Skill 化

从硬编码站点逻辑升级为 WebSkill 插件生态。

### 6. 把 `ToolRegistry` 升级为 Tool Platform

补充 tool router、execution service、validator、hook chain、result normalizer。

### 7. 把 risk/gate 升级为 Policy Engine

保留 L0-L4，但加入 policy store、audit、domain policy、user policy。

### 8. 引入 Task State 和 Checkpoint

支持 pause / resume / retry / cancel，避免任务中断后无法恢复。

### 9. 建立 Trace Replay 和 EvalOps

把 trace 从日志升级为调试、评估、回归测试基础设施。

### 10. 发展多 Agent 协作

复杂任务拆给 Search / Match / Browser / Review / Human 等子 Agent，而不是一个 Agent 全做。

---

## 24.5 为什么这些优化能提高 Agent 效果

前面的章节主要讲了 `multi-functional-agent` 应该补哪些架构模块，例如 `AgentRuntime`、`ContextManager`、`MemoryStore`、`Skill System`、`Policy Engine`、`Workflow Engine`、`EvalOps` 等。

但这些模块不是为了“架构好看”而加的。它们真正的价值在于：

```text
把 Agent 从“靠大模型临场发挥”
变成“模型推理 + 系统状态 + 工具治理 + 经验沉淀 + 风险控制”的稳定执行系统。
```

一个 Agent 最终效果好不好，通常体现在以下几个指标：

- **任务成功率是否更高**
- **长任务是否更稳定**
- **失败后是否能恢复**
- **是否能跨网站、跨任务泛化**
- **是否能记住用户偏好和历史经验**
- **是否能减少无效工具调用和重复尝试**
- **是否能降低高风险误操作**
- **是否能被观测、评估和持续优化**

下面逐项解释这些架构优化为什么能提升 Agent 效果。

---

### 24.5.1 从单体 `runAgentLoop` 升级到 `AgentRuntime`，能提升稳定性和可控性

当前 `multi-functional-agent` 的核心执行逻辑比较集中，`runAgentLoop` 同时承担很多职责：

- 构造 prompt
- 管理 messages
- 调用 LLM
- 解析 tool call
- 执行浏览器工具
- 处理风险 gate
- 刷新页面 snapshot
- 写 trace
- 判断是否结束

这种方式在 demo 或短任务里没问题，但任务复杂后会出现一个问题：

> **Agent Loop 越复杂，越难判断一次失败到底是模型问题、上下文问题、工具问题、页面状态问题，还是安全策略问题。**

把它拆成 `AgentRuntime` 后，每个模块负责一类明确职责：

```text
AgentRuntime
├── PromptAssembler：负责 prompt 组装
├── ContextManager：负责上下文管理
├── ToolRouter：负责工具选择与暴露
├── ToolExecutionService：负责工具执行
├── PolicyEngine：负责风险判断
├── ObservationManager：负责页面状态
├── TraceManager：负责记录与复盘
└── StopConditionManager：负责停止条件
```

这样提升效果的原因是：

- **减少职责耦合**：某个环节失败时更容易定位和修复。
- **增强可测试性**：可以单独测试 prompt、工具执行、风险策略、上下文压缩，而不是只能端到端碰运气。
- **提升可替换性**：未来可以替换模型、替换工具、替换策略，而不影响整个 loop。
- **降低行为不确定性**：系统状态由 runtime 显式管理，而不是全部塞给 LLM 自己记。

本质上，这是把 Agent 从：

```text
LLM 自己一边观察、一边记忆、一边行动、一边判断风险
```

升级为：

```text
系统负责可靠状态与约束，LLM 负责高层判断和局部推理
```

这会明显提升复杂任务中的稳定性。

---

### 24.5.2 引入 `ContextManager`，能减少遗忘、幻觉和重复动作

Web Agent 的任务经常不是一步完成的。

比如自动投递任务可能包含：

```text
打开岗位列表
  ↓
筛选岗位
  ↓
打开岗位详情
  ↓
判断匹配度
  ↓
进入申请页面
  ↓
识别表单字段
  ↓
填写多页表单
  ↓
上传附件
  ↓
检查结果
  ↓
停在提交前
```

如果只靠 messages 数组不断追加，随着步骤变多，会出现几个典型问题：

- **早期目标被上下文冲掉**：模型忘记用户最初要求，例如“不要最终提交”。
- **页面 snapshot 太长**：无关 DOM 挤占 token，关键任务状态反而丢失。
- **工具 observation 重复堆积**：模型看到大量低价值日志，判断质量下降。
- **模型重复操作**：忘记自己刚才已经填过某个字段或点击过某个按钮。
- **长任务中后段性能下降**：上下文越乱，模型越容易随机选择动作。

`ContextManager` 的作用不是简单“压缩文本”，而是把上下文分层管理：

```text
必须长期保留：用户目标、安全约束、任务阶段
必须短期保留：当前页面、最近动作、当前表单状态
可以压缩保留：旧页面、旧工具结果、历史尝试
可以归档引用：截图、完整 trace、大型 snapshot
```

这能提升效果的原因是：

- **让模型始终看到最重要的信息**，避免 token 被噪音占满。
- **显式保留任务目标和安全约束**，减少越界行为。
- **压缩历史但保留结论**，让模型知道“之前发生了什么”，而不必阅读全部日志。
- **降低重复动作概率**，因为已完成事项被结构化记录。
- **提升长任务一致性**，因为状态不是靠模型临时记忆，而是由系统维护。

尤其对浏览器 Agent 来说，`ContextManager` 可以把复杂页面变成更适合模型判断的摘要：

```text
当前阶段：fill_form
已填字段：姓名、邮箱、电话、教育经历
未填必填字段：期望职位、工作城市
风险提示：页面存在“提交申请”按钮，属于 L3，需要人工确认
下一步建议：填写期望职位和工作城市，不要点击提交按钮
```

这种上下文比直接塞完整 DOM 更能提高决策质量。

---

### 24.5.3 引入 `TaskState` / `PageState` / `FormState`，能让 Agent 从“看见页面”升级为“理解进度”

当前 Web Agent 通常依赖页面 snapshot：

```text
[e1] input "姓名"
[e2] input "邮箱"
[e3] button "提交申请"
```

这让模型能“看见页面上有什么”，但还不一定知道：

- 哪些字段已经填了？
- 哪些字段是必填？
- 哪些字段填得不确定？
- 当前是否进入了最终提交阶段？
- 任务还差哪几步？
- 上一步失败的原因是什么？

这就是为什么需要 `TaskState`、`PageState`、`FormState`。

它们把网页操作从“原始观察”升级为“状态理解”：

```text
PageState：当前是什么页面
FormState：当前表单完成度如何
TaskState：当前任务进展到哪一步
```

这能提高效果的原因是：

- **模型不再需要从零推断页面阶段**，系统直接告诉它当前处于 `login`、`job_detail`、`application_form` 还是 `confirmation`。
- **模型不再需要记忆表单完成情况**，系统提供已填、未填、必填、不确定字段。
- **模型能做更好的下一步决策**，例如优先填缺失必填字段，而不是反复点击按钮。
- **可以在 step budget 用尽时恢复任务**，因为状态已经结构化保存。
- **可以更容易做人机协作**，用户接手时能看到明确进度。

没有状态模型时，Agent 像是在每一步重新观察世界；有状态模型后，Agent 才像是在持续推进一个任务。

这会直接提升：

- 表单完成率
- 长流程成功率
- 中断恢复能力
- 人工接管体验

---

### 24.5.4 引入 `MemoryStore`，能让 Agent 从“每次从零开始”变成“越用越好”

没有长期记忆的 Agent，每次任务都像第一次使用。

例如用户已经多次表达过：

```text
只看杭州和上海的岗位
不考虑外包公司
优先投递 AI Infra / Agent 平台方向
所有最终提交前必须让我确认
```

如果没有 `MemoryStore`，下一次任务模型仍然需要用户重复说明这些偏好。更糟糕的是，如果用户忘了说，Agent 就可能做出不符合用户预期的选择。

引入长期记忆后，可以沉淀四类信息：

```text
UserMemory：用户长期偏好
SiteMemory：网站操作经验
TaskMemory：历史任务结果
ExperienceMemory：可复用失败教训和成功策略
```

这能提高效果的原因是：

- **个性化更强**：岗位匹配、表单填写、风险策略都能符合用户长期偏好。
- **重复任务效率更高**：同一个网站的登录方式、字段映射、流程坑点可以复用。
- **失败经验可复用**：例如某网站点击某按钮会跳登录，下一次可以提前规避。
- **减少用户反复输入**：用户不需要每次都重新说明背景和偏好。
- **提升匹配质量**：岗位推荐不只看简历，还看历史偏好和历史反馈。

对 `multi-functional-agent` 这种求职 Agent 来说，长期记忆尤其重要。因为“好不好”不只是能否填表，还包括：

- 投的岗位是不是用户真的想要的？
- 有没有避开用户不喜欢的公司类型？
- 有没有记住用户对城市、行业、薪资、远程办公的偏好？
- 有没有根据历史投递结果调整策略？

这些都不是单次页面 snapshot 能解决的，必须靠记忆系统。

---

### 24.5.5 引入 `Skill System`，能提高跨网站泛化能力和专业任务成功率

当前如果把 Alibaba 招聘逻辑写死在代码里，那么支持一个新网站就要继续加分支。

长期会变成：

```text
if alibaba...
if linkedin...
if boss...
if greenhouse...
if lever...
```

这种方式的问题是：

- 不同网站逻辑混在一起
- orchestrator 越来越难维护
- prompt 越来越长
- 工具和策略无法按站点隔离
- 新网站上线容易影响旧网站
- 很难单独测试某个网站能力

`Skill System` 的本质是把“领域知识”和“通用 runtime”分开。

例如：

```text
AgentRuntime：负责通用执行循环
BrowserTools：负责通用浏览器操作
AlibabaSkill：负责 Alibaba 网站结构、字段策略、流程规则
LinkedInSkill：负责 LinkedIn 网站结构、字段策略、流程规则
GenericJobBoardSkill：负责通用招聘网站策略
```

这能提高效果的原因是：

- **减少模型盲猜**：特定网站的流程和字段映射可以由 skill 提供，模型不用每次从页面中猜。
- **提升站点适配能力**：不同网站可以加载不同 prompt、工具、workflow、policy。
- **降低上下文噪音**：只给模型当前网站相关的 skill，不暴露无关规则。
- **提高维护效率**：某网站页面变化时，只修对应 skill，不影响核心 runtime。
- **支持专家经验沉淀**：人工总结的网站经验可以变成 skill，而不是散落在 prompt 里。

对 Web Agent 来说，Skill 的价值类似人类的“网站使用经验”。

没有 Skill 时，Agent 每次像第一次访问这个网站；有 Skill 后，Agent 知道：

```text
这个网站岗位列表在哪里
申请入口通常叫什么
哪些按钮是保存草稿
哪些按钮是最终提交
登录页如何识别
哪些字段可以从简历自动填
哪些字段必须问用户
```

这会明显提升跨网站任务成功率。

---

### 24.5.6 把 `ToolRegistry` 升级为 `Tool Platform`，能减少错误调用并提高动作质量

工具调用是 Agent 从“会说”变成“会做”的关键。

但工具越多，风险也越大：

- 模型可能选择错误工具
- 参数可能不合法
- 页面元素 ref 可能过期
- 工具结果可能太长
- 高风险工具可能被误用
- 同一个任务阶段不应该暴露全部工具

当前简单的 `ToolRegistry` 可以解决“有哪些工具”和“如何执行”，但平台化后还需要解决：

```text
什么时候可以用这个工具？
这个工具参数是否合法？
这个工具结果怎么压缩？
这个工具失败后是否重试？
这个工具是否需要人工确认？
这个工具调用是否应该写审计？
```

`Tool Platform` 提升效果的原因是：

- **工具选择更准确**：通过 `ToolRouter` 按任务阶段暴露工具，减少模型误选。
- **参数错误更少**：通过 `ToolValidator` 在执行前拦截非法参数。
- **风险控制更强**：通过 `ToolPermissionResolver` 判断是否需要 gate。
- **结果更易消费**：通过 `ToolResultNormalizer` 把工具输出变成模型更容易理解的 observation。
- **失败恢复更可靠**：通过 retry / fallback / stale ref handling 提高执行成功率。
- **审计更完整**：每次工具调用都有 metadata、risk、reason、result。

例如在 `fill_form` 阶段，只暴露：

```text
browser_snapshot
browser_type
browser_select
browser_click_non_submit
browser_screenshot
agent_done
```

暂时不暴露或限制：

```text
browser_click_submit
browser_upload_sensitive_file
browser_external_navigation
```

这样模型就不容易提前点击最终提交按钮。

这不是削弱模型能力，而是让模型在更合理的动作空间里决策，从而提高成功率和安全性。

---

### 24.5.7 引入 `Workflow Engine`，能让复杂任务从“临场规划”变成“可控流程”

如果所有任务都交给 LLM 临场规划，会出现几个问题：

- LLM 可能跳步骤
- LLM 可能忘记必须先登录
- LLM 可能没完成匹配就开始投递
- LLM 可能没检查表单就进入提交阶段
- 长任务中间失败后不知道从哪里恢复

`Workflow Engine` 的价值是把稳定的流程显式化。

例如求职投递不是完全开放任务，它天然有阶段：

```text
解析简历
  ↓
搜索岗位
  ↓
匹配岗位
  ↓
打开详情
  ↓
进入申请流程
  ↓
填写表单
  ↓
检查结果
  ↓
提交前确认
```

这些固定结构应该由 workflow 管理，而不是每一步都让模型重新规划。

这能提高效果的原因是：

- **减少 LLM 规划负担**：模型专注每个阶段的局部判断。
- **避免跳过关键步骤**：workflow 强制执行必要阶段。
- **支持失败重试**：某一步失败可以只重试该 step，而不是重跑整个任务。
- **支持暂停恢复**：任务状态可以保存到具体 step。
- **支持评估优化**：可以统计每个 step 的失败率。
- **方便人工介入**：在关键 step 插入 human gate。

好的 Agent 架构不是让 LLM 负责全部流程，而是让：

```text
Workflow 负责确定性流程
LLM 负责不确定判断
Tools 负责真实执行
Policy 负责风险边界
```

这种分工会让任务更稳定。

---

### 24.5.8 引入 `Policy Engine`，能降低高风险误操作并增强用户信任

Web Agent 和代码 Agent 不同，它经常操作真实外部系统。

一次错误点击可能导致：

- 投递了错误岗位
- 上传了错误简历
- 提交了隐私信息
- 发送了消息
- 修改了线上系统配置
- 发起了支付或订单

所以安全不应该只靠 prompt 里写一句“不要点击提交”。

因为 prompt 约束有几个问题：

- 模型可能忘记
- 模型可能误判按钮含义
- 页面文案可能诱导模型
- 多轮之后安全指令被上下文稀释
- 工具层如果不拦截，模型一旦调用就已经执行

`Policy Engine` 的价值是把安全从“模型自觉”变成“系统强制”。

它能提升效果的原因是：

- **高风险动作执行前被系统拦截**，而不是依赖模型自律。
- **风险原因可解释**，用户知道为什么需要确认。
- **策略可配置**，不同用户、不同网站、不同任务可以有不同规则。
- **审计可追踪**，每次 gate 决策都有记录。
- **信任感增强**，用户敢让 Agent 执行更长、更复杂的任务。

这点非常关键：

> **Agent 能力越强，越需要安全边界；安全边界越可靠，用户越愿意授权 Agent 做更多事。**

因此，`Policy Engine` 不只是防事故，它还间接提高 Agent 可用范围。

---

### 24.5.9 引入 `Trace Replay` 和 `EvalOps`，能让 Agent 从“主观感觉变好”变成“可度量地变好”

很多 Agent 项目最大的问题不是“不知道怎么改”，而是：

```text
改了之后到底有没有变好？
成功率提高了吗？
失败原因减少了吗？
成本增加了吗？
安全 gate 是否更合理？
某个网站是不是退化了？
```

如果没有评估体系，只能靠人工观察几次 demo。这会导致：

- prompt 改动不可控
- 工具改动容易引入回归
- 模型切换无法比较
- 网站适配效果无法量化
- 安全策略过严或过松都不易发现

`Trace Replay` 和 `EvalOps` 的作用是把 Agent 行为变成可复盘、可统计、可回归测试的数据。

它们提升效果的原因是：

- **可以定位失败步骤**：知道失败发生在搜索、匹配、填表、上传还是 gate。
- **可以比较不同模型**：同一批任务下比较成功率、成本、步数。
- **可以发现工具短板**：例如 stale ref 频繁出现，就说明 snapshot/ref 机制要优化。
- **可以做回归测试**：改动后跑 benchmark，避免旧场景变差。
- **可以沉淀数据闭环**：失败 trace 进入经验总结，再进入 memory 或 skill。

最终形成闭环：

```text
执行任务
  ↓
记录 trace
  ↓
评估成功/失败/风险/成本
  ↓
定位瓶颈
  ↓
优化 prompt / tool / workflow / policy / skill
  ↓
重新跑 benchmark
  ↓
确认效果提升
```

这就是 Agent 从“工程原型”走向“可持续优化产品”的关键。

---

### 24.5.10 引入多 Agent 协作，能提升复杂任务的专业性和可靠性

单 Agent 最大的问题是：

> **所有能力都由一个模型实例同时承担。**

在求职场景里，一个 Agent 要同时做：

- 搜索岗位
- 理解岗位 JD
- 匹配简历
- 研究公司
- 填写网页表单
- 判断风险按钮
- 生成总结
- 和用户沟通

这会造成注意力分散，尤其在长任务里，模型容易在不同角色之间摇摆。

多 Agent 协作的价值是专业分工：

```text
Search Agent：找岗位
Match Agent：判断匹配度
Research Agent：调研公司
Browser Agent：操作网页
Form Agent：理解表单字段
Review Agent：检查风险和完整性
Human Agent：和用户交互确认
```

这能提高效果的原因是：

- **每个 Agent prompt 更聚焦**，输出质量更稳定。
- **复杂任务可以分治**，降低单次上下文压力。
- **关键节点可以互相校验**，例如 Reviewer Agent 检查 Browser Agent 的结果。
- **可以并行处理子任务**，例如同时调研多个岗位。
- **失败影响范围更小**，某个子任务失败不一定导致全局失败。

不过，多 Agent 不是越多越好。它适合在任务复杂度足够高时引入。

建议演进路径是：

```text
第一阶段：单 Agent + Workflow
第二阶段：Planner / Executor 分离
第三阶段：增加 Reviewer Agent
第四阶段：引入 Search / Match / Research 等专业 Agent
```

这样可以避免过早复杂化。

---

### 24.5.11 这些优化对核心指标的影响

可以把前述优化和 Agent 效果指标对应起来：

| 架构优化 | 直接提升的效果 |
|---|---|
| `AgentRuntime` | 稳定性、可控性、可测试性 |
| `ContextManager` | 长任务成功率、减少遗忘、减少重复动作 |
| `TaskState` / `PageState` / `FormState` | 任务进度理解、表单完成率、中断恢复能力 |
| `MemoryStore` | 个性化、复用历史经验、减少重复输入 |
| `Skill System` | 跨网站泛化、专业站点成功率、维护效率 |
| `Tool Platform` | 工具调用准确率、参数合法性、失败恢复能力 |
| `Workflow Engine` | 流程稳定性、可恢复性、可评估性 |
| `Policy Engine` | 安全性、用户信任、高风险任务可用性 |
| `Trace Replay` / `EvalOps` | 可观测性、可度量优化、回归防护 |
| 多 Agent 协作 | 复杂任务专业性、局部校验、上下文压力降低 |

换句话说，这些优化分别解决了 Agent 效果差的不同根因：

```text
效果不稳定 → AgentRuntime / Workflow Engine
容易忘记 → ContextManager / TaskState
不会积累经验 → MemoryStore
跨网站能力弱 → Skill System
工具误用 → Tool Platform
风险不可控 → Policy Engine
不好调优 → Trace Replay / EvalOps
复杂任务能力不足 → 多 Agent 协作
```

---

### 24.5.12 最核心的提升逻辑：把不确定性交给模型，把确定性交给系统

Agent 系统里最重要的设计原则之一是：

> **不要让 LLM 负责所有事情。**

LLM 擅长：

- 理解自然语言
- 解释页面含义
- 推断用户意图
- 在不确定信息中做判断
- 生成计划和文本
- 根据上下文选择下一步

但 LLM 不擅长：

- 长期可靠记忆
- 精确状态维护
- 权限边界执行
- 重复流程控制
- 大量日志筛选
- 审计追踪
- 稳定重试
- 成本统计

所以提升 Agent 效果的核心，不是简单换更强模型，而是重新分配职责：

```text
确定性部分交给系统：
- 状态管理
- 工具执行
- 风险拦截
- 工作流推进
- 记忆检索
- trace 记录
- 评估指标

不确定性部分交给模型：
- 页面理解
- 字段语义判断
- 用户意图推理
- 岗位匹配解释
- 下一步动作选择
- 异常场景判断
```

当系统承担更多确定性职责时，模型的上下文更干净、动作空间更合理、风险边界更清楚，最终就会表现得更稳定、更可靠。

这也是为什么 `box-allinone` 看起来“架构更重”，但效果上更容易成为平台级 Agent：

```text
不是因为模块多，所以效果好；
而是因为模块把 LLM 不擅长的可靠性工作接管了，所以模型能把能力用在真正需要推理的地方。
```

---

### 24.5.13 对 `multi-functional-agent` 的具体收益总结

如果按本文建议演进，`multi-functional-agent` 的效果提升可以概括为：

- **任务成功率提升**
  - workflow 保证关键步骤不遗漏
  - skill 提供站点经验
  - tool platform 减少错误调用
  - state model 让 Agent 知道当前进度

- **长任务稳定性提升**
  - context manager 控制上下文质量
  - task state 支持阶段推进
  - checkpoint 支持中断恢复

- **跨网站泛化能力提升**
  - skill system 把不同网站经验插件化
  - generic workflow 支持同类任务复用
  - site memory 沉淀站点策略

- **个性化效果提升**
  - user memory 记录偏好
  - job matching 参考历史反馈
  - policy 适配用户风险偏好

- **安全性提升**
  - policy engine 强制拦截高风险操作
  - human gate 变成可配置、可审计机制
  - trace replay 支持事后追责和复盘

- **持续优化能力提升**
  - evalops 量化成功率、失败率、成本、风险
  - trace replay 定位失败原因
  - benchmark 防止优化一个场景却破坏另一个场景

最终，`multi-functional-agent` 会从：

```text
一个能操作浏览器的 Agent demo
```

演进为：

```text
一个具备稳定执行、长期记忆、技能扩展、安全治理和评估闭环的 Web Agent 平台
```

这才是架构优化真正能提升 Agent 效果的原因。

---

## 25. 最终总结

### 25.1 `box-allinone` 是什么？

`box-allinone` 是一个平台型 Agent 系统。它的核心价值是：

- 多模型
- 多 Agent
- 多工具
- 多入口
- 上下文管理
- 技能生态
- 长期记忆
- 工程化运行
- 安全治理
- 产品化部署

它更像：

```text
Agent OS for software engineering and productivity
```

### 25.2 `multi-functional-agent` 是什么？

`multi-functional-agent` 是一个以浏览器为核心的 Web Agent runtime。它的核心价值是：

- Playwright 浏览器执行
- 页面 snapshot
- DOM ref 操作
- 网页研究、比较与决策支持
- 通用表单与多步骤流程
- Task Graph、上下文管理与中断恢复
- Skill / Workflow 场景扩展
- 风险等级、Permission 与 Human Gate
- trace / metrics / screenshot / safety report 复盘

它更像：

```text
Browser embodiment runtime for web automation agents
```

### 25.3 `multi-functional-agent` 应该往哪里走？

它不应该简单复制 `box-allinone`，而应该吸收 `box-allinone` 的平台能力，同时保留自己的浏览器优势。

目标形态应该是：

```text
Web Agent Platform
= box-allinone 式平台底座
+ multi-functional-agent 式浏览器具身执行
```

也就是：

```text
通用 Agent Runtime
+ Web Skill System
+ Browser Tool Platform
+ Context / Memory / Policy / Trace
+ Workflow Engine
+ Human Gate
+ Multi-Agent
+ Server / Worker / EvalOps
```

沿着这一方向演进，Web Buddy 可以在不绑定单一业务的前提下，成为真正可扩展、
可治理、可复盘、可产品化的 **多场景浏览器 Agent 平台**。
