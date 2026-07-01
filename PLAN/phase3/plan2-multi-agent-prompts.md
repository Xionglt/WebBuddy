# Phase 3 Plan 2 Multi-Agent Execution Prompts

> 用途：这份文档用于把 `PLAN/phase3/plan2.md` 拆成多个可协作的 agent 任务。
>
> 目标：每个 agent 都拿到足够上下文、清晰边界、可验证输出和交接标准；能并行的并行，必须串行的串行；避免多个 agent 同时修改同一核心文件造成冲突。

## 0. 使用方式

建议创建一个主控线程负责协调，多个子线程分别执行下方 prompt。

每个子 agent 启动前，都应把对应 prompt 完整粘贴给它。不要只说“参考计划做一下”，否则 agent 容易越界。

如果使用 Codex 新线程，建议标题按下面命名：

```text
phase3-plan2-00-baseline-contracts
phase3-plan2-01-resume-ingestion
phase3-plan2-02-resume-tests
phase3-plan2-03-job-crawl-match
phase3-plan2-04-permission-modes
phase3-plan2-05-direct-submit
phase3-plan2-06-risk-timeline-ui
phase3-plan2-07-integration-qa
phase3-plan2-08-docs
```

## 1. 全局上下文

当前项目：

```text
Repo: multi-functional-agent
Main package: packages/web-buddy
Current real-site target: Alibaba Careers / talent-holding.alibaba.com
Current model path: OpenAI-compatible Qwen via DashScope / Bailian
Current safety contract: login/captcha/upload/final submit are human boundaries
```

关键计划文件：

```text
PLAN/phase3/README.md
PLAN/phase3/plan1.md
PLAN/phase3/plan2.md
```

关键代码区域：

```text
packages/web-buddy/src/sdk/resume.ts
packages/web-buddy/src/sdk/llm.ts
packages/web-buddy/src/sdk/config.ts
packages/web-buddy/src/sdk/matcher.ts
packages/web-buddy/src/sdk/alibaba.ts
packages/web-buddy/src/sdk/orchestrator.ts
packages/web-buddy/src/runtime/local/agent-loop.ts
packages/web-buddy/src/policy/policy-engine.ts
packages/web-buddy/src/permission/*
packages/web-buddy/src/workflow/*
packages/web-buddy/src/web/server.ts
packages/web-buddy/src/web/public/index.html
packages/web-buddy/scripts/*
```

当前真实演示暴露的问题：

```text
1. PDF 简历解析不是模型解析，而是 pdfjs + 本地启发式规则。
2. 简历画像不可靠会直接影响岗位匹配。
3. 阿里岗位抓取只看当前可见列表和少量详情，覆盖不足。
4. 详情页和岗位标题存在错位风险。
5. 低匹配岗位仍可能进入申请流程。
6. L3/L4 风险门太多，演示和真实使用体验卡。
7. 阿里登录后可能出现 direct-submit flow：只有协议 checkbox + 投递按钮，没有表单。
```

## 2. 全局原则

所有 agent 都必须遵守：

```text
1. 不自动最终提交真实招聘申请。
2. 不绕过登录、验证码、扫码、人机验证。
3. 不把 .env、API key、cookie、storage state、简历原文写入文档或日志。
4. 不把 trace artifact 当 runtime state 来源。
5. 保持现有 demo 和 test:mvp 可回归。
6. 所有新能力必须有可本地验证的 fixture 或脚本测试。
7. 真实站点能力必须有安全 fallback。
8. 不做大范围重构，按模块边界推进。
9. 低匹配不进入投递流程，除非显式演示/用户确认。
10. final_submit 默认仍是硬门；任何放开最终提交的能力都必须显式开关。
```

## 3. 执行拓扑

### 3.1 Wave 0: 串行

必须先执行：

```text
Agent 00: Baseline Contracts
```

产出统一接口和差距清单，后续 agent 以它为准。

### 3.2 Wave 1: 可并行

在 Agent 00 完成后，可以并行：

```text
Agent 01: Resume Ingestion v2 Implementation
Agent 02: Resume Fixtures and Tests
Agent 03: Job Crawl and Matching v2
Agent 04: Permission Modes
```

注意：

