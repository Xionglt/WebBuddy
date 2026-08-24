# Web Buddy 真实门户适配试点

这份计划承接外部副作用对账主线。目标不是再做一个页面 Demo，而是用一个真实但低风险的
客户门户回答三个问题：业务身份能否稳定生成、门户是否提供足够的只读终态证据、恢复是否会
在真实最终一致与登录状态下产生伪成功或重复写入。

## 最小试点范围

- 一个明确门户 origin、一个测试/沙箱租户、一个发票类型。
- 先选择可撤销、可人工核对的测试单据；不使用真实付款、生产客户或不可逆财务入账。
- 第一期只读，不提交；第二期先由操作员亲自提交单张、Runtime 旁路 Probe。已有的
  `approval-binding/v2 + approve_and_execute` 在该真实门户完成 UI/审计演练后才显式开启机器
  单张，再考虑四张受控批量。
- 所有写入都经过 Control Plane、durable Session 和 Human Gate；不开放直接 SDK 恢复写入口。
- 试点 Host 必须开启 `requireExternalActionReconciliation`；缺 intent/binding/Probe 的外部写不做
  “先执行再观察”，而是在工具前失败关闭。历史 unbound 未决动作只进人工核对台。每个 opaque
  click 必须显式分类为外部动作或 `non_external`；空结果不是安全结论。输入 autosave 等其他隐式
  写入必须另列 control/effect 清单。
- Adapter 通过 Web Control Service 的 per-run trusted factory 安装，不走公共 npm callback。
  Factory 根据冻结 ownerScope 选择租户密钥/只读凭证，返回后默认 strict；不得与测试 Runtime
  driver seam 同时启用。`allowExternalActionExecution` 与 `allowFinalSubmitExecution` 默认 false，
  当前 owner-scoped Service 任一显式配置都会失败关闭；必须先实现本文件的 v3 owner binding。
  解除 No-Go 后，这两个独立 capability 也只决定是否
  向用户提供执行选项，不能代替用户的当次执行决定。
- 可信 Adapter 默认开启 `preflightExternalActions`：每个新动作在 Approval 前先查同一业务键。
  已存在则零审批零写，ambiguous 则审批前停住；不允许为了降低一次查询延迟而关闭。

## Adapter 必须回答的契约

### 0. Control-to-business-action 映射

真实页面最终提交常表现为普通 `browser_click`。Adapter 必须基于已审核的 portal origin、页面
状态和稳定 control identity，把它映射成 `submit`，并在同一次意图结果中携带后续业务绑定；
不能让 LLM 根据按钮文案自报 action kind，也不能把所有 click 一律当提交。

试点 golden set 至少包含：真正最终提交、仅打开确认弹窗、保存草稿、取消/返回、同文案不同
页面、iframe/跨站真实 sink、DOM ref 重排。每项用门户业务记录和人工标注做真相，记录漏识别和
误识别。Runtime 已有敏感分类与 Adapter 结果不一致时必须工具前失败；Adapter 无结果时不得把
普通 click 宣称为已进入外部动作对账闭环。输入即自动保存等 click 之外的隐式写入另列清单，
在建模完成前不开放自动恢复写入。

Adapter 只能读取 Runtime 提供的不可变参数快照，不能原地补字段、改金额或替换附件标识；需要
派生的数据必须通过结构化返回值提供。试点要保留“恶意/误实现 Adapter 尝试修改输入”的回归，
确认策略、审批 preview、effect digest 和实际工具 payload 来自同一个执行快照。当前 Runtime
会把脱敏且不超过 1024 字符的 canonical effect JSON 纳入 ActionBinding 并投影到 owner API；
还会绑定并展示 Adapter 判定的 semantic action kind，避免把业务提交显示成普通 click。含 secret
或无法完整展示时不开放机器执行。门户 UI 仍应把该 JSON 渲染成字段级 diff。

### 1. 业务身份

建议业务键：

