# Web Buddy 面试主线卡：外部副作用对账恢复

面试当天先看真正的一页版
[`INTERVIEW_EXTERNAL_ACTION_CHEATSHEET.md`](INTERVIEW_EXTERNAL_ACTION_CHEATSHEET.md)；这份文档
保留完整追问树、调试细节和事实边界。完整设计见
[`EXTERNAL_ACTION_RECONCILIATION.md`](EXTERNAL_ACTION_RECONCILIATION.md)。
真实门户从只读影子到小流量试点的步骤见
[`REAL_PORTAL_ADAPTER_PILOT.md`](REAL_PORTAL_ADAPTER_PILOT.md)。

## 一句话结论

> 我把 Web Buddy 从“浏览器工具返回成功”推进到“能证明外部业务结果”：外部动作前持久化
> 执行意图，崩溃恢复时按业务键只读查询权威门户，有回执才完成，无法判断就失败关闭。

## 为什么优先讲它

长期记忆、多 Agent 和页面操作能力都容易讲成通用 Agent 组件；“门户已提交、本地写回前
崩溃”则同时体现业务损失、状态建模、幂等、审批、恢复、证据和评测，是完整的后端主线。

最合适的业务场景是供应商财务提交客户门户发票：

- 重复提交会产生真实财务风险。
- 客户门户通常不能参与本地事务。
- 发票有稳定且可解释的业务身份。
- 最终提交天然需要精确审批。
- 门户确认号适合作为独立结果证据。

支付也有风险，但不适合作为当前首讲场景：真实接入门槛更高，受控 POC 更难做可信。邮件发送
较容易演示，但业务终态与重复损失没有发票清楚。发票是“价值、可验证性、项目现状”的最佳交点。

## 能力血缘：面试时怎样准确说 ownership

| 层次 | 这轮之前已有 | 这轮真正新增/修正 |
| --- | --- | --- |
| 业务入口 | 发票门户受控 POC，已有重复/异常隔离和最终提交审批 | 把“门户已收单、本地未落确认号”做成可复现故障场景 |
| Runtime | Permission/Human Gate、Action Ledger、durable Session/restore、Completion、Artifact、Control Plane | 把 `performed / not_performed` 的粗粒度审计扩成外部动作 in-doubt 状态机，并接入恢复主路径 |
| 真相与身份 | 工具结果和 Action ID | 门户/租户业务键、Runtime 计算的 effect digest、只读 Probe 和独立回执 |
| 安全恢复 | 可以恢复会话与 continuation | 动作前 fsync、query-before-retry、三态对账、迟到结果 fence、逐业务键 Completion |
| 证明 | 已有通用 Trace/Eval 框架 | 7 个崩溃边界、伪终态 golden fixtures、4 张发票 POC 回执与并发恢复回归 |

推荐的 ownership 表述是：

> 我没有重做浏览器执行和 Session 框架；我审计现有 Action Ledger 时发现，它把“本地没有
> performed 记录”当成 `not_performed`，无法表达第三方已经生效但本地未知。我负责把这个
> 语义缺口建模成未决状态，并贯通审批、持久化、恢复、回执、Completion 和故障评测。

这比“我从零搭了整个 Agent Runtime”更可信，也更容易承接面试官对个人判断、具体改动和
调试过程的追问。

## 面试官实际在打什么分

| 评分点 | 这条故事要给出的证据 |
| --- | --- |
| 场景与判断 | 为什么优先修复重复入账风险，而不是继续堆 Memory、多 Agent 或浏览器花活 |
| 后端基本功 | 外部真相、本地知识、双写故障窗、状态机、fsync 顺序、幂等/对账、CAS fence |
| Agent 边界 | LLM 负责意图和页面策略；业务身份、Probe、终态和 Completion 由确定性 Runtime 负责 |
| 安全与人控 | 业务键/effect/origin 进入精确审批绑定；旧审批不跨 attempt；无证据失败关闭 |
| 评测能力 | transcript 不代替 environment outcome；崩溃矩阵、伪终态集、受控门户都可重复运行 |
| 生产意识 | 主动说明真实门户适配、最终一致窗口、只读凭证、单写者、指标和规模边界 |
| 个人 ownership | 能区分已有平台与本轮新增，讲出至少两个跨模块 bug 及为什么单元测试抓不到 |

真正高分的顺序是：先用业务损失解释为什么做，再用一个故障窗推出最小机制，最后拿代码、
故障注入和事实边界证明判断。不要一上来枚举 `RRF / MCP / Multi-Agent / Redis` 等技术名词。

## 30 秒版本

> Web Buddy 原来最危险的边界是：门户已经接收发票，但进程在保存 ToolResult 前崩溃。
> 恢复后如果按本地没有成功记录重试，就可能重复入账。我把工具返回和业务提交拆成
> `executed`、`committed` 两层；动作前先 fsync `executing`、租户级业务键和请求指纹，
> 新动作审批前和崩溃恢复时都用只读适配器查门户确认号。查到就零点击完成，证明未落单才允许
> 重新审批，其余转人工。

这里有一个容易被追问穿的前提：模型实际调用的可能只是 `browser_click`，工具名本身并不等于
“提交发票”。真实门户必须注册可信站点意图适配器，把这个特定按钮和当前业务上下文升级为
`submit + business key + canonical effect + Probe`；Runtime 再按 `submit` 重跑 Sink Policy、
精确审批和 durable journal。未适配的任意 click 不会被自动宣称为可对账外部动作。

## 90 秒版本

