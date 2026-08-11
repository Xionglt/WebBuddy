# Web Buddy 记忆机制

Web Buddy 的记忆不是一份无限增长的对话历史，而是按用途、信任级别和生命周期分层管理的状态系统。设计目标是：在复用用户偏好和网页经验的同时，不让过期页面经验、网页提示注入或历史授权扩大 Agent 的权限。

## 1. 记忆分层

| 层级 | 用途 | 存储 | 生命周期 |
| --- | --- | --- | --- |
| Run Memory | 当前任务的目标、阻塞、近期动作和工作流状态 | Session Transcript / 内存快照 | 单次 Run |
| Resume State | 断点恢复所需的转录、ActionLedger、页面和审批引用 | `output/sessions/<sessionId>` | Session |
| Answer Memory | `ask_user` 得到的稳定表单答案 | `answers.json` | 跨 Run |
| Permission Memory | 当前 Session 的授权或持久拒绝规则 | `permission-rules.json` | Session / 持久限制 |
| Long-term Memory | 用户偏好、限制性约束和经过验证的网页流程经验 | `MemoryLifecycle` | TTL + 版本化 |

Run Memory 和 Resume State 负责“把当前任务做完”，Long-term Memory 负责“下次任务是否可以安全复用经验”。两者不共用权威边界。

## 2. 长期记忆数据模型

可复用的浏览器记忆使用 `web-memory/v1` 封装，核心字段包括：

- `effect`：`preference`、`restrictive_constraint`、`procedure` 或 `authorization`。
- `memoryKey`：逻辑身份，用于去重和纠错替换。
- `statement`：经过证据校验的原文片段。
- `applicability`：适用的站点 Origin、路径模式和工作流。
- `evidence`：来源类型、采集时间、证据 ID、原文哈希以及可选的页面语义指纹。
- `validation`：是否需要在当前页面或当前 Session 重新验证。

`MemoryLifecycle` 继续作为唯一的长期存储层，统一提供 Scope、Provenance、TTL、Revision、Conflict、Supersedes、Delete 和 Forget 语义。

## 3. 自动抽取与写回

自动抽取发生在一个 Agent Turn 的模型输出和工具执行都完成之后：

```text
Turn 完成
  -> 收集高信号证据
  -> 低温 JSON 模型抽取
  -> 原文锚定和安全过滤
  -> ActionLedger 记录 memory_write
  -> AUTOMATIC_WEB_MEMORY_WRITE_POLICY
  -> MemoryLifecycle 去重 / supersedes / 持久化
```

只有三类证据可以触发模型抽取：

1. 包含“以后、默认、偏好、每次”等稳定信号的用户指令。
2. 用户通过 `ask_user` 给出的直接回答或纠正。
3. 成功的只读浏览器观察，例如 Snapshot、Form Audit 和 Option Inspection。

没有合格证据时不调用抽取模型。每轮最多处理 3 个候选，默认置信度阈值为 0.85，抽取超时为 12 秒。抽取失败不会使前台 Agent 任务失败。

## 4. 模型输出不是写权限

模型必须为每个候选返回 `evidenceId` 和能够在对应证据中逐字找到的 `evidenceQuote`。代码会再次检查：

- 引文是否真实存在。
- 记忆类型是否与证据来源匹配。
- 是否包含密码、Token、验证码、联系方式或身份信息。
- 是否试图记忆“自动提交、允许上传、无需确认”等正向授权。
- 是否包含“忽略系统指令”类提示注入内容。

最终落库的 `statement` 使用经过验证的原文片段，而不是模型的改写结果。模型只负责发现候选、分类和生成逻辑 Key，不能自行提升信任级别。

## 5. 网页过程记忆

网页 DOM 会频繁变动，因此 Procedure Memory 不保存 CSS Selector 或元素下标，而是绑定语义页面指纹：

- URL Origin 和将数字/UUID 归一化后的 Path Pattern。
- Page Type 和 Workflow Stage。
- 表单字段的 Label、Control Kind 和 Required 状态。
- 可执行动作的名称、角色和风险等级。

