# Web Buddy 面试官信号映射：为什么先讲外部副作用闭环

这不是“所有公司都一定这样问”的统计结论，而是把当前官方岗位与工程文章里的可观察信号，
映射到 Web Buddy 已有的代码证据。用途是决定首讲顺序，不是替代具体 JD。

## 结论

Web Buddy 最强的定位不是“我也做了一个会点网页的 Agent”，而是：

> 我把一个能操作网页的原型，推进成对外部副作用可恢复、可审批、可验证、敢于失败关闭的
> Runtime；并且能明确说出本地真相、外部真相和当前还没解决的并发/多租户边界。

发票门户“外部已落单、本地确认号未落盘”是最合适的首讲场景。它同时要求后端状态建模、
浏览器语义适配、审批契约、恢复、Completion 和 Eval，且业务损失容易理解。

## 当前官方信号与项目证据

| 外部信号 | 面试官可能在判断什么 | Web Buddy 应给的证据 | 不要说成 |
| --- | --- | --- | --- |
| OpenAI Agent Infrastructure 强调生产 Agent 执行平台与 integrations | 是否只会 Prompt，还是能做 Runtime/平台 | durable Session、Action Ledger、Control Plane、恢复与 owner API | “我做过百万级集群” |
| OpenAI Evals 强调 reliable、reproducible、extendable pipeline 与 golden dataset | 能否把偶现失败变成可复现回归 | 7 个 crash boundary、9 个协议场景、6 个伪终态、release gate | “9/9 就是生产成功率” |
| Anthropic 区分 transcript 与 environment outcome | 是否知道模型说成功不等于任务成功 | 门户记录是 effect truth；ToolResult 只到 `executed`；receipt 才到 `committed` | “页面出现成功文案就完成” |
| Browserbase 强调 verifier、isolation、identity、observability | 是否理解 browser agent 不止是 Playwright wrapper | 只读 Probe、receipt、Trace、owner-scoped Adapter factory 与 v3 No-Go | “能启动 Chromium 就是生产平台” |
| Stripe 的幂等键比较同 key 的请求参数 | 是否能区分对象身份与本次效果 | business key + Runtime-owned effect digest；同 key 不同金额失败关闭 | “有 UUID 就 automatically exactly-once” |
| AWS 明确非幂等操作不应盲目 retry | 是否会按错误类型和副作用语义重试 | `not_committed + retrySafe` 才开新 attempt；ambiguous 转人工 | “任何超时都指数退避重试” |
| Playwright actionability 只保证元素可交互 | 是否把 UI 可点击误当成业务完成 | click 只证明交互条件；业务成功必须由门户回读确认 | “Playwright click 没报错就成功” |
| 小红书 AI Agent 架构岗同时强调 Runtime、复杂状态、Eval/Trace、异常降级，Browser Agent 为加分项 | 是否有系统工程背景，能把 Browser Agent 做成稳定运行时 | 外部真相状态机、失败关闭、崩溃矩阵、可回放回归 | “这一个岗位证明所有公司都考对账” |
| 小红书校招 Agent 平台岗把高可用/可扩展微服务、Workflow/Tool Calling 与可观测可恢复编排并列 | 是否能把 Agent 能力连到后端稳定性与平台交付 | durable Session、恢复 owner、Completion predicate、Control Plane 和 release gate | “定确性夹具已证明高并发生产 SLA” |

来源：