> 场景是供应商财务批量向客户门户提交发票。根因不是 click 不稳定，而是存在一个双写故障窗：
> 门户已经创建记录，但本地确认号还没落盘。此时 Session 的“没有成功”不等于外部“没有执行”。
>
> 我的最小方案有四步。第一，先 durable 写 `proposed`，审批前按业务键做权威 preflight；再在
> 真正外部动作前把 `executing` 写入 durable Action Ledger。第二，
> 每张发票绑定门户/租户作用域业务键，站点适配器提取金额、附件版本等 canonical effect，
> Runtime 再规范化并和目标 origin 一起计算效果指纹，
> 防止旧确认号覆盖修改后的 payload；第三，点击返回只记 `executed`，由只读 Probe 查询门户，
> 有独立回执才记 `committed`，明确不存在且 `retrySafe=true` 才记 `not_committed`，其他都是
> `ambiguous`；第四，Completion 必须逐业务键拿到终态和 immutable 回执，不能靠模型总结。
>
> 真要让机器执行已对账外部副作用时，我没有把旧 `approve` 偷换成执行授权，而是新增
> `approval-binding/v2 + approve_and_execute`：只有可信 Host 显式开启独立 external-effect
> capability（submit/payment 还要 final-submit capability）、strict 对账、fresh-run 权威预检、
> durable Session、绑定当前 run/attempt 的精确 `SessionRef`、v2 业务绑定和 Probe
> 都在场时才向用户提供这个决定。
> 多租户 Web Control Service 还会额外拒绝开启，直到 v3 把 owner scope 写进外部动作身份。
>
> fresh Run 查到同键已存在时 Approval 与写调用都是 0 次，并标记
> `localExecutionAttempted=false`。我还用 7 个崩溃边界和一个 4 张发票 POC 做确定性验证。
> 模拟门户生成 4 个确认号后本地崩溃，
> 恢复找回 4/4 回执，恢复阶段新增门户记录是 0；这些是受控夹具结果，不是生产指标。没有
> 权威查询或下游幂等能力时我不会宣称 exactly-once，而是失败关闭并交给人工。

## 五分钟白板主线

### 1. 先画真相边界

```text
客户门户业务记录       = 外部效果真相
Action Ledger          = Runtime 对真相的持久化知识
模型文本 / ToolResult  = 候选线索，不是业务终态
```

### 2. 再画状态机

```text
proposed
  -> authorized     # 结构化 approval/policy 引用
  -> executing      # 外部动作前 append + fsync
  -> executed       # 工具返回，仍不能证明业务完成
  -> committed      # 独立查询得到确认号

查询证明不存在且可重试 -> not_committed
断连、超时、最终一致窗口 -> ambiguous
```

### 3. 最后说恢复算法

```text
恢复当前 durable Session
  -> Control Plane CAS 选出唯一新 recovery attempt，并确认同进程旧执行已退出
  -> 找出 authorized/executing/executed/failed/ambiguous
  -> 按 businessKey 选择唯一 read_only Probe
  -> per-action 10s / whole-recovery 30s 有界查询，校验 verdict 时间、绑定和独立证据
  -> 先写 immutable receipt，再 fsync committed event
  -> 进入 Completion 前重读 receipt 并校验 SHA-256
  -> 每个目标业务键都收敛后才结束
```

## 直接机制、边界、生产增强

| 层次 | 回答 |
| --- | --- |
| 直接机制 | durable intent + scoped business key + effect digest + read-only reconciliation + conservative completion |
| 边界 | 兼容模式可记录未适配外部动作但只能长期未决；无查询/幂等时转人工；Probe 的只读声明不是代码沙箱；CAS 不会让跨进程 zombie 自动失去第三方网页写能力 |
| 生产增强 | 真实门户开启 strict reconciliation（缺 binding/Probe 工具前拒绝），再配只读凭证、最终一致窗口、opaque/HMAC 业务身份、人工核对台、指标基线、执行租约/沙箱终止确认，优先使用下游幂等键 |

## 面试官追问树

### 为什么不直接重试 click？

网络断开无法区分请求未到达、门户已提交但响应丢失。重试的前提是业务操作幂等，而不是浏览器
工具可重放。

### Runtime 怎么知道一个普通 click 是“提交发票”？

不能靠工具名、selector 或让 LLM 自报。可信站点 Adapter 在副作用前返回结构化
`external-action-intent/v1`，把已审核的页面动作升级为 `submit / send / upload / publish / payment`
之一，并同时给出 v2 业务绑定。Runtime 会校验严格 schema；若自身已经把该调用识别成另一类
敏感动作，分类冲突会在工具前失败，Adapter 不能降级或改写它。升级后的动作重新进入 Sink
Policy、ActionBinding、Human Gate 和 Action Ledger，而不是只多写一个标签。

这仍是可信代码边界，不是通用网页语义识别器：未适配网站的普通 click、输入即自动保存、以及
错误 Adapter 的业务映射都不能声称已覆盖。生产 Adapter 要以 golden 页面/业务样本验证
“control -> business action”映射，并限制其注册与发布权限。Runtime 传给意图和 binding Adapter
的是 deep-frozen 参数快照；Adapter 尝试修改它会在工具前失败，不能让策略、审计与实际工具
各自看到不同 payload。

strict 模式还区分“没有分类”和“明确非外部动作”：受控门户中的每个 opaque click 必须返回
`外部 action + binding` 或严格结构的 `non_external`。返回空值会在工具前报
`EXTERNAL_ACTION_INTENT_REQUIRED`；Adapter 不能用 `non_external` 降级 Runtime 已识别的敏感
动作。错误的 non_external 仍属于可信 Adapter 语义错误，所以必须靠页面 golden set 与发布治理，
而不是把这两个字当安全证明。

### 未适配的第一个外部动作会怎样？

