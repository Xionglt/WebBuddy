# 完整体验教程 / Full Experience Guide

> 中文版在前，English version follows.

本教程面向第一次拉取仓库的人，目标是从零开始完整体验当前项目的主要能力：离线 demo、Web 控制台、模型配置、任意招聘网站填表、阿里巴巴招聘投递 runtime、raw 对照运行、trace 和日志查看。

## 中文版

### 1. 前置要求

建议环境：

- macOS / Linux / Windows WSL。
- Node.js 18 或更高版本，建议 Node.js 20+。
- npm。
- Git。
- 一个支持 tool calling 的模型 API Key。

已经验证过的模型接入方式：

- 智谱 GLM，Anthropic-compatible API，推荐 `glm-4.7`。
- OpenAI-compatible API，只要模型支持 function/tool calling。

如果只是体验离线 demo，可以先不配置模型 Key。

### 2. 拉取仓库

```bash
git clone https://github.com/Xionglt/multi-functional-agent.git
cd multi-functional-agent
git checkout main
```

项目当前没有根目录 `package.json`，主要需要安装两个 package：

- `packages/web-buddy`
- `packages/claude-code`

### 3. 安装依赖

```bash
cd packages/web-buddy
npm install
npm run build

cd ../claude-code
npm install
npm run build
```

`packages/web-buddy` 的 `postinstall` 会安装 Chromium。如果 Chromium 没装成功，可以手动执行：

```bash
cd ../web-buddy
npx playwright install chromium
```

### 4. 先跑不需要 Key 的离线 demo

离线 demo 使用本地 fixture，不访问真实招聘网站，适合验证浏览器、构建、trace、metrics 和 safety report 是否正常。

```bash
cd packages/web-buddy
npm run demo:form
npm run demo:research
npm run report:safety
```

`demo:form` 会打开本地 mock 表单并尝试填写字段；`demo:research` 会打开本地只读产品/文档页，生成结构化 `research-summary.json`、trace 和 metrics。

也可以跑基础测试：

```bash
npm run test:smoke
npm run test:resume
npm run test:agent-loop
npm run benchmark:research
```

### 5. 配置模型 Key

在仓库根目录创建 `.env`：

```bash
cd ../..
cp configs/agent.env.example .env
```

然后编辑 `.env`。

如果使用智谱 GLM：

```env
ANTHROPIC_BASE_URL=https://open.bigmodel.cn
ANTHROPIC_AUTH_TOKEN=你的智谱APIKey
ANTHROPIC_MODEL=glm-4.7
```

如果使用 OpenAI-compatible API：

```env
MODEL_API_KEY=你的APIKey
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
```

注意：

- 不要提交 `.env`。
- `.env` 已被 gitignore 忽略。
- Claude runtime bridge 也支持 `--env-file /path/to/.env` 显式传入配置。

### 6. 准备简历

CLI 和 Web UI 当前面向用户支持三种输入：

- PDF：文本型 PDF 会用 `pdfjs-dist` 抽取文本。
- JSON：可以是旧版 `ResumeProfile`，也可以是 `resume-profile/v2`。
- TXT：普通文本简历。

Resume Ingestion v2 会在 SDK 路径中生成带 `confidence`、短 `evidence`、
schema 校验和 email/phone 确定性修复的结构化画像；当前主流程会消费兼容后的
`ResumeProfile`。如果没有传简历，部分本地 demo 会自动生成 sample resume。
扫描版或图片型 PDF 不能假设 100% 解析正确；遇到低质量文本时会给出 warning
或回退到启发式解析。

推荐把自己的简历放在一个本地路径，然后运行命令时通过 `--resume` 传入：

```bash
--resume /path/to/resume.pdf
```

也可以在 `.env` 中设置：

```env
RESUME_PDF_PATH=/path/to/resume.pdf
```

可以用本地 fixture 验证 v2 ingest：

```bash
cd packages/web-buddy
npm run test:resume-ingest
```

### 7. 启动 Web 控制台

Web 控制台适合观察 agent 行为、配置模型、上传简历、查看事件流和 trace。

```bash
cd packages/web-buddy
npm run web
```

浏览器打开：

```text
http://localhost:5178
```

如果 5178 被占用，server 会自动尝试后续端口。