```text
Agent 01 和 Agent 02 需要约定 ResumeProfileV2 schema。
Agent 03 不依赖 Agent 01 完全完成，但应兼容 ResumeProfile 和 ResumeProfileV2。
Agent 04 尽量只改 policy/permission/config/CLI，不碰 job/resume。
```

### 3.3 Wave 2: 半串行

依赖 Agent 03 和 Agent 04：

```text
Agent 05: Direct Submit Flow
```

它需要 job workflow 语义和 permission mode 基础。

### 3.4 Wave 3: 半串行

依赖 Agent 04 和 Agent 05：

```text
Agent 06: Risk Timeline and Web UI
```

它需要 risk decision / permission mode / direct-submit state 的输出。

### 3.5 Wave 4: 串行收口

最后执行：

```text
Agent 07: Integration QA
Agent 08: Docs
```

Agent 07 必须在所有实现合并后执行。Agent 08 在 QA 之后更新最终文档。

## 4. 共享交接格式

每个 agent 完成后，必须留下一个简短交接摘要：

```text
Changed files:
- ...

Implemented:
- ...

Tests run:
- command: pass/fail

New scripts/artifacts:
- ...

Known limitations:
- ...

Follow-up needed by next agent:
- ...
```

## 5. 主控 Agent Prompt

复制给主控 agent：

```text
你是 Phase 3 Plan 2 的主控协调 agent。你的目标不是亲自实现所有代码，而是协调多个子 agent 完成真实招聘投递体验优化。

必须先阅读：
- PLAN/phase3/README.md
- PLAN/phase3/plan2.md
- PLAN/phase3/plan2-multi-agent-prompts.md

全局约束：
- 不允许自动最终提交真实招聘申请。
- 不允许泄露 .env、API key、cookie、storage state、简历原文。
- 不允许让任何子 agent 依赖 trace artifacts 作为 runtime state。
- 每个子任务必须有明确文件边界、测试命令和交接摘要。

你的任务：
1. 按文档执行 Wave 0 -> Wave 1 -> Wave 2 -> Wave 3 -> Wave 4。
2. 每个 wave 开始前确认依赖是否满足。
3. 每个子 agent 完成后读取其交接摘要，检查是否越界修改。
4. 发生冲突时，优先保持现有测试通过和安全默认值。
5. 最终输出集成状态、剩余风险和下一步建议。

不要直接修改代码，除非用户明确让主控 agent 亲自收口。
```

## 6. Agent 00 Prompt: Baseline Contracts

执行方式：串行，必须最先执行。

文件边界：只允许新增分析文档，不改运行代码。

推荐输出：

```text
PLAN/phase3/plan2-contracts-audit.md
```

Prompt：

```text
你是 Phase 3 Plan 2 的 Baseline Contracts agent。你的任务是做实现前审计和接口边界定义，不要修改运行代码。

必须先阅读：
- PLAN/phase3/plan2.md
- packages/web-buddy/src/sdk/resume.ts
- packages/web-buddy/src/sdk/matcher.ts
- packages/web-buddy/src/sdk/alibaba.ts
- packages/web-buddy/src/sdk/orchestrator.ts
- packages/web-buddy/src/sdk/config.ts
- packages/web-buddy/src/sdk/llm.ts
- packages/web-buddy/src/policy/policy-engine.ts
- packages/web-buddy/src/permission/permission-rules.ts
- packages/web-buddy/src/workflow/workflow-state.ts

目标：
1. 梳理当前 ResumeProfile、JobPosting、MatchScore、PolicyDecision、PermissionDecision、WorkflowState 的真实字段和调用关系。
2. 给出 Plan 2 需要新增或扩展的最小接口：
   - ResumeProfileV2
   - JobCandidate coarse/final artifact
   - PermissionMode
   - RiskDecision artifact
   - direct_submit_review workflow state
3. 标注每个后续 agent 的推荐文件边界，避免冲突。
4. 给出所有需要新增测试脚本的列表。

输出文档：
- PLAN/phase3/plan2-contracts-audit.md

文档必须包含：
- Current state
- Proposed contracts
- File ownership map
- Test ownership map
- Breaking-change risks
- Recommended implementation order

禁止：
- 不要改 src 代码。
- 不要改 package.json。
- 不要运行真实投递。

完成后运行：
- git diff -- PLAN/phase3/plan2-contracts-audit.md

最后给出交接摘要。
```

