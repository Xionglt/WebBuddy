# Web Agent Runtime v1.0.2 初步优化方案

日期：2026-06-22

当前分支：`cl/personal/kai/web-buddy/v-1.0.2`

## 背景

项目在 v1.0.0 已经跑通“恢复版 Claude Code runtime + Playwright MCP + 阿里巴巴招聘网站初步投递”的第一版闭环；v1.0.1 进一步补充了 Web 控制台、stream-json trace、人工交接继续执行和运行过程可视化。

接下来不再优先扩展更多网站或更多功能，而是沉下心做深度优化：让网页操作 agent 在速度、token 成本、上下文管理、错误恢复和可观测性上更有竞争力。

## 核心目标

- 同样任务下，减少 LLM 调用次数和总 token。
- 降低页面快照、表单信息、简历上下文带来的上下文膨胀。
- 提升网页操作成功率，减少 ref 失效、重复点击、重复 snapshot 和原地打转。
- 让每次运行都可度量、可复盘、可对比。
- 将 runtime 从“会调用工具的模型循环”升级为“模型的结构化外脑”。

## 当前问题概览

### 1. 缺少稳定的指标基线

当前已经有 trace 和 Web 控制台，但还没有自动生成统一的指标汇总。现在很难回答：

- 一次任务到底用了多少轮 LLM？
- 哪些工具调用最频繁？
- token 主要消耗在简历、页面快照、历史上下文，还是工具结果？
- 每次失败主要是登录、表单、ref 失效，还是模型决策偏移？
- 优化之后是否真的变快、变省、变稳？

没有指标基线，优化容易变成凭感觉。

### 2. 简历上下文过重

当前 Claude runtime prompt 会包含结构化简历摘要和最多约 14k 字符的简历原文。续跑时还可能再次带上完整原始任务上下文。

这会带来几个问题：

- 首轮 prompt token 偏大。
- 续跑成本被重复放大。
- 简历内容占据上下文窗口，压缩了网页状态和任务历史空间。
- 模型在“岗位筛选”和“表单填写”两个阶段其实不需要同样粒度的简历信息。

### 3. 页面表示还比较粗

当前 `browser_snapshot` 会返回通用交互元素列表，`pageView` 只做基础压缩。这个方案通用，但不够聪明：

- 可能返回很多无关导航、收藏、筛选、分页按钮。
- 真正有价值的岗位卡片、表单字段、错误提示可能不够突出。
- 页面变化后通常要重新给模型一大段 snapshot。
- 对“我现在应该点哪个岗位 / 哪个字段没填 / 上传是否成功”这类决策，信息结构不够直接。

### 4. LLM 轮次偏多

当前大体是 ReAct 风格：模型思考一步，调用一个工具，再看观察结果，再继续。这个方式稳，但速度和 token 成本都不理想。

高频机械动作，例如连续填写多个表单字段、上传后等待解析、点击后等待跳转再 snapshot，本可以由 runtime 组合完成，不需要每一步都回到模型。

### 5. 续跑状态不够结构化

当前自动续跑主要依赖上一轮 stdout 摘要和原始 prompt。它可以工作，但不是最优：

- stdout 摘要是自然语言，不适合精确恢复。
- 原始 prompt 重复注入，token 成本高。
- “当前在哪个阶段、选了哪个岗位、填了哪些字段、缺什么字段、上次失败原因”没有统一状态模型。

### 6. Debug 模式和性能模式没有分层

当前为了观察 agent 行为，默认 headful、slowMo、type delay、保留浏览器。这对调试友好，但不适合性能评测。

应该明确区分：

- `debug`：可见浏览器、慢速动作、完整 trace、更多截图。
- `fast`：headless 或低延迟、精简 trace、最少截图、低等待时间。
- `benchmark`：固定任务集、固定模型参数、输出 metrics。

## 优化方向

### 方向一：运行指标体系

新增每次 run 自动生成的 `metrics.json`，并在 Web 控制台展示核心指标。

建议字段：