```text
portal:<portal-id>:tenant:<tenant-id>:invoice:<invoice-no>:version:<business-version>
```

上式只用于说明作用域组成，不应直接当生产日志格式。真实财务标识进入 durable Session 前应由
Adapter 生成 tenant-scoped opaque ID（例如带版本的 HMAC 或随机映射键），原始发票号、账号和
查询字段保存在 Adapter 自己的受保护状态中。业务键、Probe ID、evidence ID 都不得包含 Cookie、
Bearer token、带签名 URL 或可复用凭证。

必须验证：

- portal/tenant/account 不会因登录切换而被误省略。
- 发票号是否跨年度、公司或供应商重复。
- 金额或附件变化是同一效果更新，还是必须产生新业务版本。
- 同一个外部效果无论被识别成 `send` 还是 `submit` 都落入同一 retry namespace；action kind
  不能成为绕开查重的第二维。上传与最终提交若确实是两个效果，业务键必须显式包含 step/version。
- 页面临时 row id、DOM selector、URL query 不能进入稳定业务键。

### 2. Canonical effect

Resolver 至少提取：

```json
{
  "invoiceNo": "INV-CN-260601",
  "currency": "CNY",
  "amountMinor": 4860000,
  "purchaseOrder": "PO-7841",
  "servicePeriod": "2026-Q2",
  "attachmentSha256": "<actual uploaded bytes sha256>"
}
```

Runtime 负责 canonical JSON 和 digest；Adapter 不能只提交自己算好的 hash。真实 sink origin 由
Adapter 显式声明并同时进入 Sink Policy、ActionBinding 和 effect digest。通用 click selector
只能描述执行机制，不能代替这些业务字段。

普通 SHA-256 effect digest 只用于检测“授权效果是否一致”，不是加密。低熵金额、发票号和附件
枚举仍可能被猜测；生产若需要隐藏字段，应使用 tenant key 的 HMAC，并把可查询明文留在加密、
最小权限的 Adapter state，而不是塞进 Ledger 或 Trace。

### 3. 只读 Probe

Probe 必须使用只读账号/API/浏览器能力，并回读：

- tenant/account、发票号、金额、币种、PO、服务期间和附件版本/hash；
- 门户确认号、业务状态、门户侧更新时间；
- 查询来源或快照标识，形成唯一 evidence ID；
- 根据回读字段重算的 `observedEffectDigest`。

只有字段和授权效果完全一致才返回 `committed`。空查询必须经过该门户的稳定窗口后，且有证据
证明重试不会重复，才能返回 `not_committed + retrySafe=true`；否则返回 `ambiguous`。

Probe 收到的 Runtime Action/request 是不可变副本，适配器测试还要尝试修改 business key 与
effect digest 并确认工具前失败；这避免“验证器改题再作答”。它不等于门户权限只读，账号/API
scope 和查询前后记录数不变仍需独立证明。

### 4. 空查询与稳定窗口

Adapter 不能把“HTTP 200 + 空列表”直接翻译成 `not_committed`。试点前要由门户 owner 给出并验证：

- 查询读的是写入主记录还是延迟索引/报表；若只有延迟索引，记录其 P99 可见性时间与测量样本。
- 从外部请求可能送达的最晚时间起等待 `visibility window + clock/network margin`，而不是从恢复进程
  启动时起算；没有可靠起点就保持 ambiguous。
- 稳定窗口前后至少各保留一次独立查询快照，且每次都覆盖相同 tenant、business key 和版本。
- 旧 worker 已确认 quiescent，或下游原生接受同一幂等键；否则“此刻为空”不能排除稍后落单。
- 同键不存在其他人工/并发流程的在途写；无法证明时只允许人工核对，不自动重试。

因此 `retrySafe=true` 是 Adapter 对“查询覆盖 + 时间窗口 + 单写者/幂等条件”的组合证明，不是
一个任意布尔值。第一期只读影子要把这些原始观察与人工真相对齐，再决定是否开放该返回值。

