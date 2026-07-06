# Web-Buddy 自主填表能力设计文档（信息获取 → 转化 → 填写）

状态：实现进度表（v1，2026-07-03）
关联：`docs/golden-problems.md`（GP-001 / GP-002）、`docs/safety-model.md`

---

## 1. 背景与目标

web-buddy 目前在真实招聘投递里能做到：抓取岗位、匹配、进入申请流程、登录 handoff、上传简历、在最终提交前安全停住。但它做不到用户真正想要的：

- **自主获取信息**：表单里出现简历没有的字段时，无渠道补全。
- **转化信息**：把简历里的原始信息映射/归一化/派生成表单需要的值。
- **自动填表**：把值稳定、可验证地写进各种控件，并判断"表单是否真的填完"。

本设计的目标是补齐这三件事，且满足两条硬约束：

1. **不破坏现有安全模型**：GP-001/GP-002 的护栏（final_submit 不自动点、upload/save gate、completion gate、resume-first）必须保持有效。
2. **工程可增量落地**：不推倒 `runAgentLoop`，以"新增模块 + 新增工具 + 在既有集成点挂载"的方式演进，每个阶段独立可测、可回滚。

---

## 2. 问题定位摘要

（详细分析见上一轮定位，这里给结论，作为设计的输入。）

| # | 边界 | 证据位置 | 归属能力 |
| --- | --- | --- | --- |
| 1 | 无"获取新信息"的工具（无 web_search / ask_user / 读全量简历） | `tools/catalog.ts`（仅 12 个浏览器工具） | 获取 |
| 2 | 简历进 prompt 前被压扁两次：V2→legacy 丢 projects/targetRoles/seniority；summary 又只留名片级信息 | `sdk/resume.ts:resumeV2ToLegacyProfile`、`context/context-manager.ts:summarizeResumeProfile` | 获取 |
| 3 | 表单只抓首屏可见 + 原生 `<select>`，不滚动，自定义下拉看不到选项 | `browser/form-snapshot.ts`（`isVisible` 过滤、`fieldOptions` 仅 select） | 获取 |
| 4 | **没有"字段↔简历值"的映射/转化层**（唯一的 5 条正则只在无 LLM 兜底里用） | `sdk/form-fill.ts:FIELD_MATCHERS` | 转化 |
| 5 | prompt 主动劝模型"拿不准别填" | `agent/prompt-assembler.ts`、`context/prompt-sections.ts` | 转化 |
| 6 | 填了不回读校验，`filled` 靠 `value.length>0`，自定义控件易误判 | `observation/form-state-builder.ts` | 填写 |
| 7 | `missingRequired` 只看 required 属性/可见性，漏检严重 | `browser/form-snapshot.ts:required` | 填写 |
| 8 | 级联/日期/可搜索下拉无专门策略 | `browser/select-by-text.ts` | 填写 |
| 9 | 架构被"安全地停下来"绑架，无对称的"完成度引擎" | `runtime/local/agent-loop.ts`、`workflow/completion-gate.ts` | 结构 |
| 10 | 通用循环与阿里硬编码割裂，只靠 `extraContext` 字符串传信息 | `sdk/orchestrator.ts` | 结构 |
| 11 | 无面向填表的持久工作记忆（recentActions 上限 12，按风险排序） | `context/prompt-sections.ts:prioritizeRecentActions` | 结构 |

**死结**：信息进模型前被削薄（2）→ 手里没料 → 没工具补料（1）→ 没有转化层（4）→ prompt 还劝它别填（5）→ 只能填 name/phone/email → `agent_done`。

---

## 3. 设计总览

新增四层能力，围绕已有的 `runAgentLoop` 挂载，不改变主循环的 ReAct 骨架：

