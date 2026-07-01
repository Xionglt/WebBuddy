# Phase 3 Plan 2: Real Application Experience Optimization

> 目标：把当前可演示的 Web Agent 投递流程，优化成更接近真实可用的招聘投递体验。
>
> 本计划只定义方案和边界，不直接修改运行代码。核心优化点：简历解析、岗位快速粗排/精排、匹配阈值、权限模式、风险透明展示，以及真实站点投递流程的安全体验。

## 1. 背景和问题

最近真实阿里巴巴投递演示暴露了几个关键问题：

```text
1. 当前确实走的是 packages/web-buddy 的结构化 alibaba-apply 流程。
2. PDF 简历解析是 pdfjs 文本抽取 + 本地启发式规则，不是大模型解析。
3. 岗位匹配只抓当前可见列表和少量详情，速度慢，覆盖不足。
4. 匹配分数很低时仍会进入投递流程，体验和安全感都不好。
5. L3/L4 风险动作频繁要求用户确认，真实使用很卡。
6. 风险信息有记录，但还没有以“透明但不阻塞”的方式展示给用户。
7. 阿里某些岗位登录后没有表单，而是 checkbox + 投递按钮，agent 应该识别这是直接提交边界。
```

Phase 3 Plan 1 关注 SkillSystem。Plan 2 关注真实体验优化，两者可以并行，但 Plan 2 不依赖 SkillSystem 完成后才能启动。

## 2. 本阶段目标

完成后应具备：

1. 简历解析从“启发式字段抽取”升级为“多格式 ingest + LLM 结构化 + schema 校验 + 置信度/证据”。
2. 岗位发现从“当前页少量岗位”升级为“多页快速粗排 + Top N 详情精排”。
3. 匹配结果有明确阈值，低匹配不进入投递，而是继续翻页或停止说明原因。
4. 权限从单一安全模式升级为分层 permission mode。
5. 高风险动作默认可按模式自动放行，但风险等级、原因、审计记录仍可见。
6. 真实投递中区分：
   - 进入申请流程。
   - 上传/选择简历。
   - 勾选协议。
   - 最终提交真实申请。
7. Web UI / CLI 都能解释 agent 为什么选择某个岗位、为什么允许/拦截某个动作。

## 3. 非目标

本阶段明确不做：

- 不承诺 PDF 或任意文件解析 100% 正确。
- 不绕过登录、验证码、扫码、人机验证。
- 不默认自动最终提交真实投递。
- 不把所有岗位详情都用 LLM 精排，避免成本和速度失控。
- 不把 trace artifact 当 runtime state 来源。
- 不做远程岗位数据库或长期缓存平台。
- 不做对阿里私有接口的强依赖；如发现稳定 JSON 接口，只作为可选加速路径。

## 4. Workstream A: Resume Ingestion v2

### 4.1 当前状态

当前实现位于：

```text
packages/web-buddy/src/sdk/resume.ts
```

流程：

```text
PDF -> pdfjs-dist getTextContent -> 拼文本 -> regex/skill dictionary/heuristic -> ResumeProfile
```

问题：

- 扫描版 PDF 不可用。
- 多栏/表格 PDF 文本顺序可能乱。
- 姓名、职位、项目经验容易误判。
- 不支持 docx、图片、HTML 简历等常见输入。
- 没有 confidence 和 evidence，用户不知道哪些字段可靠。

### 4.2 目标方案

新增独立 pipeline：

```text
ResumeIngestor
  -> detect file type
  -> extract raw text and/or page images
  -> LLM structured parse
  -> schema validate
  -> deterministic repair for email/phone
  -> confidence/evidence report
  -> optional user confirmation
  -> ResumeProfile
```

推荐策略：

```text
1. 文本型 PDF
   pdfjs 抽文本；如果文本长度和质量足够，发文本给 LLM 结构化。

2. 扫描/图片型 PDF
   将前 N 页渲染成图片，发多模态模型解析。

3. docx / txt / md / json
   docx 转文本；txt/md 直读；json 走 schema 校验。

4. html / 网页简历
   DOM text extraction + LLM 结构化。
```

### 4.3 输出模型

建议新增 `ResumeProfileV2`，同时兼容现有 `ResumeProfile`：

```ts
interface ResumeProfileV2 {
  schemaVersion: 'resume-profile/v2'
  name?: FieldValue<string>
  email?: FieldValue<string>
  phone?: FieldValue<string>
  location?: FieldValue<string>
  targetRoles: FieldValue<string[]>
  skills: FieldValue<string[]>
  projects: FieldValue<ProjectExperience[]>
  experience: FieldValue<ResumeExperience[]>
  education: FieldValue<ResumeEducation[]>
  keywords: FieldValue<string[]>
  seniority?: FieldValue<string>
  source: {
    path?: string
    type: 'pdf-text' | 'pdf-image' | 'docx' | 'txt' | 'json' | 'html'
    extractionWarnings: string[]
  }
}

interface FieldValue<T> {
  value: T
  confidence: number
  evidence?: string
}
```

