# Playwright MCP Server + Visual Job-Application Agent SDK

A **generic, visual browser job-application agent**. Give it **any recruitment
site + a resume** and it logs in (via saved cookies), reads the page, and fills
the application form — with the **LLM driving the browser itself** through a
tool-calling loop. Every sensitive step (login, captcha, upload, save, submit)
waits for a human, and **nothing is ever submitted for real**. The whole run is
recorded as a replayable trace of reasoning, actions, screenshots, URLs, and
risk tiers.

Two layers in one package:

1. **Agent engine** (`src/core/` + `src/sdk/`) — generic ReAct loop, tool
   registry, LLM tool-use, cookie login, PDF resume, matcher, trace, highlight,
   human gates. Plus a demo CLI (`src/cli/demo.ts`).
2. **Playwright MCP server** (`src/server.ts`) — the same ref-based browser
   tools exposed over MCP stdio for any MCP client.

> **Safety contract.** The agent never logs in, never solves a captcha, never
> uploads a resume, never saves a draft, and never submits an application
> without a human at each of those five checkpoints. The final-submit gate
> *refuses* to auto-submit even when approved.

---

## Quick start

```bash
cd packages/playwright-mcp
npm install            # also runs `playwright install chromium`
npm run build

# 1) Offline demo — mock Alibaba form, visible LLM/heuristic fill (no key needed):
npm run demo

# 2) The headline: ANY site + resume → cookie login + LLM-driven fill:
npm run login -- https://your-recruiting-site.com/   # log in once, save cookies
MODEL_API_KEY=sk-... npm run fill -- https://your-recruiting-site.com/apply

# 3) Alibaba scrape + match (read-only):
npm run demo:match

# 4) Alibaba official site, no Web UI:
#    default = Claude Code recovered runtime + this package's Playwright MCP
npm run alibaba:apply -- --resume /path/to/resume.pdf

#    comparison path = local minimal raw Playwright runtime
npm run alibaba:apply:raw -- --resume /path/to/resume.pdf
```

No resume? A sample is generated automatically at `tmp/pdfs/resume.pdf`. Drop
your own `resume.pdf` / `resume.json` / `resume.txt` there (or `--resume path`).

### Configure your model

`fill` needs a model that supports **function/tool-calling**. Two wire formats:

- **Anthropic-compatible** (auto-detected from `ANTHROPIC_AUTH_TOKEN`) — e.g.
  **Zhipu GLM** (`open.bigmodel.cn/api/anthropic`, model `glm-4.7`) or real
  Anthropic. Verified end-to-end with tool-calling.
- **OpenAI-compatible** (`MODEL_API_KEY` + `MODEL_BASE_URL` + `MODEL_NAME`).

```bash
cp configs/agent.env.example .env
# edit .env: set ANTHROPIC_AUTH_TOKEN + ANTHROPIC_MODEL  (GLM)
#   — or — MODEL_API_KEY + MODEL_BASE_URL + MODEL_NAME  (OpenAI-compat)
```

### Web UI (dashboard)

A Codex-style dark dashboard to drive the agent from the browser:

```bash
npm run web                 # → http://localhost:5178
```

Then: pick provider/model/key, choose a mode (`demo-form` / `fill <url>` /
`match`), upload your resume, and **Run**. You get a live event stream
(think/act/observe/gate), the latest page screenshot, and the trace step
timeline — all in real time. Runs use the **auto human-gate** (sensitive steps
are surfaced as hand-offs in the stream).

Backend: `src/web/server.ts` (HTTP + SSE, wraps the orchestrator, serves
screenshots/trace). Frontend: `src/web/public/index.html` (vanilla JS/CSS,
inlined into the single-file bundle).

---

## Commands

### npm scripts

| Command | What it does | Needs key? |
|---------|--------------|------------|
| `npm run alibaba:apply` | **Default Alibaba run.** Builds `playwright-mcp`, builds `web-buddy`, then runs the Claude Code recovered runtime with the Playwright MCP server attached. | ✅ |
| `npm run alibaba:apply:raw` | **Comparison path.** Runs the local minimal raw Playwright agent loop directly, without Claude Code runtime. | ✅ |
| `npm run alibaba:claude` | Alias for the Claude runtime path. | ✅ |

Claude-runtime options:

```bash
npm run alibaba:apply -- --resume /path/to/resume.pdf
npm run alibaba:apply -- --resume /path/to/resume.pdf --stream-json
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-turns 100   # optional debug cap
npm run alibaba:apply -- --resume /path/to/resume.pdf --max-passes 3   # optional wrapper continuation cap
npm run alibaba:apply -- --resume /path/to/resume.pdf --dry-run
```

The Claude-runtime bridge generates a per-run folder under
`output/claude-runtime/<timestamp>/` with the MCP config, a redacted prompt
record, `run-events.log`, `stdout.log`, and `stderr.log`. By default this path
does not set Claude Code's `--max-turns`, so the runtime is not cut off by an
outer turn cap while the task is still in progress. Add `--max-turns <n>` only
when you want a debug cap. Because Claude Code `--print` can return a final
answer before the real-world task is complete, the wrapper asks the model to end
with `AGENT_STATUS=COMPLETED` or `AGENT_STATUS=BLOCKED`; if Claude exits without
one of those terminal markers, the wrapper starts another pass and continues the
same task. Add `--no-auto-continue` or `--max-passes <n>` when debugging. The
browser is kept open by default; pass `--close-browser-on-exit` for short tests.
When Claude reports a login/captcha/scan/verification block, the wrapper opens
a manual handoff browser, waits for you to finish the human step and press Enter,
saves the resulting storage state, then continues the task. Use
`--no-wait-on-blocked` to restore the old stop-on-blocked behavior.
For custom recruitment pages whose visible job titles are rendered as non-link
DOM nodes, the attached MCP server exposes `browser_click_text`, which clicks by
visible text when a title/card is not available as a `browser_snapshot` ref.
For application forms, the MCP server also exposes `browser_form_snapshot`,
`browser_upload_file`, `browser_fill_by_label`, and `browser_select_by_text`, so
the runtime can upload a resume PDF for site-side parsing, inspect required
fields and validation errors, then correct fields by label or visible option
text.
This path is intentionally experimental: it follows the user task through the
Claude Code runtime and may pass `confirmed=true` to Playwright click tools when
the model decides a high-risk apply/submit action is necessary.

### job-agent CLI

```bash
node dist/cli/demo.js <command> [options]
```

| Command | What it does | Needs key? |
|---------|--------------|------------|
| `raw <url>` | **Raw.** Open the URL and let the LLM drive the browser directly from your prompt + resume. No scraper, matcher, or fixed job-application workflow. | ✅ |
| `fill <url>` | **Generic.** Cookie-login the site, then the LLM-driven agent loop fills the application form from the resume. Never submits. | ✅ |
| `login <url>` | Open the site, let you log in manually, **save cookies** so later `fill` runs skip login. | ❌ |
| `alibaba-apply [url]` | Local raw Alibaba run used by `npm run alibaba:apply:raw`. | ✅ |
| `match [--list-url]` | Alibaba preset: scrape list + details, match to resume, hand off at the gate (read-only). | optional |
| `demo-form` | Offline mock form; visible fill via the agent loop (or heuristic fallback). Always works. | optional |

Options: `--resume`, `--headful`/`--headless`, `--auto-gate`, `--model-key`,
`--base-url`, `--model-name`, `--storage-state`, `--prompt`,
`--keep-browser-open`, `--max-jobs`, `-h/--help`.

Default `alibaba-apply` prompt:

```text
这是我的个人简历文件，然后现在我想去阿里官方招聘网站进行投递，然后请帮我找到适合我的岗位，然后帮我进行投递，填写表单，充分利用网站信息
```

For a saved-login run:

```bash
npm run login -- https://talent-holding.alibaba.com/off-campus/position-list?lang=zh
npm run alibaba:apply -- --resume /path/to/resume.pdf --headful
```

---

## Architecture