- [OpenAI — Software Engineer, Agent Infrastructure](https://openai.com/careers/software-engineer-agent-infrastructure-san-francisco/)
- [OpenAI — Backend Software Engineer (Evals)](https://openai.com/careers/backend-software-engineer-%28evals%29-san-francisco/)
- [Anthropic — Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Browserbase — Universal Verifier](https://www.browserbase.com/blog/building-verifiers-for-computer-use-agents)
- [Browserbase — Build vs. buy agent infrastructure](https://www.browserbase.com/blog/build-vs-buy-agent-infrastructure)
- [Stripe — Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [AWS — Retry with backoff](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html)
- [Playwright — Auto-waiting/actionability](https://playwright.dev/docs/actionability)
- [小红书招聘 — AI Agent 架构工程师](https://job.xiaohongshu.com/social/position/20400)
- [小红书校招 — AI 应用开发工程师](https://job.xiaohongshu.com/campus/position/18716)

## 国内岗位校准

当前国内官网样本已能直接确认“Agent Runtime + 后端稳定性 + Eval/可观测 +
Browser Agent”的交集，但仍不应包装成“国内面试官共识”。小红书当前官方岗位将面向业务的
Agent Runtime、复杂状态下的可靠执行、Eval/Trace/异常降级和 Browser Agent 实践写入同一张
JD；其校招平台岗又明确要求 Workflow/Tool Calling 任务编排的可观测、可恢复。华为云招聘部门
介绍则把“安全稳定高质量的云服务”、AI 基础设施、Agent 平台与行业规模化落地放在同一条产品主线上：
[华为招聘 — 云计算 BU](https://career.huawei.com/cn/department-list)。

这些信号支持“平台化 + 可恢复稳定交付 + 真实业务场景”的首讲方向，但它们没有直接证明某个岗位
一定会追问“发票副作用对账”。字节官方职位页本轮只能稳定读取职位标题，正文是动态内容，因此
不把搜索摘要写进结论。投具体 JD 时仍要逐条重排本表，外部证据只校准方向，项目源码与面试反馈才决定
最终话术。

## 面试价值排序

1. **真相建模**：外部门户记录是效果真相，本地 Ledger 是 Runtime 对真相的知识；二者不能混。
2. **故障窗**：门户写成功、本地回执写失败时，为什么不能重放 click。
3. **完成谓词**：精确 business key + immutable receipt，而不是模型总结、ToolResult 或审批决定。
4. **授权语义**：`approve` 只表示知晓；`approve_and_execute` 绑定 semantic action、effect、origin、
   preview、expiry 和 nonce；跨 action kind 不能复用。
5. **可复现证据**：故障注入的分子/分母、伪终态负例、fresh Run 零点击，而非一句“比较稳定”。
6. **边界意识**：preflight 不原子解决并发；v2 不证明 owner scope；多租户 Service 因此保持 No-Go。
7. **演进 ownership**：原有 Browser/Session/Permission/Completion 已存在；自己的贡献是发现组合缺口、
   定义最小协议、贯通模块并构造跨模块反例。

## 七个最可能追问

### 1. 为什么不直接重试 click？

连接中断无法区分“请求没到”与“门户已落单”。只有下游幂等键，或权威查询证明
`not_committed + retrySafe`，才允许新 attempt；否则保持 ambiguous。

### 2. ToolResult 为什么不算成功？

ToolResult 是本地交互结果。它可能早于门户落库，也可能在门户落库后丢失。业务终态由
只读 Probe 回读的确认号和 immutable receipt 证明。

### 3. 业务键有了为什么还要 effect digest？

发票号标识对象，不必然标识本次金额、附件版本和目标 origin。旧回执不能证明修改后的效果；
同 key 不同 effect 在工具前失败关闭。

### 4. 用户到底看见并批准了什么？

审批展示 Adapter 判定的 semantic action kind、业务键、目标 origin 和 Runtime 生成的 canonical
effect preview；完整 ActionBinding 被哈希并由一次性 v2 decision 覆盖。secret 或超长 effect 不
提供机器执行，`type` binding 也不能拿去执行 `submit`。

### 5. 这是不是 exactly-once？

不是。当前抑制顺序重复，并对不确定状态失败关闭。两个并发 fresh Run 仍可能同时看到 absent；
生产需共享 claim/CAS、单 writer 或下游原生幂等键。

### 6. 多租户怎么保证不会查错账号？

现在只证明 Factory 收到冻结 owner scope，v2 binding 没有 Runtime-owned owner digest。因此
owner-scoped Service 直接拒绝机器最终提交；先 query-only，完成 v3 scope/credential/receipt
交叉绑定与跨租户同号验收后再开放。

### 7. 这些数字可信吗？

只说受控夹具：7/7 crash boundaries、9/9 protocol cases、0/6 false-terminal acceptance、
4/4 receipt recovery、0/4 recovery writes。每个数字同时说明 fixture、分母和不能外推的范围。

## 10 分钟面试展开顺序

1. **0:00–0:30 场景与损失**：门户已落单、本地确认号未落盘；盲重试会重复入账。
2. **0:30–2:00 根因与最小解**：跨系统双写没有共同事务；拆出 effect truth、Ledger knowledge、
   business key、Probe 和 receipt。
3. **2:00–4:00 一条故障链**：`proposed -> authorized -> executing -> executed -> committed`，重点讲
   为什么 crash after click 只能先查、不能先点。
4. **4:00–6:00 一个组合漏洞**：任选 receipt-first、approval delivery，或 Permission→Approval
   session/digest handoff；说明如何用负例逼出修复。
5. **6:00–8:00 证据**：只报有分母的 crash/eval/fresh-run 数字，并说测试夹具边界。
6. **8:00–10:00 主动收口**：preflight 不解决并发；v2 不证明 owner scope；真实门户先 query-only。

## 自测评分（10 分）

| 维度 | 2 分答案 | 0 分危险信号 |
| --- | --- | --- |
| 业务 | 能说清重复发票的具体损失 | 只说“提升稳定性” |
| 真相 | 区分门户 effect truth、Ledger knowledge、模型文本 | 把 ToolResult/成功文案当完成 |
| 协议 | 说清 retry unit、审批绑定、恢复 owner、完成谓词 | 只背幂等、重试名词 |
| 证据 | 每个数字有 fixture、分子、分母、负例 | 把 9/9 当生产成功率 |
| Ownership | 说明原有能力、自己发现的组合缺口与未完成边界 | 把整个 Runtime 都说成自己从零完成 |

达到 8 分再作为首讲项目；若业务或真相任一项为 0，先回到 30 秒版本，不要继续堆架构名词。

## 一句话取舍

> Memory 解决“过去什么经验值得找回来”，这条工作解决“外部到底发生了什么、崩溃后谁来证明”。
> 对有财务副作用的浏览器 Agent，后者是当前更高优先级的生产门槛。