## 7. Agent 01 Prompt: Resume Ingestion v2

执行方式：Wave 1，可与 Agent 03/04 并行。建议等 Agent 00 输出 contracts 后执行。

主要文件边界：

```text
packages/web-buddy/src/sdk/resume.ts
packages/web-buddy/src/sdk/resume-ingest.ts       (new if useful)
packages/web-buddy/src/sdk/resume-types.ts        (new if useful)
packages/web-buddy/src/sdk/llm.ts                 (only if parser needs existing helper extension)
packages/web-buddy/scripts/resume-ingest-test.mjs (new)
packages/web-buddy/package.json                   (add script only)
```

Prompt：

```text
你是 Phase 3 Plan 2 的 Resume Ingestion v2 implementation agent。你的任务是把简历解析从纯启发式升级为“本地抽取 + LLM 结构化 + schema 校验 + confidence/evidence”，同时保持现有 readResume 兼容。

必须先阅读：
- PLAN/phase3/plan2.md
- PLAN/phase3/plan2-contracts-audit.md 如果存在
- packages/web-buddy/src/sdk/resume.ts
- packages/web-buddy/src/sdk/llm.ts
- packages/web-buddy/src/sdk/config.ts
- packages/web-buddy/scripts/resume-test.mjs
- packages/web-buddy/scripts/model-smoke-test.mjs

目标：
1. 新增 ResumeProfileV2 类型，包含 schemaVersion、字段 confidence、evidence、source metadata。
2. 实现文本型 PDF 路径：
   PDF -> pdfjs extract text -> LLM structured JSON parse -> schema validation -> deterministic email/phone repair。
3. 保留 readResume(filePath) 的现有返回兼容，旧流程不应被破坏。
4. 新增 readResumeV2 或 ingestResume 入口，供后续 orchestrator 切换。
5. 如果没有模型 key，必须 fallback 到现有 parseResumeText。
6. 如果 LLM JSON 失败，必须 fallback 到现有 parseResumeText，并记录 extraction warning。
7. 为扫描/图片型 PDF 预留接口，但本任务不要求完整多模态渲染实现，除非非常小而安全。
8. 不要把简历原文写入 console 或普通日志；trace/artifact 中也要考虑脱敏。

LLM 结构化要求：
- 使用现有 LlmGateway.generateJson 或等价能力。
- Prompt 要要求模型只输出 JSON。
- 输出字段至少包括：name, email, phone, location, targetRoles, skills, projects, experience, education, keywords, seniority。
- 每个关键字段要有 confidence 和 evidence。

测试：
1. 新增 npm script: test:resume-ingest。
2. 使用本地 fixture，不依赖真实用户简历。
3. 覆盖：
   - JSON resume 兼容。
   - TXT resume 兼容。
   - sample PDF 兼容。
   - no key fallback。
   - fake LLM structured parser 成功路径。
   - malformed LLM JSON fallback。

禁止：
- 不要修改岗位匹配逻辑。
- 不要修改 permission/policy。
- 不要真实调用用户简历。
- 不要把 API key 或简历原文输出到日志。

完成前运行：
- npm run build
- npm run test:resume
- npm run test:resume-ingest

如果 test:model 需要真实 key，不强制运行；若运行，不输出 key。

最后给出交接摘要，特别说明：
- 新入口是什么。
- 旧 readResume 是否兼容。
- 后续 orchestrator 如何切换到 v2。
```

## 8. Agent 02 Prompt: Resume Fixtures and Parser QA

执行方式：Wave 1，可与 Agent 01 并行，但最好先读 Agent 00 contracts。

主要文件边界：

```text
packages/web-buddy/scripts/resume-ingest-test.mjs
packages/web-buddy/scripts/fixtures/resumes/*       (new)
packages/web-buddy/src/sdk/resume.ts                (only test-driven small fixes)
packages/web-buddy/package.json                     (add script only if Agent 01 has not)
```

Prompt：