默认兼容模式仍会在 durable Session 中记 `executing/executed`，但没有稳定 binding/Probe 时只能
保持 indeterminate，不能自动对账或完成。真实门户试点必须开启
`requireExternalActionReconciliation`：新外部动作缺 binding 时在审批/工具前拒绝；恢复历史中
发现 unbound 外部动作时，也在模型继续操作前失败关闭。这样才能准确说“该试点的外部动作都有
可恢复身份”，不能把兼容模式说成任意网站的恢复保证。strict 当前只要求 opaque click 显式
分类；输入触发 autosave 等 click 之外的隐式写仍必须由站点单独建模。

### 为什么不直接把 Adapter callbacks 放进公共 npm SDK？

公共 `runWebTask()` 刻意不暴露内部 driver、恢复权限和本地路径。只开放副作用 callback 却不给
Control Plane、租户身份和 durable recovery，会形成半套危险 API。因此当前接入点是 Web Control
Service 的可信、每运行 Adapter factory：它收到冻结的 runId/ownerScope，生成 tenant-scoped
Resolver/Probe，安装后默认 strict；返回字段闭集校验，并与整套 Runtime driver 测试 seam 互斥。
这能支持受控真实门户试点，但不能说成第三方 npm 插件生态已完成。未来公共能力应是受限的
声明式 manifest/隔离进程协议，而不是任意进程内代码回调。

### 为什么 ToolResult 或页面“成功”文案不是证据？

它们最多证明交互过程。业务终态必须来自确认号、权威记录查询或经过审核的外部回执；页面文案
可能过期、可伪造，也可能先展示成功再异步失败。

### 权威状态到底在哪？

外部门户记录是效果真相；Ledger 是本地知识状态。恢复不是让模型回忆，而是让 Runtime 重新
查询真相并更新自己的知识。

### 为什么不做分布式事务或 Outbox？

Outbox 能保证本地事件可靠投递，但第三方网页通常不参加 prepare/commit，也没有消费幂等协议。
跨边界仍要靠业务键、权威查询和补偿。这里不伪装成跨系统 ACID。

### 业务键为什么还要效果指纹？

业务键标识逻辑效果，发票号只标识对象。金额、附件或目标 origin 改变时，旧确认号不能证明新
请求成功。站点 Resolver 提取 canonical effect，Runtime 对动作类型、规范化业务字段和目标
origin 计算 digest；同键不同 digest
报 `EXTERNAL_ACTION_KEY_COLLISION`，必须用新版本键并重新审批。

跨站工具由可信站点 Resolver 声明 canonical 真实去向，Runtime 校验后同时交给 Sink Policy、
效果指纹与审批绑定；Resolver 不声明时只能回退当前页面，不能把 fallback 说成真实目标证明。

如果是通用 click，selector 本身不能代表金额和附件；没有 canonical effect 的适配器只能退回
工具参数，不能宣称已防住业务 payload 变化。这是生产接入必须补的 adapter contract。

业务键示例里的发票号只是为了让 POC 和面试可读；真实 Ledger 应使用 tenant-scoped opaque
identity，原始查询字段放进 Adapter 的受保护状态。普通 SHA-256 effect digest 是一致性指纹，
不是加密，不能把“没有保存 canonical 明文”等同于低熵金额和发票号已获得机密性保护。

业务键是跨所有外部写类型的 retry namespace，不是 `(actionKind, businessKey)` 二元组。否则同一
发票第一次识别为 `send`、第二次误识别为 `submit` 就会打开第二条执行通道。当前在线 propose、
Agent Loop 查询和 durable restore 在同一 Session/恢复链内按业务键查重；action kind 已进入
effect digest，分类变化会成为同键不同效果碰撞并在工具前失败。fresh Run 则依赖审批前权威
preflight 发现已有同键效果；它不是原子跨 Run 锁。确实需要“先上传、再提交”两个效果时，
Adapter 必须给它们两个有明确步骤/版本语义的业务键。

### Probe 怎么证明自己是只读的？

当前 Runtime 校验 `external-action-probe/v1 + authority=read_only`，拒绝重复 ID 和声明可写的
适配器，并在副作用前完成注册检查。但类型字段不是沙箱；生产还要给 Probe 只读账号和只读
工具能力，并测试查询前后外部记录数不变。Runtime 交给 Probe 的 request envelope 和 Action
副本会递归冻结；Probe 不能先改掉 expected effect/business key，再让自己的 verdict 通过校验。
Probe ID 也在进入异步查询前取快照，返回 verdict 必须匹配调用前的注册身份，不能在 `await`
期间改名。返回 verdict 会先物化成 detached frozen snapshot，校验过程不会反复读取一个可变对象
或 getter。这保护 Runtime 内验证对象，但不替代外部门户的只读凭证。

### Probe 如果把别人的回执匹配到这张发票呢？

协议校验不能证明适配器业务逻辑正确。站点适配器还要核对租户、业务键、金额/版本等门户回读
字段，回读后重算 `observedEffectDigest`，并用人工审计真相做 false-terminal golden set；当前
`0 / 6` 是协议负例，不是生产
Probe 的错误率。

调用者也不能临时覆盖查询身份：Action 有 durable binding 时，显式传入的 Probe business key
必须与 Ledger 完全相同，否则在查询前拒绝。这样不会出现“查到 B 的确认号，却把 A 的 Action
标成 committed”。

### 空查询为什么不能直接认为没提交？

索引或页面可能最终一致。只有适配器理解该门户的一致性窗口并明确返回 `retrySafe=true`，空查询
才能收敛为 `not_committed`；否则保持 `ambiguous`。这里的 `retrySafe` 不是随手填的布尔值：
要能说明查询源、可见性窗口从哪个时点起算、旧 worker 是否 quiescent，以及下游是否接受稳定
幂等键。任一项未知，即使连续两次为空也不能自动重试。

