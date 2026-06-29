# Web Buddy Local Web Agent Runtime

`@multi-functional-agent/web-buddy` is the main package for the local,
auditable Web Agent runtime. It owns the Playwright browser tools, local agent
loop, MCP server, CLI, Web UI, observation model, context assembly, policy
boundary, session store, trace, metrics, benchmarks, and safety report helpers.

Job application is the flagship workflow, but the runtime is broader than
recruiting automation. The default demos use local fixtures so a new user can
verify browser control, observation artifacts, metrics, and safety reports
without a real account, captcha, or live website.

## Safety Contract

The runtime does not automatically log in, solve captchas, upload files, save
drafts, or final-submit real forms. Sensitive steps route through human gates.
`PolicyEngine` decides allow/gate/block/auto-confirm before tools execute;
`HumanGate` confirms or hands off sensitive steps. Trace, metrics, and
`safety-report.json` are diagnostic artifacts, not runtime state sources.

Full model: [../../docs/safety-model.md](../../docs/safety-model.md).

## Quickstart

```bash
npm install
npm run build

# Local mock form fill. No key, login, or network.
npm run demo:form

# Local read-only web research. No key, login, or network.
npm run demo:research

# Generate safety-report.json for the latest trace.
npm run report:safety

# Maintainer regression entry.
npm run test:mvp
```

## Demo Positioning

| Entry | What it proves | Safety profile |
| --- | --- | --- |
| `npm run demo:form` | Local form observation, resume-based filling, submit-adjacent gate behavior. | Offline fixture; never contacts a real site. |
| `npm run demo:research` | Read-only page observation, structured summary artifact, trace, metrics, safety report. | Offline fixture; no login, no form submit, no L3/L4 action. |
| `npm run demo:match` | Read-only Alibaba list/detail matching for the flagship workflow. | Does not enter final application submission. |
| `npm run alibaba:apply` | Complex flagship workflow through the optional Claude Code adapter. | Requires model and human handoff for login/captcha/final submit. |

## Run Observability

Each local Web Agent run writes an append-only session plus a unified trace
identity. Session files are the runtime recovery source; trace files remain
diagnostic review artifacts. `npm run report:safety` adds `safety-report.json`
for the selected run:

```text
output/sessions/<sessionId>/session.json
output/sessions/<sessionId>/transcript.jsonl
output/sessions/<sessionId>/events.jsonl
output/sessions/<sessionId>/workflow.json
output/<runId>/trace.jsonl
output/<runId>/summary.json
output/traces/<sessionId>/run-manifest.json
output/traces/<sessionId>/metrics.json
output/traces/<sessionId>/agent-state.json
output/traces/<sessionId>/safety-report.json
output/traces/<sessionId>/artifacts/page-state-latest.json
output/traces/<sessionId>/artifacts/form-state-latest.json
```

Useful commands:

```bash
npm run report:safety
npm run report:safety -- --run-id <runId>
npm run report:safety -- --trace-dir ../../output/traces/<sessionId>
npm run benchmark:research
npm run test:tool-execution
npm run test:kernel
npm run test:session
```

The research benchmark validates `metrics.json`, `page-state-latest.json`,
`research-summary.json`, and `safety-report.json`.

## Phase 2 Kernel Notes

Phase 2 is splitting the local runtime in small compatibility-preserving steps.
Plan 2 wrapped the runtime entry in Kernel control:

```text
AgentRuntime.run()
  -> AgentKernel.start()
    -> QueryLoop.run()
      -> runAgentLoop()
```

Plan 3 moves single-tool execution out of `runAgentLoop` without making
`QueryLoop` own tool scheduling yet:

```text
QueryLoop
  -> runAgentLoop
    -> ToolExecutionService
```

`ToolExecutionService v1` is an execution layer for one already-approved tool
call. It owns tool use context, execution state, timeout, abort-before-execution,
and error normalization. It preserves normal successful observations and
existing `FAILED (...)` observations so the model-visible behavior stays
compatible.

Boundaries:

- `PolicyEngine` decides risk and allow / gate / block / auto-confirm before
  tools execute.
- `HumanGate` keeps user confirmation and handoff behavior.
- The future `PermissionEngine` will own general permission rules and approval
  queues; it is not part of ToolExecutionService v1.
- Workflow state and future evidence checks remain outside the execution
  service.

Phase 2C v1 does not claim full pause/resume, automatic retry, concurrent tool
execution, streaming tool output, or forced cancellation of an already-running
Playwright action.

Plan 3 adds the dedicated service-level verification command
`npm run test:tool-execution-service`; keep `npm run test:tool-execution`,
`npm run test:agent-loop`, `npm run test:kernel`, `npm run test:session`, and
`npm run test:mvp` as compatibility checks around it.

Plan 4 / Phase 2D is the permission boundary step after ToolExecutionService:

```text
runAgentLoop
  -> PolicyEngine
  -> PermissionEngine
  -> ApprovalQueue if ask
  -> HumanGate if ask
  -> ToolExecutionService
```

The split is intentionally narrow:

