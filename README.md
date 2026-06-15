# Multi-Functional Agent

A **generic, visual browser job-application agent**. Give it **any recruitment
site + a resume** and it logs in (via saved cookies), reads the page, and fills
the application form — with the **LLM driving the browser itself** through a
tool-calling loop. Every sensitive step (login, captcha, upload, save, submit)
waits for a human, and **nothing is ever submitted for real**. The whole run is
recorded as a replayable trace of reasoning, actions, screenshots, URLs, and
risk tiers.

> 给一个网站 + 一份简历，Agent 用 cookie 登录后，由 LLM 通过工具调用亲自驱动
> 浏览器把申请表填好——全程可视化、可确认、可复盘，且永不真实提交。

## What works

- ✅ **Generic fill** — any site + resume → cookie login → LLM-driven agent loop
  fills the form. No hardcoded field mapping; the model picks the right inputs.
- ✅ **Cookie login** — `login <url>` once, save cookies; `fill` reuses them.
- ✅ **Visual** — headful Chromium with mouse-move + click/fill highlighting so
  you can watch every action.
- ✅ **PDF resume** → structured `ResumeProfile` (`.json`/`.txt` too).
- ✅ **Alibaba match** — scrape the position list + details, match to resume.
- ✅ **Human-in-the-loop** at login / captcha / upload / save / submit.
- ✅ **Trace** — every step, screenshot, URL, risk tier, under `output/<runId>/`.
- ✅ `npm run build`, `npm run test:smoke`, `npm run test:alibaba-probe` pass.
- ✅ **Never** submits a real application.

## Project structure

```text
multi-functional-agent/
├── configs/                       # config + resume examples
├── packages/
│   └── playwright-mcp/            # ★ the agent (engine + MCP server + CLI)
│       ├── src/core/              # agent-loop · tool-registry · page-view · login
│       ├── src/sdk/               # orchestrator · llm · config · trace · human · resume · matcher · alibaba
│       ├── src/cli/demo.ts        # fill / login / match / demo-form
│       └── src/{browser,snapshot,session,policy,tools}  # MCP server core
└── output/                        # run traces + screenshots + saved cookies (gitignored)
```

## Quick start

```bash
cd packages/playwright-mcp
npm install && npm run build

# 1) Offline demo (no key needed) — mock form, visible fill:
npm run demo

# 2) The headline — any site + resume:
npm run login -- https://your-recruiting-site.com/        # log in once, save cookies
MODEL_API_KEY=sk-... npm run fill -- https://your-recruiting-site.com/apply

# 3) Alibaba scrape + match (read-only):
npm run demo:match
```

### Configure your model

`fill` needs an OpenAI-compatible model with **function/tool-calling** support.

```bash
cp configs/agent.env.example .env
# edit .env → set MODEL_API_KEY (and MODEL_BASE_URL / MODEL_NAME if non-OpenAI)
```

## Commands

| Command | What | Key? |
|---------|------|------|
| `fill <url>` | Generic: cookie-login + LLM-driven form fill. Never submits. | ✅ |
| `login <url>` | Interactive login, save cookies for reuse. | ❌ |
| `match` | Alibaba scrape + match, hand off at gate (read-only). | opt |
| `demo-form` | Offline mock form, visible fill. Always works. | opt |

## How the generic fill works

There is **no hardcoded field mapping**. The page is rendered to a compact,
LLM-readable view listing every interactive element with a stable ref
(`[e1] input "姓名 Name" risk=L2`). That view + the resume go to the model with
the browser tools available as **function calls**. The model picks the next
action (`browser_type ref=e1 …`, `browser_click ref=e4`, …), the loop runs it,
feeds the updated view back, and repeats until `agent_done`. Risky actions are
intercepted by the human gate. (hermes/openclaw-style LLM-drives-the-browser
loop, in TypeScript.)

## Safety model

| Tier | Meaning | Gate |
|------|---------|------|
| L0–L1 | Info / safe navigation | none |
| L2 | Form inputs | auto-filled |
| L3 | Submit-like buttons (提交/投递/申请) | `confirmed=true` + human gate |
| L4 | `password` / `file` inputs | always gated |

The five hard checkpoints — **login, captcha, upload, save, submit** — always
stop for a human. Final-submit *refuses* to auto-submit even when approved.

## Documentation

- [Agent + MCP README](./packages/playwright-mcp/README.md) — architecture, CLI, env, scripts
- [Config examples](./configs/) (`agent.env.example`, `resume.example.json`)
- [Web-agent RFC](./docs/architecture/web-agent-bmad-rfc.md) · [Week-1 plan](./docs/architecture/web-agent-week1-plan.md)

## Roadmap

| Phase | Status | Goal |
|-------|--------|------|
| Phase 1 | ✅ | Playwright MCP tools, risk gating, navigation guard |
| MVP | ✅ | PDF resume, Alibaba scrape+match, gated draft fill, trace, demo CLI |
| **Generic + cookie** | ✅ | **LLM-driven agent loop (any site), cookie login, architecture refactor** |
| Next | 🚧 | resume-upload automation (gated), trace replay UI, multi-step wizards, more job boards |

## License

MIT