preflight 只能发现查询时已经可见的效果，不是 query-and-write 原子事务。两个并发 fresh Run
仍可能同时看到 absent；机器写阶段必须具备 owner-scoped 共享 claim/CAS、下游原生幂等键，或
明确且可验证的单 writer 约束。当前 Runtime 未实现跨 Run 共享 claim，缺少另外两项时为 No-Go。

## 四阶段上线顺序

| 阶段 | 外部写入 | 主要验证 | 退出条件 |
| --- | --- | --- | --- |
| 0. 离线夹具 | 无 | 现有 7 个崩溃边界、9 个协议场景、4 张发票 POC | Release Gate 全绿 |
| 1. 真实只读影子 | 无 | 登录保持、业务键稳定、字段回读、Probe 零写入 | 人工审计样本全部可解释；未知项保持 ambiguous |
| 2a. 人执行单张沙箱 | 操作员亲自点击 1 张 | 真实业务键、字段回读、确认号、最终一致窗口 | Probe 与人工真相一致；不把人操作算 Agent 执行 |
| 2b. 机器执行单张沙箱 | v3 owner binding 后，`approve_and_execute` 每次 1 张 | owner/effect/origin/nonce 绑定、崩溃恢复 | 无盲重试；旧 approve 不能执行；人工可核对 |
| 3. 四张受控批量 | 正式 BatchApprovalBinding 的明确 item set | 逐项回执、部分失败、最终一致、预算公平性 | 每项独立收敛；无关回执不能凑数 |
| 4. 小流量试点 | 受租户与额度限制 | 真实覆盖率、延迟、人工接管与重复率 | 达到事先定义门槛后再扩租户/动作 |

## 必做故障注入

1. 提交请求发出前终止进程。
2. 门户落单、浏览器响应返回前断网。
3. 浏览器返回、`executed` event 前终止进程。
4. Probe 首次查询为空、稳定窗口后出现记录；还要注入“两个查询都为空，但旧 worker 在第二次
   查询后才落单”，验证没有 quiescence/幂等时仍保持 ambiguous。
5. 同发票号但金额或附件 hash 不同。
6. 页面 shell 与真实写入 origin 不同。
7. 登录租户切换，发票号相同。
8. 同一个“提交”文案分别对应打开弹窗和真正落单，且 DOM ref 在刷新后变化。
9. Receipt 文件落盘后、committed event 前失败。
10. committed event 存在但 Receipt 文件缺失/被替换。
11. 两个同 epoch resume 命令竞争，以及旧 worker 无法确认终止的 zombie 场景。
12. 同轮两个外部动作中，第一个已点击但 Probe 未决；验证第二个在审批和写入前
    被整轮阻断，不继续扩大 in-doubt 集合。
13. 重启后启动对账仍返回 ambiguous；验证 strict 模式在模型启动前阻断，而不是让模型
    换一个业务键继续产生外部效果。

第 11 项中，当前系统只能证明一个新 resume 命令获胜和旧结果不入账，不能给第三方网页发送
fencing token。无法确认旧执行者 quiescent 时，试点必须只查询并转人工，不能自动恢复写入。

## 多租户机器写之前的 v3 binding

当前 `ownerScope` 已进入 WebTask 输入、Control Store、Approval 和最终 Artifact，但 durable
`external-action-binding/v2` 仍只保存业务键、Probe ID 和 effect digest。Adapter 可以约定把租户
写进业务键，受控工厂也冻结了 owner scope；这足以做单租户/只读试点，却还不是 Runtime 对
跨租户隔离的结构化证明。

机器写扩到多个租户前，应新增而不是悄悄修改 v2 语义：

```text
external-action-binding/v3
  ownerScopeDigest = Runtime(canonical OwnerScope)
  businessKey      = Adapter 的租户内稳定业务身份
  effectDigest     = Runtime(ownerScopeDigest + action + effect + sink origin)
  probeId          = owner-scoped 只读查询能力

logical action key = ownerScopeDigest + businessKey
shared claim key   = ownerScopeDigest + businessKey
```