- `PolicyEngine` remains the risk and policy recommendation layer
  (`allow` / `gate` / `block` / `auto_confirm`).
- `PermissionEngine` maps the policy recommendation and runtime context to
  `allow` / `ask` / `deny`.
- `ApprovalQueue v1` records in-memory pending/resolved approvals for the
  current process; it does not decide risk, persist permissions, or replace UI.
- `HumanGate` still performs the actual user prompt or handoff.

Phase 2D v1 does not claim a complete Task Cockpit approval UI, persistent
permission store, cross-process approval recovery, or "always allow" rules.
When implemented, it should add `npm run test:permission` and either
`npm run test:approval-queue` or include approval queue coverage inside
`test:permission`.

## CLI

After `npm run build`:

```bash
node dist/cli/demo.js <command> [options]
```

| Command | What it does | Needs key? |
| --- | --- | --- |
| `demo-form` | Local mock form; agent loop or heuristic fallback fills a draft and stops before submit. | No |
| `demo-research` | Local read-only product/docs page; captures observation and structured research summary. | No |
| `raw <url>` | LLM drives the browser directly from your prompt and resume. | Yes |
| `fill <url>` | Cookie-login target site, then LLM-driven form filling from resume. Never final-submits. | Yes |
| `login <url>` | Open a visible browser for manual login and save Playwright storage state. | No |
| `match [--list-url]` | Alibaba list/detail scraping and resume matching, read-only. | Optional |
| `auto-apply <url>` | Structured local/sandbox job board benchmark flow. | No for local fixtures |
| `alibaba-apply [url]` | Local raw Alibaba run used by `npm run alibaba:apply:raw`. | Yes |

Options include `--resume`, `--headful`, `--headless`, `--auto-gate`,
`--model-key`, `--base-url`, `--model-name`, `--storage-state`, `--prompt`,
`--keep-browser-open`, `--profile`, and `--max-jobs`.

## Web UI

```bash
npm run web
```

Open `http://localhost:5178` to configure a model, upload a resume, run demos or
fill workflows, and inspect live events, screenshots, trace steps, and metrics.

## Architecture

```text
src/
  runtime/local/           self-owned local Web Agent loop and ToolRegistry
  tools/                   shared Tool Catalog plus local/MCP adapters
  browser/                 Playwright browser tool handlers
  snapshot/                ref-based page snapshots and risk labels
  observation/             PageState, FormState, ObservationManager
  context/                 ContextManager, prompt sections, budget metrics
  agent/                   AgentRuntime facade, PromptAssembler, stop conditions
  session/                 FileSessionStore, transcript, KernelEvent recorder
  kernel/                  AgentKernel, QueryLoop, RunController, turn snapshots
  policy/                  PolicyEngine, audit event, safety report helper
  workflow/                WorkflowState and transition helpers
  sdk/                     orchestrator, config, llm, trace, human gate, resume
  web/                     HTTP/SSE server and dashboard
  cli/                     demo CLI
```

The local runtime and MCP server share tool definitions through
`src/tools/catalog.ts`. Execution paths stay separate: local runtime tools still
call existing browser handlers, and MCP clients call the MCP adapter.

Observation is runtime memory first and artifact second. `browser_snapshot` and
`browser_form_snapshot` refresh PageState/FormState for context and write
latest artifacts best-effort for trace, benchmarks, and review.

## Generic Fill

The runtime does not hardcode site-specific field mappings. It snapshots the
current page into a compact view such as:

```text
[e1] input "Name" risk=L2
[e4] button "Submit application" risk=L3
```

The model receives the page view, selected context, resume profile, and browser
tools. It chooses tool calls, the runtime applies policy before execution, and
the loop repeats until the draft is filled, blocked, or handed off.

## MCP Server

The same browser capabilities are exposed over MCP stdio from `dist/server.js`:
`browser_open`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_select`, `browser_wait`, `browser_screenshot`,
`browser_form_snapshot`, `browser_click_text`, `browser_fill_by_label`,
`browser_select_by_text`, and `browser_upload_file`.

See [../../configs/mcp.playwright.example.json](../../configs/mcp.playwright.example.json).

## Scripts

```bash
npm run build                 # compile src to dist
npm run web                   # Web UI dashboard
npm run demo:form             # local form demo
npm run demo:research         # local read-only research demo
npm run demo:match            # Alibaba read-only match preset
npm run benchmark:simple      # local simple form benchmark
npm run benchmark:complex     # local complex form benchmark
npm run benchmark:research    # local read-only research benchmark
npm run report:safety         # generate safety-report.json
npm run test:mvp              # full MVP regression entry
npm run alibaba:apply         # optional Claude Code adapter path
npm run alibaba:apply:raw     # local raw runtime comparison path
```

## Model Configuration

`fill`, `raw`, and Alibaba apply paths need a model that supports tool calling.
Copy the example env file from the repository root:

```bash
cp ../../configs/agent.env.example ../../.env
```

Supported wire formats:

- Anthropic-compatible via `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and
  `ANTHROPIC_MODEL`.
- OpenAI-compatible via `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME`.

Do not commit `.env`, cookies, storage state, resume content, or verification
codes.