### 最新状态只有 `authorized`，为什么还要查门户？

durable journal 能证明这个 Runtime attempt 没有越过 `executing`，却不能证明用户或另一条业务
流程没有在门户里完成同一个业务键。重试前仍查询外部真相，可以发现人工补单或并发系统写入；
查到完全相同的 effect 就把业务目标收敛为 committed，查不到且明确可重试才开启新的审批 attempt。

### 用户新开第二个任务提交同一张发票呢？

新的 Run 没有第一条 Session Ledger，所以可信服务端 Adapter 会在创建 Approval 前用同一 v2
binding 做权威 preflight。受控证据中，已存在同键时 fresh Run 的 Approval 和写工具调用都是
`0/1`，只生成本 Run 可验证的 receipt；`ActionOutcome.localExecutionAttempted=false` 明确表示
“目标已存在”而不是“本 Run 执行了”。外部状态命中后还会重新进入当前 Completion Gate：受控
负例让模型请求已存在的 A 发票、而 TaskContract 要求 B 发票，A 的真回执没有触发审批或写工具，
但任务仍被拒绝完成。查询 ambiguous 时审批和工具也都是 `0/1` 并失败关闭。

但这只抑制顺序重复：两个并发 fresh Run 可能都在执行前看到 absent。生产要加 owner-scoped
共享 claim/CAS、限制为单 writer，或把业务幂等键交给下游。没有这层时我不会说“全局幂等”。

### Probe 超时后迟到结果怎么办？

Runtime 到期后触发 AbortSignal，并在写 Ledger 前再次检查取消状态。即使底层查询忽略取消，
迟到 verdict 也不能把已经持久化的 `ambiguous` 偷改成 `committed`。

### `not_committed` 后为什么还要重新审批？

查询只证明重试安全，不等于旧审批授权新 attempt。新 Action 重新经过 Permission/Human Gate，
Ledger 保存新的 approval ID 与精确 ActionBinding 摘要；旧审批只属于旧动作。

ActionBinding 的 digest 还覆盖业务键、effect digest、Probe ID 和 Runtime 生成的
`externalEffectPreview`，并单独绑定 Adapter 判定的 semantic action kind；Gate 与 owner API
会把底层 `browser_click` 显示为业务 `submit`，同时展示脱敏后的 canonical effect JSON，因此审批
不是只绑定一个可能变化的 click selector 或不可读哈希。若 preview 含 secret 或超过完整展示
上限，`approve_and_execute` 不会出现。真实产品下一步是把该 JSON 渲染成金额、币种、附件版本
等字段级 diff，而不是改变已绑定的语义。

### 两个恢复进程会不会都继续写？

Control RunService 用 `recordRevision + runRevision + attempt` 保证两个同 epoch resume 命令只有
一个创建下一 attempt；同一 Web Server 还会在存在 live execution 时拒绝恢复，旧 attempt 的
晚到结果也不会进入新记录。但这不是第三方系统可执行的 fencing token：若旧 worker 在另一个
进程成为 zombie，它可能在新 attempt 查询到“尚未提交”之后才完成旧点击。生产上必须先确认
旧沙箱/浏览器执行者已终止或让执行租约失效，并优先把业务幂等键传给下游；做不到时不能自动
恢复写入，只能保持 ambiguous。Session 是事实日志，不是锁，直接 SDK 更不承诺跨进程单写者。

### 回执文件被换了怎么办？

终态事件同时保存公开 ArtifactRef 和内部存储引用。恢复时在 Artifact Store 根目录内重读，
校验引用、SHA-256、Action ID、业务键、动作类型和 Probe；event verdict 的确认号、时间、证据、
summary、effect 也必须与实体逐字段相同。任一侧缺失或单改都在 Completion 前失败。
这是损坏/单侧篡改检测，不是密码学信任根；能同时重写 Session 事件与文件的本机攻击者仍需
签名链或远端 append-only 审计来约束。

写入时也不能只相信 Store 返回的 hash：persistence sanitizer 可能合法地改变内容并为新内容生成
新 hash，却恰好改坏业务键。我在 terminal event 前立刻重读并校验语义；不匹配只留下 orphan，
不会让当前进程先通过 Completion、等重启才暴露。

### 写了回执但 committed event 失败呢？

Receipt Store 先 fsync 文件和新目录项，再允许 committed event fsync；Store 不提供 durable
write 能力时直接失败。若回执成功而 event callback 报错，不能仅凭异常判断 event 是否落盘：
它可能在 append 前失败并留下不可达 orphan，也可能已经 fsync 但 ACK 丢失。恢复必须重读
durable journal；前者保持未决并重新 Probe，后者恢复 committed。反方向如果终态事件存在但
回执不可读，恢复失败关闭。当前未实现 orphan 自动修复/GC，这是明确的可用性增强项。

### Session 日志只写了半条怎么办？

不能跳过坏行继续把后面的 `committed` 当真。当前 JSONL 解析会返回带路径和行号的
`SESSION_JSONL_CORRUPT` 并阻断恢复；同一进程内又用共享 append 尾队列保证普通与 durable
writer 的调用顺序。没有跨进程 writer lease 时，我也不在读路径自动截断尾部，因为修复动作
可能覆盖另一个进程刚追加的数据。生产增强应在获得独占租约后隔离坏尾、原子修复，再重新 Probe；
或者升级为带 checksum/sequence 的 framed WAL。

### 多租户场景下，本地回执会不会写到别人的目录？