```
┌─────────────────────────────────────────────────────────────┐
│                      runAgentLoop (保留)                       │
│  观察 → 决策(LLM) → policy/permission/gate → 执行 → 观察 ...    │
└───────────────┬───────────────┬───────────────┬──────────────┘
                │               │               │
   ┌────────────▼──┐  ┌─────────▼────────┐  ┌───▼──────────────┐
   │ ① 信息层       │  │ ② 转化层          │  │ ④ 完成度层        │
   │ ProfileStore  │  │ FieldPlanner     │  │ FillLedger       │
   │ AnswerStore   │  │ + Normalizers    │  │ + fill gate      │
   │ resume_query  │  │ (确定性 + LLM)     │  │ (prompt 再平衡)   │
   │ ask_user 工具  │  └─────────┬────────┘  └───▲──────────────┘
   └───────────────┘            │                │
                     ┌──────────▼────────────────┴───┐
                     │ ③ 观察层增强                     │
                     │ 滚动审计 / 选项探测 / 回读校验     │
                     │ (form-snapshot + 新 setField)    │
                     └────────────────────────────────┘
```

设计原则：

- **确定性优先，LLM 兜底**：能用规则归一化的（手机/日期/枚举匹配）走确定性代码；只有语义模糊的（长文本合成、字段含义判断）才调 LLM。降低成本、可测、可解释。
- **信息可回溯**：每个被填的值都要能回答"来自简历哪一项 / 用户哪次回答 / 如何归一化 / 置信度多少"。
- **把"填表完成度"做成一等公民**：与 final_submit gate 对称，新增只管"是否填全、是否验证"的 fill-completion gate。

---

## 4. 详细设计

### 4.1 信息层（获取）

#### 4.1.1 停止在进入循环前压扁简历

现状：`orchestrator.ts` 把 `ResumeProfileV2` 转成 legacy `ResumeProfile` 再交给 `runAgentLoop`，projects / targetRoles / seniority / evidence 全丢。

改动：

- `AgentLoopInput` 增加可选字段 `resumeV2?: ResumeProfileV2`（保留 `resume: ResumeProfile` 向后兼容）。
- 新增 `context/profile-store.ts`：一个 **ProfileStore**，持有完整 V2，并提供分节查询能力。
- `RESUME_SUMMARY` 段仍保留（作为常驻概览），但不再是模型获取简历细节的唯一途径。

#### 4.1.2 `resume_query` 工具（按需取全量简历）

模型可主动查询完整简历分节，而不是只能看被截断的摘要。

```ts
// tools/catalog.ts 新增
{
  name: 'resume_query',
  category: 'observation',
  risk: 'L0',
  description:
    '查询候选人完整简历的某个分节（experience/projects/education/skills/summary/contact/all）。' +
    '当表单需要项目经历、工作职责、自我评价等细节时使用；这些细节不在 RESUME_SUMMARY 里。',
  parameters: {
    type: 'object',
    properties: {
      section: { type: 'string', enum: ['contact','summary','skills','experience','projects','education','targetRoles','all'] },
      query: { type: 'string', description: '可选：用自然语言描述要找的信息，如"最近一段后端项目的职责"' },
    },
    required: ['section'],
  },
}
```

实现：读 ProfileStore，返回该分节的结构化 JSON（含 evidence/confidence）。纯本地、无副作用、L0，不经过 gate。

#### 4.1.3 `ask_user` 工具（信息入口，复用 gate 基础设施）

表单需要简历里没有、页面上也推不出的信息（期望薪资、到岗时间、是否服从调剂、紧急联系人……）时，模型可以**向用户提问**，而不是留空或编造。

- 复用现有 `HumanGate`：新增一个 **非风险类** 的 gate kind `info_request`，语义是"我需要一条信息才能继续"，不是"我要做危险动作"。
- CLI 下 `CliHumanGate` 直接读一行文本作为回答；Web/SDK 下走 approval queue 的 resolution（附带 `answer` 文本）。
- 回答写入 **AnswerStore**（见下），保证同一问题只问一次。

