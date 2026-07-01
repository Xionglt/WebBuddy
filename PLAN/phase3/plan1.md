# Phase 3 Plan 1: SkillSystem v1

> 目标：把任务经验从代码、orchestrator 和通用 prompt 中抽离出来，形成可发现、可读取、可推荐、可按需注入、可审计的 SkillSystem v1。
>
> 本阶段不做远程技能市场，不做插件安装，不做 Memory，不做技能自动改写，不让 Skill 绕过 Permission / Workflow / CompletionGate。

## 1. 为什么 Phase 3 第一件事做 SkillSystem

Phase 2 到 Plan 8 后，底层 Agent Kernel 已经具备关键闭环：

```text
run/session persistence
tool execution lifecycle
permission / approval
context compaction
workflow evidence
completion gate
resume completion
```

这意味着底层 Agent 已经基本能回答：

```text
怎么运行？
怎么审计？
怎么确认高风险动作？
怎么判断完成？
怎么从 blocked 恢复？
```

下一步要回答的是：

```text
做同类任务时，Agent 如何复用经验？
```

第一性原理：

```text
Tool 是动作。
Workflow 是状态和完成标准。
Skill 是经验。
```

例如招聘投递任务里：

- Tool 负责点击、输入、截图、上传。
- Workflow 负责判断 observing / filling / reviewing / done。
- Skill 负责告诉 Agent：招聘表单通常如何识别字段、哪些动作要谨慎、哪些站点有特殊流程、失败时如何恢复。

## 2. 当前代码关键上下文

当前项目已经有：

- `PromptAssembler` / `prompt-sections`。
- `extraContext` 注入通道。
- session transcript/events。
- trace 里已有 `skill_call` span 类型和 metrics 字段。
- README 里已有 SkillSystem 目标结构。

但还没有：

- `packages/web-buddy/src/skills/*`。
- `packages/web-buddy/skills/*/SKILL.md`。
- skill registry / loader / recommender。
- skill list/view。
- skill context injection。
- skill recommendation audit。

## 3. 本阶段目标

完成后应具备：

1. 新增 Skill 数据模型。
2. 新增本地 bundled skill loader。
3. 新增 skill registry。
4. 新增 deterministic skill recommender。
5. 新增 skill context renderer。
6. `PromptAssembler` 能按需注入相关 skill 摘要。
7. session / trace 能记录 skill recommended / loaded / injected。
8. 新增内置 skills：
   - `job-application`
   - `alibaba-careers`
   - `web-research`
9. 新增 list/view 测试入口。
10. 不改变 tool schema / AgentRuntimeResult schema。

## 4. 非目标

本阶段明确不做：

- 不做远程 skill 安装。
- 不做技能市场。
- 不做插件生命周期。
- 不做 Memory。
- 不做多 Agent 委派。
- 不让 LLM 自动改写 skill 文件。
- 不把全部 skill 塞进 system prompt。
- 不让 Skill 执行工具。
- 不让 Skill 绕过 PermissionEngine。
- 不让 Skill 绕过 WorkflowEngine。
- 不让 Skill 绕过 CompletionGate。
- 不读取 trace artifacts 来决定 runtime state。

## 5. 职责边界

## 5.1 SkillDefinition

Skill 定义负责描述：

- id。
- title。
- description。
- version。
- domains。
- goal keywords。
- workflow phases。
- safety notes。
- prompt snippets。
- source file。

Skill 不负责：

- 不执行工具。
- 不调用 LLM。
- 不修改 session。
- 不改变 permission / workflow / completion 结果。

## 5.2 SkillLoader

SkillLoader 负责：

- 从 `packages/web-buddy/skills/*/SKILL.md` 读取技能。
- 解析 frontmatter 或 metadata block。
- 返回结构化 `SkillDefinition`。

SkillLoader 不负责：

- 不做推荐。
- 不做 prompt 注入。
- 不做远程下载。

## 5.3 SkillRegistry

SkillRegistry 负责：

- 注册 bundled skills。
- list skills。
- view skill。
- 根据 id 获取 skill。

SkillRegistry 不负责：

- 不决定某次任务使用哪个 skill。
- 不写 session。

## 5.4 SkillRecommender

SkillRecommender 负责：

- 基于 goal / url / domain / page type / workflow phase 推荐 skill。
- 给出 deterministic reason。
- 返回有序 recommendations。

v1 不调用 LLM。

## 5.5 SkillContext

SkillContext 负责：

- 把被推荐或显式选择的 skill 渲染成 prompt section。
- 控制注入长度。
- 只注入相关摘要，不注入所有技能全文。