业务键必须包含租户作用域，但这还不够；本地 `runId / sessionId` 也会进入 Trace、Session 和
Artifact 路径。我把它们在 Contract 与各存储边界限制为 canonical 单路径组件，并在 restore 时
重验 `session.json` 中四条路径必须精确落在当前 session root。`../`、斜杠、控制字符和被替换的
绝对 events 路径都会在读写前失败。这里解决的是本地路径隔离；Probe 使用哪套门户凭证仍是
Adapter/密钥系统的责任，生产上还应把 owner-scope digest 纳入 binding 与审计。

### 旧 v1 绑定没有 digest 怎么迁移？

不猜 hash。v1 历史仍可只读对账旧动作；若模型提出同键新写入，Runtime 失败关闭并要求人工
确认或生成新语义键。新动作只允许写 v2。

### Completion 为什么还要回执 Artifact？

Ledger 证明每个目标业务键的状态；Artifact 保存可独立复核的确认号内容。批量 Contract 同时
要求逐键 `performed`，并让每份 `external_action_receipt` 的 binding 覆盖同一组业务键；既避免
一张成功覆盖整批，也避免四份无关回执只靠数量通过。

另外我封死了一个迁移漏洞：旧 Runtime 的 `performed` 只表示本地工具成功，带 external binding 的
动作无论在线还是 restore 都不能使用它；唯一成功终态是 `committed + verdict + receipt`。

### 这是不是 exactly-once？

不是通用 exactly-once。它提供的是：在已适配、可查询或幂等的外部系统中，尽量避免重复并对
不确定状态失败关闭。不可查询、不可幂等的网站只能人工核对。

### 真实门户现在能让 Agent 自动点最终提交吗？

默认不能，真实门户也还没有试点数据。但本地单动作的通用协议已经实现：旧 `approve`
对任一 v2 已对账外部副作用都只表示知晓并停手；只有可恢复条件全部成立时，审批请求才额外列出
`approve_and_execute`。这里的成立条件包含 fresh-run 权威预检已开启、Session 确实
durable，且 Runtime 持有绑定当前 run/attempt 的精确 `SessionRef`。
该决定使用 `approval-binding/v2`，绑定 owner-scoped Approval Store、
exact Action/effect/origin、有效期和一次性 nonce；`upload/send/publish/submit/payment` 的已对账
Sink 都不接受旧 v1 approve。受控 send/payment 夹具已走通
`authorized -> executing -> executed -> committed`，send 的 awareness 负例写调用为 `0 / 1`。
同一条通用 Agent Loop 也新增了单张发票 submit 正例：opaque click 经可信 Adapter 升级后，
使用 v2 执行决定、只调用一次工具，并拿到独立确认号和 receipt Artifact。

owner-scoped Web Control Service 当前反而会拒绝 `allowFinalSubmitExecution=true` 或
`allowExternalActionExecution=true`：v2 还没有
结构化 owner digest，不能只靠业务键里的 tenant 字符串开放多租户机器写。要到 v3 的 scope
替换、跨租户同号和 Probe 凭证绑定验收通过后才解除这个 No-Go。

不能顺手升级的是：四张发票 POC 仍由受控 batch harness 执行，正式 `BatchApprovalBinding`
还没实现；真实门户仍按 query-only -> 人执行单张 -> 显式开启机器单张的顺序验证。

### 审批已经成功落盘，进程在唤醒 Agent 前崩溃怎么办？

这时不能把 durable decision 当成 delivered decision。启动恢复会保留 v2 决定作为审计事实，
但旧 attempt 失败关闭且不执行网页动作；正常仍为 pending 的审批则继续等待。由于当前还没有
跨 attempt 的 Approval Delivery Receipt，新 run 必须先对账门户，再重新审批。这样牺牲一次
无感继续，换取不把一次用户决定错误重放成第二次副作用。

## 可说结论与证据