```ts
{
  name: 'ask_user',
  category: 'human',
  risk: 'L0', // 不是风险动作，是信息请求；但会暂停等待人回答
  description:
    '当某个表单字段需要的信息既不在简历、也无法从页面推断时，向用户提出一个简短问题并等待回答。' +
    '不要用它来确认危险动作（那走安全 gate）。问过的问题不要重复问。',
  parameters: {
    type: 'object',
    properties: {
      field: { type: 'string', description: '这条信息对应的表单字段，如"期望薪资"' },
      question: { type: 'string', description: '给用户看的一句话问题' },
      options: { type: 'array', items: { type: 'string' }, description: '可选：候选项' },
    },
    required: ['field', 'question'],
  },
}
```

工程注意：`ask_user` 会阻塞等待人类输入，和 gate 一样必须支持 `abortSignal`。它**不占用 final_submit 语义**，也不能被 permission mode 静默"approve 掉"——没有回答就没有值。

#### 4.1.4 AnswerStore（问过的记住）

```ts
// context/answer-store.ts
export interface UserAnswer {
  field: string
  question: string
  answer: string
  at: string
  source: 'ask_user'
}
export class AnswerStore {
  get(field: string): UserAnswer | undefined
  put(a: UserAnswer): void
  all(): UserAnswer[]
}
```

AnswerStore 与 ProfileStore 一起，构成 FieldPlanner 的两个值来源。会话级持久化可复用现有 `session` transcript（新增一种 transcript 事件 `user_answer`）。

#### 4.1.5 （可选）`web_search`

优先级最低，作用域外。若未来要做"公司背景/JD 术语澄清"等，可作为独立 L1 只读工具接入。本设计不依赖它。

---

### 4.2 转化层（核心新增）：FieldPlanner + Normalizers

这是补齐"笨"的最关键一层。职责单一：**给定一个表单字段 + ProfileStore + AnswerStore → 产出一个 FieldPlan（该填什么、怎么填、置信度、是否要问用户）**。

```ts
// fill/field-plan.ts
export type FieldControlKind =
  | 'text' | 'textarea' | 'select_native' | 'select_custom'
  | 'cascader' | 'date' | 'radio' | 'checkbox' | 'file' | 'unknown'

export interface PlannedField {
  fieldIndex: number            // 对应 FormFieldState.index
  label: string
  controlKind: FieldControlKind
  intendedValue: string | string[] | null
  valueSource: 'resume' | 'user_answer' | 'derived' | 'page' | 'none'
  sourceRef?: string            // 如 "experience[0].title" / "answer:期望薪资"
  normalization?: string        // 如 "phone:digits" / "date:YYYY.MM" / "option-match:0.82"
  confidence: number            // 0..1
  needsUser?: { question: string; options?: string[] }
  optionMatched?: { optionValue: string; optionLabel: string; score: number }
  skipReason?: string           // 明确为何不填（如 disabled / 无来源 / 低置信度）
}

export interface FieldPlan {
  planned: PlannedField[]
  updatedAt: string
}
```

#### 4.2.1 两级映射策略

1. **确定性映射（deterministic mapper）**：按控件类型 + label 语义规则命中常见字段。覆盖招聘表单 80% 的高频字段：
   - 联系：姓名/手机/邮箱/所在城市/性别/年龄 → 直接取 profile / 归一化。
   - 结构派生：`工作年限` ← 由 experience 时间段求和；`最高学历` ← education 里挑最高；`当前/最近公司/职位` ← experience[0]。
   - 枚举/下拉：把候选值和 `field.options` 做模糊匹配（见 Normalizers），选最高分。
2. **LLM 映射（planner LLM，仅对未命中或模糊字段）**：把"剩余未决字段 + 简历分节 + 已知答案"打成一个结构化请求，让模型输出 `PlannedField[]`（严格 JSON schema，复用 `resume.ts` 里已有的 `generateJson` + zod 校验模式）。只处理确定性映射搞不定的字段，控制 token。

> 关键：LLM 在这里**只做映射决策，不直接操作浏览器**。这样它的输出是可校验、可留痕的结构化 plan，而不是即兴点按钮。