### 4.4 验收标准

- 对文本 PDF，能稳定抽出姓名、邮箱、电话、技能、项目经验、教育经历。
- 对扫描 PDF，能通过多模态 fallback 给出结构化结果或明确失败原因。
- 所有低置信度字段可被标记。
- UI/CLI 可展示“简历画像确认”摘要。
- 旧 demo 和现有填表流程仍可消费兼容后的 `ResumeProfile`。

## 5. Workstream B: Job Discovery and Matching v2

### 5.1 当前状态

当前阿里抓取位于：

```text
packages/web-buddy/src/sdk/alibaba.ts
packages/web-buddy/src/sdk/matcher.ts
```

当前流程：

```text
打开列表 -> 解析当前可见岗位 -> 对少量岗位打开详情 -> 本地粗匹配 -> LLM rerank shortlist
```

问题：

- 只看当前页/当前可见区域，覆盖不足。
- 详情页打开存在页面复用/positionId 错位风险。
- 低分岗位仍可能进入投递。
- LLM rerank 前的候选池太小，模型没有足够好选项。

### 5.2 目标方案

将匹配拆为粗排和精排：

```text
Stage 1: Fast List Crawl
  多页快速抓取 title/category/location/updated/positionId/detailUrl

Stage 2: Coarse Scoring
  不打开详情，基于 title/category/location/list tags 和简历画像快速打分

Stage 3: Detail Enrichment
  只打开 Top 10/20 岗位详情，抓 description/requirements

Stage 4: Final Ranking
  本地特征分 + LLM rerank + 阈值裁决

Stage 5: Apply Decision
  Top 1 高于阈值才进入申请流；否则继续翻页或停止说明
```

### 5.3 可选加速路径

优先用 DOM 翻页实现，保证稳定。

如果后续发现阿里列表页有稳定 JSON 接口，可增加：

```text
NetworkJobSource
  -> 从浏览器 network response 捕获职位 JSON
  -> 作为快速列表源
  -> DOM crawler 作为 fallback
```

但 v1 不强依赖私有接口。

### 5.4 分数策略

建议分层：

```text
coarseScore = titleFit + skillOverlap + roleFit + locationFit + negativeSignals
detailScore = requirementsOverlap + projectFit + seniorityFit + educationFit
llmScore = LLM 对 Top N 的排序和理由
finalScore = weighted(coarseScore, detailScore, llmScore)
```

必须加入阈值：

```text
score < 0.25: 不进入投递，继续找
0.25 <= score < 0.45: 可展示给用户，但默认不自动进入申请
score >= 0.45: 可进入申请流程
```

阈值需要可配置，并在 trace/metrics 中记录。

### 5.5 验收标准

- 能快速扫描至少前 5 页或前 100 个岗位。
- 粗排不依赖 LLM，速度可控。
- 只对 Top N 打开详情，避免慢和费用高。
- 低匹配岗位不会进入申请流。
- trace 能解释：
  - 扫描了多少岗位。
  - 粗排 Top N 是谁。
  - 精排 Top N 是谁。
  - 为什么选中最终岗位。

## 6. Workstream C: Permission Modes and Risk Transparency

### 6.1 当前状态

当前策略：

```text
L0/L1/L2: allow
L3/L4: gate / ask
```

优点是安全，缺点是演示和真实使用都很卡。

### 6.2 目标方案

新增权限模式：

```text
safe
  默认生产模式。
  登录、验证码、上传、最终提交全部人工确认。

review
  允许进入申请流程和非最终 L3 动作。
  上传、验证码、最终提交仍确认。

trusted
  允许大多数 L3 操作，只拦 L4 和 final_submit。
  适合本机演示、调试、用户已授权场景。

autopilot
  最大自动化。
  仍建议默认保留 final_submit 硬门。
  如需真实最终提交，必须显式 --allow-final-submit。
```

### 6.3 风险透明展示

权限模式决定是否阻塞，但风险信息始终展示和审计：

```text
Next action: browser_click("投递简历")
Risk: L3
Gate kind: apply_entry
Decision: auto-allowed by trusted mode
Reason: entering application flow, not final submit
```

CLI 可先输出 compact 日志。

Web UI 后续展示为 timeline：

```text
Think -> Plan -> Risk -> Decision -> Tool -> Observation
```

### 6.4 验收标准

- 用户可通过 CLI/env/Web UI 选择 permission mode。
- `trusted` 模式下，进入申请流不再反复确认。
- `final_submit` 默认仍需确认。
- 每个自动允许的 L3/L4 动作都有审计记录。
- metrics 能统计 auto-allowed / gated / denied 动作。

## 7. Workstream D: Real Application Flow Semantics

### 7.1 当前问题

阿里真实页面中，登录后岗位详情可能只出现：

