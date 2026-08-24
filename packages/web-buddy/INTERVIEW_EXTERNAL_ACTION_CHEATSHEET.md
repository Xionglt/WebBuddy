# Web Buddy 面试一页卡：发票门户的可证明执行

## 首讲结论

> 我最值得讲的改进不是再加一个 Agent，而是解决网页副作用的真相问题：客户门户可能已经
> 收到发票，但进程在本地保存确认号前崩溃。恢复时不能因为本地没写成功就再点一次。我把
> 外部动作做成 durable intent、业务键、只读对账和回执驱动的完成闭环；证据不足就失败关闭。

## 为什么是这个场景

供应商财务向客户门户提交发票，兼具四个特点：重复提交有业务损失、第三方网页不参加本地
事务、发票有稳定业务身份、门户确认号可作为独立证据。它比“Memory 检索更准”更能同时体现
后端状态建模、Agent 边界、安全审批、故障恢复和 Eval。

## 30 秒版本

> Web Buddy 原来的风险是：门户已落单，本地 ToolResult 还没持久化就崩溃。恢复后盲重试会
> 重复入账。我把工具返回和业务成功拆成 `executed` 与 `committed`：动作前先 fsync 意图和
> 业务绑定，审批前先按业务键查一次权威状态，执行后仍由只读 Probe 回读确认号；只有独立回执
> 才完成，明确不存在才重新审批，未知就转人工。

## 90 秒版本

> 根因是跨本地 Runtime 和第三方门户的双写故障窗。本地“没有成功记录”不等于外部“没有
> 执行”，所以 click 重试不是正确抽象。
>
> 我的最小闭环有四层。第一，可信站点 Adapter 把普通 `browser_click` 映射成业务 `submit`，
> 并给出 tenant-scoped business key、canonical effect 和真实 sink origin；Runtime 自己计算
> effect digest，并生成脱敏、完整、受 ActionBinding 保护的 effect preview；无法安全完整展示
> 就不提供机器执行。底层工具名和语义 action kind 都被绑定，审批看到的是 `submit` 而不是
> `browser_click`。第二，先 durable 跑 Sink Policy，未 block 才写 `proposed`、用只读 Probe 做
> preflight，
> 最后才进入精确审批；
> fresh Run 若发现同键已完成，审批和写工具都是 0 次，但这个外部事实还必须再次通过当前
> TaskContract；查到别的发票真回执也不能把当前任务判完。第三，用户必须显式选择
> `approve_and_execute`，而且只有当前 Contract 明确要求同一业务键和 receipt，且
> durable Session 提供当前 run/attempt 的精确 `SessionRef` 时才提供这个选项；之后先
> fsync `executing` 再点页面。ToolResult 只到 `executed`，回读
> 确认号才到 `committed`。第四，Completion 同时要求精确业务键和 immutable receipt，不能靠
> 模型总结或页面“成功”文案。
>
> 我用 7 个崩溃边界、9 个协议场景和 4 张发票 POC 验证。受控环境里恢复找回 4/4 确认号，
> 恢复新增门户记录 0/4，6 个伪终态接受 0 个；这些不是生产指标。preflight 只能抑制顺序重复，
> 并发 Run 仍需共享 claim、单 writer 或下游幂等键，因此我不宣称任意网页 exactly-once。

## 白板只画这条线

```text
外部门户记录 = 效果真相
本地 Ledger  = Runtime 对真相的知识

durable policy (unblocked)
  -> durable proposed
  -> read-only preflight
       committed       -> receipt -> 完成（本 Run 未执行）
       ambiguous/error -> 人工核对（零审批、零写）
       not_committed    -> approve_and_execute
                            -> fsync executing
                            -> click -> executed
                            -> read-only Probe
                                 -> committed + receipt -> 完成
                                 -> ambiguous          -> 人工核对
```

## 我的 ownership

> 浏览器执行、Permission、Session、Completion 和 Control Plane 原来就有。我审计 Action Ledger
> 时发现，它无法表达“外部已生效但本地未知”，还会把业务完成和 ToolResult 混在一起。我负责
> 新增并贯通 in-doubt 状态机、v2 业务绑定、精确执行决定、权威 preflight、receipt durability、
> 恢复与 Completion，并用跨模块故障注入把组合漏洞找出来。

最值得讲的三个调试点：

1. `committed` 有 event 却没有 receipt 也会误完成，于是补成 receipt-first、event-second，并在
   恢复时重读实体、校验 hash 和业务绑定。随后又发现恢复侧对 verdict 的规则弱于在线 Probe，
   继续补齐闭合字段、时间单调、evidence 唯一性和 committed 状态约束。
2. 审批已经落盘却未交付给 live Agent 时崩溃，不能在新 attempt 重放；旧 attempt 失败关闭，
   先对账再重新审批。
3. 预检一度把“查到真实回执”直接等同于整项任务完成；反过来，错误 key 还没提交时也不能
   先执行再等 Completion 报错。现在 Contract 精确 key + receipt 既是提供机器执行选项的前置，
   也是最终完成条件；真回执但目标错会被拒绝，尚未提交的错 key 则根本不出现
   `approve_and_execute`。
4. 同一模型轮次提出两张发票时，第一张 click 返回后的权威回读可能仍是
   `ambiguous`。如果只防同 key 重试，第二张仍会扩大未决副作用集。现在 strict 模式会当场
   阻断整轮；受控夹具中后续写调用为 `0 / 1`。同一不变量也贯通重启：启动对账后仍未决时，
   在模型启动前整体转人工，不用新业务键扩大未决集。

