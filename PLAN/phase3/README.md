# Phase 3 Skill / Experience Layer 总纲领

> Phase 3 从“底层 Agent Kernel”进入“经验层 / 可复用能力层”。
> Phase 2 已经把运行、权限、证据、完成裁决和 blocked session 恢复闭环基本搭好；Phase 3 的目标是让 Agent 不再每次从零做任务，而是能发现、加载、注入和审计可复用技能。

## 1. 阶段定位

Phase 2 解决的是底座：

```text
Agent 如何运行
工具如何执行
高风险动作如何确认
上下文如何压缩
workflow 如何用 evidence 解释
completion 如何被 gate 裁决
blocked session 如何被用户确认后恢复完成
```

Phase 3 解决的是经验：

```text
Agent 做同类任务时，如何复用已经沉淀的操作知识。
```

第一性原理：

```text
Tool 是动作能力。
Workflow 是任务状态和完成标准。
Skill 是可复用经验。
```

没有 SkillSystem，Agent 每次都会像第一次遇到任务一样，只能靠通用 prompt 和当前页面状态摸索。

## 2. Phase 3 当前计划

当前计划：

- `PLAN/phase3/plan1.md`
- `PLAN/phase3/plan2.md`
- `PLAN/phase3/plan2-multi-agent-prompts.md`

Plan 1 目标：

```text
SkillSystem v1：让技能可发现、可读取、可推荐、可按需注入 prompt，并进入 session/trace 审计。
```

Plan 2 目标：

```text
真实投递体验优化：简历大模型结构化、多页岗位快速粗排/精排、匹配阈值、权限模式、风险透明展示和 direct-submit flow。
```

Plan 2 multi-agent prompts 目标：

```text
把真实投递体验优化拆成可串行/并行协作的高质量 agent prompt，包括文件边界、验收标准、测试命令和交接格式。
```

## 3. Phase 3 边界

Phase 3 v1 不做：

- 不做远程技能市场。
- 不做插件安装系统。
- 不做技能自动改写。
- 不做 Memory。
- 不做多 Agent 委派。
- 不让 Skill 绕过 Permission / Workflow / CompletionGate。
- 不把所有 Skill 全量塞进 system prompt。

## 4. 成功标准

Phase 3 第一阶段完成后，应满足：

- 一个 task skill 可被发现、加载、推荐、注入、记录。
- `job-application` 能被招聘投递目标推荐。
- `alibaba-careers` 能被阿里招聘域名推荐。
- `web-research` 能被调研目标推荐。
- prompt 只注入相关 skill 摘要，而不是全量 skill。
- session / trace 能解释本次用了哪些 skill、为什么推荐、注入了什么上下文。

Phase 3 真实投递体验优化完成后，应满足：

- 简历解析有大模型结构化、schema 校验、confidence 和 evidence。
- 岗位匹配先多页快速粗排，再对 Top N 详情精排。
- 低匹配岗位不会默认进入投递流程。
- 权限模式可配置，减少演示和可信环境下的重复确认。
- 风险等级始终可展示、可审计，即使动作被自动允许。
- 阿里等站点的 direct-submit flow 能被识别，并停在最终提交边界。
