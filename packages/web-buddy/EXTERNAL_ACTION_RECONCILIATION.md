# Web Buddy 最高优先级改进：外部副作用对账恢复

日期：2026-08-12

## 结论

当前最值得继续投入、也最适合作为面试主线的改进，不是再增加一层长期记忆或多 Agent，
而是解决一个真实业务故障窗：

> 客户门户已经接收发票，但 Web Buddy 在保存确认号前崩溃。恢复后不能因为本地没有
> `ToolResult` 就再次点击提交，也不能让模型凭页面文案猜测是否成功。

这个问题把 Web Buddy 已有的浏览器执行、审批、Session、恢复、Completion Contract 和
证据系统串成一条业务闭环。它能直接回答面试官最关心的五个问题：

1. 权威状态在哪里？外部业务结果以客户门户为准，本地 Ledger 只记录已知事实。
2. 重试单位是什么？一张发票的稳定业务键，而不是整轮 Agent 对话。
3. 如何防止重复副作用？先落执行边界，恢复时先查询，不能盲目重放。
4. 谁负责恢复？确定性的站点适配器，不是 LLM。
5. 什么时候算完成？每张目标发票都有独立回执，且没有未决动作。

真实门户的下一步落地清单见 [`REAL_PORTAL_ADAPTER_PILOT.md`](REAL_PORTAL_ADAPTER_PILOT.md)。

## 为什么它排第一

| 候选改进 | 业务价值 | 面试区分度 | 当前缺口 | 判断 |
| --- | --- | --- | --- | --- |
| 外部副作用对账恢复 | 高：直接避免重复提交、重复支付或漏单 | 高：能讲状态真相、幂等、故障恢复和验证 | 已有执行与恢复框架，但原先缺少 `in-doubt` 真相 | 第一优先级 |
| 接管已登录 Chrome 并做真实门户适配 | 高：决定 POC 能否进入试用 | 高：能提供真实运行证据 | 需要账号、门户和适配验证 | 第二优先级 |
| 长期记忆继续扩展 | 中：减少重复输入 | 中：容易变成通用 RAG 叙事 | CJK BM25、RRF、冲突策略和场景 Capsule 已有实现 | 暂不扩张 |
| 增加更多 Agent 角色 | 低到中 | 低：如果没有业务失败场景容易显得堆架构 | 当前主写者/只读辅助边界已经足够讲 | 暂不扩张 |

排序原则是：先补会造成真实业务损失的状态缺口，再增强使用体验；已经有可信实现的模块，
不为了面试继续堆概念。

## 能力血缘与个人贡献边界

这条主线建立在现有工程之上，而不是从零重写 Web Buddy。Git 历史可区分三层：

| 能力层 | 已有基线 | 本轮补齐 |
| --- | --- | --- |
| 产品场景 | 发票门户受控 POC、重复/异常隔离、精确提交审批 | 将外部已收单而本地未落确认号变成主故障场景 |
| 执行与治理 | Agent Loop、Permission/Human Gate、Action Ledger | `executing / executed / committed / not_committed / ambiguous` 及审批引用连续性 |
| 持久化与续跑 | durable Session、Continuation、Control RunService | 动作前 fsync、未决动作 restore、query-before-retry、恢复预算和迟到结果 fence |
| 完成与证据 | Completion Contract、Artifact Store、Trace/Eval | 逐业务键终态、immutable receipt 重验、崩溃矩阵与伪终态 fixtures |
| 记忆 | 自动 recall、CJK lexical ranking、RRF、BrowserScenarioCapsule | 本轮没有继续扩张；外部效果真相不交给记忆或 LLM 推断 |

最准确的个人贡献表述不是“从零搭建整个 Runtime”，而是：审计现有 Action Ledger 后发现，
原来的 `performed / not_performed` 投影无法表达第三方已生效、本地未知；随后定义最小状态机，
并把身份绑定、durable journal、确定性对账、回执、Completion 和故障评测贯通成一个闭环。
这既保留已有团队资产的归属，也能明确回答“你具体判断了什么、改了什么、怎样证明”。

## 外部校准：为什么这条主线更像生产面试题

2026-08-12 做了一轮招聘页、浏览器 Agent 工程文章和近 30 天社区讨论校准。它们不能证明
“所有面试官都只问这个”，但提供了六个相互支持的信号：

1. 当前 OpenAI Evals 后端岗位明确要求可靠、可复现、可扩展的评测流水线，持续回归与漂移
   监控、golden dataset，以及 Agent、工具调用、长上下文和分布式后端经验。面试材料因此应
   展示可运行的故障夹具和回归门禁，而不只是架构图。
2. Anthropic 对 Agent eval 的公开定义把 transcript 与 environment outcome 分开：Agent
   说“预订成功”不等于外部系统中真的存在订单。这正对应 Web Buddy 中“点击成功不等于
   发票已入账”的根因。
3. Browserbase 的浏览器 Agent verifier 工作把 outcome verification、过程与结果分离、
   可控与不可控失败分离、false-positive rate 放到核心位置。这说明最有区分度的叙事不是
   “能操作网页”，而是“如何证明操作产生了正确业务结果，并拒绝伪成功”。
4. OpenAI 的 Agent Infrastructure 岗位把研究环境和生产 Agent 平台放在同一职责中，并明确
   强调从 0→1 到大规模运行。对应到这份项目，不应只展示本地 POC，也不应虚构大规模结果；
   要能说清“最小机制已经怎样工作、到真实门户和多租户规模还缺什么”。
5. Anthropic 的可信 Agent 实践把 model、harness、tools、environment 分开，并指出高后果动作
   需要保留 meaningful human control，同时避免逐动作批准造成疲劳。这里的 Runtime 真相状态、
   精确 ActionBinding 和未来正式 BatchApprovalBinding，正好体现模型之外的工程治理。
6. Browserbase 对 Web Agent 基础设施的近期拆解强调：浏览器规模化还需要 session recovery、
   isolation、identity 和足够的 observability。它支持把“恢复和可观测性”放在主线，但也提醒
   当前受控单机 POC 不能冒充 browser fleet 经验。

近 30 天社区检索拿到的高热度内容更集中在 sandbox、浏览器基础设施、安全和产品采用，
“外部副作用对账”没有形成足够集中的直接讨论，所以不把社区热度当作选题依据。这里的排序
主要依赖项目真实缺口、公开招聘要求和一手工程资料，避免把零散帖子包装成行业共识。

外部校准资料：