| 可说结论 | 代码锚点 | 可重复验证 |
| --- | --- | --- |
| 外部执行边界会 durable journal | `src/task/action-ledger.ts`、`src/runtime/local/agent-loop.ts` | `npm run test:action-reconciliation` |
| Probe 三态、独立证据、超时 fencing | `src/task/action-reconciliation.ts` | `npm run test:action-reconciliation`、`npm run test:agent-loop` |
| 效果指纹和 v1/v2 安全升级 | `src/task/action-ledger.ts`、`src/task/action-reconciliation.ts` | `npm run test:action-reconciliation`、`npm run test:agent-loop` |
| opaque click 的可信业务意图升级与分类冲突拒绝 | `src/task/action-reconciliation.ts`、`src/runtime/local/agent-loop.ts` | `npm run test:action-reconciliation`、`npm run test:agent-loop` |
| 审批引用跟随 Action 且重试重新审批 | `src/task/action-ledger.ts`、`src/runtime/local/agent-loop.ts` | `npm run test:agent-loop` |
| 知晓与机器执行授权分离 | `src/sdk/human.ts`、`src/task/contracts.ts`、`src/security/sink-policy.ts`、`src/control/durable-human-gate.ts` | `npm run test:agent-loop`、`npm run test:security-sink-policy`、`npm run test:control-plane` |
| ActionBinding 闭集校验与完整 Probe 身份投影 | `src/task/contracts.ts`、`src/public/clients.ts`、`src/web/server.ts` | `npm run test:generic-contract`、`npm run test:m5-release` |
| Permission→Approval 跨模块 handoff 绑定当前 contract/session/digest | `src/runtime/local/agent-loop.ts`、`src/control/durable-human-gate.ts` | `npm run test:control-plane`、`npm run test:control:m6` |
| 执行终态与 Workflow Completion 对齐 | `src/workflow/workflow-engine.ts`、`src/workflow/workflow-transition.ts` | `npm run test:agent-loop`、`npm run test:runtime-rewrite` |
| 回执实体与哈希在恢复时重验 | `src/task/action-reconciliation-artifact.ts`、`src/sdk/web-task.ts` | `node scripts/generic-web-task-resume-runtime-test.mjs` |
| receipt-first/event-second 两个失败方向 | `persistExternalActionReconciliationAttempt` | `npm run test:action-reconciliation` |
| 同进程追加有序、损坏日志失败关闭 | `src/session/session-store.ts`、`src/session/transcript.ts` | `npm run test:session`、`npm run test:action-reconciliation` |
| run/session 路径身份与恢复路径绑定 | `src/security/storage-identity.ts`、`src/session/session-store.ts` | `npm run test:generic-contract`、`npm run test:security:m6` |
| 每业务键 Completion | `src/task/completion-contract.ts` | `npm run test:action-reconciliation` |
| fresh Run 权威预查、零审批/零写抑制顺序重复 | `src/runtime/local/agent-loop.ts` | `npm run test:invoice-runtime-single` |
| 外部事实命中后重跑当前 Contract、同轮副作用串行 | `src/runtime/local/agent-loop.ts` | `npm run test:invoice-runtime-single` |
| 首个外部写回读未决时阻断同轮后续副作用 | `src/runtime/local/agent-loop.ts` | `npm run test:invoice-runtime-single` |
| strict 启动对账后仍未决时在模型前阻断 | `src/sdk/web-task.ts` | `node scripts/generic-web-task-resume-runtime-test.mjs` |
| off-contract 业务键不提供机器最终提交 | `src/runtime/local/agent-loop.ts` | `npm run test:agent-loop` |
| WebTask Contract/Policy 输入在异步执行前脱离调用方可变引用 | `src/task/contracts.ts` | `npm run test:generic-contract` |
| 缺失 TaskPolicy 时 Probe 前失败关闭 | `src/security/sink-policy.ts`、`src/runtime/local/agent-loop.ts` | `npm run test:agent-loop` |
| 外部动作 Policy 显式 fsync 后才允许 proposal | `src/runtime/local/agent-loop.ts`、`src/session/session-recorder.ts` | `npm run test:agent-loop` |
| 机器最终提交配置必须同时保持 strict + preflight | `src/web/server.ts` | `npm run test:control:m6` |
| 4 张发票受控页面恢复 | `scripts/invoice-portal-poc-test.mjs` | `npm run test:invoice-portal-poc` |
| 控制面并发恢复单写者 | `src/control/run-service.ts` | `npm run test:control:m6` |
| 审批已落盘但未交付的启动恢复 | `src/control/recovery-service.ts` | `npm run test:control-plane` |
| Control owner scope、Artifact/安全边界精确 Session/Checkpoint、闭合持久化 schema 与 Approval event epoch 交叉绑定 | `src/control/store-contracts.ts` | `npm run test:control-store-contract` |

## 指标身份证

当前只能引用受控夹具：

- 崩溃矩阵：符合预期的边界 / 注入边界 = `7 / 7`。
- POC 回执恢复：找到确认号的发票 / 目标发票 = `4 / 4`。
- 恢复新增门户记录：恢复阶段新增记录 / 恢复前记录 = `0 / 4`。
- 回执 Artifact：生成且进入 Completion 的回执 / 已确认发票 = `4 / 4`。
- 并发恢复：获得新 attempt 的命令 / 同 epoch 并发命令 = `1 / 2`。
- Control owner/artifact/session/checkpoint 错绑：被拒绝 / 注入案例 = `7 / 7`。
- Control 持久化 schema 关闭：被拒绝 / 注入案例 = `8 / 8`。
- ApprovalBinding 消费失败关闭：被拒绝 / 时间与 schema 注入案例 = `5 / 5`。
- Completion 时间有效性失败关闭：未产生 false terminal / 时间与空值注入案例 = `7 / 7`。
- EvidenceRef 契约闭合：被拒绝 / authority、时间、空值、审批-动作绑定注入案例 = `5 / 5`。
- Context 时间/墓碑失败关闭：被拒绝或失去 prompt/sink 资格 / 注入案例 = `4 / 4`。
- ActionLedger 恢复日志闭合：被拒绝 / schema、时间、身份注入案例 = `4 / 4`。
- ActionLedger 墙钟回拨：仍保持非递减且可恢复 / 回拨夹具 = `1 / 1`。
- receipt verdict 在线/恢复同强度：恢复时被拒绝 / schema、时间、evidence、状态注入案例 = `5 / 5`。
- 伪终态接受：被接受的伪终态 / 固定伪终态夹具 = `0 / 6`。
- opaque click 意图升级：进入完整外部动作状态机 / 受控升级案例 = `1 / 1`。
- 分类冲突：工具调用前被拒绝 / Runtime 与 Adapter 冲突案例 = `1 / 1`。
- Adapter 参数改写：工具前被拒绝 / 意图与 binding 两类改写注入 = `2 / 2`。
- 跨 action kind 复用业务键：被拒绝 / 在线 Ledger、restore、Agent Loop 三条注入 = `3 / 3`。
- Probe 改写验证输入：副作用终态前被拒绝 / envelope 与嵌套 Action 注入 = `2 / 2`。
- Probe 异步修改 verifier ID：被拒绝 / 身份 TOCTOU 注入 = `1 / 1`。
- Probe verdict 可变 accessor：一次物化后稳定校验 / accessor 注入 = `1 / 1`。
- Probe verdict 未知权限字段：终态前被拒绝 / `writeAuthority` 扩展注入 = `1 / 1`。
- 调用者用错业务键查询：Probe 前被拒绝 / durable binding 覆盖注入 = `1 / 1`。
- strict reconciliation 缺 binding：工具/模型前被拒绝 / 新动作与历史恢复注入 = `2 / 2`。
- strict opaque click 分类：无结论被拒绝、明确 non_external 可执行 / 分类案例 = `2 / 2`。
- 低风险 click 的有效风险升级：外部 send 进入 L3、payment 进入 L4/critical / 受控升级案例 = `2 / 2`。
- Generic SDK strict 恢复：模型前拒绝 / unbound 与缺 Probe 历史 = `2 / 2`。
- 服务端插件边界：owner scope 冻结、未知字段拒绝、driver 互斥 / 三项契约 = `3 / 3`。
- 回执租户绑定：SDK 出口 owner scope 匹配 / 恢复回执案例 = `1 / 1`。
- Completion 回执唯一性：同 Artifact ID 改绑另一业务键仍被拒绝 / 重复 ID 注入 = `1 / 1`。
- 单动作机器执行授权：v2 决定落盘并走完 committed / 受控 invoice submit + payment 案例 = `2 / 2`。
- 非 final-submit 外部效果：普通 approve 后写调用 / send awareness 案例 = `0 / 1`；
  `approve_and_execute` 后完整 committed / send execution 案例 = `1 / 1`。
