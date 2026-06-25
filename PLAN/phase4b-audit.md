# Phase 4B Shared Audit

日期：2026-06-25

范围：Phase 4B: Context Selection Metrics / Freshness Metadata / Minimal TaskState

本文件是共享 handoff，供后续 Agent 派工 prompt 直接引用。本次审计只读代码，未修改 `packages/web-buddy` 或 `packages/claude-code`。

## 当前已实现能力清单

- `ContextManager` 已从 `ObservationProvider` 内存态读取 `PageState` / `FormState`，默认 provider 是 `observationManager`。
- `ContextManager` 当前不读取 trace artifacts。`context-manager-test.mjs` 已用 poisoned `page-state-latest.json` / `form-state-latest.json` 验证 artifact 不进入 snapshot。
- `ContextSnapshot` 当前字段包括 `page`、`form`、`resumeSummary`、`recentActions`、`safetyNotes`、`blockers`、`extraContext`、`updatedAt`。
- `ContextSnapshot` 还没有 freshness metadata。
- 当前没有 runtime working set 里的最小 `TaskState`。
- `Prompt Sections` 已有稳定 section 顺序：
  - `SYSTEM_ROLE`
  - `SAFETY_RULES`
  - `TASK`
  - `RESUME_SUMMARY`
  - `CURRENT_PAGE_STATE`
  - `CURRENT_FORM_STATE`
  - `RECENT_ACTIONS`
  - `NEXT_ACTION_RULES`
- `Prompt Sections` 已有 section 级预算和 total budget 截断。
- `CURRENT_PAGE_STATE` 已渲染 page schema/url/title/pageType/counts/textSummary/updatedAt。
- `CURRENT_FORM_STATE` 已渲染 fields 统计、filledFields、missingRequired、submitCandidates、uploadHints、visibleErrors、updatedAt。
- `RECENT_ACTIONS` 已保留 step/tool/args/status/risk/observation/at，但 tight budget 下还没有 blocked/error/high-risk 优先策略。
- `PromptAssembler` 已承接 agent-loop prompt helper，提供 `buildLoopContext`、`renderSystemContext`、`renderUserContext`、`renderInitialUserContext`。
- `PromptAssembler` 当前每次 `renderSystemContext` / `renderUserContext` 都会重新 `buildPromptSections()`。后续加 metrics 时要明确 `contextBuilds` 是按 snapshot build 计数，还是按 render 计数，避免重复计数。
- `RunMetrics` 当前覆盖 trace、LLM、tool、browser action、handoff、legacy steps、文件大小等指标。
- `RunMetrics` 还没有 context selection metrics：`contextBuilds`、`contextChars`、`contextTruncations`、`recentActionsIncluded`、`pageStateAgeMs`、`formStateAgeMs`、`promptSectionChars`。
- `aggregateMetrics()` 当前允许读取 trace/session/spans/events/legacy/files，这是 run 后旁路分析，符合边界。
- `runAgentLoop` 仍是 local runtime 实际执行入口。
- `AgentRuntime.run()` 是 facade，内部仍调用 `runAgentLoop`。
- `agent-state.json` 已是 trace 输出，但不是 runtime working set 的 TaskState。

## Phase 4B 最小文件改动清单

建议最小核心改动如下。

新增文件：

- `packages/web-buddy/src/context/metrics.ts`
  - 定义 context selection metrics helper。
  - 建议保留 `buildPromptSections()` 返回 `PromptSection[]`，另加 `measurePromptSections(sections)`。
- `packages/web-buddy/src/task/task-state.ts`
  - 定义 `TaskPhase = 'observing' | 'filling' | 'reviewing' | 'blocked' | 'done'`。
  - 定义 `TaskState`，schemaVersion 为 `task-state/v1`。

修改文件：

- `packages/web-buddy/src/context/types.ts`
  - 增加 `ContextFreshness`。
  - `ContextSnapshot` 增加 `freshness`。
  - `ContextSnapshotInput` / `ContextSnapshot` 增加可选 `taskState`。
  - `PromptSectionId` 增加 `TASK_STATE`。
- `packages/web-buddy/src/context/context-manager.ts`
  - 根据 `page.updatedAt` / `form.updatedAt` 和 snapshot `updatedAt` 计算 freshness。
  - 默认 stale 阈值建议 `30_000ms`，可通过 `ContextManagerOptions` 覆盖。
  - 复制 `taskState` 到 snapshot。
  - 仍然只读 `ObservationProvider`，不读 artifact。
- `packages/web-buddy/src/context/prompt-sections.ts`
  - 在 `CURRENT_PAGE_STATE` / `CURRENT_FORM_STATE` 渲染 freshness cue。
  - 增加 `TASK_STATE` section，推荐放在 `TASK` 后、`RESUME_SUMMARY` 前。
  - 增加 tight budget priority 行为：blockers、missingRequired label、blocked/error/high-risk recent actions 要优先保留。
  - 可增加 `measurePromptSections()` 或只从新 `context/metrics.ts` 导入 helper。
- `packages/web-buddy/src/agent/prompt-assembler.ts`
  - 在 build/render context 时通过 active trace 记录 `context_selection` event。
  - 如果没有传入 taskState，可以根据 goal 构造默认 observing TaskState。
  - 注意避免因为 system/user/initial render 重复调用 `buildPromptSections()` 而重复计数。