```text
你是 Phase 3 Plan 2 的 Resume Fixtures and Parser QA agent。你的任务是为 Resume Ingestion v2 提供高质量测试夹具和验收覆盖，尽量避免和实现 agent 冲突。

必须先阅读：
- PLAN/phase3/plan2.md
- PLAN/phase3/plan2-contracts-audit.md 如果存在
- packages/web-buddy/src/sdk/resume.ts
- packages/web-buddy/scripts/resume-test.mjs

目标：
1. 新增多种简历 fixture：
   - simple txt resume
   - structured json resume
   - generated text PDF resume
   - Chinese/English mixed resume text
   - low-quality extracted text case
2. 新增或扩展 test:resume-ingest，确保 ResumeProfileV2 的 schema、confidence/evidence、fallback 都被覆盖。
3. 测试中不要依赖真实 LLM；使用 fake gateway/stub。
4. 测试不得包含真实用户简历内容。
5. 如果 Agent 01 已经创建测试脚本，则在其基础上补 coverage；不要重写整个脚本。

验收重点：
- 解析失败时返回 fallback profile，而不是 throw。
- email/phone deterministic repair 生效。
- low confidence 字段可被标记。
- 旧 readResume 行为不退化。

完成前运行：
- npm run build
- npm run test:resume
- npm run test:resume-ingest

最后给出交接摘要，列出 fixture 和覆盖点。
```

## 9. Agent 03 Prompt: Job Crawl and Matching v2

执行方式：Wave 1，可与 Agent 01/04 并行。

主要文件边界：

```text
packages/web-buddy/src/sdk/alibaba.ts
packages/web-buddy/src/sdk/matcher.ts
packages/web-buddy/src/sdk/orchestrator.ts          (only integration points)
packages/web-buddy/scripts/job-crawl-pagination-test.mjs (new)
packages/web-buddy/scripts/job-match-threshold-test.mjs  (new)
packages/web-buddy/package.json
```

Prompt：

```text
你是 Phase 3 Plan 2 的 Job Crawl and Matching v2 agent。你的任务是把阿里岗位发现和匹配从“当前页少量详情”升级为“多页快速粗排 + Top N 详情精排 + 阈值裁决”。

必须先阅读：
- PLAN/phase3/plan2.md
- PLAN/phase3/plan2-contracts-audit.md 如果存在
- packages/web-buddy/src/sdk/alibaba.ts
- packages/web-buddy/src/sdk/matcher.ts
- packages/web-buddy/src/sdk/orchestrator.ts
- packages/web-buddy/scripts/e2e-auto-apply.mjs
- packages/web-buddy/scripts/matcher-test.mjs

目标：
1. 新增 fast list crawl 能力：
   - 支持多页或多批次抓取。
   - 提取 title/category/location/updated/positionId/detailUrl。
   - positionId/title 去重。
   - 不打开所有详情。
2. 新增 coarse scoring：
   - 基于 title/category/location/tags/resume skills/targetRoles。
   - 不依赖 LLM。
3. 新增 threshold：
   - 默认低于阈值不进入投递。
   - 阈值可配置。
4. Detail enrichment：
   - 只打开 Top N。
   - 修复详情页 title/positionId 错位问题。
   - LLM rerank 只对 Top N。
5. 输出 artifacts：
   - job-candidates-coarse.json
   - job-candidates-final.json
6. trace 要解释：
   - 扫描数量。
   - Top coarse candidates。
   - Top final candidates。
   - 为什么选择最终岗位或为什么停止。

测试：
1. 新增 test:job-crawl-pagination。
2. 新增 test:job-match-threshold。
3. 使用本地 mock job board fixture，不依赖真实阿里网络。
4. 覆盖：
   - 多页去重。
   - Top N 详情精排。
   - 低阈值停止。
   - 高分进入 apply decision。
   - 详情页错位防护。

禁止：
- 不要真实提交申请。
- 不要把所有详情都交给 LLM。
- 不要让低分岗位默认进入投递。
- 不要修改 resume parser。
- 不要修改 permission mode。

完成前运行：
- npm run build
- npm run test:matcher
- npm run test:job-crawl-pagination
- npm run test:job-match-threshold
- npm run test:e2e-auto-apply

最后给出交接摘要，说明新 API、阈值默认值和 artifact 路径。
```