- 通用 Runtime 发票对齐：确认号和 receipt Artifact 均生成 / 单张发票 submit 案例 = `1 / 1`。
- fresh Run 顺序重复抑制：Approval、写工具调用 / 已存在同键案例 = `0 / 1`、`0 / 1`。
- 同轮首个写后对账未决：后续写调用 / 剩余外部动作 = `0 / 1`。
- strict 重启对账后仍未决：模型调用、写调用 / ambiguous 恢复案例 = `0 / 1`、`0 / 1`。
- 真实回执但目标错配：被 Completion 接受 / 已存在 A、Contract 要求 B 的案例 = `0 / 1`。
- off-contract 最终提交：提供 `approve_and_execute`、写工具调用 / 未存在 A、Contract 要求 B 的案例 = `0 / 1`、`0 / 1`。
- 输入快照 TOCTOU：调用方后续修改 goal、Contract、Context 后仍保持不变的快照字段 / 注入字段 = `3 / 3`。
- 同一模型轮的双副作用顺序：符合 `preflight -> tool -> reconcile` 的动作 / 两个动作 = `2 / 2`。
- ambiguous preflight 失败关闭：Approval、写工具、伪回执 / 受控案例 = `0 / 1`、`0 / 1`、`0 / 1`。
- durable 但缺当前 run/attempt SessionRef：出现机器执行选项、写工具 / 注入案例 =
  `0 / 1`、`0 / 1`。
- Policy 落盘后、proposal 前崩溃：遗留 proposal、Probe、写工具调用 / 注入案例 = `0 / 1`、`0 / 1`、`0 / 1`。
- 危险插件配置：启用机器提交同时关闭 strict、关闭 preflight，或 final/general capability 缺 v3
  owner binding 均拒绝 / 注入配置 = `4 / 4`。
- Workflow 收口：业务键 + receipt 已满足后正确解除 final-submit handoff / 单张发票案例 = `1 / 1`；仅有执行决定仍不解除 = `0 / 1`。
- 部分批次不误完成：1 个 committed key 未解除 2-key Contract / 受控负例 = `0 / 1` 误解除。
- 旧 approve 隔离：知晓决定未执行已对账 send/submit、v1 binding 未通过 Sink / 负例 = `3 / 3`。
- 未提供的执行决定：内存 Queue、Agent Loop、owner API 均拒绝 / 越权注入 = `3 / 3`。
- 跨语义重用审批：被 Sink 接受 / `type_or_paste` binding 搭配执行决定冒充 `submit` = `0 / 1`。
- 审批终态闭合：裸 `approved` 与“状态/决定冲突”均在落盘前拒绝 / 语义绕过注入 = `2 / 2`。
- 审批交付故障窗：已落 v2 决定在重启后被隐式执行 / 注入故障窗 = `0 / 1`；旧 attempt 失败关闭。
- Durable Gate 交接错绑：外部 contract、外部 run envelope 被拒绝 / 注入案例 = `2 / 2`。
- SDK 响应资源错绑/乱序：envelope、Approval、Artifact、Event 的 run/owner/schema/time/session/sequence 注入被拒绝 = `12 / 12`。
- 同 epoch 终态竞争：late runtime 覆盖 durable control terminal / 注入案例 = `0 / 1`。

不能把它们说成生产恢复率、生产重复率或客户成功率。上线后才采集：对账覆盖率、自动收敛率、
重复副作用率、错误终态率、P95 对账延迟和人工接管率。

## 事实分级：现场不要混层

| 级别 | 当前可以说 | 不能顺手升级成 |
| --- | --- | --- |
| A：源码与回归已验证 | 状态机、durable 顺序、恢复接线、回执重读、路径绑定、opaque click 意图升级、v2 单动作执行授权、fresh Run preflight | 已部署、已有客户、线上 SLO、任意 click 都能被正确理解、原子跨 Run claim |
| B：受控环境结果 | 7/7 崩溃边界、4/4 回执、0/4 恢复新增记录、0/6 伪终态接受、fresh Run 零审批零写 | 生产恢复率 100%、生产重复率 0、并发 Run exactly-once |
| C：真实门户试点设计 | query-only 影子、稳定窗口、只读凭证、人工核对台、Go/No-Go | 已证明任意门户、自动 exactly-once |

被问“上线效果”时，先回答“还没有真实试点分母”，再给 B 级事实和 C 级采集计划；不要用更响亮但
无法核验的数字填空。

## 三分钟 Demo 顺序