- `packages/web-buddy/src/metrics/schema.ts`
  - `RunMetrics` 增加 context metrics 字段，旧 trace 缺失时默认 0 或 `{}`。
- `packages/web-buddy/src/metrics/aggregate.ts`
  - 从 `events.jsonl` 汇总 `context_selection` event。
  - aggregation 读 trace 是允许的旁路行为。
- `packages/web-buddy/scripts/context-manager-test.mjs`
  - 增加 freshness 计算断言。
  - 保留 poisoned artifact 不进入 snapshot 的断言。
  - 可增加 taskState 复制断言。
- `packages/web-buddy/scripts/prompt-sections-test.mjs`
  - 增加 freshness rendering 断言。
  - 增加 `TASK_STATE` section 顺序和渲染断言。
  - 增加 tight budget priority 断言。
- `packages/web-buddy/scripts/metrics-test.mjs`
  - 增加 `context_selection` event fixture。
  - 断言新 metrics 字段聚合正确。
  - 断言旧 trace / missing files 时新字段默认安全。

可选后置：

- `packages/web-buddy/scripts/prompt-priority-test.mjs`
  - 如果不想继续膨胀 `prompt-sections-test.mjs`，可单独新增 priority 测试脚本。
- `packages/web-buddy/benchmarks/mock-pages/complex-apply.html`
- `packages/web-buddy/scripts/benchmark-complex.mjs`

## 容易并行冲突的文件

高冲突：

- `packages/web-buddy/src/context/types.ts`
  - Freshness、TaskState、PromptSectionId 都会碰这里。
- `packages/web-buddy/src/context/prompt-sections.ts`
  - Metrics、Freshness、Priority、TaskState 都会碰这里。
- `packages/web-buddy/scripts/prompt-sections-test.mjs`
  - Freshness、Priority、TaskState 测试都会碰这里。

中冲突：

- `packages/web-buddy/src/context/context-manager.ts`
  - Freshness 和 TaskState 都会碰这里。
- `packages/web-buddy/src/agent/prompt-assembler.ts`
  - Metrics event 和 default TaskState 都会碰这里。
- `packages/web-buddy/scripts/context-manager-test.mjs`
  - Freshness 和 TaskState 都会扩展这里。

建议串行：

- `packages/web-buddy/src/metrics/schema.ts`
- `packages/web-buddy/src/metrics/aggregate.ts`
- `packages/web-buddy/scripts/metrics-test.mjs`

这些应等 `context_selection` event shape 确定后再改。

建议不要碰：

- `packages/web-buddy/src/runtime/local/agent-loop.ts`
  - Phase 4B 不应重写主循环。
  - TaskState 第一版可由 `PromptAssembler` 默认生成 observing 状态。
- `packages/claude-code/**`
  - 严格禁止修改。

## Trace Artifact 被 runtime/context/prompt 读取的风险

当前未发现 runtime / context / prompt 读取 trace artifact 的风险。

审计结果：

- `packages/web-buddy/src/context/**` 未发现读取 `page-state-latest.json`、`form-state-latest.json`、`events.jsonl`、`metrics.json`、`agent-state.json` 的路径。
- `packages/web-buddy/src/agent/**` 未发现读取 trace artifact 的路径。
- `packages/web-buddy/src/runtime/local/**` 未发现读取 trace artifact 的路径。
- `packages/web-buddy/src/runtime/local/login.ts` 有 `existsSync(storageStatePath)`，这是 cookie storage 输入，不是 trace artifact。
- `ObservationManager` 会写 `page-state-latest.json` / `form-state-latest.json` 并记录 `observation_artifact` event，但不会读 artifact。
- trace artifact 读取集中在：
  - `packages/web-buddy/src/metrics/**`
  - `packages/web-buddy/src/web/**`
  - benchmark scripts
  - test scripts
  这些属于允许的 Web UI / benchmark / debug / replay / metrics aggregation 旁路输出。

后续每个实现 Agent 完成后建议跑边界检查：

```bash
rg -n "page-state-latest|form-state-latest|output/traces|readFileSync|readFile" \
  packages/web-buddy/src/agent \
  packages/web-buddy/src/context \
  packages/web-buddy/src/runtime/local \
  --glob '*.ts'
```

期望：

- 无命中；或只有明确不是 trace artifact runtime-state read 的命中。

## 派工建议

推荐波次：

1. Wave 1 并行：Context Metrics / Freshness Metadata。
2. Wave 2 串行或小并行：Metrics Aggregation / Prompt Freshness Rendering。
3. Wave 3 谨慎并行：Prompt Priority Tests / Minimal TaskState。
4. Wave 4 串行：TaskState Prompt Section 合并和全量验证。
5. Wave 5 可选：Complex Local Benchmark。

实现边界提醒：

- 不重写 `runAgentLoop`。
- 不改变 `runAgentLoop` 对外接口。
- 不改变 `ToolRegistry` 对外接口。
- 不引入 `ToolExecutionService`。
- 不抽 `PolicyEngine`。
- 不做 Skill / Memory / 多 Agent。
- 不从 trace artifacts 恢复 TaskState。
- Runtime / ContextManager / PromptAssembler 不允许为了构建上下文读取 trace artifacts。

## 当前工作区提示

审计时 `git status --short` 显示：

```text
?? PLAN/plan5.md
```

也就是说 `PLAN/plan5.md` 当前是未跟踪文件。后续 Agent 不应误删或重置它。