```text
checkbox: 同意申请工作需知
button: 投递简历
```

这不是传统“填写表单”，而是接近直接提交动作。

### 7.2 目标方案

明确区分流程语义：

```text
apply_entry
  进入申请流程，不一定是最终提交。

resume_select_or_upload
  选择已有在线简历或上传本地简历。

agreement_checkbox
  勾选协议；通常是最终提交前置条件。

final_submit
  真实投递提交。默认硬门。
```

如果页面只有 checkbox + 投递按钮，没有表单字段：

```text
1. agent 应判断为 direct-submit flow。
2. 展示岗位、简历画像、风险说明。
3. 停在 final_submit 前，让用户手动确认。
4. 不把它误判成“填表失败”。
```

### 7.3 验收标准

- 阿里 direct-submit flow 被识别为独立状态。
- agent 能解释“没有表单可填，因为该站点使用在线简历/直接投递模式”。
- 用户可以选择：
  - 停止。
  - 手动投递。
  - 在显式授权模式下继续最终提交。

## 8. 数据和审计输出

建议新增/扩展 artifact：

```text
output/traces/<run>/artifacts/resume-profile-v2.json
output/traces/<run>/artifacts/job-candidates-coarse.json
output/traces/<run>/artifacts/job-candidates-final.json
output/traces/<run>/artifacts/risk-decisions.json
```

每次真实投递应能回答：

```text
解析出的候选人画像是什么？
扫描了多少岗位？
为什么选择这个岗位？
为什么没有选择其他岗位？
哪些高风险动作被自动允许？
最终是否真实提交？
```

## 9. 实施顺序建议

### Step 1: ResumeProfile v2

- 增加 LLM structured resume parser。
- 保留 pdfjs/text extraction。
- 增加 schema validation 和 confidence/evidence。
- CLI 先输出简历画像摘要。

### Step 2: Fast Job Crawl v1

- 多页列表抓取。
- 去重 positionId。
- 粗排所有候选。
- 增加阈值，不合适就继续找或停止。

### Step 3: Detail Enrichment and Rerank

- Top N 打开详情。
- 修复详情页错位。
- LLM 只 rerank Top N。
- 输出候选解释 artifact。

### Step 4: Permission Modes

- env/CLI 支持 `PERMISSION_MODE=safe|review|trusted|autopilot`。
- `trusted` 自动允许 apply_entry。
- final_submit 仍保留硬门。

### Step 5: Risk Timeline

- CLI 输出风险决策摘要。
- Web UI 展示风险 badge / auto-allow 原因。

### Step 6: Direct Submit Flow

- 检测 checkbox + 投递按钮 + 无表单字段。
- 明确标记为 `direct_submit_review`。
- 停在 final_submit 前。

## 10. 测试计划

本地测试：

```text
npm run test:model
npm run test:e2e-auto-apply
npm run demo:form
npm run demo:research
```

新增测试建议：

```text
test:resume-llm-parser
test:resume-ingest-fixtures
test:job-crawl-pagination
test:job-match-threshold
test:permission-modes
test:direct-submit-flow
```

真实站点手动验收：

```text
1. 阿里列表扫描至少 5 页。
2. Top 10 候选与简历方向基本一致。
3. 低匹配岗位不会进入申请。
4. 登录/验证码仍交给人。
5. trusted 模式下 apply_entry 不反复确认。
6. final_submit 默认停止。
```

## 11. 风险和开放问题

### 11.1 LLM 简历解析成本

大模型解析更准，但会增加成本和延迟。

缓解：

- 文本 PDF 优先发文本。
- 扫描 PDF 才走多模态。
- 对同一简历缓存 `resume-profile-v2.json`。

### 11.2 多页职位抓取稳定性

招聘站点 DOM 会变。

缓解：

- DOM crawler + optional network source。
- 抓不到详情时仍可粗排。
- trace 记录失败页面截图。

### 11.3 权限放开带来的真实风险

trusted/autopilot 可能误点高风险动作。

缓解：

- final_submit 默认硬门。
- 所有 auto-allow 都审计。
- `--allow-final-submit` 必须显式声明。

### 11.4 匹配阈值需要校准

0.25/0.45 只是初始建议。

缓解：

- metrics 记录命中率。
- 使用真实简历和岗位样本校准。

## 12. 成功标准

Plan 2 完成后，真实投递演示应达到：

```text
用户上传任意常见简历
-> agent 生成可确认的简历画像
-> agent 快速扫描大量岗位
-> agent 解释 Top 匹配岗位
-> agent 只对合理匹配进入申请
-> agent 自动执行低/中风险和被授权的 apply_entry 动作
-> agent 明确停在登录、验证码、上传、最终提交等边界
-> 用户能从 UI/trace 理解整个过程
```

这时 web-buddy 才从“能跑 demo”进入“真实招聘投递体验可被用户信任”的阶段。