SkillContext 不负责：

- 不改变模型消息历史。
- 不执行工具。
- 不替代 ContextCompactor。

## 6. 数据模型草案

建议新增：

```text
packages/web-buddy/src/skills/skill-types.ts
packages/web-buddy/src/skills/skill-loader.ts
packages/web-buddy/src/skills/skill-registry.ts
packages/web-buddy/src/skills/skill-recommender.ts
packages/web-buddy/src/skills/skill-context.ts
packages/web-buddy/src/skills/index.ts
```

建议类型：

```ts
export interface SkillDefinition {
  schemaVersion: 'skill-definition/v1'
  id: string
  title: string
  version: string
  description: string
  domains: string[]
  goalKeywords: string[]
  workflowPhases: string[]
  safetyNotes: string[]
  promptSnippets: string[]
  sourcePath?: string
}

export interface SkillRecommendation {
  schemaVersion: 'skill-recommendation/v1'
  skillId: string
  score: number
  reason: string
  matchedSignals: string[]
}

export interface SkillContext {
  schemaVersion: 'skill-context/v1'
  recommendations: SkillRecommendation[]
  rendered: string
  injectedSkillIds: string[]
}
```

## 7. 内置技能建议

新增：

```text
packages/web-buddy/skills/job-application/SKILL.md
packages/web-buddy/skills/alibaba-careers/SKILL.md
packages/web-buddy/skills/web-research/SKILL.md
```

### 7.1 job-application

用于通用招聘投递：

- 表单字段识别策略。
- resume mapping 策略。
- upload resume 注意事项。
- final submit safety。
- blocked / user_confirm 语义。

### 7.2 alibaba-careers

用于阿里招聘站点：

- 站点域名和路径特征。
- 职位列表 / 职位详情 / 投递流程经验。
- 登录、验证码、最终投递 handoff。
- 站点特有恢复建议。

### 7.3 web-research

用于网页调研：

- 搜索、打开、比较、摘录。
- 多页面证据收集。
- 不修改页面状态的 read-only 策略。
- 结果总结结构。

## 8. run / prompt 接入点

最小接入点：

```text
AgentRuntime / QueryLoop / runAgentLoop input
  -> skill registry loads bundled skills
  -> recommender recommends relevant skills
  -> skill context renders compact prompt section
  -> PromptAssembler includes SKILL_CONTEXT section
  -> session/trace records recommendation and injection
```

推荐新增 prompt section：

```text
SKILL_CONTEXT
```

位置建议：

```text
TASK
TASK_STATE
WORKFLOW_STATE
SKILL_CONTEXT
RESUME_SUMMARY
```

原因：

```text
Skill 应该围绕当前任务和 workflow 阶段解释经验，
但不应该压过 resume / page / form 的事实状态。
```

## 9. Session / Events

建议新增 additive session events：

```text
skills_loaded
skills_recommended
skills_injected
```

建议新增 transcript entry：

```text
skill_context
```

记录：

- recommended skill ids。
- injected skill ids。
- recommendation reasons。
- rendered context size。
- source paths。

## 10. 验收标准

新增验证入口：

```bash
npm run test:skills
npm run test:skill-recommender
npm run test:skill-context
```

更新验证入口：

```bash
npm run test:prompt-sections
npm run test:agent-loop
npm run test:session
npm run test:mvp
```

关键验收：

- bundled skills 可 list / view。
- `job-application` 能被招聘投递 goal 推荐。
- `alibaba-careers` 能被阿里招聘域名推荐。
- `web-research` 能被 research goal 推荐。
- prompt 只注入推荐 skill，而不是全量 skill。
- skill context 有长度预算。
- session / trace 记录 skill recommendation / injection。
- Skill 不改变 Permission / Workflow / CompletionGate 裁决。
- runtime state 不依赖 trace artifacts。

## 11. 多 Agent 执行顺序

建议：

```text
串行 1：
  Agent A：Skill 数据模型 + Registry / Loader。

并行 2：
  Agent B：内置 bundled skills 内容。
  Agent C：SkillRecommender 规则。

串行 3：
  Agent D：SkillContext + PromptAssembler 接入。

串行 4：
  Agent E：session / trace 审计 + tests/package scripts。

串行 5：
  Agent F：最终安全审查和完成说明。
```

依赖关系：

```text
Agent A 先定义模型和加载边界。
Agent B 可在 A 后填充 skills 文件。
Agent C 可在 A 后实现 deterministic recommendation。
Agent D 必须等 A/B/C 后再接 prompt。
Agent E/F 最后补审计、回归和文档。
```