在 Web UI 中可以体验：

- 配置 provider / model / key。
- 上传简历。
- 运行 `demo-form`。
- 运行通用 fill。
- 观察 think / act / observe / gate 事件。
- 查看截图和 trace。
- 在遇到登录、验证码、扫码时通过 UI 继续。

### 8. 体验任意网站填表

第一步，登录一次并保存 cookie：

```bash
cd packages/web-buddy
npm run login -- https://your-recruiting-site.com/
```

浏览器打开后，手动完成登录、验证码、扫码等步骤。完成后根据终端提示继续，系统会保存 Playwright `storageState`。

第二步，让 agent 填写申请表：

```bash
npm run fill -- https://your-recruiting-site.com/apply
```

如果你要显式传简历：

```bash
npm run fill -- https://your-recruiting-site.com/apply --resume /path/to/resume.pdf
```

可以通过 permission mode 调整非最终高风险动作的提示频率：

```bash
npm run fill -- https://your-recruiting-site.com/apply \
  --resume /path/to/resume.pdf \
  --permission-mode review
```

说明：

- `fill` 需要模型 Key。
- agent 会通过浏览器工具读取页面、选择输入框、填写字段。
- `safe|review|trusted|autopilot` 只影响可自动放行的非最终动作。
- 登录、验证码、上传、保存、最终提交等敏感步骤默认仍会进入人工交接。
- 首次测试真实网站时建议选择你自己的账号和可控页面。

### 9. 体验阿里巴巴招聘 Claude runtime

这是高级对照路径：恢复版 Claude Code runtime 通过 Playwright MCP 操作阿里巴巴官方招聘网站。它适合调试 Claude runtime bridge 和 MCP 工具链；Plan 2 的本地安全边界、permission mode、候选 artifact 和 direct-submit review 主要在 `packages/web-buddy` 本地 runtime 中验证。

先做 dry-run，确认配置和 MCP 工具都能生成：

```bash
cd packages/web-buddy
npm run alibaba:apply -- \
  --resume /path/to/resume.pdf \
  --dry-run
```

真实运行：

```bash
npm run alibaba:apply -- \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open
```

如果 `.env` 不在仓库根目录，可以显式传入：

```bash
npm run alibaba:apply -- \
  --env-file /path/to/.env \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open
```

常用调试参数：

```bash
# 输出 Claude Code stream-json，便于 Web 控制台和 trace 分析
npm run alibaba:apply -- --resume /path/to/resume.pdf --stream-json

# 限制 Claude turn 数，只用于调试
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-turns 20

# 限制 wrapper 自动续跑轮数
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-passes 2

# 遇到 BLOCKED 后不等待人工交接
npm run alibaba:apply -- --resume /path/to/resume.pdf --no-wait-on-blocked
```

运行时如果遇到登录、短信验证码、扫码或人机验证，终端会提示你在浏览器里人工处理。处理完成后回到终端按 Enter，runtime 会保存登录状态并继续同一个任务。不要把这个路径理解成可以绕过登录或验证码。

### 10. 体验 raw 对照路径

raw 路径不走恢复版 Claude Code runtime，而是使用本项目的本地 minimal agent loop。它适合对比“Claude runtime + MCP”和“本地 raw runtime”的行为差异。

```bash
cd packages/web-buddy
npm run alibaba:apply:raw -- \
  --resume /path/to/resume.pdf \
  --keep-browser-open
```

也可以直接指定任意 URL 和 prompt：

```bash
node dist/cli/demo.js raw 'https://example.com' \
  --resume /path/to/resume.pdf \
  --prompt '请打开页面，观察当前信息，然后总结页面主要内容。'
```

### 11. 阿里职位匹配只读模式

如果只想体验职位抓取和匹配，不进入真实投递流程：

```bash
cd packages/web-buddy
npm run demo:match -- \
  --resume /path/to/resume.pdf \
  --max-pages 5 \
  --max-crawl-jobs 100 \
  --max-jobs 10 \
  --match-threshold 0.45
```

这个模式会先快速扫描多页列表，基于标题、类别、地点、标签和简历画像做粗排，再只打开 Top N 详情做精排。低于阈值的岗位会停在 `no_match`，不会进入申请流。候选解释会写到 `job-candidates-coarse.json` 和 `job-candidates-final.json`。