- [OpenAI Backend Software Engineer (Evals)](https://openai.com/careers/backend-software-engineer-%28evals%29-san-francisco/)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Browserbase: Universal Verifier for browser agents](https://www.browserbase.com/blog/building-verifiers-for-computer-use-agents)
- [OpenAI: Software Engineer, Agent Infrastructure](https://openai.com/careers/software-engineer-agent-infrastructure-san-francisco/)
- [Anthropic: Trustworthy agents in practice](https://www.anthropic.com/research/trustworthy-agents)
- [Browserbase: Build vs. buy agent infrastructure](https://www.browserbase.com/blog/build-vs-buy-agent-infrastructure)
- [Anthropic Careers](https://www.anthropic.com/careers)

## 最佳业务场景

场景沿用 `PRODUCT_POC.md` 的“接手 · 网页代办箱”：供应商财务批量向客户门户提交发票。

正常路径：

1. ERP 导入发票，重复项和金额异常先隔离。
2. Agent 填字段、传附件，并在最终提交前展示金额、目标门户和授权范围。
3. 受控 POC 允许用户一次批准一个明确的四项集合，harness 再把它展开为四个独立的发票
   Action；每个 Action 保留同一个批次 decision ref 和自己的业务键。通用 Runtime 目前仍是
   单 Action ApprovalBinding，正式 BatchApprovalBinding 是后续产品化工作，不能用 POC 代替。
4. 门户逐张返回确认号，Web Buddy 逐项保存回执并判断该发票完成；不能用一个批次成功文案
   覆盖四张发票的终态。

故障路径：

```text
本地持久化 executing
  -> 点击提交
  -> 门户创建发票记录 CSP-884120
  -> 进程崩溃
  -> 本地没有收到 ToolResult/确认号
```

旧语义会把“没有 performed 记录”投影成 `not_performed`。这既可能错误通过“不要提交”的
完成条件，也可能在恢复后触发第二次提交。

## 最小可靠机制

### 1. 把工具成功与业务成功拆开

浏览器点击返回成功，只能说明本地工具执行结束或页面发生变化，不能证明门户已经形成
业务记录。因此状态机拆成：

```text
proposed
  -> authorized
  -> executing       # 调用外部动作前持久化并 fsync
  -> executed        # 工具返回，但业务结果尚未证明
  -> committed       # 独立查询得到确认号/业务记录
```

失败或断连进入 `ambiguous`。权威查询确认没有落单且证明可以安全重试时，才进入
`not_committed`。

### 2. 副作用前写入 Durable Journal

`upload / send / publish / submit / payment` 在调用工具前必须把 `executing` 写入持久化
Session，并执行文件同步。没有 durable Session 时直接拒绝执行。

这个写入不能消除所有不确定性；它的作用是保证恢复者知道“该动作可能已经越过外部边界”，
从而禁止盲目重放。

### 3. 先把网页控制动作映射为业务动作

实际 Agent 往往只调用 `browser_click`，但工具名和 selector 不能说明这个控制是否会“提交发票”、
“发送消息”或只展开一个面板。如果 Runtime 把所有 click 都当外部写，会制造大量误审批；如果
只保护名字里带 `submit` 的专用工具，又会漏掉真实门户按钮。

因此可信站点适配器可在执行前返回严格投影的 `external-action-intent/v1`，把一个尚未被 Runtime
识别的调用升级为 `upload / send / publish / submit / payment` 之一，并同时提供 v2 binding。
升级后的动作不是只改审计标签：Runtime 会用新的 action kind 重新进入 Sink Policy、
ActionBinding、Permission/Human Gate、Action Ledger 和 Probe 检查。若 Runtime 已经推断出敏感
action kind，Adapter 只能返回同一种；任何改类、降级或 contract 顶层扩展都会在工具调用前以
`EXTERNAL_ACTION_CLASSIFICATION_CONFLICT` 或 `EXTERNAL_ACTION_INTENT_INVALID` 失败关闭。

这是一条可信 Adapter 边界，不是 LLM 或通用 DOM 语义分类器。未配置 Adapter 的普通 click 不会
被自动升级；`type_or_paste` 触发的站点自动保存等其他隐式写入也仍需单独建模。错误 Adapter 仍
可能把控件映射到错误业务动作，因此真实接入要用经过人工标注的页面状态与业务真相建立
control-to-business-action golden set，并限制 Adapter 注册、代码评审和发布权限。

接口类型中的 `Readonly` 不是运行时隔离。Runtime 会把工具参数和请求对象 deep-clone 后再
deep-freeze，分别交给 intent 与 binding Resolver；Adapter 尝试原地修改参数会在副作用前失败。
Resolver 返回值也先复制并冻结再参与 origin、effect digest、Policy 和 Ledger 计算，避免异步持有
引用后让“已审批的 payload”和“实际执行的 payload”发生漂移。

在 strict reconciliation 中，“Resolver 没返回”不能等价于“这个 click 没有外部效果”。每个
opaque `browser_click / browser_click_text` 必须由受控站点 Adapter 明确返回外部 action+binding，
或闭集结构的 `non_external` attestation；缺少结论在工具前报
`EXTERNAL_ACTION_INTENT_REQUIRED`。若 Runtime 已识别为敏感动作，Adapter 返回 non_external 同样
触发分类冲突。non_external 仍是可信 Adapter 的业务判断，真实接入必须用提交、弹窗、草稿、
取消、同文案不同页面等 golden cases 验证；当前 strict 不自动覆盖输入触发 autosave 等非 click
隐式写入。

### 4. 在动作前绑定稳定业务键

站点适配器在执行前生成候选业务键，Runtime 持久化 `external-action-binding/v2`：

```json
{
  "schemaVersion": "external-action-binding/v2",
  "businessKey": "portal:huadong-fssc:invoice:INV-CN-260601",
  "probeId": "invoice-receipt-query/v1",
  "effectDigest": "<sha256(actionKind + canonicalEffect + destinationOrigin)>"
}
```

业务键随 Action Ledger 一起持久化。它必须包含门户/租户作用域，不能只用可能跨客户重复的
发票号。`effectDigest` 由 Runtime 对站点适配器给出的 canonical effect descriptor 做规范化和
哈希，不信任 Resolver 自报 digest；descriptor 只进哈希、不以明文进入 Ledger。它应包含金额、
附件 hash/版本等真实业务字段，因为通用 `browser_click` 的 selector 无法表达这些语义。
站点 Resolver 还可显式给出规范化的实际 sink origin（不一定等于当前页面 origin），Runtime
验证后同时用于 effect digest、Sink Policy 和审批 ActionBinding。若 Resolver 未提供，才回退到
工具可解析目标或当前页面 origin。若金额、附件版本、目标站点等
发生变化却复用旧业务键，Runtime
报 `EXTERNAL_ACTION_KEY_COLLISION` 并在副作用前失败关闭，不能拿旧确认号冒充新请求成功。
恢复后不需要让模型从对话中猜发票号，也不依赖已经丢失的局部变量。

descriptor 明文不进入 Ledger，但审批不能只给人看一个哈希。Runtime 会从同一冻结的 effect
payload 生成最长 1024 字符的脱敏 canonical JSON，写入 `ActionBinding.externalEffectPreview`；
同时把 Adapter 判定的业务 action kind 作为 `externalActionKind` 写入绑定，使审批展示 `submit`
而不是底层 `browser_click`。ActionBinding 摘要因此同时保护展示内容、语义分类和实际动作。
preview 含 secret、发生脱敏或无法完整展示
时，不向用户提供 `approve_and_execute`，只保留知晓、拒绝或接管。控制台与 owner API 都投影
该 preview；哈希负责机器一致性，preview 负责人类可理解性。

业务键的语义唯一域覆盖全部可对账外部动作，不按 `actionKind` 再分命名空间。`actionKind` 本身已
进入 effect digest；同一 durable Session/恢复链里，若同一发票从 `send` 漂移成 `submit`，它会
表现为同键不同效果碰撞，而不是获得第二次执行机会。在线 Ledger、Agent Loop 历史查询和
restore 都执行这条 Session 内查重。新建 Run 没有共享这份 Ledger，所以可信服务端 Adapter 还会
在每个新动作审批前执行权威 preflight；它能发现另一个已完成 Run 或人工流程留下的同一效果并
零点击收敛，但不等于跨 Run 的原子全局锁。真正包含“上传附件”和“提交发票”两个独立业务效果
的流程，应使用带 step/version 语义的两个业务键，并让 Completion 分别要求它们。

专用工具的参数本身已经是稳定业务载荷时，可以用工具参数作为保守 fallback；对于通用 click，
真实站点接入必须提供 canonical effect descriptor，否则只能证明“同一个点击请求”，不能声称
已经覆盖金额或附件变化。这也是可信站点适配器的一部分，而不是 LLM 能自动推断的属性。

这是显式的 v2 升级，不会悄悄改写 v1 语义。历史 v1 绑定仍可恢复并用 Probe 对账，但因为
没有效果指纹，模型提出同键新动作时会报 `EXTERNAL_ACTION_LEGACY_BINDING_REQUIRES_REVIEW`，
转人工确认/迁移；不能把旧记录自动当成新 payload 的授权或成功证据。

### 5. 用独立 Probe 对账

`ExternalActionProbe` 是可信站点适配器。它按业务键读取门户回执、业务记录或权威查询页，
返回三态结果：

- `committed`：有独立证据和外部引用，例如确认号。
- `not_committed`：没有落单，并且适配器明确证明 `retrySafe=true`。
- `ambiguous`：超时、查询不可用、最终一致窗口未结束或证据不足。

模型文本、刚才的点击结果、普通页面发生变化都不能单独生成终态。
对 v2 动作，`committed` 还必须带站点适配器根据门户回读字段重算的
`observedEffectDigest`，并与授权时的 effect digest 完全一致；同发票号但金额、服务期间或
附件版本不一致会被 Runtime 拒绝。
调用方即使显式提供 Probe business key，也不能覆盖 Action Ledger 中的 durable binding；两者
不相等会在 Probe 调用前拒绝，避免查询 B 的回执却提交 A 的本地 Action。
Probe 必须声明并通过 `external-action-probe/v1 + authority=read_only` 契约校验；重复 `probeId`
也会失败关闭。Runtime 在副作用发生前验证相关 Probe，避免把一个能写页面的工具误注册成
恢复查询。它还受每动作默认 10 秒、整次启动默认 30 秒的双层预算约束；超时保持
`ambiguous`，不会被解释为“未提交”。SDK 完成启动对账后会显式通知 Agent Loop，后者不会
立刻对同一批 `ambiguous` 动作做一次无退避重复查询。
为避免大批量中固定前几项每次吃完预算，Ledger 每次新追加的 `ambiguous` 会在下一轮未决队列
中移到末尾，未被本轮触达的 Action 先查询；这是基于 durable 顺序的轮转公平性，不需要并发
修改同一 Session 日志。
这里的声明是可信适配器边界，不是对任意代码的沙箱证明；生产 Probe 还应使用只读账号、
只读 API/浏览器能力和单独的适配器测试，避免实现违背声明。

#### 新动作的权威 preflight

可信 Web Control Service Adapter 默认在审批和副作用工具之前查询一次同一 v2 binding：

Runtime 先 durable 记录 Sink Policy；只有策略未 block 才 fsync `proposed`、执行查询，并把 verdict
作为 durable `external_action_preflight` 事件写在 Approval 前。Probe 虽声明只读，也不能先访问
被 destination/data policy 拒绝的外部状态。策略 block 只留 Policy 审计，不制造一个恢复器会
误认成“可查询”的 proposal。若进程只写完 proposed 就崩溃，启动恢复会在模型前接管该动作；
查询结果不依赖一次易丢的函数调用。当前正向夹具直接断言持久化顺序为
`policy:gated -> proposed -> preflight:not_committed -> approval_requested`。

- `committed`：把本 Run 的 `proposed -> committed` 和独立 receipt 持久化；不创建 Approval，
  不调用写工具，也不伪造本 Run 已获执行授权。公开 `ActionOutcome` 会标
  `localExecutionAttempted=false`。外部事实命中后仍重新运行当前 Completion Gate：只有精确
  Contract 业务键和 receipt 均满足才完成；查到 A 的真实回执而当前 Contract 要求 B 时，动作
  保持 no-op，但任务完成被拒绝。
- `not_committed + retrySafe=true`：只表示可以继续进入本 Run 的新审批，不能复用旧决定。
- `ambiguous`、超时或非法 verdict：持久化 `proposed -> ambiguous`，在审批前失败关闭。

这样可抑制“第一个任务已完成，用户又新开第二个任务”的顺序重复。它仍有 query-to-write 竞态：
两个并发新 Run 可能都先看到 absent。真实写试点必须额外证明同键不存在并发 writer，使用一个
owner-scoped 共享 claim/CAS Store，或把同一业务幂等键传给下游；否则只能开放单 writer。当前
Runtime 没有把本地 preflight 宣称为跨 Run exactly-once。

这也适用于同一 Session 中从 `not_committed/denied/skipped` 重新提议的新 Action：每个新 attempt
都重新 preflight，不能拿上一轮“当时不存在”的结论直接进入审批。受控负例在旧查询后注入外部
补单，新 attempt 再查到 committed，Approval 与写调用保持 0。

`Readonly` 类型也不能阻止 JavaScript 实现在运行时修改对象。Probe 收到的是当前 Ledger Action
的 deep-frozen 副本和冻结的 request envelope；它不能篡改 expected business key、effect digest
或时间后再提交一份自洽 verdict。该冻结只保护 Runtime 内验证输入，无法约束 Probe 进程使用的
外部门户凭证，后者仍必须在能力层面只读。Probe ID 还会在进入异步查询前固定；verdict 校验不
会在 `await` 之后重新相信可变的 `probe.id`，防止 verifier identity 的 TOCTOU。Probe 返回值也
先物化为 detached、deep-frozen 数据快照，再执行字段与终态校验；同一个 getter/对象不能在
一次验证的不同读取之间改变 `state` 或 effect。verdict 字段也是闭集，携带
`writeAuthority` 等未声明扩展会在终态前拒绝，不会静默投影后继续。

### 6. 让 Completion Gate 保持保守

| Ledger 最新状态 | Completion ActionOutcome | 是否能证明已执行 | 是否能证明未执行 |
| --- | --- | --- | --- |
| `committed` | `performed` | 是 | 否 |
| `not_committed` | `not_performed` | 否 | 是 |
| `authorized / executing / executed / failed / ambiguous` | `indeterminate` | 否 | 否 |

因此未决动作既不能让“必须提交”通过，也不能让“禁止提交”通过。它必须先对账或转人工。

兼容模式允许第一次未适配的外部动作先得到 durable `executing/executed` 日志，但因为没有稳定
business key/Probe，它只能保持 indeterminate，不能事后由调用者补一个身份冒充原始绑定。生产
试点应开启 `requireExternalActionReconciliation`：新外部动作没有 binding 时在工具前拒绝；启动
恢复若发现历史 unbound 外部动作，也在模型继续前失败关闭。严格模式不是任意网站自动适配，
而是把“缺适配能力”从事后人工事故变成事前可见拒绝。

真实服务端不是通过公共 npm `runWebTask()` 接收任意 callbacks。公共入口刻意不暴露 Runtime
driver、恢复 authority 和文件路径；敏感 Adapter 当前由 Web Control Service 的可信 per-run
factory 安装。Factory 收到冻结的 runId 与 ownerScope，用闭包创建 tenant-scoped Resolver/Probe；
返回对象做闭集/类型校验，安装后默认 strict，并且不能与整套 `webTaskRuntimeDriver` 测试 seam
同时配置。外部回执离开 SDK 时也补同一 ownerScope，才能通过 Control Service 的 Artifact 租户
门禁。该设计支持内部/受控试点，不等于已经发布第三方公共插件 ABI。

批量任务的 Contract 还要列出期望业务键，避免“4 张发票中只成功 1 张”被任意一个
`performed` 误判为整批完成：

```json
{
  "kind": "action_boundary",
  "actionKinds": ["submit"],
  "outcome": "performed",
  "businessKeys": [
    "portal:huadong-fssc:invoice:A",
    "portal:huadong-fssc:invoice:B",
    "portal:huadong-fssc:invoice:C",
    "portal:huadong-fssc:invoice:D"
  ]
}
```

Runtime 按业务键合并同一发票的多次尝试，并逐键要求终态。Contract 还应同时要求对应数量
的确认号 Artifact，并用同一组 `businessKeys` 逐项匹配 Artifact binding；不能让四份无关回执
只靠 `minCount=4` 冒充目标四张发票的证据。

## 恢复责任与重试边界

### 真相状态

- 外部效果真相：客户门户的业务记录或回执。
- 本地知识状态：Action Ledger。
- 对话和模型结论：只能作为候选线索，不是终态证据。

### 重试单位

一张发票对应一个稳定业务键。批量任务中某张发票未决时，只对账这一张；已经有确认号的
发票不能随整批任务重放。

### 恢复所有者

Runtime 发现未决 Action；与 `probeId` 匹配的站点适配器负责查询；Completion Contract
决定任务能否结束。LLM 只负责解释和选择下一步，不负责宣布外部状态。

新恢复 attempt 的创建权由 Control RunService 的 `recordRevision + runRevision + attempt` CAS
决定：两个恢复命令竞争同一个旧 epoch 时只允许一个成功，另一个按 stale/revision conflict
拒绝。同一 Web Server 还会拒绝在 live execution 存在时恢复，并拒收旧 attempt 的晚到结果。

但这三点不等于外部写入 single-writer：若旧 worker 在另一个进程成为 zombie，第三方网页不会
识别本地 epoch，它仍可能在新 attempt 查询“尚不存在”之后完成旧请求。Session 是事实日志，
CAS 是控制命令 fence，都不是下游 fencing token。生产恢复写入前还要确认旧沙箱/浏览器已终止
或执行租约已经安全失效；最强路径仍是向下游传稳定幂等键。无法排除 zombie 且下游不幂等时，
恢复只能查询并保持 `ambiguous`，不能自动写。

### 安全重试规则

1. 下游支持幂等键：使用同一业务键重试，并保存下游返回。
2. 下游不支持幂等但支持权威查询：先查询；只有 `not_committed + retrySafe` 才允许再次进入
   审批。旧审批只授权旧 attempt，Runtime 不会把它复用给新副作用。
3. 查询最终一致：等待适配器定义的稳定窗口；在窗口内保持 `ambiguous`。
4. 下游既不幂等也不可查询：失败关闭，转人工核对，不能宣称 exactly-once。
5. 同业务键的 `effectDigest` 变化：视为键设计错误或新业务版本，失败关闭；必须生成新的
   语义业务键并重新审批。

### 已对账外部副作用的授权语义

`approve` 继续表示普通敏感动作授权；一旦动作带有 v2 外部业务绑定，它只表示用户已知晓并停手。
机器执行 `upload/send/publish/submit/payment` 中任何已对账副作用，都必须使用独立
`approve_and_execute`，对应 `approval-binding/v2`。它只在以下条件
全部成立时进入请求的 `allowedDecisions`：可信 Host 显式开启独立的
`allowExternalActionExecution`（submit/payment 还需 Host 的
`allowFinalSubmitExecution`）、strict reconciliation、fresh-run authoritative preflight、durable
Session、绑定当前 run/attempt 的 exact SessionRef、v2 external binding、exact ActionBinding、
已注册 Probe，且 effect preview 已脱敏并能
完整展示。owner-scoped Web Control Service 还要求未来 v3 owner binding；当前不会开放该决定。

开关只允许“向用户提供这个决定”，不会自动产生授权。ApprovalQueue、durable Store 和 owner API
都会拒绝请求未列出的决定；Sink Policy 还会验证 action/effect/origin 摘要、有效期和一次性
nonce。因此旧 v1 approve、隐藏 flag 或一个恶意 Gate 返回值都不能单独越过外部副作用边界。
队列也不接受裸 `approved/denied` 代替人类语义决定，并拒绝状态与决定不一致的记录，避免
审计日志出现“看似批准、却无法证明用户究竟批准了什么”的伪终态。

审批持久化与 live Agent Loop 唤醒之间仍是两个步骤。若进程在两者之间重启，启动恢复不会把
durable `approved_and_execute` 直接重放成外部动作：正常 pending approval 继续等待；已经终态、
但无法证明已交付的 approval 会保留审计记录，旧 attempt 失败关闭并清空 pending 引用。操作者
需要先对账外部状态，再在新 run 中获取新审批。当前没有实现跨 attempt 的 Approval Delivery
Receipt，因此这条路径追求 fail-closed，而不是无感继续。
同进程无法交付时还会 abort 残留 controller；异步 settler 晚到时以已持久化 terminal 为准，
不允许同一 epoch 再执行 `failed -> cancelled/completed` 的第二次终态迁移。

## 已实现的代码锚点

- `src/task/action-ledger.ts`
  - 新增 `executing / executed / committed / not_committed / ambiguous`。
  - `indeterminate` 不再被错误投影为 `not_performed`。
  - 持久化稳定业务键、Runtime 效果指纹与 Probe 绑定；恢复历史中的指纹变化会被拒绝。
  - `authorized` 之后携带 `action-decision-ref/v1`；审批/策略引用与 ActionBinding 摘要
    必须在后续状态中保持不变，恢复时拒绝被替换的授权历史。
  - 带 external binding 的动作禁止进入旧版 `performed` 终态；在线调用和历史 restore 都要求
    外部成功只能表示为带 verdict/receipt 的 `committed`，避免兼容路径绕过对账。
- `src/task/contracts.ts` + `src/security/sink-policy.ts`
  - `approval-binding/v2` 表示独立执行决定；带 v2 reconciliation binding 的所有外部动作都不消费
    v1 awareness approval。
  - exact ActionBinding、有效期和 nonce 仍在 Sink 边界一次性消费。
- `src/permission/approval-queue.ts` + `src/control/durable-human-gate.ts` + `src/web/server.ts`
  - 内存、durable Store 与 owner API 都校验 `allowedDecisions`；知晓和执行在 UI/事件中保留不同语义。
  - Agent Loop 生成的 ActionBinding 带当前 SessionRef；Durable Gate 再交叉校验 TaskContract、
    run/session attempt 和 PermissionRequest 中的 binding digest，拒绝跨模块错绑。
- `src/control/recovery-service.ts`
  - 启动时保留真正 pending 的人工等待；若终态审批尚未证明交付给 live loop，则不重放动作，
    失败关闭旧 attempt，并保留 v2 决定用于审计。
- `src/workflow/workflow-engine.ts` + `src/workflow/workflow-transition.ts`
  - `approve_and_execute` 本身不解除 final-submit handoff；只有 Contract 中精确 submit/payment
    业务键的 performed 边界与对应 receipt Artifact 都通过，Workflow 才回到可完成状态。
- `src/task/completion-contract.ts`
  - 批量 Action Boundary 可按 `businessKeys` 逐项验证，不能用单个成功覆盖未决项。
- `src/task/action-reconciliation.ts`
  - `ExternalActionIntentResolver` 将受控站点中的 opaque browser call 升级为外部业务动作；严格
    schema 与分类冲突检查禁止 Adapter 改写 Runtime 已有敏感分类。
  - 独立 Probe 协议、绑定校验、证据校验和三态收敛。
  - Probe 必须声明 `read_only` 权限；重复 ID 或可写权限在调用前被拒绝。
  - Probe request 与嵌套 Action 是 deep-frozen Ledger 副本，拒绝验证器改写自己的 expected value。
  - `not_committed` 必须显式证明 `retrySafe=true`。
- `src/task/action-reconciliation-artifact.ts`
  - `persistExternalActionReconciliationAttempt` 是 Agent Loop 与 SDK 共用的唯一
    receipt-first/event-second 编排点，避免两个入口各自手写顺序后漂移。
  - `committed` verdict 先通过 `writeDurably` 写入 `external-action-receipt/v1` immutable
    Artifact；文件与逐级父目录项完成 durability barrier 后，才把 ArtifactRef、内部存储引用与
    终态放进同一条 durable event。不提供 durable write 能力的自定义 Store 会失败关闭。
  - 写入后在当前进程立即从 Store 重读并做 hash + 语义绑定校验，验证通过才返回 Artifact；因此
    persistence sanitizer 或自定义 Store 改坏 business key/effect 时，不能等到下次 restore 才发现，
    更不能在本轮先进入 Completion。
  - 恢复时要求每个带外部绑定的 `committed` event 都必须同时带匹配的 reconciliation verdict、
    ArtifactRef 和内部存储引用，再重新读取底层文件，校验路径边界、引用一致性、SHA-256 与
    Action/业务键/Probe/effect 语义绑定；event verdict 的 external reference、observedAt、evidence
    IDs、summary 和 effect 还必须与实体内容逐字段一致。文件缺失、回执字段被删、任一侧被替换或
    内容不匹配都会失败关闭。
  - 恢复时 `observedAt` 以 terminal event 之前的最后一条 unresolved Action 状态为时间下界，
    而不是以 `committed` event 为下界：门户观察先发生、本地终态后落盘才是正常顺序；同时保留
    canonical timestamp 与 bounded future-skew，避免为了修正顺序而接受陈旧或未来回执。
  - Completion Contract 因此可以同时要求逐业务键 `performed` 和足量回执 Artifact。
- `src/session/transcript.ts`、`src/session/session-store.ts`
  - 为关键 Action Event 增加 append + fsync 路径。
  - 同一 Node 进程内对相同 Session/stream 的普通与 durable append 共用串行尾队列；即使先调用
    writer 的元数据读取更慢，JSONL 仍按调用顺序落盘。队列在模块级共享，覆盖指向同一 root 的
    多个 `FileSessionStore` 实例，但不冒充跨进程锁或执行租约。
  - JSONL 任一非空行无法解析时抛出带路径和行号的 `SESSION_JSONL_CORRUPT`，恢复失败关闭；当前
    不自动截断半条尾记录，因为没有跨进程 writer lease 时，读侧修复可能覆盖并发追加。
  - `runId / sessionId` 在 Contract、Trace、Session 与 Artifact 写入边界都必须是 canonical 单一
    路径组件；Session restore 还重验 `session.json` 中 output/transcript/events/workflow 路径必须
    精确绑定当前 root，拒绝目录穿越和被替换的绝对路径。
- `src/runtime/local/agent-loop.ts`
  - 外部副作用前持久化 `executing`。
  - 工具成功先进入 `executed`，随后才由 Probe 收敛。
  - 恢复后的未决动作在模型继续操作前优先对账。
  - 模型再次提出同业务键时，已确认动作直接返回 no-op，未决动作失败关闭，工具不会重放。
  - `not_committed + retrySafe` 只开放新 attempt；新 attempt 必须再次经过 Human Gate。
  - 同业务键但 canonical effect/origin 指纹变化时在工具调用前报
    `EXTERNAL_ACTION_KEY_COLLISION`；通用 click 由站点 Resolver 提供业务字段，避免只 hash selector。
  - Permission 的 `ActionBinding` 同时覆盖 business key、semantic action kind、effect digest、
    Probe ID 和可审阅的 effect preview；Human Gate 与 owner API 展示业务动作、业务键、canonical
    effect 和 digest，批准后写入
    Ledger 的 decision ref 不能脱离该精确效果。
  - intent 与 binding Resolver 只能读取 deep-frozen 参数快照；返回值也在使用前复制并冻结，
    防止 Adapter 通过对象引用制造 policy/tool payload 的 TOCTOU。
  - Probe 超时会触发 AbortSignal；即使底层查询忽略取消，迟到 verdict 也会被 fencing 拒绝，
    不能在内存里把已持久化的 `ambiguous` 偷改成 `committed`。
  - 启动对账同时受 per-action 与 whole-recovery budget 约束；SDK/Agent Loop 的启动阶段不会
    对同一批未决动作重复执行。
  - 缺业务绑定、缺 Probe 或整次预算耗尽时写结构化
    `external_action_reconciliation_skipped` Trace，保留 action/business/probe 与剩余数量，
    避免“失败关闭”变成不可观测的静默卡住。
  - strict reconciliation 模式下，缺 binding 的新动作在工具前拒绝；历史 unbound 未决动作在
    Agent Loop 启动、模型继续前拒绝。默认兼容模式只保证记录未决，不保证自动收敛。
  - strict 模式对 opaque click 要求显式外部或 non_external 意图；空分类不再被当作安全。
  - 如果 Resolver 返回了绑定，但对应 `probeId` 没有注册，副作用前直接报
    `EXTERNAL_ACTION_PROBE_REQUIRED`。
  - Probe 的结构化 verdict 与终态 Ledger entry 写入同一条 durable event，保留 verifier、
    evidence IDs 和 external reference，不依赖解析 reason 文本。
- `src/session/session-restore.ts`
  - 恢复时显式返回 `unresolvedActions`。
- `src/sdk/web-task.ts`
  - Generic Runtime 恢复时从当前磁盘 Session 重建 Ledger，不信任调用方可能过期的
    `restoredSession` 快照。
  - 确定性外部对账在检查模型 Key 之前运行；即使 LLM 暂时不可用，也能先收敛外部真相。
  - 恢复回执在 SDK 出口绑定运行 ownerScope 与 SessionRef，满足服务端多租户 Artifact 门禁。
- `src/web/server.ts`
  - 提供可信 per-run external-action Adapter factory；输入 run/owner scope 冻结，返回集合闭集校验，
    默认 strict，并与整套 Runtime driver seam 互斥。该入口不从公共 npm 根导出。

## 故障注入与指标身份证

### 当前确定性测试事实

这些是本地固定夹具结果，不是生产指标：

| 测试 | 分子 / 分母 | 当前结果 |
| --- | --- | --- |
| 外部已提交、确认号写回前崩溃后自动收敛 | 成功收敛的注入案例 / 此类注入案例 | 1 / 1 |
| 恢复导致重复提交 | 重复副作用次数 / 此类注入案例 | 0 / 1 |
| 无 durable journal 的外部动作 | 被拒绝执行的案例 / 无 journal 案例 | 1 / 1 |
| 无独立证据的伪成功 | 被拒绝的伪终态 / 伪终态案例 | 1 / 1 |
| 最终一致空查询但不可安全重试 | 被拒绝的 `not_committed` / 不安全空查询案例 | 1 / 1 |
| 恢复后模型再次提出同一业务动作 | 被 Runtime 拦截的重放 / 已确认动作重放案例 | 1 / 1 |
| 批量任务存在未决发票 | 被 Completion Gate 拒绝的部分完成 / 部分完成案例 | 1 / 1 |
| Probe 超时 | 保持 `ambiguous` 的超时案例 / Probe 超时案例 | 1 / 1 |
| Probe 超时后迟到 `committed` | 仍保持 `ambiguous` 的案例 / 迟到终态案例 | 1 / 1 |
| SDK 已完成启动对账 | Agent Loop 未重复调用 Probe / 已尝试的 ambiguous 动作 | 1 / 1 |
| 整次恢复预算 | 被剩余预算裁剪或停止的新 Probe / 预算边界案例 | 2 / 2 |
| 完整崩溃矩阵 | 符合外部真相且恢复零写入的边界 / 注入边界 | 7 / 7 |
| 受控发票门户批量恢复 | 找回独立确认号的发票 / 批次目标发票 | 4 / 4 |
| 受控门户 immutable 回执 | 生成并通过 Completion 的回执 Artifact / 已确认发票 | 4 / 4 |
| 数量足够但业务键无关的回执 | 被 Completion 拒绝的批次 / 无关回执批次 | 1 / 1 |
| 受控门户恢复新增重复记录 | 恢复阶段新增门户记录 / 恢复前门户记录 | 0 / 4 |
| 绑定了未注册 Probe 的动作 | 副作用前被拒绝的动作 / 缺失 Probe 的绑定动作 | 1 / 1 |
| 注册了可写权限 Probe 的动作 | Probe 与副作用都未运行的案例 / 非只读 Probe 案例 | 1 / 1 |
| `not_committed` 后安全重试 | 重新请求审批的重试 / 被证明可安全重试的动作 | 1 / 1 |
| 重试误用旧审批 | 获得新 approval id 的重试 / 安全重试案例 | 1 / 1 |
| Ledger 中审批引用被替换 | 被拒绝的恢复日志 / 授权引用篡改日志 | 1 / 1 |
| 同业务键但参数指纹变化 | 副作用前拒绝的碰撞 / 效果指纹碰撞案例 | 1 / 1 |
| v1 绑定恢复与新动作隔离 | 成功只读对账 / v1 未决历史；被拒绝自动重放 / v1 新动作 | 1 / 1；1 / 1 |
| durable 回执文件被篡改 | 恢复前拒绝的回执 / 篡改回执案例 | 1 / 1 |
| durable receipt 写入失败 | 被调用的 terminal event callback / receipt 故障注入 | 0 / 1 |
| terminal event append 前失败 | 恢复后仍为未决 / pre-append 故障注入 | 1 / 1（receipt 为 orphan） |
| terminal event fsync 后 ACK 丢失 | 从 journal 恢复 committed / post-fsync 故障注入 | 1 / 1 |
| 同进程 append 元数据读取乱序 | 仍按调用顺序落盘的事件 / 延迟注入事件 | 2 / 2 |
| Session JSONL 半条尾记录 | 被恢复拒绝的损坏日志 / partial-tail 注入 | 1 / 1 |
| 非安全 run/session 存储身份 | 被拒绝的读写尝试 / 路径身份注入 | 12 / 12 |
| Session 元数据路径被替换 | 被拒绝的加载 / forged path 案例 | 1 / 1 |
| 外部动作误用 legacy `performed` | 被拒绝的绕过 / 在线调用与恢复注入 | 2 / 2 |
| opaque click 业务意图升级 | 进入完整 durable external-action 路径 / 受控升级案例 | 1 / 1 |
| Runtime 与 Adapter 分类冲突 | 工具前被拒绝的调用 / 分类冲突案例 | 1 / 1 |
| Adapter 修改 Runtime 请求参数 | 工具前被拒绝的改写 / intent 与 binding 改写注入 | 2 / 2 |
| 跨 action kind 复用业务键 | 被拒绝的复用 / 在线 Ledger、restore、Agent Loop 注入 | 3 / 3 |
| Probe 改写验证输入 | 终态前被拒绝的修改 / request envelope 与嵌套 Action 注入 | 2 / 2 |
| Probe 在异步查询中修改 verifier ID | 被拒绝的终态 / 身份 TOCTOU 注入 | 1 / 1 |
| Probe verdict 使用可变 accessor | 单次物化且稳定校验 / accessor 注入 | 1 / 1 |
| Probe verdict 未知权限字段 | 终态前被拒绝 / `writeAuthority` 扩展注入 | 1 / 1 |
| 调用者覆盖 durable business key | Probe 前被拒绝的查询 / 错键注入 | 1 / 1 |
| strict reconciliation 缺 binding | 工具或模型前被拒绝 / 新动作与历史恢复注入 | 2 / 2 |
| strict opaque click 分类 | 无结论拒绝、明确 non_external 可执行 / 分类案例 | 2 / 2 |
| 低风险 click 的有效风险升级 | 外部 send 进入 L3、payment 进入 L4/critical / 受控升级案例 | 2 / 2 |
| Generic SDK strict 恢复 | 模型前拒绝 / unbound 与缺 Probe 历史 | 2 / 2 |
| 服务端 Adapter factory 边界 | owner scope 冻结、未知字段拒绝、driver 互斥 / 契约项 | 3 / 3 |
| 恢复回执 owner scope | 与运行租户匹配的回执 / Generic 恢复案例 | 1 / 1 |
| Completion 回执 ID/业务键唯一性 | 被拒绝的重复 Artifact ID / 改绑另一业务键注入 | 1 / 1 |
| 单动作机器执行授权 | v2 决定落盘并走完 committed / 受控 invoice submit + payment 案例 | 2 / 2 |
| 非 final-submit 外部效果授权 | send awareness 写调用、send 显式执行 committed / 两个案例 | 0 / 1、1 / 1 |
| 通用 Runtime 发票对齐 | 确认号和 receipt Artifact 均生成 / 单张发票 submit 案例 | 1 / 1 |
| 新 Run 顺序重复抑制 | Approval、写工具调用 / 已存在同业务键的 fresh Run | 0 / 1、0 / 1 |
| 新动作 preflight 未知 | Approval、写工具、伪回执 / ambiguous 案例 | 0 / 1、0 / 1、0 / 1 |
| 同轮首个写后对账未决 | 后续写调用 / 剩余外部动作 | 0 / 1 |
| strict 重启对账后仍未决 | 模型调用、写调用 / ambiguous 恢复案例 | 0 / 1、0 / 1 |
| 未开启 authoritative preflight | 机器执行选项、写工具 / 受控 send 案例 | 0 / 1、0 / 1 |
| 非 durable Session | Probe、Approval、写工具 / 注入案例 | 0 / 1、0 / 1、0 / 1 |
| durable 但缺当前 run/attempt SessionRef | 机器执行选项、写工具 / 注入案例 | 0 / 1、0 / 1 |
| 完成来源区分 | fresh Run 外部观察的 `localExecutionAttempted` / 已存在同键案例 | `false` / 1 |
| Policy 先于 preflight | Probe、Approval、写工具调用 / Sink Policy deny 案例 | 0 / 1、0 / 1、0 / 1 |
| 缺少 TaskPolicy 失败关闭 | Probe、Approval、写工具调用 / 无策略案例 | 0 / 1、0 / 1、0 / 1 |
| Policy fsync 后、proposal 前崩溃 | 遗留 proposal、Probe、写工具调用 / 注入案例 | 0 / 1、0 / 1、0 / 1 |
| 机器提交危险配置 | 被拒绝的 strict 关闭、preflight 关闭、final/general 缺 v3 owner binding / 注入配置 | 4 / 4 |
| retry attempt 重新 preflight | Approval、写工具调用 / 旧 absence 后外部补单案例 | 0 / 1、0 / 1 |
| 真回执但 Contract 目标错配 | Completion 接受 / 已存在 A、要求 B 的案例 | 0 / 1 |
| off-contract 最终提交 | 机器执行选项、写工具调用 / 未存在 A、要求 B 的案例 | 0 / 1、0 / 1 |
| 不可完整审阅的 effect | 机器执行选项 / secret 与超长 preview 案例 | 0 / 2 |
| 跨语义重用审批 | 被 Sink 接受 / `type_or_paste` binding 冒充 `submit` 案例 | 0 / 1 |
| WebTask 输入快照 TOCTOU | 不受调用方后续修改影响的 goal/Contract/Context 字段 / 注入字段 | 3 / 3 |
| 同轮多个副作用串行化 | 符合 `preflight -> tool -> reconcile` / 两个动作 | 2 / 2 |
| Workflow 收口 | 业务键 + receipt 满足后解除 handoff / 单张发票案例 | 1 / 1 |
| 决定不是完成证据 | 只有 `approve_and_execute` 时仍保持 final-submit boundary / 负例 | 0 / 1 误解除 |
| 部分批次不误完成 | 1 个 committed key 未解除 2-key Contract / 受控负例 | 0 / 1 误解除 |
| 同 epoch 终态竞争 | late runtime 覆盖 durable control terminal / 注入案例 | 0 / 1 |
| 旧 approve 不能执行已对账外部效果 | send/submit 知晓未执行、v1 binding 未通过 Sink / 负例 | 3 / 3 |
| 未提供的执行决定 | 内存 Queue、Agent Loop、owner API 均拒绝 / 越权注入 | 3 / 3 |
| Durable Gate handoff 错绑 | 被拒绝的外部 contract、外部 run envelope / 注入案例 | 2 / 2 |
| Control owner/artifact/session/checkpoint 错绑 | 被拒绝的 record/snapshot 分叉、未知 scope 字段、跨租户 Artifact、Artifact 错 session/attempt、安全边界错 session/checkpoint / 注入案例 | 7 / 7 |
| Control 持久化 schema 关闭 | 被拒绝的 Run、Session、Resource kind、安全边界、Approval/Event/Binding 扩展字段与路径型 Session ID / 注入案例 | 8 / 8 |
| Approval Store epoch 错绑 | 被拒绝的 event/record、ActionBinding/session attempt 分叉 / 注入案例 | 2 / 2 |
| ApprovalBinding 消费失败关闭 | 被拒绝的非法 expiry、未来 issuedAt、逆序时间窗、隐藏授权字段、空 approvalId / 注入案例 | 5 / 5 |
| Completion 时间有效性失败关闭 | 未被接受的非法/空 Evidence expiry、过期 freshness、未来 Artifact、非法/空/过期 retention / 注入案例 | 7 / 7 |
| EvidenceRef 契约闭合 | 被拒绝的隐藏 completion authority、未知 authority、非法/空 expiry、无 exact ActionBinding 的 Approval evidence / 注入案例 | 5 / 5 |
| Context 时间/墓碑失败关闭 | 被拒绝或失去资格的非法 expiry、未来 capturedAt、空值 tombstone / 注入案例 | 4 / 4 |
| ActionLedger 恢复日志闭合 | 被拒绝的隐藏字段、非 canonical/倒退时间、非字符串 actionId / 注入案例 | 4 / 4 |
| ActionLedger 墙钟回拨 | 保持非递减且可恢复的写入序列 / 回拨夹具 | 1 / 1 |
| receipt verdict 恢复校验同强度 | 被拒绝的隐藏字段、非 canonical/早于动作时间、重复 evidence、committed retrySafe / 注入案例 | 5 / 5 |
| SDK 响应资源错绑/乱序 | 被拒绝的 envelope 错 runId/approvalId、同租户 Approval 列表错 run、Artifact 内层错 runId/owner/隐藏字段、Event 内层错 runId/字段/时间/snapshot session，以及重复 sequence/倒退时间 / transport 注入 | 12 / 12 |
| durable receipt 写后语义被改变 | 被阻止的 terminal callback / altered-receipt 注入 | 1 / 1（callback 0 次） |
| event verdict 确认号与 receipt 不一致 | 被拒绝的物理验证 / 单侧 verdict 篡改 | 1 / 1 |
| 伪终态 golden fixtures | 被接受的伪终态 / 伪终态夹具 | 0 / 6 |
| 回读字段与授权效果不一致 | 被拒绝的 committed verdict / 错误 effect digest 案例 | 1 / 1 |
| 早于最新 durable 状态的回执 | 被拒绝的 stale verdict / stale verdict | 1 / 1 |
| 恢复日志中业务键被篡改 | 被拒绝的恢复日志 / 身份变化日志 | 1 / 1 |
| 调用方恢复快照落后于 durable Session | 从当前 Session 找回并对账的动作 / stale-snapshot 动作 | 1 / 1 |
| 无模型 Key 的确定性恢复 | 在模型启动前完成对账的动作 / 无模型 Key 未决动作 | 1 / 1 |
| 两个恢复命令竞争同一旧 epoch | 成功获得新 attempt 的命令 / 并发恢复命令 | 1 / 2 |
| 并发恢复后的 attempt 增量 | 实际新增 attempt / 允许新增 attempt | 1 / 1 |

对应测试：

```bash
npm run test:action-reconciliation
npm run test:invoice-runtime-single
npm run test:agent-loop
npm run test:invoice-portal-poc
```

`test:action-reconciliation` 还输出 `external-action-reconciliation-eval/v1`：当前固定数据集为
9 个场景，其中 6 个伪终态均被拒绝。该 `0 / 6` 只描述版本为 `2026-08-12` 的 golden
fixtures，不代表真实门户错误终态率为 0。

### 上线前应持续采集

| 指标 | 定义 | 用途 |
| --- | --- | --- |
| 对账覆盖率 | 有可用 Probe 的未决动作数 / 未决动作总数 | 判断自动恢复能力 |
| 自动收敛率 | 无人工介入进入终态的动作数 / 触发对账的未决动作数 | 判断业务可用性 |
| 重复副作用率 | 重复业务记录数 / 执行过的外部动作数 | 核心安全指标 |
| 错误终态率 | 与人工审计真相不一致的终态数 / 被审计终态数 | 判断 Probe 正确性 |
| 对账延迟 P95 | 从首次发现未决到终态的耗时分布 | 判断恢复体验 |
| 人工接管率 | 最终保持 ambiguous 并转人工的动作数 / 未决动作总数 | 定位不可自动化门户 |

没有真实试点样本前，不填写生产百分比。

## 面试 60 秒主线

> Web Buddy 最有价值的改进不是让模型再聪明一点，而是处理网页副作用的崩溃窗。
> 例如供应商财务提交发票时，客户门户已经生成确认号，但进程在保存 ToolResult 前崩溃。
> 如果恢复后按本地“没有成功记录”重试，就可能重复入账。
>
> 我的最小方案是把本地工具成功和外部业务成功拆开：外部动作前先把 `executing` 和发票
> 业务键、请求指纹 fsync 到 Action Ledger；点击返回只记 `executed`，不能算完成。恢复后由确定性的
> 门户适配器按发票号查询回执，有确认号才记 `committed`；确认未落单且证明可以安全重试
> 才记 `not_committed`；其余保持 `ambiguous` 并转人工。Completion Gate 对未决状态既不
> 证明已提交，也不证明未提交。
>
> 我把它做成了 7 个崩溃边界的故障矩阵，并接回受控发票门户：同一次批量批准拆成 4 个
> 发票 Action，门户生成回执后模拟本地崩溃，恢复查询找回 4/4 确认号，门户记录仍是 4 条，
> 没有二次提交。这个机制不宣称第三方网页 exactly-once；没有幂等键或权威查询能力时会
> 失败关闭。

## 高频追问

### 为什么不能只给点击加重试？

点击是否可重试取决于外部业务操作是否幂等。网络断开时，本地无法区分“请求未到达”和
“门户已提交但响应丢失”，直接重试可能重复创建业务记录。

### 一个普通 `browser_click` 怎么被识别成外部写？

不是由模型根据按钮文字临时决定。经过审核的站点 Adapter 在工具前把特定页面状态与 control
映射为结构化外部 action intent，并给出业务键、canonical effect 和 Probe；Runtime 校验后再按
对应 action kind 跑 Sink Policy、审批和 durable journal。Adapter 只能升级未知分类或保持
Runtime 已有分类，不能把 `send` 改成 `upload`。没有 Adapter 的 click 不在这套语义保证内，
输入即自动保存等隐式写入也必须另行建模。

### Playwright 的 click 成功和页面变化还不够吗？

不够。Actionability 和页面变化证明的是浏览器交互，不是客户财务系统的业务终态。确认号、
业务记录查询或权威回执才是更高等级证据。

### 为什么不做分布式事务？

第三方门户通常不参与本地事务，也不会暴露 prepare/commit 协议。这里能做的是 durable
intent、幂等键、对账和补偿，而不是假装存在跨系统 ACID。

### `not_committed` 为什么还要 `retrySafe`？

空查询可能只是索引延迟。只有站点适配器了解该门户的一致性和查询语义，能证明当前重试
不会重复时，Runtime 才允许它成为终态。

### 同一个发票号为什么还要效果指纹？

发票号只标识对象，不一定标识本次效果。金额、附件或收件方变化后，旧确认号不能证明新请求
成功。站点 Resolver 提供包含这些业务字段的 canonical effect descriptor，Runtime 规范化后与
动作类型、目标 origin 一起计算 SHA-256；descriptor 明文不进 Ledger，同键不同指纹直接报
冲突。若业务确实要提交新版本，适配器必须生成包含版本语义的新业务键，并重新审批。

示例为可读性直接展示了发票号，生产日志不应照抄。Adapter 应把原始财务标识保存在加密、
最小权限的受保护状态中，向 Runtime 暴露 tenant-scoped opaque/HMAC identity。普通 SHA-256
effect digest 只证明两个 canonical effect 是否相同，不提供加密语义；低熵金额、发票号或
附件枚举不能因为“只落 hash”就被宣称为不可推断。

只 hash `browser_click` 的 selector 是不够的：同一个按钮可能提交不同金额。若站点适配器没有
提供 canonical descriptor，Runtime 只能退回原始工具参数，这是一条可用性 fallback，不是对
表单业务载荷完整性的证明。

如果工具的真正 sink 与当前页面不同，站点 Resolver 必须声明 canonical target origin；Runtime
将其同时交给 Sink Policy 和指纹计算。否则只能回退到当前页面，嵌入式页面或跨站发送就不能
宣称已正确绑定真实目标。

### 旧 Session 没有效果指纹，升级后怎么办？

不伪造迁移数据。v1 日志仍能按原业务键只读查询并收敛旧动作；但一旦模型提出同键的新写入，
Runtime 因无法比较 payload 而失败关闭。人工确认后应以新语义键建立 v2 动作，不能后台补一个
“看起来合理”的 hash。

### `not_committed` 后能自动重试，为什么还要再次审批？

权威查询只证明重试不会重复，不代表用户授权可以跨 attempt 复用。新动作拥有新的 Action ID，
重新经过 Policy/Human Gate，并把新的 approval ID 与精确 ActionBinding 摘要写入 Ledger；原审批
仍保留在旧 attempt 的审计链中，但不授权第二次副作用。

### Probe 声明 `read_only` 就真的绝对不会写吗？

不能把类型字段说成安全沙箱。当前 Runtime 会拒绝声明为可写或重复 ID 的 Probe，并且只在
可信站点适配器注册表中调用。生产增强还应给 Probe 单独的只读凭证和网络/工具能力，并用
“查询前后外部记录数不变”的适配器测试验证它没有副作用。

### Probe 有证据 ID，但适配器代码把错误记录匹配过来怎么办？

Runtime 能校验 action/business binding、时间、字段一致性和证据存在性，不能从类型系统证明
站点适配器的业务匹配算法正确。真实适配器必须用门户回读字段校验租户、发票号、金额/版本，
并用人工审计真相建立 false-terminal golden set。当前 `0 / 6` 只覆盖协议层伪终态，不覆盖
任意真实门户适配器的语义错误。

### 回执 ArtifactRef 没被改，但底层文件被换了怎么办？

终态事件同时保存内部存储引用。恢复时 Runtime 会在限定的 Artifact Store 根目录内重新读取，
校验引用元数据、SHA-256，以及内容中的 Action ID、业务键、Probe 和动作类型；缺失或篡改都
在进入 Completion 前失败关闭。

### 这能防本机恶意攻击者同时改事件和文件吗？

不能把完整性检查说成密码学防篡改。当前能发现“durable event 保持不变、底层回执缺失或内容
变化”，也能拒绝结构/绑定不一致的历史；但拥有本地写权限的攻击者如果同时重写事件引用、
hash 和文件，当前没有独立信任根。高威胁部署要把事件写入受控 append-only Store，或增加
由外部密钥保护的 hash chain/签名和远端审计副本。

### LLM 在这套机制里还有什么作用？

LLM 负责识别任务意图、组织页面操作和解释异常；稳定业务键、执行日志、终态查询和完成
判断由 Runtime 与站点适配器负责。

### 两个进程同时恢复，会不会都继续提交？

两个恢复命令不会同时获胜：旧 `recordRevision / runRevision / attempt` 的 CAS 只允许一个
创建下一 attempt，同进程 live execution 也会阻止 resume。但跨进程旧 worker 可能已经过了
最后一次本地检查，第三方门户不会替 Runtime 验证 epoch。因此当前证明的是“唯一新恢复命令”
和“晚到结果不入账”，不是“旧 zombie 绝无外部写”。生产还需要执行者租约与沙箱终止确认，
或下游幂等/查询；直接 SDK 当前没有跨进程 lease。

### 受控 POC 能提交，通用 Agent Loop 也会执行最终提交吗？

默认不会。旧 `final_submit + approve` 仍只是“用户知晓边界”，Runtime 会主动停手。
但本地单动作通用协议已实现：只有可恢复条件全部成立且可信 Host 显式开启独立的 external-effect
capability（submit/payment 再叠加 final-submit capability）时，
Approval 才会额外提供 `approve_and_execute`。它使用 `approval-binding/v2`，绑定 owner-scoped
Store、exact Action/effect/origin、有效期和一次性 nonce；任何带 v2 外部绑定的 Sink 都不消费旧 v1
approve。还必须有当前 TaskContract 的 performed action criterion 和 receipt criterion 同时精确
覆盖该 business key；否则 UI/Queue 只提供旧的知晓决定，不允许“先做错副作用再由
Completion 报错”。未出现在 `allowedDecisions` 中的执行决定，无论是 Gate 返回还是 owner API
伪造都会被拒绝。

四张发票提交仍由受控 POC batch harness 建模，不是正式 `BatchApprovalBinding`。真实门户也
还没有机器执行数据，所以试点仍从 query-only 和“人提交、Runtime 验证”开始。
owner-scoped Web Control Service 还会拒绝 `allowFinalSubmitExecution=true` 或
`allowExternalActionExecution=true`，因为 v2 binding 没有
Runtime 强制的 owner digest；该能力只有完成 v3 隔离验收后才能从 No-Go 解锁。

### 审批已落盘、但 live Agent Loop 还没收到决定就崩溃呢？

durable decision 不等于 delivered decision。启动恢复发现 pending 引用对应的审批已经终态时，
不会把它重放到新进程；旧 attempt 失败关闭、决议保留用于审计，任何仍 pending 的正常审批则
继续等待。当前未实现跨 attempt 的 Approval Delivery Receipt，所以操作者要先对账外部状态，
再启动新 run 并获取新审批。这比猜测旧 loop 是否收到决定更保守。

## 事实边界与下一步

当前可以说：

- Action Ledger 已表达外部动作未决状态。
- 关键外部动作要求 durable journal。
- 通用 Web Task Host 已可注入站点意图 Resolver、业务键 Resolver 和站点 Probe。
- 通用 Web Task Host 可为真实门户开启 strict reconciliation，缺 binding/Probe 不进入外部写路径。
- Web Control Service 已有 per-run、owner-scoped 的可信 Adapter factory；公共 npm 根仍不开放内部
  Runtime driver 或任意副作用 callback。
- 单 Action 的 `approve_and_execute` 已在本地通用 Agent Loop 通过 v2 binding、allowed-decision
  闭集、durable Store 和全部已对账外部动作的 Sink Policy 接入；`send` 也验证了知晓不执行、
  精确执行才写。旧 approve 对普通敏感动作的语义未改变。多租户
  Web Control Service 仍因缺 v3 owner binding 明确拒绝机器执行开关。
- 可信服务端 Adapter 默认开启新动作权威 preflight；受控 fresh Run 已验证已有同键时
  Approval `0/1`、写工具 `0/1`，ambiguous 时也在审批前保持 `0/1`、`0/1`；命中错误业务键
  的真回执仍被当前 Contract 拒绝完成。同一模型轮给出两个副作用时，两个动作各自按
  `preflight -> approval -> tool -> reconcile` 顺序执行，不并发穿透；首个写后对账未决时，
  后续写在审批前被整轮阻断，夹具调用为 `0 / 1`。
- 固定夹具已覆盖 7 个崩溃边界、无日志拒绝、伪证据拒绝、不安全空查询、Probe 迟到和
  恢复日志身份变化拒绝；还覆盖非只读 Probe、效果键碰撞、重试重新审批和回执文件篡改。
- 受控发票门户 POC 已用四个逐项 Action 在页面提交后恢复出 4/4 确认号，恢复阶段没有再次
  点击或增加门户记录，并生成 4/4 `external_action_receipt` Artifact；Completion 同时要求
  四个业务键终态与四份回执。
- Generic WebTask 已验证调用方快照落后于磁盘事件时，以当前 durable Session 为准；没有
  模型 Key 也会先运行确定性 Probe。
- Control RunService 已验证两个并发恢复命令只有一个进入新 attempt，attempt 不会重复递增。

当前不能说：

- 已在真实客户门户证明生产 exactly-once；当前 4/4 结果来自本地受控 POC。
- 已有真实用户重复提交率或恢复成功率。
- 任意网站都存在稳定业务键和权威查询接口。
- 任意 click 都能被 Runtime 自动、正确地解释成业务副作用；当前依赖可信站点 Adapter。
- 默认兼容模式下未绑定的第一次外部写能够自动对账；它只能被 durable 记录为未决。
- 公共 npm SDK 已提供可恢复的第三方 Adapter 插件 ABI；当前是服务端内部可信扩展点。
- 绕过 Control Plane 的两个直接 SDK 进程会自动获得跨进程单写者 lease。
- 两个并发 fresh Run 会因 preflight 自动获得原子跨 Run claim；当前 preflight 能抑制顺序重复，
  但 query-to-write 竞态仍需共享 claim、单 writer 约束或下游原生幂等键。
- Control Plane 的 CAS 能作为第三方门户可识别的 fencing token，或自动阻止跨进程 zombie
  在检查后继续产生外部效果。
- 当前本地文件完整性校验可以抵抗拥有写权限、能同时重算事件和文件的恶意攻击者。
- 通用 Agent Loop 已支持任意多动作共享一次批量审批；当前“四项一次批准”由受控发票 POC
  harness 建模，生产 BatchApprovalBinding 仍需单独实现并绑定精确 item set。
- 受控单动作夹具通过等于真实门户已安全开放机器 final submit。

下一步按价值排序：

1. 把当前受控页面 Probe 替换为一个真实试点门户的回执查询适配器；复用已经实现的
   immutable 回执 Artifact 管道。这一步严格 query-only，不解锁机器写。
2. 实现 `external-action-binding/v3`，由 Runtime 把 owner scope digest 交叉绑定到业务键、effect、
   Probe 凭证、Approval 和 Receipt；没有该绑定时 owner-scoped Service 继续 No-Go。
3. 为同 owner/business key 增加跨 Run 共享 claim/CAS，或验证下游原生幂等键；没有二者时把
   真实试点限制为单 writer，不能把 preflight 说成原子查重。
4. 为最终一致门户实现有界查询窗口；超窗转人工。
5. 用真实试点样本建立重复副作用率、对账覆盖率和人工接管率基线。
6. 验证门户/租户作用域业务键在多账号、多客户下不会碰撞。
7. 给真实 Probe 配置只读账号/能力，并增加查询前后业务记录不变的适配器契约测试。
8. 用真实单张试点验证已有 `approve_and_execute` UI/审计协议，再将 POC 批量授权升级为正式
   BatchApprovalBinding；摘要包含 owner scope、四个业务键和效果指纹，任何 item set 或 payload
   变化都重新审批。
9. 高威胁部署增加带外密钥保护的事件 hash chain/签名或远端 append-only 审计副本。
10. 给执行沙箱增加有期限 lease 与终止确认；恢复写入前等待旧执行者 quiescent。下游支持时把
   业务幂等键直接传入；第三方网页无法识别 fencing token 时，不把本地 CAS 宣称为绝对单写者。

## 设计参考

- Stripe API 的幂等键语义：<https://docs.stripe.com/api/idempotent_requests>
- AWS Retry with Backoff 对非幂等操作的边界：<https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html>
- Playwright Actionability 只保证交互前置条件：<https://playwright.dev/docs/actionability>