- `ownerScopeDigest` 只能由 Runtime 从已校验的 `owner-scope/v1` 计算，Adapter 不能提供或覆盖。
- 启动恢复必须先比对 WebTask/Session/Control 的 owner scope 与 Ledger v3 binding，任何不一致都在
  Probe 前失败；不能先查错账号，再靠 verdict 校验补救。
- Probe factory 必须根据同一 owner scope 选择凭证，并收到 deep-frozen 的 v3 Action；receipt
  内容、Artifact owner scope 和 Approval 的 ActionBinding digest 都要交叉覆盖该 digest。
- v1 只允许历史 query-only；多租户机器写遇到无 owner digest 的 v2 必须转人工迁移，不能靠
  猜测 business key 字符串中的 tenant 片段升级。

最小验收集是 6 类：同号不同租户互不碰撞、同租户别名不能绕过 canonical scope、恢复时 scope
被替换在 Probe 前拒绝、A 租户回执不能完成 B 租户 Contract、缺 scope 的多租户机器写拒绝、
同 scope 正常预查与恢复通过。只有这组测试和真实跨租户真相集都过，才把“Adapter 契约边界”
升级为“Runtime 强制隔离”。

## 指标身份证

| 指标 | 分子 / 分母 | 数据源 | 不能混淆成 |
| --- | --- | --- | --- |
| Probe 覆盖率 | 有合格 Probe 的未决动作 / 未决动作 | Ledger + adapter registry | 自动恢复成功率 |
| 自动收敛率 | 无人工进入 terminal 的未决动作 / 触发对账动作 | Ledger terminal event | 任务成功率 |
| 错误终态率 | 与人工审计不一致的 terminal / 被审计 terminal | 人工真相集 | 模型幻觉率 |
| 重复副作用率 | 被确认的重复门户记录 / 跨过 executing 的动作 | 门户记录 + Ledger | 重试次数 |
| P95 对账延迟 | 首次发现未决到 terminal 的耗时分布 | durable timestamps | 整个任务耗时 |
| 人工接管率 | 最终转人工的 ambiguous / 未决动作 | Ledger + control events | Probe 失败率 |
| 意图漏识别率 | 未升级的真实外部写 control / 人工标注外部写 control | 页面 golden set + Adapter trace | Probe 覆盖率 |
| 意图误识别率 | 被错误升级的非外部写 control / 人工标注非外部写 control | 页面 golden set + Adapter trace | 模型工具选择错误率 |

样本量、门户/租户、版本、一致性窗口和故障注入条件必须随数字一起报告。真实试点前继续只说
受控夹具 `7/7`、`4/4`、恢复新增记录 `0/4` 和伪终态接受 `0/6`。

## Go / No-Go

只有以下条件同时成立才允许从只读进入单张写试点：

- 业务键和 canonical effect 经过财务/业务 owner 审核。
- control-to-business-action golden set 通过，真正提交、开弹窗、草稿和取消不会混类。
- Adapter 输入不可变回归通过，Policy/approval/effect/tool payload 的执行快照一致。
- strict reconciliation 已开启，新动作与恢复历史的缺 binding 注入都在外部写前失败。
- opaque click 全部显式分类；缺分类拒绝与 non_external 正例均通过，非 click 隐式写已盘点。
- Factory 的 ownerScope 冻结/闭集返回/driver 互斥和回执 ownerScope 绑定通过回归。
- v2 binding 本身没有结构化 `ownerScopeDigest`，因此只允许 query-only；进入机器写前必须完成
  v3 Runtime-owned owner binding。Adapter 契约测试还要证明 factory 选择的 portal
  tenant/account、业务键映射和 Probe 凭证都与冻结 ownerScope 一致，但这不能替代 v3。只在
  字符串里出现 tenant 名称不算 Runtime 证明；跨租户同号真相集失败即 No-Go。