## 10. Agent 04 Prompt: Permission Modes

执行方式：Wave 1，可与 Agent 01/03 并行。

主要文件边界：

```text
packages/web-buddy/src/sdk/config.ts
packages/web-buddy/src/policy/policy-engine.ts
packages/web-buddy/src/permission/*
packages/web-buddy/src/cli/demo.ts
packages/web-buddy/scripts/permission-modes-test.mjs (new)
packages/web-buddy/package.json
configs/agent.env.example
```

Prompt：

```text
你是 Phase 3 Plan 2 的 Permission Modes agent。你的任务是减少可信演示场景下的重复确认，同时保持最终提交等真实风险边界。

必须先阅读：
- PLAN/phase3/plan2.md
- PLAN/phase3/plan2-contracts-audit.md 如果存在
- docs/safety-model.md
- packages/web-buddy/src/sdk/config.ts
- packages/web-buddy/src/policy/policy-engine.ts
- packages/web-buddy/src/permission/permission-rules.ts
- packages/web-buddy/src/sdk/human.ts
- packages/web-buddy/src/cli/demo.ts
- packages/web-buddy/scripts/permission-engine-test.mjs
- packages/web-buddy/scripts/approval-queue-test.mjs

目标：
1. 新增 PermissionMode：
   - safe
   - review
   - trusted
   - autopilot
2. 支持 env 和 CLI：
   - PERMISSION_MODE=safe|review|trusted|autopilot
   - --permission-mode <mode>
3. 默认仍为 safe 或现有安全行为。
4. trusted 模式：
   - 自动允许 apply_entry / entering_application 类 L3 动作。
   - 仍拦 login/captcha/upload/final_submit。
5. review 模式：
   - 可以减少普通 high_risk_action 的确认，但 final_submit/upload/login/captcha 仍确认。
6. autopilot 模式：
   - 最大自动化。
   - final_submit 默认仍硬门。
   - 如未来允许 final submit，必须另有显式 allowFinalSubmit 开关；本任务不默认放开。
7. 所有 auto-allow 必须进入 trace/metrics/audit tags。

测试：
1. 新增 test:permission-modes。
2. 覆盖：
   - safe 下 L3 ask。
   - trusted 下 apply_entry allow。
   - trusted 下 final_submit ask。
   - login/captcha 仍 ask。
   - autopilot 不默认 final_submit。

禁止：
- 不要改变 final_submit 默认安全边界。
- 不要修改岗位匹配。
- 不要修改简历解析。
- 不要删除现有 permission tests。

完成前运行：
- npm run build
- npm run test:policy
- npm run test:policy-engine
- npm run test:permission-engine
- npm run test:approval-queue
- npm run test:permission-modes

最后给出交接摘要，说明每个模式的行为表。
```

## 11. Agent 05 Prompt: Direct Submit Flow

执行方式：Wave 2。依赖 Agent 03 的岗位流程和 Agent 04 的权限模式。

主要文件边界：

```text
packages/web-buddy/src/workflow/*
packages/web-buddy/src/sdk/orchestrator.ts
packages/web-buddy/src/sdk/alibaba.ts
packages/web-buddy/src/policy/policy-engine.ts       (only if gate kind needs refinement)
packages/web-buddy/scripts/direct-submit-flow-test.mjs (new)
packages/web-buddy/package.json
```

Prompt：