字段和按钮顺序不参与指纹，因此布局重排不会让记忆失效。但如果页面从“Preview”变成“Submit”，动作语义发生变化，指纹相似度会降低并拒绝注入该记忆。

Procedure Memory 即使通过指纹校验也只是 `advisory`，主流程仍需实时观察具体元素和动作风险。

## 6. 非对称权限继承

记忆可以收紧行为，但不能扩大权限：

- “每次提交前先询问”这类限制性约束可以跨 Session 保留。
- `allow` 类决策最多作用于当前 Session。
- 旧版本留下的跨 Session `always allow` 规则在匹配时失效关闭。
- 登录、验证码、简历上传、保存和最终提交始终使用实时权限门。

## 7. 去重、纠错与 TTL

| 记忆类型 | 默认 TTL |
| --- | --- |
| Procedure | 30 天 |
| Preference | 180 天 |
| Restrictive Constraint | 365 天 |

相同 `memoryKey + applicability + statement` 不重复写入。如果同一 `memoryKey` 出现了新的原文证据，创建新版本时会携带旧版本的 `entryId + expectedRevision`，通过 CAS 和 `supersedes` 原子替换。并发纠错中的过期 Revision 会返回 Conflict，不会覆盖新记忆。

不同 `memoryKey` 也可能表达同一件事。自动写入会先在相同 `effect + applicability` 中用本地 BM25 选出小候选集，再让当前 Agent 模型只提出 `store / update / merge / skip` 关系。模型返回的 ID 必须来自候选集；低置信度或无效输出降级为 `store`，最终提交仍由 MemoryLifecycle 的 Revision/CAS 保护。

## 8. 召回与注入

```text
MemoryLifecycle Retrieve
  -> Scope / TTL / Tombstone / Superseded 过滤
  -> 中文字符 n-gram BM25
  -> 可选 Embedding Provider + RRF
  -> Auth / Secret 过滤
  -> Site / Path / Workflow 校验
  -> Page Fingerprint 校验
  -> eligible / advisory / rejected
  -> BrowserScenarioCapsule 结构化投影
  -> derived_untrusted + data_only ContextItem
  -> Agent Prompt
```

本地关键词检索使用无依赖 BM25：英文和逻辑 Key 按词及标点切分，中文、日文和韩文使用重叠字符 bigram，不需要本地 Embedding 模型。如果注入 Embedding Provider，词法排名与向量排名通过 RRF 融合，Provider 失败仍会回退到 BM25。

Web Runtime 会把同一 `origin + pathPattern + workflow + pageType` 下的原子记忆投影为 `BrowserScenarioCapsule`。Capsule 只包含已通过治理的 statement、governance 结果和 `atomRefs`，不生成新事实。因为它是多条 Memory 的派生视图，Context 固定使用 `origin=derived`、`trust=derived_untrusted`、`instructionAuthority=data_only`。原子模式仍保留给 SDK 和兼容性测试。

## 9. 可观测性

自动抽取 Trace 记录：

- `proposed / accepted / rejected`。
- `low_confidence`、`ungrounded_quote`、`authorization_content`、`instruction_like_content` 等拒绝原因。
- 成功写入的 `effect`、`memoryKey`、`confidence`、`entryId` 和被替代版本。
- MemoryLifecycle 召回的 `evaluated / injected / advisory / rejected` 以及原因分布。

可用以下指标评估效果：

- 有效记忆复用率。
- 过期或跨页面记忆拦截率。
- 记忆写入去重率和纠错成功率。
- 记忆帮助下的任务成功率、Token 消耗和人工接管率。
- 授权继承越界次数，目标始终为 0。

## 10. 启用和验证

租户 Web Runtime 的自动抽取默认关闭，显式启用：

```bash
WEB_BUDDY_AUTOMATIC_MEMORY_ENABLED=true npm run web
```

本地 Legacy SDK 仍使用 AnswerStore、Permission Rules 和 Memdir；只有注入 `automaticMemorySink` 的 Runtime 才会增加模型抽取调用和长期写入。

相关回归命令：

```bash
npm run typecheck
npm run test:automatic-memory
npm run test:m4-b1
npm run test:m4-b2
npm run test:memory-eval
npm run test:runtime-rewrite
```