```text
src/
  core/                    ★ generic agent engine (the brain)
    agent-loop.ts          ReAct loop: LLM picks browser tools itself (tool-calling)
    tool-registry.ts       schema-driven tool registry → OpenAI function schemas
    page-view.ts           snapshot → LLM-readable text ([e1]/[e2] refs + risk)
    login.ts               cookie login (storageState save/load) + login-wall detect
  sdk/                     domain logic + runtime
    orchestrator.ts        runJobApplicationAgent() — unified pipeline (raw/fill/match/alibaba-apply/demo-form)
    llm.ts                 LLM client: OpenAI-compat + Anthropic Messages (tool-use)
    config.ts / human.ts / trace.ts / highlight.ts / resume.ts / matcher.ts / alibaba.ts / form-fill.ts
  web/                     web UI (HTTP + SSE server + Codex-style dashboard)
    server.ts · public/index.html
  browser/ snapshot/ session/ policy/ tools/   MCP server core (ref-based browser tools)
  cli/demo.ts              the demo CLI (fill / login / match / demo-form)
  server.ts                the MCP server entry
```

### How the generic fill works (the key idea)

There is **no hardcoded field mapping**. Instead:

1. The page is snapshotted into a compact, LLM-readable text view listing every
   interactive element with a stable ref (`[e1] input "姓名 Name" risk=L2`).
2. That view + the parsed resume go to the model as a system prompt, with the
   browser tools available as **function calls**.
3. The model decides the next action — `browser_type ref=e1 text="Zhang San"`,
   `browser_click ref=e4`, … — and the loop executes it, feeds the updated page
   view back, and repeats until the model calls `agent_done`.
4. Risky actions (L3/L4) are intercepted by the **human gate** before they run.

This is the hermes/openclaw-style "LLM drives the browser via tool calls" loop,
in TypeScript, with visualization and a hard safety contract.

### Cookie login

`login <url>` opens the site, hands the window to you to log in (+ solve any
captcha), then persists cookies via Playwright `storageState` to
`output/auth/<host>.json`. Subsequent `fill` runs load that file, so you log in
once and the agent reuses the session — no credentials stored in code.

---

## Human-in-the-loop gates

| Gate | When |
|------|------|
| `login` | A login wall appears |
| `captcha` | A verification challenge appears |
| `upload_resume` | Attaching the resume PDF |
| `save_resume` | Persisting the on-site draft |
| `final_submit` | Submitting — **MVP refuses to auto-submit even if approved** |

Every step is recorded under `output/<runId>/` (`trace.jsonl` + `summary.json`
+ PNG screenshots) with action, timestamp, URL, and risk tier.

---

## Use it as a library

```ts
import { runJobApplicationAgent, loadConfig } from '@multi-functional-agent/playwright-mcp/dist/sdk/orchestrator.js'

const result = await runJobApplicationAgent({
  config: loadConfig(),
  mode: 'fill',
  startUrl: 'https://your-site.com/apply',
  onEvent: (e) => console.log(e.phase, e.message),
})
console.log(result.finalState, result.summary.tracePath)
```

Lower level: build a `ToolRegistry`, point a `LlmGateway` at your model, and run
`runAgentLoop({ goal, resume, llm, registry, ctx, gate })` directly for any
browser task — not just job applications.

---

## Risk tiers

| Tier | Meaning | Gate |
|------|---------|------|
| L0–L1 | Info / safe navigation | none |
| L2 | Form inputs | auto-filled |
| L3 | Submit-like buttons (提交/投递/申请/submit/apply) | `confirmed=true` + human gate |
| L4 | `password` / `file` inputs | always gated |

## MCP server

The same browser tools are exposed over MCP stdio (`dist/server.js`):
`browser_open`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_select`, `browser_wait`, `browser_screenshot`. See
[`configs/mcp.playwright.example.json`](../../configs/mcp.playwright.example.json).

## Scripts

```bash
npm run build              # compile src → dist (server + cli + core + sdk)
npm run web                # web UI dashboard → http://localhost:5178
npm run demo               # offline demo-form (visible)
npm run demo:match         # Alibaba scrape + match (headful)
npm run alibaba:apply      # Raw Alibaba browser-agent run
npm run fill / login       # generic fill / interactive cookie login
npm run test:smoke         # browser tools + risk gating
npm run test:resume        # PDF → ResumeProfile
npm run test:matcher       # deterministic heuristic ranking
npm run test:agent-loop    # generic agent loop (mock LLM, no key needed)
npm run test:alibaba-probe # live Alibaba read-only probe (never submits)
```

## Environment variables

See [`configs/agent.env.example`](../../configs/agent.env.example) for the full
list (model, resume, cookie login, browser/visualization, agent loop, safety,
trace).
