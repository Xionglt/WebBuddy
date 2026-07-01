# 项目评价与优化建议

> 评审对象：Multi-Functional Agent（自研本地 Web Agent 运行时）
> 评审日期：2026-07-01
> 评审范围：`packages/web-buddy` 主线 + `packages/claude-code` 适配器 + docs / PLAN / configs

---

## 一、总体结论

这是一个**明显高于普通 side project 水平**的项目。它不是"套个框架写 demo"，而是自研了一套具备安全边界、可审计、可恢复能力的 Web Agent 运行时。工程规划（`PLAN/phase1-3`）、安全模型文档、测试脚本体系都体现出清晰的产品化思路。

**当前定位：高级 MVP / 早期产品原型。** 作为"可审计的本地 Web Agent 研究/演示平台"已较成熟；作为"生产级无人投递机器人"尚有距离（缺长期记忆、Skill 复用，Web UI 不安全，真实站点依赖人工 gate）。

**一句话总评：** 技术功底和工程 discipline 都在线，方向也对；现在缺的不是"再加功能"，而是"收拢核心（拆大文件、剥业务）+ 补齐生产化短板（Web 鉴权、真实站点验证、Skill/记忆）"。

---

## 二、做得好的地方（应保留的优势）

1. **架构判断正确 —— 没有滥用框架**
   自研 ReAct loop + ToolRegistry，而非硬套 LangChain/LangGraph。对于"浏览器 Agent + 强安全边界"场景，框架抽象反而会挡住对 policy/permission/gate 的精细控制。轻、可控、边界清晰是真实优势。

2. **安全设计是项目的灵魂**
   L0–L4 风险分级、`PolicyEngine → PermissionEngine → HumanGate` 三段门控、默认不自动登录 / 不解 captcha / 不 final submit、中英文提交关键词检测。这套"安全默认（safe by default）"的设计非常成熟，是最大的差异化。

3. **可审计性超出预期**
   每次运行落 `session + trace + metrics + safety-report`，且明确区分"诊断产物"与"运行时状态"（trace 不回读为 state）。这种 discipline 在个人项目里很罕见。

4. **零 key 可跑 demo**
   `demo:form` / `demo:research` 用本地 fixture 即可运行，新用户 5 分钟上手。对开源采纳率至关重要。

5. **测试意识强**
   50 个 `.mjs` 回归脚本 + `test:mvp` 串联，覆盖 policy / permission / workflow / session / kernel 各层。

---

## 三、主要问题（按优先级排序）

### P0 — 核心文件过大，是最大的技术债

实测行数：

| 文件 | 行数 |
|------|------|
| `packages/web-buddy/src/runtime/local/agent-loop.ts` | **1840** |
| `packages/web-buddy/src/sdk/orchestrator.ts` | **1196** |
| `packages/web-buddy/src/web/server.ts` | 720 |
| `packages/web-buddy/src/sdk/alibaba.ts` | 695 |

`agent-loop.ts` 是典型"上帝文件"：主循环 + session recording + workflow evidence + permission + context compaction 全挤在一起。后果：
- **难单测**：只能整体跑 `agent-loop-test.mjs`，无法对 compaction、evidence 单独测。
- **难协作 / 难改**：任何改动都要在 1840 行里定位，回归风险高。

### P0 — Web UI 零鉴权 + 监听所有网卡

`web/server.ts` 中 `server.listen(port, ...)` 未指定 host，**Node 默认绑 `0.0.0.0`（对外暴露）**。且：
- `POST /api/config` 能写入 API key，`POST /api/run` 能启动 agent，`POST /api/resume` 能上传文件——**全部无鉴权**。
- `GET /api/config` 返回 `keyPreview`（key 前 6 位）。
- Docker compose 默认 `HUMAN_GATE_MODE=auto`，容器内人工确认更少。

在同一局域网 / 云主机上运行，等于把"能填写你的 key 并驱动浏览器的后门"开放给整个网络。这与项目主打的"安全"卖点自相矛盾。

### P1 — 业务逻辑污染通用 core

`sdk/alibaba.ts`（695 行阿里招聘 scraping）与 `config.ts` 中硬编码的 `alibabaCareersUrl` 直接嵌在通用 SDK 里。README 声明"job application is the flagship workflow, not the whole product"，但代码结构让阿里业务与 core 强耦合，会让外部贡献者困惑，削弱"通用 Web Agent"定位。