#### 4.2.2 Normalizers（确定性归一化）

```ts
// fill/normalizers.ts
normalizePhone(raw): string           // 去掉分隔符/国家码策略
normalizeDate(raw, fmt): string        // "2021.05-至今" → "2021-05" 等，按目标控件格式
matchOption(value, options): {optionValue,optionLabel,score} | null
                                       // 归一化后做 token/编辑距离模糊匹配，返回最佳选项
deriveYearsOfExperience(experience[]): number
pickHighestDegree(education[]): string
composeSelfIntro(profile, maxLen): string  // 由 summary+skills+最近经历合成，受长度约束
```

`matchOption` 是解决"下拉/级联填不进去"的关键：先拿到 options（见 4.3.2），再把简历值归一化后匹配，输出选项的 value/label 供执行层精确选择。

#### 4.2.3 何时产出 FieldPlan

- 进入 `filling_application`/`editing_resume` phase 且检测到可填表单时，由主循环调用 `FieldPlanner.plan()` 生成一次，注入 prompt（见 4.4.4）。
- 表单结构变化（滚动出新字段、上传后刷新详情）后重算。
- 模型也可以显式请求：新增 `plan_form_fill` 工具触发重算（L0）。

---

### 4.3 观察层增强（获取 + 填写基础）

#### 4.3.1 滚动审计（formCoverage）

现状：`form-snapshot.ts` 只抓当前视口可见控件，`maxFields=120`，不滚动。

改动：新增 `browser/form-audit.ts`，实现 `scrollAuditForm()`：

- 分段滚动整页（top → middle → bottom，按 viewport 高度步进），每段调用一次现有 form-snapshot 抽取逻辑。
- 合并去重（按 name/id/label + 位置指纹），产出**完整字段集**。
- 记录 `formCoverage: { scrolledTop, scrolledBottom, segments, totalFieldsSeen }`。

暴露为工具 `browser_form_audit`（L0，observation），并把 `formCoverage` 写进 FormState / WorkflowState，供完成度层判断。

#### 4.3.2 自定义下拉/级联的选项探测

现状：`fieldOptions` 仅对原生 `<select>` 有效，Ant Design 等 combobox 返回 `undefined`。

改动：新增 `browser/inspect-options.ts` 的 `inspectOptions({ ref | label })`：

- 点击/聚焦控件打开浮层，读取 `[role=listbox] [role=option]` / `.ant-select-item` / 级联 `.ant-cascader-menu-item` 等常见结构的可见文案。
- 读完后关闭浮层（Esc），尽量无副作用。
- 返回 `{ options: {value?,label}[], multiLevel?: boolean }`。

暴露为工具 `browser_inspect_options`（L0）。FieldPlanner 的 `matchOption` 消费它。

> 兼容性：选择器用"已知组件库 + 通用 role"两套，命中不了就退回让模型用 `browser_click` 手动展开——不追求 100% 自动，但覆盖主流中文站点。

#### 4.3.3 必填检测增强

现状仅：`required` 属性 / aria-required / 附近 `*`|必填。

补充信号（都在 `form-snapshot.ts` 的 evaluate 里可拿）：

- label 容器 class 含 `required`/`ant-form-item-required`。
- 提交后出现的校验错误文案回填到对应字段（利用已有 `visibleErrors` + 字段 root 匹配）。
- 输出 `requiredConfidence`，让完成度层区分"确定必填未填"和"疑似必填"。

---

### 4.4 执行层 + 完成度层（填写 + 判断填完）

#### 4.4.1 统一的 `browser_set_field`（按控件类型分派）

现状：`browser_type`/`browser_fill_by_label`/`browser_select_by_text` 割裂，且级联/日期无专门策略。

新增高层工具 `browser_set_field`（L2，写字段），内部按 `controlKind` 分派：

