# 接手：网页代办箱 POC

## 产品判断

Web Buddy 最有力的第一款产品，不是再做一个“输入网址和 Prompt”的通用 Agent，
而是把供应商财务每月重复的客户门户工作变成一个可审批的代办箱：

> 从 ERP 导入回款资料，自动核对客户采购订单、填写门户、上传附件，
> 只把资料缺失、风险异常和最终提交交给用户。

首个切口是“客户门户发票提交”。它同时具备四个适合浏览器 Agent 的条件：

- 门户由客户指定，供应商很难推动 API 集成。
- 操作跨 ERP、采购订单、附件和客户网页，重复但并不完全标准化。
- 错过月结窗口会直接推迟回款，结果价值容易量化。
- 最终提交具有财务影响，正好需要 Web Buddy 已有的审批、证据和恢复能力。

产品品牌使用“接手 · 网页代办箱”。发票提交是一条高价值流程，不把产品永远限制在
财务场景；后续可以扩展到招投标资料、保险理赔、物流预约、商家后台和 SaaS 管理台。

## 可运行体验

```bash
cd packages/web-buddy
npm run web
```

打开：

```text
http://localhost:5178/poc/invoice-portal
```

主路径是确定性的离线交互，不需要模型或真实客户账号：

1. 导入 6 张发票，先隔离 1 张重复和 1 张金额异常。
2. 代办助手填写 4 张安全发票，在客户必填字段缺失时暂停。
3. 用户补充服务期间；此时仍没有任何最终提交。
4. 页面给出金额、附件、目标门户和精确四项范围，等待 POC harness 的受控批准。
5. 批准后 harness 依次提交 4 张发票，保存门户确认号与回读证据；这不代表通用
   BatchApprovalBinding 已实现。
6. 将成功路径保存为“待审核 Recipe”，未来仍不会自动扩大权限。

自动验收：

```bash
npm run test:invoice-portal-poc
```

## 从 POC 到真实产品

### 首要可靠性边界：提交后崩溃

真实门户接入前，必须先处理“门户已创建发票记录，但本地在保存确认号前崩溃”的故障窗。
恢复时不能根据缺失的本地 `ToolResult` 再次点击，而要按发票业务键查询门户回执；只有独立
确认号才能证明成功，安全性未知时转人工。

状态机、故障注入、指标定义和面试讲法见
[`EXTERNAL_ACTION_RECONCILIATION.md`](EXTERNAL_ACTION_RECONCILIATION.md)。

现有 `POST /api/runs`、事件流、approval、cancel、trace 与 artifact API 可以直接复用。
POC 的前端状态机下一步替换为这些 API。本地通用 Agent Loop 的单动作已有独立的
`approval-binding/v2 + approve_and_execute`：旧 approve 对已对账外部副作用只表示知晓，
`upload/send/publish/submit/payment` 都只消费精确、同语义且可审阅的 v2 执行授权。
owner-scoped Service 在 v3 owner binding 前仍拒绝机器
提交；四项共享一次批准也仍需正式 BatchApprovalBinding。

浏览器执行层应收敛成内部 `BrowserSessionPort`：

```text
listTabs / selectTab / snapshot / click / fill / pressKey
wait / screenshot / download
```

上层继续只看到 Web Buddy 的规范化工具结果、审批边界和证据。底层可以 A/B：

- [agent-browser](https://github.com/vercel-labs/agent-browser)：CLI/JSON 接入薄，
  可通过 `--auto-connect` 接管现有 Chrome。
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)：
  与项目已有 MCP SDK 形态一致，也可通过 `--autoConnect` 接管现有 Chrome。
- CDP 或 [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/)：
  适合未来自建更底层、跨浏览器的长期实现。

POC 阶段不要把任一供应商工具直接暴露给模型，也不要加入正式 runtime dependency。
先用固定外部二进制路径完成串行 A/B；所有“提交、发送、支付”动作仍进入现有
Approval Gate。

## 48 小时验证目标

- Live Chrome：能接管用户已登录的客户门户标签页，不要求重复登录。
- 语义观察：能稳定找到至少 3 个关键控件，页面变化后只重取一次 snapshot。
- 文件闭环：能上传 PDF/OFD，并把下载回执限制到任务临时目录。
- 安全边界：批准前提交请求为 0；重复发票没有“强制提交”路径。
- 证据闭环：成功项必须有确认号、字段回读和附件摘要。
- 稳定性：同一流程连续 5 次至少成功 4 次，并能从外部进程退出中恢复。

这轮验证的核心不是证明某个浏览器库最好，而是证明用户愿意把“每月回款最后一公里”
交给一个只在真正需要判断时打断他的网页代办箱。