### 12. 从上传简历到岗位匹配再到 direct-submit review

真实招聘投递建议按这个顺序做：

1. 上传或传入简历：Web UI 使用上传控件，CLI 使用 `--resume /path/to/resume.pdf`。
2. 先跑 `npm run test:resume-ingest` 或查看运行日志里的 `parse_resume` 摘要，确认姓名、邮箱、电话、技能和项目方向没有明显错误。
3. 运行只读匹配，确认扫描页数、Top 候选和阈值决策合理。
4. 需要进入申请流时使用 headful 浏览器，并保持 `final_submit` 默认 gated。可以把 permission mode 调到 `review` 或 `trusted` 来减少非最终 L3 动作确认，但不要关闭最终提交边界。
5. 如果页面跳到登录、短信、扫码或验证码，人工在浏览器里处理；agent 不会代替你绕过这些检查。
6. 如果登录后页面只有“申请工作需知/协议” checkbox 和“投递简历”按钮，没有真实可填写表单，agent 会识别为 `direct_submit_review`。
7. 在 `direct_submit_review` 状态下，运行会写 `direct-submit-review.json`，说明该站点使用在线简历/直接投递模式，并停在 `final_submit` 前。此时用户可以停止、自己手动操作，或在明确授权的受控环境中继续；默认不会真实提交。

本地 guarded runtime 可通过 legacy mode 直接体验该链路：

```bash
cd packages/web-buddy
node dist/cli/demo.js --mode alibaba-apply \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open \
  --permission-mode trusted \
  --max-pages 5 \
  --max-crawl-jobs 100 \
  --max-jobs 10
```

这条链路需要支持 tool calling 的模型 Key。首次真实站点验证请使用你有权操作的账号、简历和岗位，并观察浏览器最终停在哪里。

### 13. 查看运行输出

运行产物主要在：

```text
output/
```

常见目录：

```text
output/<runId>/trace.jsonl
output/<runId>/summary.json
output/<runId>/shot-*.png
output/sessions/<sessionId>/session.json
output/sessions/<sessionId>/transcript.jsonl
output/sessions/<sessionId>/events.jsonl
output/sessions/<sessionId>/workflow.json
output/claude-runtime/<timestamp>/run-events.log
output/claude-runtime/<timestamp>/stdout.log
output/claude-runtime/<timestamp>/stderr.log
output/claude-runtime/<timestamp>/mcp.playwright.json
output/traces/<traceId>/session.json
output/traces/<traceId>/spans.jsonl
output/traces/<traceId>/events.jsonl
output/traces/<traceId>/metrics.json
output/traces/<traceId>/safety-report.json
output/traces/<traceId>/artifacts/page-state-latest.json
output/traces/<traceId>/artifacts/form-state-latest.json
output/traces/<traceId>/artifacts/research-summary.json
output/traces/<traceId>/artifacts/risk-decisions.json
output/traces/<traceId>/artifacts/job-candidates-coarse.json
output/traces/<traceId>/artifacts/job-candidates-final.json
output/traces/<traceId>/artifacts/direct-submit-review.json
```

排查问题时优先看：

1. `output/sessions/<sessionId>/session.json`
2. `output/sessions/<sessionId>/transcript.jsonl`
3. `run-events.log`
4. `stdout.log`
5. `stderr.log`
6. `metrics.json`
7. `safety-report.json`
8. `artifacts/job-candidates-final.json`
9. `artifacts/risk-decisions.json`
10. `artifacts/direct-submit-review.json`
11. `spans.jsonl`
12. 最后的截图

### 14. 安全注意事项

- 不要提交 `.env`、Cookie、storage state、简历原文或验证码信息。
- `output/` 默认是运行产物目录，里面可能包含截图、日志、登录态路径或简历相关信息。
- 真实招聘网站测试请使用你有权操作的账号和简历。
- 首次测试建议先用 `--dry-run` 或离线 demo。
- permission mode 可以减少非最终动作提示，但 `final_submit` 默认仍是硬边界。
- `HUMAN_GATE_MODE=auto` 是非交互交接/测试模式，不代表真实最终提交授权。
- 真实投递相关动作会受到 runtime、工具和人工交接逻辑影响，但你仍然应该在浏览器里观察关键步骤。
- Safety Model 详见 [`docs/safety-model.md`](./safety-model.md)。