## 核心受控证据

| 要证明什么 | 分子 / 分母 | 当前结果 |
| --- | --- | --- |
| 崩溃边界行为符合预期 | 通过边界 / 注入边界 | `7 / 7` |
| POC 恢复没有再写门户 | 恢复新增记录 / 恢复前记录 | `0 / 4` |
| 伪终态不会被接受 | 接受的伪终态 / 固定攻击夹具 | `0 / 6` |
| fresh Run 顺序重复抑制 | Approval、写调用 / 已存在同键案例 | `0 / 1`、`0 / 1` |
| 真实回执但目标错配 | 被 Completion 接受 / 错业务键案例 | `0 / 1` |
| 未完成的错 key 机器执行 | 出现执行选项、写调用 / off-contract 案例 | `0 / 1`、`0 / 1` |
| 不可完整审阅的 effect | 出现机器执行选项 / secret、超长案例 | `0 / 2` |
| 缺 authoritative preflight | 出现机器执行选项、写调用 / send 案例 | `0 / 1`、`0 / 1` |
| 非 durable Session | Probe、Approval、写调用 / 注入案例 | `0 / 1`、`0 / 1`、`0 / 1` |
| 缺当前 run/attempt 的 SessionRef | 出现机器执行选项、写调用 / durable 但未绑定案例 | `0 / 1`、`0 / 1` |
| 跨语义重用审批 | 被 Sink 接受 / `type` binding 冒充 `submit` 案例 | `0 / 1` |
| send 仅知晓不执行 | 写调用 / v2 send awareness 案例 | `0 / 1` |
| 同轮两个副作用保持顺序 | 符合 `probe→tool→probe` 的动作 / 动作数 | `2 / 2` |
| 首个写后对账未决时停止扩张 | 后续写调用 / 同轮剩余外部动作 | `0 / 1` |
| strict 重启对账后仍未决 | 模型调用、写调用 / ambiguous 恢复案例 | `0 / 1`、`0 / 1` |

运行证据：

```bash
npm run test:invoice-runtime-single
npm run test:action-reconciliation
npm run test:invoice-portal-poc
npm run test:release-gate
```

## 高频追问短答

**为什么不能重试 click，ToolResult 也不够？** 断网时无法区分请求未送达和门户已落单；
本地返回只证明交互过程，业务终态必须由确认号或权威记录回读证明。

**普通 click 怎么知道是提交？** 不是 LLM 自报；受信站点 Adapter 用已审核页面状态把它映射成
`submit + business key + effect + Probe`，冲突或缺映射时工具前失败。

**为什么 preflight 也要在 Policy 后？** 只读仍是外部访问；被目标站点或数据策略拒绝的动作，
Probe 调用、Approval 和写工具都必须是 0 次。

**为什么还要 effect digest？** 发票号只标识对象，金额、附件版本或目标 origin 变化后，旧回执
不能证明新请求；同键不同效果必须失败关闭。哈希给机器验一致性，绑定内的 effect preview 给人
审阅；preview 含 secret 或超过完整展示上限时，只能知晓或接管，不能授权机器执行。

**查不到为什么不能重试，这是 exactly-once 吗？** 空查询可能是最终一致。只有越过可见窗口并
证明 `retrySafe=true` 才开新 attempt；每轮仍重做 preflight。它只抑制顺序重复，并发 Run 还需
共享 claim、单 writer 或下游幂等，所以不是通用 exactly-once。

**审批为什么分两个词？** `approve` 对已对账外部副作用只表示知晓；机器执行必须是绑定 exact
action/effect/origin/expiry/nonce 的 `approve_and_execute`，且 Contract 要明确覆盖同一 key + receipt；
否则该选项不出现。Sink 最后还会重验 semantic action kind，不能拿一次 `type` 审批去执行
`submit`。

**Probe 查到真回执为什么还不能直接 done？** Probe 只证明“这个业务键的效果存在”；Completion
还要证明“它就是当前 Contract 要求的业务键与回执”。命中时 outcome 仍是业务
`performed`，但 `localExecutionAttempted=false` 明确本 Run 没有获批或点击。

## 主动边界

- 所有数字来自确定性夹具，不是客户生产成功率。
- v2 binding 尚无结构化 `ownerScopeDigest`；owner-scoped Service 因此直接拒绝机器执行开关，
  真实多租户先做 query-only，等 v3 绑定账号、业务键、Probe 凭证和冻结 owner scope。
- 服务端还会拒绝“开启机器最终提交却关闭 strict 对账或 preflight”的自相矛盾配置。
- preflight 抑制顺序重复，不原子解决并发 query-to-write 竞态。
- 四张发票共用一次决定仍是 POC harness；正式 `BatchApprovalBinding` 尚未实现。
- 第三方网页不识别本地 epoch；无法确认旧 zombie 终止且下游不幂等时只能 query-only。

## 真实门户下一步

先做 query-only 影子，再做人点击单张、Runtime 验证，最后才开放机器单张。Go 条件包括：只读
凭证、稳定业务键、跨租户同号真相集、最终一致窗口、精确 effect 回读、人工核对台，以及共享
claim/下游幂等/单 writer 三者至少一项。拿到真实分母后才报告对账覆盖率、错误终态率、重复
副作用率、P95 对账延迟和人工接管率。

## 最后一句

> 这条改进的核心不是“让 Agent 更敢点”，而是把什么时候能点、点过什么、外部到底发生了什么、
> 崩溃后由谁证明、什么证据才算完成，都从模型猜测变成可恢复的确定性协议。
