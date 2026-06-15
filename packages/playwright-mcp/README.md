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
```

No resume? A sample is generated automatically at `tmp/pdfs/resume.pdf`. Drop
your own `resume.pdf` / `resume.json` / `resume.txt` there (or `--resume path`).

### Configure your model

`fill` needs an OpenAI-compatible model that supports **function/tool-calling**.

```bash
cp configs/agent.env.example .env
# edit .env: set MODEL_API_KEY (and MODEL_BASE_URL / MODEL_NAME if not OpenAI)
```

---

## Commands

```bash
node dist/cli/demo.js <command> [options]
```

| Command | What it does | Needs key? |
|---------|--------------|------------|
| `fill <url>` | **Generic.** Cookie-login the site, then the LLM-driven agent loop fills the application form from the resume. Never submits. | ✅ |
| `login <url>` | Open the site, let you log in manually, **save cookies** so later `fill` runs skip login. | ❌ |
| `match [--list-url]` | Alibaba preset: scrape list + details, match to resume, hand off at the gate (read-only). | optional |
| `demo-form` | Offline mock form; visible fill via the agent loop (or heuristic fallback). Always works. | optional |

Options: `--resume`, `--headful`/`--headless`, `--auto-gate`, `--model-key`,
`--base-url`, `--model-name`, `--storage-state`, `--max-jobs`, `-h/--help`.

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
    orchestrator.ts        runJobApplicationAgent() — unified pipeline (fill/match/demo-form)
    llm.ts                 OpenAI-compatible client: chat + chatWithTools (tool-use)
    config.ts / human.ts / trace.ts / highlight.ts / resume.ts / matcher.ts / alibaba.ts / form-fill.ts
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
npm run demo               # offline demo-form (visible)
npm run demo:match         # Alibaba scrape + match (headful)
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