### P1 — 双 runtime 认知负担

自研 loop（主线）与 `packages/claude-code`（2000+ 文件、依赖极重的对比路径）并存，新读者难判断该看哪条线。且 claude adapter 使用 `permissionMode: 'bypassPermissions'`，安全边界弱于主线——两条线安全标准不一致。

### P2 — 其它

- 日志仅 `console.log/error`，无结构化日志（Pino/Winston），生产排障困难。
- 无 RAG / 长期记忆 / Skill 系统（Phase 3 全在纸面）——决定了目前无法"越用越聪明"。
- Web UI 用 `innerHTML` 渲染 SSE 事件，存在潜在 XSS 面。

---

## 四、优化路线图（按投入产出比排序）

### 立刻做（低成本、高收益，1–2 天）

- [ ] **1. Web UI 默认绑 `127.0.0.1`**
      将 `server.listen(port)` 改为 `server.listen(port, '127.0.0.1')`，需对外暴露时用环境变量 `WEB_HOST` 显式开启。一行改动消除最大安全隐患。
- [ ] **2. 给写操作加 token**
      启动时生成随机 token 打印到终端，`/api/config`、`/api/run`、`/api/resume` 校验 header。半小时工作量，堵住后门。
- [ ] **3. 移除 `keyPreview` 中的 key 前缀**
      只返回 `hasKey: boolean`，不泄露任何字符。

### 近期做（1–2 周，偿还技术债）

- [ ] **4. 拆分 `agent-loop.ts`**
      拆为 `loop.ts`（纯 ReAct 循环）+ `turn-recorder.ts`（session/trace 记录）+ `compaction-hook.ts` + `evidence-collector.ts`。目标：主 loop 文件 < 400 行，每块可独立单测。
- [ ] **5. 把 Alibaba 剥离成 plugin/preset**
      新建 `src/presets/alibaba/`，core SDK 只暴露 workflow preset 注册接口，`config.ts` 删除硬编码 URL。让"通用 runtime"名副其实。
- [ ] **6. 引入结构化日志**
      换用 Pino，带 `sessionId` / `turnId` 字段，与现有 trace 打通。

### 中期做（决定项目天花板）

- [ ] **7. 落地 Skill System v1（Phase 3）**
      让 Agent 会积累经验。可先做最简版："成功 workflow 存 JSON + 下次相似任务召回"，也远胜每次从零。
- [ ] **8. 明确 claude-code 去留**
      要么降级为明确标注的可选 experiment 目录（README 说清"非主线、依赖重、慎用"），要么移出主仓到独立分支/仓库，降低主线认知负担。
- [ ] **9. 补真实站点端到端成功率基准**
      当前 benchmark 均为本地 fixture。选 1–2 个公开可复现的真实表单站点，量化"通用 fill"的成功率——把"架构正确"变成"确实好用"的唯一办法。

---

## 五、如果只做三件事

1. **Web UI 绑 localhost + 加 token**（安全）
2. **拆 `agent-loop.ts`**（可维护性）
3. **落地 Skill v1**（能力天花板）

---

## 附录：关键文件速查

| 用途 | 路径 |
|------|------|
| Agent 主循环 | `packages/web-buddy/src/runtime/local/agent-loop.ts` |
| Kernel 入口 | `packages/web-buddy/src/kernel/agent-kernel.ts` |
| Runtime 门面 | `packages/web-buddy/src/agent/agent-runtime.ts` |
| LLM 客户端 | `packages/web-buddy/src/sdk/llm.ts` |
| 工具目录 | `packages/web-buddy/src/tools/catalog.ts` |
| 策略引擎 | `packages/web-buddy/src/policy/policy-engine.ts` |
| 编排器 | `packages/web-buddy/src/sdk/orchestrator.ts` |
| 配置 | `packages/web-buddy/src/sdk/config.ts` |
| MCP 服务 | `packages/web-buddy/src/server.ts` |
| Web UI | `packages/web-buddy/src/web/server.ts` |
| Phase 2 规划 | `PLAN/phase2/README.md` |