```json
{
  "runId": "string",
  "scenario": "alibaba-apply",
  "status": "completed|blocked|incomplete|failed",
  "durationMs": 0,
  "llmCalls": 0,
  "mcpToolCalls": 0,
  "browserSnapshots": 0,
  "browserClicks": 0,
  "browserTypes": 0,
  "browserWaits": 0,
  "inputTokens": 0,
  "outputTokens": 0,
  "estimatedCost": 0,
  "snapshotBytes": 0,
  "toolResultBytes": 0,
  "resumeContextBytes": 0,
  "staleRefFailures": 0,
  "repeatedActions": 0,
  "manualHandoffs": 0,
  "finalStage": "search|detail|login|form|submitted|blocked",
  "failureCategory": "login|captcha|form|navigation|model|tool|unknown"
}
```

第一阶段可以先统计 span 数、耗时、stdout 字节数、工具调用次数，不必一开始就做到精确 token 计费。后续再接入模型返回的 usage。

### 方向二：上下文预算管理

新增 `ContextBudgetManager`，所有进入模型的内容都经过预算控制。

建议预算分区：

- 系统指令：固定上限。
- 用户目标：固定保留。
- 简历摘要：默认短摘要。
- 页面状态：动态预算，优先当前决策相关区域。
- 历史事件：只保留最近关键事件和结构化状态。
- 工具结果：大结果只存 trace，模型只看摘要。

核心原则：

- 不把完整简历原文默认塞进 prompt。
- 不把完整上一轮 stdout 默认塞进续跑 prompt。
- 不把完整页面所有元素默认塞给模型。
- 大内容落盘到 trace，模型按需读取摘要或片段。

### 方向三：简历作为可查询资源

把简历从“大段 prompt 文本”改造成结构化资源。

建议拆成：

- `resume_profile`：姓名、联系方式是否存在、学历、工作年限、技能概览。
- `resume_capability_summary`：岗位匹配用的能力摘要。
- `resume_form_fields`：表单填写用的字段字典。
- `resume_relevant_snippets(query)`：按岗位描述或表单字段取相关简历片段。

默认 prompt 只放 `resume_profile` 和 `resume_capability_summary`。只有当 agent 进入表单或需要证据时，再给更细字段或片段。

预期收益：

- 首轮 token 明显下降。
- 续跑 token 下降。
- 表单填写更稳定，因为字段来自结构化数据而不是模型临时从原文里找。

### 方向四：语义化页面工具

在通用 snapshot 之外，新增更高层的页面理解工具，让模型拿到“可决策对象”而不是原始元素列表。

候选工具：

- `browser_page_summary`
  - 返回页面类型、主区域、可见任务状态、关键按钮。

- `browser_find_text`
  - 输入关键词，返回匹配文本及附近上下文。

- `browser_list_job_candidates`
  - 返回职位卡片候选：标题、地点、部门、更新时间、可点击文本、匹配原因。

- `browser_form_candidates`
  - 返回当前表单字段、必填项、缺失项、错误提示、上传状态。

- `browser_snapshot_delta`
  - 返回上次 snapshot 以来新增、消失、变化的关键元素。

这样模型不需要每次从 60 个 refs 里自己读出页面结构，可以直接基于候选对象做决策。

### 方向五：减少工具往返

将高频机械操作封装为复合工具。

候选工具：

- `browser_click_and_wait`
  - 点击、等待页面稳定、返回新页面摘要。

- `browser_fill_form_batch`
  - 一次填写多个字段，返回成功、失败、缺失字段列表。

- `browser_upload_resume_and_parse`
  - 上传简历、等待解析、返回解析后表单差异。

- `browser_recover_from_failure`
  - 对 ref 失效、元素不可见、弹窗遮挡进行自动恢复尝试。

目标是减少“LLM 调用一次只做一个非常机械动作”的情况。

### 方向六：结构化 AgentState

新增一个可落盘、可续跑、可展示的 `AgentState`。

建议结构：

```json
{
  "goal": "string",
  "site": "string",
  "stage": "search|detail|login|form|review|submitted|blocked",
  "loginStatus": "unknown|logged_in|login_required|captcha_required",
  "selectedJobs": [],
  "currentJob": {
    "title": "string",
    "url": "string",
    "fitReason": "string",
    "risk": "low|medium|high"
  },
  "form": {
    "uploadStatus": "unknown|uploaded|parsed|failed",
    "filledFields": {},
    "missingFields": [],
    "errors": []
  },
  "lastAction": {},
  "lastFailure": {
    "category": "stale_ref|navigation|form|login|captcha|model|tool|unknown",
    "message": "string",
    "recoverable": true
  }
}
```