- `text/textarea`：fill + 触发 `input`/`change` 事件（解决受控组件不更新）。
- `select_native`：selectOption。
- `select_custom`：打开浮层 → 按 optionLabel 精确点击。
- `cascader`：按路径逐级点击（省→市→区）。
- `date`：按控件类型输入或选择。
- `radio/checkbox`：按 label 匹配点击。

保留旧工具向后兼容；新逻辑优先走 `set_field`。

#### 4.4.2 回读校验（fill-verify 闭环）

`set_field` 执行后**立即回读**该字段值/选中态并比对 `intendedValue`：

- 命中 → 标记 `verified`。
- 未命中 → 用备选策略重试一次（如改用事件派发、或 `click_text` 选项）；仍失败则标记 `failed` 并把原因写进 ledger 和 observation。

这直接解决边界 6（填了不知道有没有进去）。

#### 4.4.3 FillLedger（面向填表的持久工作记忆）

```ts
// fill/fill-ledger.ts
export interface FillLedgerEntry {
  fieldIndex: number
  label: string
  intendedValue: string | string[] | null
  status: 'planned' | 'filled_unverified' | 'verified' | 'failed' | 'skipped' | 'needs_user'
  attempts: number
  lastError?: string
  source?: PlannedField['valueSource']
  updatedAt: string
}
export class FillLedger {
  upsert(e: Partial<FillLedgerEntry> & { fieldIndex: number }): void
  snapshot(): FillLedgerEntry[]
  summary(): { total; verified; failed; needsUser; skipped; pendingRequired }
}
```

- 独立于 `recentActions`（那个上限 12、按风险排序，不适合追踪逐字段进度）。
- 每轮把 ledger 摘要注入 prompt，模型永远知道"还差哪些字段"。
- 会话持久化：新增 transcript 事件 `fill_ledger_snapshot`。

#### 4.4.4 prompt 再平衡

现状 SAFETY_RULES/NEXT_ACTION_RULES 偏"别填"。新增一个 **FILL_PLAN** prompt 段（在 `prompt-sections.ts` 的 `PROMPT_SECTION_ORDER` 中插入，放在 CURRENT_FORM_STATE 后）：

- 渲染当前 `FieldPlan`（字段 → 建议值 → 来源 → 是否需问用户）。
- 渲染 `FillLedger.summary()`（已填/已验证/失败/待问/未填必填）。
- 指令改为主动完成导向，同时不越过安全边界：
  - "按 FILL_PLAN 逐个把 intendedValue 写进对应字段，用 browser_set_field。"
  - "遇到 needsUser 的字段，用 ask_user 获取后再填。"
  - "缺细节时用 resume_query 取完整简历分节，不要因为 RESUME_SUMMARY 没有就留空。"
  - "只有当 FillLedger 里没有 pendingRequired、且已 form_audit 覆盖整页后，才考虑 agent_done / 进入最终提交边界。"
- 保留原有 final_submit / upload / save 的安全措辞不变。

#### 4.4.5 fill-completion gate（与 final_submit gate 对称）

现状 `completion-gate.ts` 只防"过早最终提交"。新增/扩展一个只管"填表彻底性"的判断（可作为 completion gate 的一类 criteria，避免再造一套引擎）：

进入最终提交边界前必须满足（缺任一则拒绝 `agent_done`，把结构化缺口返回给模型）：

```
formCoverage.scrolledBottom = true          # 整页滚过
FillLedger.pendingRequired = 0              # 无"确定必填未填"
FillLedger.failed = 0                       # 无填写失败未处理
FillLedger.needsUser = 0                    # 无待问用户
(若本次任务带简历文件) currentResumeUploaded = true   # 复用 GP-002 的诉求
```

这一步同时落地 GP-002 里"提交前证明"的 `formScrollAuditStatus` / `currentResumeUploaded` / `missingRequiredCount=0`。

---

## 5. 关键数据结构汇总