### 15. 常见问题

#### npm 找不到 package.json

如果你已经在 `packages/web-buddy` 目录里，就不要再写：

```bash
npm --prefix packages/web-buddy run ...
```

应该直接运行：

```bash
npm run ...
```

如果你在仓库根目录，才使用：

```bash
npm --prefix packages/web-buddy run web
```

#### 缺少模型 Key

确认仓库根目录 `.env` 存在，并且设置了：

```env
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_MODEL=glm-4.7
```

或者 OpenAI-compatible：

```env
MODEL_API_KEY=...
MODEL_BASE_URL=...
MODEL_NAME=...
```

#### 浏览器没有打开

确认：

```env
PLAYWRIGHT_HEADLESS=false
```

或者命令里加：

```bash
--headful
```

#### 网站打不开或被拦截

检查 allowlist：

```env
PLAYWRIGHT_ALLOWED_DOMAINS=talent-holding.alibaba.com
```

如果是其他网站，把目标域名加进去，多个域名用逗号分隔。

#### 运行中断但没有完成

查看最新目录：

```text
output/claude-runtime/<timestamp>/
```

重点看 `run-events.log` 和 `stdout.log` 中的 `AGENT_STATUS`。

#### 匹配结果停在 no_match

打开 `job-candidates-final.json`，查看最高分、阈值和 missing skills。可以调整 `--max-pages`、`--max-crawl-jobs`、`--max-jobs` 或 `--match-threshold`，但不要为了强行投递而把明显不匹配的岗位放过阈值。

#### 看到 direct-submit review

这不是普通填表失败。它表示页面没有可填写申请字段，下一步就是最终提交边界。查看 `direct-submit-review.json`，确认岗位、页面信号和提示后再决定是否手动处理。

#### trusted/autopilot 仍然要求确认

这是预期行为。登录、验证码、上传、保存简历和 `final_submit` 默认仍然要求人工边界。

### 16. 建议体验顺序

推荐按这个顺序体验：

1. `npm run build`
2. `npm run demo`
3. `npm run web`
4. 配置模型 Key
5. Web UI 运行 `demo-form`
6. 上传或传入简历，运行 `npm run test:resume-ingest`
7. `npm run demo:match -- --resume /path/to/resume.pdf --max-pages 5`
8. `npm run login -- <your-site>`
9. `npm run fill -- <your-apply-url> --resume /path/to/resume.pdf --permission-mode review`
10. `npm run alibaba:apply -- --resume /path/to/resume.pdf --dry-run`
11. 需要验证本地 guarded 阿里链路时运行 `node dist/cli/demo.js --mode alibaba-apply --resume /path/to/resume.pdf --headful --keep-browser-open`
12. 查看 `output/` trace、candidate artifact、risk artifact 和日志

---

## English Version

This guide is for someone who clones the repository for the first time and wants to experience the main capabilities end to end: offline demo, Web console, model configuration, generic recruiting-site form filling, Alibaba Careers Claude runtime, raw comparison runtime, traces, and logs.

### 1. Prerequisites

Recommended environment:

- macOS / Linux / Windows WSL.
- Node.js 18 or newer, Node.js 20+ recommended.
- npm.
- Git.
- A model API key that supports tool/function calling.

Verified model options:

- Zhipu GLM through an Anthropic-compatible API, recommended model: `glm-4.7`.
- Any OpenAI-compatible API whose model supports tool/function calling.

If you only want to try the offline demo, you can skip the model key at first.

### 2. Clone the Repository

```bash
git clone https://github.com/Xionglt/multi-functional-agent.git
cd multi-functional-agent
git checkout main
```

The repository currently has no root-level `package.json`. Install the two main packages:

- `packages/web-buddy`
- `packages/claude-code`

### 3. Install Dependencies

```bash
cd packages/web-buddy
npm install
npm run build

cd ../claude-code
npm install
npm run build
```

`packages/web-buddy` runs `playwright install chromium` during postinstall. If Chromium is missing, install it manually:

```bash
cd ../web-buddy
npx playwright install chromium
```

