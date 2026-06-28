# Multi-Functional Agent

**Multi-Functional Agent is a local, auditable Web Agent runtime.** It gives an
agent browser tools, page observation, context selection, policy gates, trace,
metrics, and safety reports so a new user can run a safe demo and inspect what
happened.

Job application is the flagship workflow, not the whole product. The same
runtime also supports read-only web research, local form filling, MCP browser
tools, and benchmarkable safety/observability experiments.

## What It Is

- `packages/web-buddy`: the main project line. It contains the self-owned local
  Web Agent runtime, Playwright browser tools, MCP server, CLI, SDK helpers,
  Web UI, trace, metrics, policy, and safety report helpers.
- `packages/claude-code`: an optional recovered Claude Code runtime adapter used
  for comparison and advanced Alibaba workflow experiments.

Core capabilities:

- Browser action tools: open, snapshot, click, type, select, wait, screenshot,
  form snapshot, upload, fill-by-label, click-by-text.
- Observation model: PageState and FormState artifacts for page understanding.
- Context and prompt assembly: selected state enters the model context without
  reading trace artifacts as runtime state.
- Policy boundary: `PolicyEngine.evaluate()` decides allow, gate, block, or raw
  compatibility auto-confirm before tools execute.
- Human gates: login, captcha, upload, save, and final submit are routed to a
  person.
- Session store: every SDK/CLI run writes a resumable session under
  `output/sessions/<sessionId>/`.
- Observability: every run writes trace, screenshots, metrics, agent state, and
  optional `safety-report.json`.

## Safety Defaults

The runtime does not automatically log in, solve captchas, upload files, or
final-submit real forms. Sensitive steps are human handoff points. Trace,
metrics, and safety reports are diagnostic outputs; runtime, context, policy,
and workflow code do not read them back as state.

Read the full model: [docs/safety-model.md](./docs/safety-model.md).

## Quickstart

```bash
cd packages/web-buddy
npm install
npm run build

# 1. Local form-fill demo. No real website, account, or model key required.
npm run demo:form

# 2. Local read-only web research demo. No network or login required.
npm run demo:research

# 3. Inspect metrics and safety report for the latest run.
npm run report:safety

# 4. Maintainer MVP regression suite.
npm run test:mvp
```

The two demos write session, trace, and metrics artifacts under `output/`;
`npm run report:safety` adds `safety-report.json` for the selected run:

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

## Demo Map

| Demo | Purpose | Requires key? | Requires account? |
| --- | --- | --- | --- |
| `npm run demo:form` | Local mock application form. Shows form observation, safe fill, and submit gate behavior. | No | No |
| `npm run demo:research` | Local read-only product/docs page. Shows observation, structured summary, trace, metrics, and safety report. | No | No |
| `npm run demo:match` | Read-only Alibaba job scraping/matching preset. Shows the flagship workflow's matching side. | Optional | No |
| `npm run alibaba:apply` | Flagship complex workflow through the optional Claude Code adapter. | Yes | Usually |

## Optional Web UI

```bash
cd packages/web-buddy
npm run web
```

Open `http://localhost:5178` to configure a model, upload a resume, run local
demos or fill workflows, and watch events, screenshots, and traces.

## Optional Job Application Workflow

For a real recruiting site, log in manually once and then run the generic fill
mode:

```bash
cd packages/web-buddy
npm run login -- https://your-recruiting-site.example/
MODEL_API_KEY=sk-... npm run fill -- https://your-recruiting-site.example/apply
```

`fill` needs a tool-calling model. It reads the page, maps resume fields to
visible form controls, fills a draft, and stops before sensitive actions.

Model configuration examples live in [configs/agent.env.example](./configs/agent.env.example).

## Verification

Maintainers should use:

```bash
cd packages/web-buddy
npm run test:kernel
npm run test:mvp
```

This builds the package, runs context/prompt/metrics/policy/workflow/runtime and
kernel/session tests, executes simple/complex/research benchmarks, and verifies
observation and safety-report outputs. `test:kernel` specifically covers the
AgentKernel skeleton, AgentRuntime delegation, kernel lifecycle events, session
compatibility, and abort-before-tool behavior.

## Documentation

- [Safety model](./docs/safety-model.md)
- [Session model](./docs/session-model.md)
- [Full experience guide](./docs/full-experience-guide.md)
- [Web Buddy package README](./packages/web-buddy/README.md)
- [Agent iteration log](./docs/agent-iteration-log.md)
- [Phase 2 Agent Kernel master plan](./PLAN/phase2/README.md)
- [Phase 1 archived plans](./PLAN/phase1/plan-all.md)

## License

MIT