- `ProfileStore`（持有 `ResumeProfileV2`，分节查询）
- `AnswerStore` + `UserAnswer`
- `FieldPlan` / `PlannedField`
- `FillLedger` / `FillLedgerEntry`
- `FormCoverage`（挂到 `FormState` 与 `WorkflowState`）
- 新 gate kind：`info_request`（`GateKind` 扩展，仅信息请求，非风险）

新增/扩展 WorkflowState 字段（可选，不破坏 v1）：`formCoverage`、`fillLedgerSummary`、`currentResumeUploaded`。

---

## 6. 集成点（精确到文件/函数）

| 集成动作 | 位置 |
| --- | --- |
| 保留完整 V2 简历传入循环 | `sdk/orchestrator.ts`（runAgentLoop 调用处，增加 `resumeV2`）；`runtime/local/agent-loop.ts:AgentLoopInput` |
| 注册新工具 | `tools/catalog.ts`（定义）+ `tools/local-adapter.ts:localHandlers`（实现）|
| 新工具风险/权限 | `permission/permission-rules.ts`、`policy/*`：`resume_query`/`plan_form_fill`/`browser_form_audit`/`browser_inspect_options` = L0 放行；`browser_set_field` = L2；`ask_user` = 信息请求（不占 final_submit）|
| FieldPlanner 触发 | `agent-loop.ts` 在 `buildLoopContextWithWorkflow` 后、进入 filling phase 时调用；结果进 ContextSnapshot |
| 新 prompt 段 | `context/prompt-sections.ts`（`PROMPT_SECTION_ORDER` 增 `FILL_PLAN`、`renderSectionContent`）、`context/types.ts`（ContextSnapshot 增 `fieldPlan`/`fillLedgerSummary`）|
| 滚动审计/选项探测 | 新增 `browser/form-audit.ts`、`browser/inspect-options.ts`；`observation/observation-manager.ts` 存 coverage |
| 回读校验 + set_field | 新增 `browser/set-field.ts` |
| FillLedger 生命周期 | `agent-loop.ts` 内实例化，随 set_field/校验结果更新；持久化走 `session` transcript |
| 完成度校验 | `workflow/completion-gate.ts`（增填表 criteria）；在 `agent_done` 分支消费 |
| ask_user gate | `sdk/human.ts:GateKind` 扩展；`CliHumanGate.confirm` 支持返回文本；approval-queue resolution 带 `answer` |

---

## 7. 实现进度表

本节从原"分阶段落地计划"更新为当前实现进度。状态以 2026-07-03 本地 QA 为准。