续跑时优先传 `AgentState`，而不是传完整历史 stdout。

### 方向七：速度模式和基准任务集

新增运行 profile：

- `--profile debug`
  - headful、slowMo、完整 trace、截图多。

- `--profile fast`
  - headless、低等待、精简 trace、减少截图。

- `--profile benchmark`
  - 固定配置、固定任务、输出 metrics，用于比较优化前后。

同时建立一组本地 benchmark 页面：

- 简单登录页。
- 职位列表页。
- 职位详情页。
- 简历上传表单。
- 复杂必填表单。
- 自定义下拉/城市选择。
- ref 失效/DOM 变化页面。

有了本地 benchmark，才能快速验证速度、token、成功率，而不用每次都跑真实招聘网站。

## 优先级建议

### P0：先做可度量

目标：每次运行自动输出 `metrics.json`。

原因：没有指标，后面所有优化都难以判断效果。

交付：

- 从 agent trace 聚合 metrics。
- Web 控制台展示核心指标。
- 文档记录每次版本的指标变化。

### P1：上下文预算和简历压缩

目标：降低首轮和续跑 prompt token。

交付：

- 默认 prompt 不再塞完整简历原文。
- 新增简历摘要和表单字段字典。
- 续跑 prompt 使用结构化状态和短摘要。

### P2：语义化页面工具

目标：减少 snapshot token，提升页面决策质量。

交付：

- `browser_page_summary`
- `browser_find_text`
- `browser_form_candidates`
- `browser_list_job_candidates`

### P3：复合工具和状态恢复

目标：减少 LLM 往返，提升速度。

交付：

- `browser_click_and_wait`
- `browser_fill_form_batch`
- `browser_upload_resume_and_parse`
- stale ref 自动恢复。

### P4：benchmark 套件

目标：让优化可回归、可比较。

交付：

- 本地模拟页面。
- benchmark runner。
- 指标报告对比。

## v1.0.2 建议交付范围

为了避免第二版过大，v1.0.2 建议只做“指标和上下文预算”的基础设施。

建议 v1.0.2 包含：

- `metrics.json` 自动生成。
- Web 控制台展示 LLM 调用、工具调用、耗时、状态。
- 简历上下文分层：默认短摘要，不默认注入完整原文。
- 续跑 prompt 改为短摘要 + 结构化状态草案。
- 增加 `--profile debug|fast|benchmark` 参数设计，先实现 debug/fast 的基础差异。

暂时不做：

- 多招聘网站扩展。
- 复杂岗位推荐算法。
- 大规模前端重构。
- 完整 benchmark 平台。

## 验收标准

初版验收可以先不追求绝对性能，只要求指标可见、行为不退化。

- 同一个阿里投递任务仍可运行。
- 每次运行生成 `metrics.json`。
- Web 控制台能看到核心指标。
- 默认 prompt 不再包含完整简历原文。
- 续跑时不重复注入完整原始 prompt。
- `npm run build` 通过。
- 至少一个本地 mock 页面 benchmark 能跑通。

## 后续评价指标

长期可以用以下指标判断 agent 是否真的变强：

- 完成率：`COMPLETED / total runs`
- 人工阻塞率：`BLOCKED / total runs`
- 平均 LLM 调用次数
- 平均 MCP 工具调用次数
- 平均 snapshot 次数
- 平均输入 token
- 平均输出 token
- 平均任务耗时
- ref 失效恢复成功率
- 表单字段填写准确率
- 单次成功任务成本

## 设计原则

- 优先优化 runtime，而不是把业务流程写死。
- 优先结构化状态，而不是堆更长 prompt。
- 优先让模型看决策相关信息，而不是完整网页。
- 优先复合机械动作，而不是让模型一步步点。
- 优先真实指标回归，而不是凭感觉判断模型聪明程度。

## 当前结论

v1.0.2 的关键不是继续扩展功能，而是建立 agent 的性能工程底座：指标、预算、状态、压缩和 benchmark。

一旦这套底座稳定，后续再优化岗位匹配、表单填写、跨网站泛化时，就能清楚知道每次改动是否真的提升了速度、成本和成功率。