### 4. Run the Offline Demo Without a Key

The offline demos use local fixtures. They do not touch a real recruiting website, and they are the safest first check for browser control, trace, metrics, and safety reports.

```bash
cd packages/web-buddy
npm run demo:form
npm run demo:research
npm run report:safety
```

`demo:form` opens a local mock form and attempts to fill fields. `demo:research` opens a local read-only product/docs page and writes `research-summary.json`, trace, and metrics.

You can also run basic tests:

```bash
npm run test:smoke
npm run test:resume
npm run test:agent-loop
npm run benchmark:research
```

### 5. Configure a Model Key

Create `.env` in the repository root:

```bash
cd ../..
cp configs/agent.env.example .env
```

Then edit `.env`.

For Zhipu GLM:

```env
ANTHROPIC_BASE_URL=https://open.bigmodel.cn
ANTHROPIC_AUTH_TOKEN=your_zhipu_api_key
ANTHROPIC_MODEL=glm-4.7
```

For an OpenAI-compatible API:

```env
MODEL_API_KEY=your_api_key
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
```

Notes:

- Never commit `.env`.
- `.env` is ignored by git.
- The Claude runtime bridge also supports `--env-file /path/to/.env`.

### 6. Prepare a Resume

User-facing CLI and Web UI inputs are:

- PDF: text PDFs are extracted with `pdfjs-dist`.
- JSON: either the legacy `ResumeProfile` shape or `resume-profile/v2`.
- TXT: plain text resumes.

Resume Ingestion v2 returns field-level confidence, short sanitized evidence,
schema validation, optional LLM parsing, heuristic fallback, and deterministic
email/phone repair for SDK callers. The current orchestrator still consumes the
compatible `ResumeProfile` shape. Some local demos generate a sample resume
automatically. Scanned or image-heavy PDFs are best-effort and should not be
treated as perfectly parsed.

For real runs, pass your resume explicitly:

```bash
--resume /path/to/resume.pdf
```

Or set it in `.env`:

```env
RESUME_PDF_PATH=/path/to/resume.pdf
```

Verify the v2 ingestion fixtures locally:

```bash
cd packages/web-buddy
npm run test:resume-ingest
```

### 7. Start the Web Console

The Web console is useful for model configuration, resume upload, live events, screenshots, and trace review.

```bash
cd packages/web-buddy
npm run web
```

Open:

```text
http://localhost:5178
```

If port 5178 is busy, the server will try the next ports automatically.

In the Web UI you can:

- configure provider / model / key.
- upload a resume.
- run `demo-form`.
- run generic fill.
- watch think / act / observe / gate events.
- inspect screenshots and trace.
- continue after login, captcha, or scan handoffs.

### 8. Try Generic Form Filling on Any Website

First, log in once and save cookies:

```bash
cd packages/web-buddy
npm run login -- https://your-recruiting-site.com/
```

Complete login, captcha, or scan manually in the browser. Then follow the terminal prompt so the system can save Playwright `storageState`.

Second, let the agent fill an application form:

```bash
npm run fill -- https://your-recruiting-site.com/apply
```

With an explicit resume:

```bash
npm run fill -- https://your-recruiting-site.com/apply --resume /path/to/resume.pdf
```

Tune permission mode for non-final risky actions:

```bash
npm run fill -- https://your-recruiting-site.com/apply \
  --resume /path/to/resume.pdf \
  --permission-mode review
```

Notes:

- `fill` requires a model key.
- The agent reads the page through browser tools and fills matching fields.
- `safe|review|trusted|autopilot` only changes which non-final actions can be auto-allowed.
- Login, captcha, upload, save, and final submit remain human-gated by default.
- For first real-site tests, use an account and page you control.

### 9. Try the Alibaba Careers Claude Runtime

This is an advanced comparison path: the recovered Claude Code runtime operates Alibaba Careers through Playwright MCP. Use it to debug the Claude runtime bridge and MCP toolchain. Plan 2's local safety boundary, permission modes, candidate artifacts, and direct-submit review are primarily verified in the `packages/web-buddy` local runtime.

First run dry-run:

```bash
cd packages/web-buddy
npm run alibaba:apply -- \
  --resume /path/to/resume.pdf \
  --dry-run
```