```text
你是 Phase 3 Plan 2 的 Direct Submit Flow agent。你的任务是让真实招聘站点中“无表单、只有协议 checkbox + 投递按钮”的场景被正确识别为 direct-submit review，而不是普通填表失败。

必须先阅读：
- PLAN/phase3/plan2.md
- PLAN/phase3/plan2-contracts-audit.md 如果存在
- packages/web-buddy/src/sdk/orchestrator.ts
- packages/web-buddy/src/sdk/alibaba.ts
- packages/web-buddy/src/workflow/workflow-state.ts
- packages/web-buddy/src/workflow/workflow-engine.ts
- packages/web-buddy/src/workflow/completion-gate.ts
- packages/web-buddy/src/policy/policy-engine.ts
- packages/web-buddy/scripts/workflow-engine-test.mjs
- packages/web-buddy/scripts/completion-gate-test.mjs

目标：
1. 新增或复用 workflow state 表达 direct_submit_review。
2. 检测条件：
   - 页面无真实可填写表单字段。
   - 有协议 checkbox 或申请工作需知。
   - 有 submit/apply/投递简历 按钮。
   - 用户已登录或页面不再是 login wall。
3. agent 应解释：
   - 该站点使用在线简历/直接投递模式。
   - 没有字段可填。
   - 下一步是最终提交边界。
4. 默认停在 final_submit 前。
5. trusted/autopilot 也不默认自动 final_submit。
6. trace/artifact 中要能区分 blocked 与 direct_submit_review。

测试：
1. 新增 test:direct-submit-flow。
2. 使用本地 HTML fixture：
   - checkbox + 投递按钮 + 无输入字段。
   - 普通表单 + submit。
   - login wall。
3. 验证 direct-submit flow 不被误判成普通 blocked。

禁止：
- 不要真实点击最终提交。
- 不要修改 resume ingestion。
- 不要修改 job crawl 粗排。

完成前运行：
- npm run build
- npm run test:workflow
- npm run test:completion-gate
- npm run test:direct-submit-flow

最后给出交接摘要，说明 direct_submit_review 的状态、检测规则和用户可见文案。
```

## 12. Agent 06 Prompt: Risk Timeline and Web UI

执行方式：Wave 3。依赖 Agent 04/05。

主要文件边界：

```text
packages/web-buddy/src/sdk/trace.ts
packages/web-buddy/src/policy/policy-audit.ts
packages/web-buddy/src/policy/safety-report.ts
packages/web-buddy/src/web/server.ts
packages/web-buddy/src/web/public/index.html
packages/web-buddy/scripts/risk-timeline-test.mjs (new)
packages/web-buddy/package.json
```

Prompt：

```text
你是 Phase 3 Plan 2 的 Risk Timeline and Web UI agent。你的任务是让用户看到 agent 每个高风险动作的风险等级、决策、原因和是否自动允许，而不是只在被 gate 时才感知风险。

必须先阅读：
- PLAN/phase3/plan2.md
- PLAN/phase3/plan2-contracts-audit.md 如果存在
- packages/web-buddy/src/sdk/trace.ts
- packages/web-buddy/src/policy/policy-audit.ts
- packages/web-buddy/src/policy/safety-report.ts
- packages/web-buddy/src/web/server.ts
- packages/web-buddy/src/web/public/index.html
- packages/web-buddy/scripts/safety-report-test.mjs
- packages/web-buddy/scripts/metrics-test.mjs

目标：
1. 新增 risk-decisions.json artifact 或等价 artifact。
2. 每个 policy/permission decision 记录：
   - tool/action
   - risk
   - riskLevel
   - gateKind
   - decision: allow/ask/deny/auto_allow
   - permissionMode
   - reason
   - url
   - timestamp
3. CLI 输出 compact risk decision：
   - high-risk action auto-allowed by trusted mode
   - final-submit gated
4. Web UI timeline 显示：
   - Think
   - Risk
   - Decision
   - Tool
   - Observation
5. 不改变默认安全行为。
6. safety-report 汇总 auto-allowed/gated/denied 计数。

测试：
1. 新增 test:risk-timeline。
2. 更新 safety-report-test 或 metrics-test 覆盖 risk decisions。
3. 不需要真实站点。

禁止：
- 不要把 key/cookie/resume raw text 放入 artifact。
- 不要让 UI 控制权限模式，除非已有后端支持；本任务主要展示。
- 不要改变 final_submit gate。

完成前运行：
- npm run build
- npm run test:metrics
- npm run test:safety-report
- npm run test:risk-timeline

最后给出交接摘要，说明 artifact schema 和 Web UI 展示位置。
```

## 13. Agent 07 Prompt: Integration QA

执行方式：Wave 4，所有实现 agent 完成后串行执行。

文件边界：允许做小范围测试修复，但不要新增大功能。

Prompt：