1. 打开 `/poc/invoice-portal`，展示 6 张中隔离重复/异常，只准备 4 张。
2. 补充缺失字段，展示最终提交的精确四项审批。
3. 批准后让门户生成 4 个确认号，模拟本地确认号未持久化。
4. 展示恢复只查询、不再点击，Ledger 从 `executing` 收敛到 `committed`。
5. 展示 4 个 receipt Artifact 和 Completion 通过。
6. 最后主动说：这是本地受控 POC，下一步才是真实门户只读 Probe 和生产指标。

## 最能体现 ownership 的调试细节

第一处是 Completion 的混合终态：一张发票 `performed`、另一张 `not_performed` 时，旧的
“存在一个匹配结果”语义可能误过。我把默认 Action Boundary 改成所有终态一致，批量任务再
显式逐 `businessKeys` 判断。

第二处是安全与审计字段冲突：最初审批引用字段叫 `authorization`，写时安全器把它当 HTTP
凭证整段脱敏，导致内存测试通过但 durable restore 失败。集成测试暴露后改为结构化
`actionDecision`，并增加“落盘后与内存一致”的回归。这说明可靠性不能只测单模块状态机，必须
跨 Permission、redaction、Session 和 restore 走完整链。

第三处是回执校验最初只有正向关系：“出现 receipt 时验证它”，但没有反向要求“外部
`committed` 必须有 receipt”。删掉 event 中的回执字段后，Ledger 仍可能恢复成 performed。
我把恢复门禁改为同时要求 verdict、ArtifactRef 和 storage ref，并补了删字段负例；同时发现
递归创建目录时只 fsync 最深目录也不完整，于是对首次创建的父目录项逐级建立 durability barrier。
继续把在线与恢复校验对齐时还踩到一个时序细节：外部 `observedAt` 本来就发生在本地
`committed` event 落盘前，不能错误地要求它晚于 terminal event。现在用上一条 unresolved
Ledger 状态作为下界，并保留 bounded future-skew 检查；这样既拒绝旧回执，也不把正常
“先观察、后落终态”误判为伪证据。

第四处是 Adapter 的 `Readonly` 最初只有 TypeScript 编译期含义。站点代码仍可在运行时改写
`request.args`，造成早期 Policy 与最终工具调用看到不同 payload。我改成对 resolver 输入做
deep-clone + deep-freeze，并对意图和 binding 两条路径都注入恶意改写；两次都在副作用前失败，
原始工具参数保持不变。

第五处是授权语义：最初 ApprovalQueue 虽然存了 `allowedDecisions`，resolve 时却没有校验。
如果直接加一个执行决定，恶意 Gate 可以凭空返回它。我先让 Queue 和 durable Store 都验证
权威请求中的决定闭集，再用 `approval-binding/v2` 区分知晓与执行；owner API 伪造未提供
的 `approve_and_execute` 也保持 pending。继续攻击时还发现调用者可以绕过决定、只写
`approved`，或写出“状态 denied、决定 approve”这种矛盾审计记录；现在 approved/denied
必须携带显式决定，终态还必须与决定一一对应。

第六处是审批双写：owner API 已把 `approved_and_execute` 持久化，但进程可能在唤醒等待中的
Agent Loop 前崩溃。若只看审批终态，重启后隐式执行会把“用户决定”误当成“决定已交付”。
启动恢复现在区分正常 pending wait 与 orphan terminal decision：前者继续等待；后者保留审批
审计、把旧 attempt 失败关闭且不重放动作。生产上的下一步是引入独立 delivery receipt，再决定
能否在新 attempt 安全继续；当前选择重新对账、重新审批，而不是猜测交付成功。
同时，失败关闭会 abort 同进程 controller；settler 若随后返回，先承认已经持久化的 terminal，
不能再把 `failed` 改成 `cancelled/completed`。

第七处是两个正确模块组合后仍然矛盾：Agent Loop 已用 v2 授权并拿到 committed 回执，但旧
Workflow Engine 仍把页面上的 final-submit 按钮视为永久人工 handoff，所以动作成功、任务却
永远 blocked。我没有因为“用户批准了”就清 blocker，而是让 Runtime 从 Contract 中提取精确
submit/payment 业务键，要求这些键的 performed Action Boundary 和 immutable receipt Artifact
子集都满足，才传入 verified completion fact。只有决定、ToolResult 或页面成功文案都不能解锁。

受控 POC 中四项共享一个批次 decision ref；通用 Runtime 的正式 BatchApprovalBinding 还没有
完成。面试时应主动把它作为下一步，而不是把 POC harness 说成已上线的通用批量授权。

## 不要说的话

- “我们实现了任意网站 exactly-once。”
- “7/7 说明生产恢复率 100%。”
- “Probe 写了 read_only，所以绝对不可能有副作用。”
- “一个确认号说明整个批次都提交成功。”
- “Control Plane CAS 成功，所以旧 worker 绝不可能再写外部门户。”
- “没适配业务键和 Probe 的第一次外部动作也能自动恢复。”
- “单动作执行协议通过夹具，所以真实门户和批量授权已经可上线。”

## 面试前自测

1. 不看文档，说清 truth state、retry unit、recovery owner、completion predicate。
2. 解释 `executed` 为什么不能直接投影成 `performed`。
3. 解释同业务键不同 effect digest 为什么不能自动生成新键继续执行。
4. 说出 receipt 失败、event 前失败、event fsync 后 ACK 丢失三种方向分别如何处理。
5. 说出当前三项最重要的事实边界。
6. 回答一个普通 `browser_click` 怎样进入外部动作状态机，以及哪些 click 仍不在覆盖范围内。
7. 解释为什么真实 Adapter 先做服务端可信插件，而不是直接暴露公共 npm callback。