| 模块 | 状态 | 已落地 | 验证 |
| --- | --- | --- | --- |
| 完整简历透传 | 已完成 | `AgentLoopInput.resumeV2`、`ProfileStore`、运行时上下文注入 | `npm run test:resume-query` 通过 |
| `resume_query` | 已完成 | L0 本地工具，可按 section 查询 V2 简历，结果写 transcript | `scripts/resume-query-test.mjs` 通过 |
| `ask_user` / AnswerStore | 已完成 | L0 信息请求工具，复用 human input 入口，同 field 去重，写 `user_answer` transcript | `scripts/ask-user-flow-test.mjs` 通过 |
| FILL_PLAN prompt 段 | 已完成 | `ContextSnapshot` 增 `fieldPlan` / `fillLedgerSummary` / `answerSummary`，`prompt-sections.ts` 渲染填表上下文 | `npm run test:prompt-sections`、`npm run test:context` 覆盖 |
| FieldPlan 类型 | 已完成 | `fill/field-plan.ts` 定义 `FieldPlan` / `PlannedField` / `FieldPlanner` 接口 | build 覆盖 |
| FieldPlanner 实现 | 已完成 | 已有确定性 mapper、normalizers、枚举模糊匹配、LLM 兜底、`plan_form_fill` 工具和保守自动触发；LLM 只补 `valueSource=none` 的未决字段，不覆盖确定性结果 | `npm run test:field-planner`、`npm run test:tool-catalog` 通过 |
| 滚动表单审计 | 已完成 | `browser/form-audit.ts`、`browser_form_audit`、`formCoverage` 写入 FormState/WorkflowState | `npm run test:form-audit` 通过 |
| 自定义选项探测 | 已完成 | `browser/inspect-options.ts`、`browser_inspect_options`，覆盖 role/listbox、Ant Select、cascader fixture | `npm run test:inspect-options` 通过 |
| 必填检测增强 | 已完成 | `requiredConfidence`、错误文案匹配、checkbox/自定义控件状态进入 FormState | `npm run test:form-audit`、`npm run test:observation` 通过 |
| `browser_set_field` | 已完成 | L2 高层写字段工具，覆盖 text/textarea/native select/custom select/cascader/date/radio/checkbox，文件字段拒绝转由 upload 工具处理 | `scripts/set-field-test.mjs` 通过 |
| 回读校验 | 已完成 | `set_field` 执行后 readback，比对 intendedValue，失败返回结构化原因 | `scripts/set-field-test.mjs` 通过 |
| FillLedger | 已完成 | `fill/fill-ledger.ts`、运行时实例化，随 `browser_set_field` 结果更新并注入 prompt/workflow | `npm run test:completion-gate`、`npm run test:agent-runtime-workflow` 通过 |
| fill-completion gate | 已完成 | completion gate 消费 `formCoverage`、`fillLedgerSummary`、`requiresCurrentResumeUpload`、`currentResumeUploaded`，拒绝过早 `agent_done` | `npm run test:completion-gate`、`npm run test:agent-runtime-workflow` 通过 |
| demo-form 本地验收 | 已完成 | 离线 demo 能解析简历、打开本地表单、填 name/email/phone/summary，并在 L3 save 边界停住不提交；新增固定离线脚本避免误走外部模型 | `npm run demo:form:offline` 通过；外部 GLM 路径曾因 HTTP 529 阻塞 |
| 真实阿里 E2E | 待跑 | 本轮未触碰真实站点；需在执行前确认 GP-002 quota 弹窗 final_submit 边界、当前简历上传证据、整页表单审计证据 | 见第 12 节检查清单 |

当前主要缺口：

- `FieldPlanner` 的外部真实模型调用仍需要单独 smoke/E2E；本地回归使用 fake LLM 覆盖 hybrid merge 语义。
- demo-form 的 LLM 驱动路径仍依赖外部模型，本轮 GLM 返回 HTTP 529；固定离线 heuristic 脚本已通过，可作为 QA 默认验收路径。

---

## 8. 与现有安全模型的关系（不回退 GP-001/GP-002）

- **final_submit 仍不自动点**：新增能力只填字段、选选项、上传（已 gated），不触碰最终提交。fill-completion gate 是"提交前的更严前置条件"，只会让停得更稳，不会放宽。
- **upload/save 仍走 gate**：`browser_set_field` 不处理文件；上传仍是 `browser_upload_file` + `upload_resume` gate。
- **ask_user ≠ 危险确认**：`info_request` 是信息请求，不能被 permission mode 静默放行，也不改变 final_submit 语义。
- **quota 弹窗（GP-002 #1）**：不在本设计范围内改判，但 FieldPlanner/ledger 提供的 `currentResumeUploaded` 证据正是 GP-002 想要的前置条件，可协同。

---

## 9. 风险与取舍

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 选项探测/set_field 的站点兼容性 | 自定义组件库结构各异 | 已知库选择器 + 通用 role 双通道；命中不了退回让模型手动点，不追求 100% |
| LLM planner 成本/延迟 | 每次重算都调模型 | 确定性优先，LLM 只处理残余模糊字段；表单结构不变时缓存 plan |
| ask_user 打断体验 | 问太多变啰嗦 | AnswerStore 去重；只对"确定必填 + 无任何来源"才问；可配置上限 |
| 过度自动填写误填 | 低置信度乱填 | PlannedField 带 confidence 阈值；低于阈值走 skip 或 ask_user，而非硬填 |
| 回读校验误判自定义控件 | 值不在 .value 上 | 校验读多来源（value / aria / 选中项文案）；失败降级为 unverified 而非 failed 阻塞 |
| 工作量 | 4 阶段较大 | Phase 1 单独就能显著改善"填不出字段"，可先只做 Phase 1+2 |