Real run:

```bash
npm run alibaba:apply -- \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open
```

If your `.env` lives elsewhere:

```bash
npm run alibaba:apply -- \
  --env-file /path/to/.env \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open
```

Useful debugging options:

```bash
npm run alibaba:apply -- --resume /path/to/resume.pdf --stream-json
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-turns 20
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-passes 2
npm run alibaba:apply -- --resume /path/to/resume.pdf --no-wait-on-blocked
```

If the site requires login, SMS, QR scan, captcha, or other human-only steps, the terminal will pause. Complete the step in the browser, then press Enter in the terminal. The runtime saves the browser state and continues the same task. This path does not bypass login or verification.

### 10. Try the Raw Comparison Runtime

The raw path does not use the recovered Claude Code runtime. It uses this repository's local minimal agent loop, which is useful for comparison.

```bash
cd packages/web-buddy
npm run alibaba:apply:raw -- \
  --resume /path/to/resume.pdf \
  --keep-browser-open
```

You can also run a custom raw URL and prompt:

```bash
node dist/cli/demo.js raw 'https://example.com' \
  --resume /path/to/resume.pdf \
  --prompt 'Open the page, inspect the visible information, and summarize it.'
```

### 11. Alibaba Job Matching Read-Only Mode

To try job scraping and matching without entering the real application flow:

```bash
cd packages/web-buddy
npm run demo:match -- \
  --resume /path/to/resume.pdf \
  --max-pages 5 \
  --max-crawl-jobs 100 \
  --max-jobs 10 \
  --match-threshold 0.45
```

This mode quickly scans multiple list pages, coarse-ranks by title, category, location, tags, and resume profile, then opens only Top N detail pages for final ranking. Below-threshold jobs stop at `no_match` before the apply flow. Candidate explanations are written to `job-candidates-coarse.json` and `job-candidates-final.json`.

### 12. From Resume Upload to Matching to Direct-Submit Review

For real recruiting workflows, use this flow:

1. Upload or pass a resume: Web UI upload, or CLI `--resume /path/to/resume.pdf`.
2. Run `npm run test:resume-ingest` or check the `parse_resume` summary in the run log to confirm name, contact, skills, and direction look reasonable.
3. Run read-only matching first, then review scanned pages, Top candidates, and threshold decisions.
4. When entering an application flow, stay headful and keep `final_submit` gated. You may use `review` or `trusted` permission mode to reduce non-final L3 prompts, but do not remove the final-submit boundary.
5. If the site shows login, SMS, QR, or captcha, complete that manually in the browser; the agent does not bypass those checks.
6. If the post-login page has only an application notice/agreement checkbox and an apply button, with no real fillable form, the agent marks it as `direct_submit_review`.
7. In `direct_submit_review`, the run writes `direct-submit-review.json`, explains the online-resume/direct-submit semantics, and stops before `final_submit`. The user can stop, take over manually, or continue only in an explicitly authorized controlled environment; default behavior is not to submit.

The local guarded runtime can exercise this chain through the legacy mode entry:

```bash
cd packages/web-buddy
node dist/cli/demo.js --mode alibaba-apply \
  --resume /path/to/resume.pdf \
  --headful \
  --keep-browser-open \
  --permission-mode trusted \
  --max-pages 5 \
  --max-crawl-jobs 100 \
  --max-jobs 10
```

This path needs a tool-calling model key. For first real-site verification, use
an account, resume, and job you are authorized to operate, and watch where the
browser stops.

### 13. Inspect Run Outputs

Run artifacts live under:

```text
output/
```

Common files:

```text
output/<runId>/trace.jsonl
output/<runId>/summary.json
output/<runId>/shot-*.png
output/sessions/<sessionId>/session.json
output/sessions/<sessionId>/transcript.jsonl
output/sessions/<sessionId>/events.jsonl
output/sessions/<sessionId>/workflow.json
output/claude-runtime/<timestamp>/run-events.log
output/claude-runtime/<timestamp>/stdout.log
output/claude-runtime/<timestamp>/stderr.log
output/claude-runtime/<timestamp>/mcp.playwright.json
output/traces/<traceId>/session.json
output/traces/<traceId>/spans.jsonl
output/traces/<traceId>/events.jsonl
output/traces/<traceId>/metrics.json
output/traces/<traceId>/safety-report.json
output/traces/<traceId>/artifacts/page-state-latest.json
output/traces/<traceId>/artifacts/form-state-latest.json
output/traces/<traceId>/artifacts/research-summary.json
output/traces/<traceId>/artifacts/risk-decisions.json
output/traces/<traceId>/artifacts/job-candidates-coarse.json
output/traces/<traceId>/artifacts/job-candidates-final.json
output/traces/<traceId>/artifacts/direct-submit-review.json
```