- fresh Run preflight 已开启；并发 writer 还必须由共享 claim、下游幂等键或单 writer 约束覆盖。
- Probe 账号在权限层面只读，查询前后外部记录数不变。
- 至少一组人工标注真相集覆盖同号不同金额、最终一致空查询和跨租户同号。
- Receipt durable write、Session restore 和 Completion 逐业务键门禁全部通过。
- 机器执行仅在 durable Session 与当前 run/attempt 的 exact SessionRef 同时存在时才可见；
  durable 但未绑定的负例必须保持执行选项 `0/1`、写调用 `0/1`。
- 机器写试点前，已有 `approve_and_execute` UI 完成本门户的人工演练，v2 决定能落盘且旧
  approve 仍只表示知晓；伪造未提供的执行决定必须保持 pending。
- 旧执行者能确认终止；否则恢复路径保持 query-only。
- 已有明确的人工核对台与升级 owner，不让 ambiguous 静默卡住。

任一项缺失都不是“再调 Prompt”可以解决的问题，应停止自动写入并保留只读辅助。

## 运行监控、停机与回滚

机器单张试点不是一次性开关，而是一个随时可收缩的受控变更。上线前必须指定业务 owner、
Runtime on-call 和门户 owner，并约定以下告警只触发“停止新写入”，不能直接触发自动重试：

- 任一 `ambiguous` 超过试点定义的人工接管时限，或待核对队列超过容量上限；
- 任一已确认重复门户记录、跨租户证据、错误 terminal、回执语义不一致或未授权写入；
- Probe 连续超时/鉴权失败、门户 origin/证书/登录租户发生变化，或 golden control identity 失配；
- durable Receipt、Session event、Approval 决定、owner scope 与门户记录无法形成一一对应；
- 同一业务键出现并发 executing、旧 worker 不能确认退出，或下游幂等/共享 claim 健康检查失败。

回滚顺序固定为：先在可信配置面同时关闭 `allowExternalActionExecution` 与
`allowFinalSubmitExecution`，暂停新的 `approve_and_execute` 请求并冻结队列消费；再隔离/终止
现有浏览器 worker；最后只用 owner-scoped Probe 盘点所有 `executing / not_committed /
ambiguous / indeterminate` 动作。不能通过删除 Session、Receipt 或 Approval 记录来“清理状态”，
也不能把尚未核对的动作改写成 failed 后盲重跑。每个在途业务键必须收敛到：门户已存在且字段
匹配、稳定窗口和单写者证明下可安全重试、或人工接管三者之一。

恢复写入需要一次新的 Go 审核，而不是自动重新打开 flag。复盘至少保留：时间线、受影响的
owner/业务键数量、门户真相、是否产生重复、哪个不变量或监控先发现、为何现有 Release Gate
未覆盖，以及新增的故障夹具。任何凭证/租户路由异常还要轮换 Adapter 凭证并使旧会话失效；
轮换本身不能改变 durable owner/business identity。

建议为试点单独展示四组仪表，而不是只报“成功率”：入口（新动作、审批、执行数）、未决库存
（按状态和 age bucket）、终态质量（人工审计错误/重复/跨租户）和恢复负担（对账延迟、人工接管）。
第一批样本很小时使用原始计数和分母，不用百分比掩盖一次严重事故。

## 面试时如何描述这一步

> 本地 POC 证明的是协议和故障语义，不是生产成功率。下一步我不会先扩更多网站，而是选一个
> 测试租户做 query-only Adapter：先验证业务键、金额/附件回读和一致性窗口，再开放单张显式
> 的“人提交、Runtime 验证”。已实现的 `approve_and_execute` 协议要先在该门户演练；错误终态、
> 重复副作用和人工接管都有真实分母后，才开放机器单张，再讨论批量和扩租户。