### 9.1 已知限制（实现后补记）

| 限制 | 说明 | 现状/后续 |
| --- | --- | --- |
| FieldPlan 不随表单变化自动重算 | `ensureFieldPlan` 有 `if (ctx.fieldPlan) return` 守卫，上传简历、滚动露出新字段、或页面跳转后，plan 不会自动刷新，需模型主动调 `plan_form_fill(refresh:true)` | prompt（NEXT_ACTION_RULES）已提示"FILL_PLAN missing/stale 时先 plan_form_fill"，但依赖模型自觉。后续可在"表单字段数变化 / URL 变化"时自动使 plan 失效 |
| 工作年限按段求和会重复累加 | `normalizers.ts:deriveYearsOfExperience` 逐段 `period` 相加，若多段经历时间重叠会高估年限（可能偏差 1–2 年） | 低优先级。后续可改为按月份区间取并集去重后再统计 |

---

## 10. 最小可行切片（如果只做一件事）

**只做 Phase 1**：把完整简历透传 + `resume_query` + `ask_user`。
理由：当前"笨"的最短因果链是"信息进模型前被削薄 + 没有补料入口"。仅此一步就能让模型在填长文本、项目经历、以及简历没有的字段时不再空手，且改动集中在 orchestrator/agent-loop/catalog/prompt 四处，风险可控、当天可验证。转化层（Phase 2）紧随其后，收益最大。

---

## 11. 待确认问题

1. `ask_user` 在非交互（无 TTY / benchmark）下的默认行为：跳过该字段并记 `needs_user`，还是整任务 block？（建议：记 `needs_user` 并继续，不阻塞主流程。）
2. FieldPlanner 的 LLM 兜底是否允许联网调用？在纯离线回归里应可关闭，只跑确定性路径。
3. `browser_set_field` 是否直接取代旧的三个填写工具，还是灰度共存一段时间？（建议共存，prompt 引导优先用新工具。）

## 12. 真实阿里 E2E 前检查清单

执行真实站点前，先确认以下项，避免重复 GP-002 中"旧简历/未填全/误投递"风险。

| 检查项 | 必须满足的证据 |
| --- | --- |
| 账号与登录 | 使用显式 `login` 命令预先登录；不在 agent 中自动输入账号、密码、短信码或处理验证码。 |
| 简历文件 | `extraContext` / trace 中有 `Current task resume file path`；上传动作只能走真实 `input[type=file]` 或明确上传控件。 |
| 当前简历已生效 | `currentResumeUploaded=true`，并保留上传后的页面观察、截图或表单状态证据；未确认时不得进入最终投递。 |
| 整页表单审计 | 已运行 `browser_form_audit`，`formCoverage.scrolledBottom=true`，首屏外字段也进入 FormState。 |
| 必填字段 | `FillLedger.pendingRequired=0`，无确定必填未填；`failed=0`，无未处理写入失败；`needsUser=0`，无待问用户信息。 |
| 自定义选项 | 对关键 select/cascader 已用 `browser_inspect_options` 或页面观察证明选项和值匹配。 |
| 保存/上传/最终提交 | `save_resume`、`upload_resume`、`final_submit` 仍由 gate 控制；permission mode 不得绕过 final submit。 |
| quota 弹窗 | 出现"本月能申请 N 个职位 / 请慎重选择 / 投递名额"等文案时，弹窗确认按钮按 `final_submit` 处理，不作为普通申请流程确认。 |
| agent_done | 只有在 fresh observation 之后，且 completion gate 没有返回缺口时，才接受完成或停在最终提交边界。 |
| 输出归档 | 保存 trace、session transcript、final screenshot、page-state/form-state artifacts，便于复盘真实风险边界。 |