For debugging, check in this order:

1. `output/sessions/<sessionId>/session.json`
2. `output/sessions/<sessionId>/transcript.jsonl`
3. `run-events.log`
4. `stdout.log`
5. `stderr.log`
6. `metrics.json`
7. `safety-report.json`
8. `artifacts/job-candidates-final.json`
9. `artifacts/risk-decisions.json`
10. `artifacts/direct-submit-review.json`
11. `spans.jsonl`
12. final screenshot

### 14. Safety Notes

- Do not commit `.env`, cookies, storage state, raw resume content, or verification codes.
- `output/` may contain screenshots, logs, paths to login state, and resume-related information.
- Use real recruiting websites only with accounts and resumes you are allowed to operate.
- Start with `--dry-run` or the offline demo.
- Permission modes can reduce non-final prompts, but `final_submit` remains a hard boundary by default.
- `HUMAN_GATE_MODE=auto` is a non-interactive handoff/testing mode, not real final-submit authorization.
- Watch the browser during important real-site steps.
- See [`docs/safety-model.md`](./safety-model.md) for the full safety model.

### 15. Troubleshooting

#### npm cannot find package.json

If you are already inside `packages/web-buddy`, do not run:

```bash
npm --prefix packages/web-buddy run ...
```

Run this instead:

```bash
npm run ...
```

Use `--prefix` only from the repository root:

```bash
npm --prefix packages/web-buddy run web
```

#### Missing model key

Make sure root `.env` exists and contains:

```env
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_MODEL=glm-4.7
```

Or OpenAI-compatible settings:

```env
MODEL_API_KEY=...
MODEL_BASE_URL=...
MODEL_NAME=...
```

#### Browser does not open

Set:

```env
PLAYWRIGHT_HEADLESS=false
```

Or pass:

```bash
--headful
```

#### Website is blocked by navigation policy

Check:

```env
PLAYWRIGHT_ALLOWED_DOMAINS=talent-holding.alibaba.com
```

For other websites, add the target host. Multiple domains are comma-separated.

#### Run exits before completion

Open the latest folder:

```text
output/claude-runtime/<timestamp>/
```

Check `run-events.log` and `stdout.log`, especially the final `AGENT_STATUS`.

#### Matching stops at no_match

Open `job-candidates-final.json` and review the top score, threshold, and
missing skills. You can tune `--max-pages`, `--max-crawl-jobs`, `--max-jobs`,
or `--match-threshold`, but do not lower the threshold just to force an
unrelated job into the apply flow.

#### Direct-submit review appears

This is not ordinary form-fill failure. It means the page has no fillable
application fields and the next step is final submit. Review
`direct-submit-review.json` before deciding whether to handle the site manually.

#### trusted/autopilot still asks

That is expected. Login, captcha, upload, save-resume, and `final_submit` remain
human boundaries by default.

### 16. Recommended Experience Order

1. `npm run build`
2. `npm run demo`
3. `npm run web`
4. configure model key
5. run `demo-form` in the Web UI
6. upload or pass a resume, then run `npm run test:resume-ingest`
7. `npm run demo:match -- --resume /path/to/resume.pdf --max-pages 5`
8. `npm run login -- <your-site>`
9. `npm run fill -- <your-apply-url> --resume /path/to/resume.pdf --permission-mode review`
10. `npm run alibaba:apply -- --resume /path/to/resume.pdf --dry-run`
11. for the local guarded Alibaba path, run `node dist/cli/demo.js --mode alibaba-apply --resume /path/to/resume.pdf --headful --keep-browser-open`
12. inspect `output/` traces, candidate artifacts, risk artifacts, and logs