```text
你是 Phase 3 Plan 2 的 Integration QA agent。你的任务是在所有实现合并后做端到端回归、发现冲突并做小范围修复。

必须先阅读：
- PLAN/phase3/plan2.md
- 每个子 agent 的交接摘要
- package.json scripts
- README.md
- docs/full-experience-guide.md

目标：
1. 跑完整构建和关键测试。
2. 验证新增脚本都存在并能通过。
3. 验证旧 demo 不退化。
4. 验证安全默认值没有被放开。
5. 验证真实站点相关功能有本地 fixture 测试，不依赖真实阿里。
6. 修复明显集成问题，但不要做大功能改造。

必须运行：
- npm run build
- npm run test:model      (如果本地有 key；没有 key 则说明跳过原因)
- npm run test:resume
- npm run test:resume-ingest
- npm run test:matcher
- npm run test:job-crawl-pagination
- npm run test:job-match-threshold
- npm run test:permission-modes
- npm run test:direct-submit-flow
- npm run test:risk-timeline
- npm run test:e2e-auto-apply
- npm run benchmark:research
- npm run test:mvp

输出：
- PLAN/phase3/plan2-qa-report.md

报告包含：
- Passed tests
- Failed tests and fixes
- Remaining risks
- Manual real-site verification checklist
- Whether final-submit default remains gated

禁止：
- 不要真实提交招聘申请。
- 不要清理用户未提交的改动。
- 不要重写其他 agent 的架构。

最后给出交接摘要。
```

## 14. Agent 08 Prompt: Docs and Operator Guide

执行方式：Wave 4，QA 后执行。

主要文件边界：

```text
README.md
packages/web-buddy/README.md
docs/full-experience-guide.md
docs/safety-model.md
PLAN/phase3/plan2-completion-explanation.md (new)
```

Prompt：

```text
你是 Phase 3 Plan 2 的 Docs and Operator Guide agent。你的任务是在实现和 QA 完成后，更新用户可读文档和维护者说明。

必须先阅读：
- PLAN/phase3/plan2.md
- PLAN/phase3/plan2-qa-report.md
- README.md
- packages/web-buddy/README.md
- docs/full-experience-guide.md
- docs/safety-model.md

目标：
1. 更新 README：
   - Resume Ingestion v2 使用方式。
   - 多页岗位匹配使用方式。
   - permission mode 使用方式。
   - final-submit 安全边界。
2. 更新 Web Buddy README：
   - 新增 scripts。
   - 新增 artifacts。
   - 新增 troubleshooting。
3. 更新 full-experience-guide：
   - 从上传简历到岗位匹配到 direct-submit review 的真实流程。
4. 更新 safety-model：
   - permission modes。
   - auto-allow 和 final-submit hard gate 的关系。
5. 新增 completion explanation：
   - PLAN/phase3/plan2-completion-explanation.md

禁止：
- 不要修改运行代码。
- 不要包含真实 API key、cookie、简历原文。
- 不要宣称可以绕过登录/验证码。
- 不要宣称 PDF 解析 100% 正确。

完成后运行：
- npm run build
如果只改 docs，build 可选；若没有运行，请说明原因。

最后给出交接摘要。
```

## 15. 最终人工验收脚本

所有 agent 完成后，主控线程按顺序执行：

```bash
cd packages/web-buddy
npm run build
npm run test:model
npm run test:mvp
npm run test:resume-ingest
npm run test:job-crawl-pagination
npm run test:job-match-threshold
npm run test:permission-modes
npm run test:direct-submit-flow
npm run test:risk-timeline
npm run demo:research
npm run demo:form
```

真实站点手动验收只做非最终提交：

```text
1. 使用测试简历。
2. 扫描多页岗位。
3. 查看 Top 匹配解释。
4. trusted 模式进入申请流程。
5. 登录/验证码手动处理。
6. direct-submit flow 停在最终提交边界。
7. 不点击最终真实提交，除非用户本人手动操作。
```

## 16. 完成定义

Plan 2 完成必须同时满足：

```text
1. 简历解析输出可确认画像，而不是盲信 PDF 启发式。
2. 岗位匹配覆盖足够候选，不再第一页低分硬投。
3. 权限模式让可信演示不再反复卡在 apply_entry。
4. 风险等级始终可见和可审计。
5. direct-submit flow 被识别并停在 final_submit。
6. test:mvp 和新增测试全部通过。
7. 文档能指导新用户跑完整流程。
```
