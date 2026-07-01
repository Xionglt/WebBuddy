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
- Resume ingestion: `.pdf`, `.json`, and `.txt` inputs can be parsed into a
  compatible resume profile; the v2 SDK path adds confidence, evidence, schema
  validation, deterministic email/phone repair, and optional LLM parsing when a
  model key is present.
- Job matching: Alibaba/list-style workflows can crawl multiple pages, coarse
  rank many jobs, open only the Top N detail pages, and stop before apply when
  the best score is below the configured threshold.
- Context and prompt assembly: selected state enters the model context without
  reading trace artifacts as runtime state.
- Policy boundary: `PolicyEngine.evaluate()` decides allow, gate, block, or raw
  compatibility auto-confirm before tools execute.
- Permission modes: `safe`, `review`, `trusted`, and `autopilot` tune which
  non-final risky actions can be auto-allowed while preserving sensitive gates.
- Human gates: login, captcha, upload, save, and final submit are routed to a
  person.
- Session store: every SDK/CLI run writes a resumable session under
  `output/sessions/<sessionId>/`.
- Observability: every run writes trace, screenshots, metrics, agent state, and
  optional `safety-report.json`.

## Safety Defaults

The runtime does not automatically log in, solve captchas, bypass human
verification, upload files, or final-submit real forms. Sensitive steps are
human handoff points. `PERMISSION_MODE=review|trusted|autopilot` may reduce
prompts for non-final L3 actions, but login, captcha, upload, save-resume, and
`final_submit` remain sensitive gates by default. Trace, metrics, and safety
reports are diagnostic outputs; runtime, context, policy, and workflow code do
not read them back as state.

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

Runs write session, trace, and metrics artifacts under `output/`;
`npm run report:safety` adds `safety-report.json` for the selected run.
Mode-specific artifacts appear when that workflow produces them:

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
output/traces/<sessionId>/artifacts/risk-decisions.json
output/traces/<sessionId>/artifacts/job-candidates-coarse.json
output/traces/<sessionId>/artifacts/job-candidates-final.json
output/traces/<sessionId>/artifacts/direct-submit-review.json
```

## Demo Map

| Demo | Purpose | Requires key? | Requires account? |
| --- | --- | --- | --- |
| `npm run demo:form` | Local mock application form. Shows form observation, safe fill, and submit gate behavior. | No | No |
| `npm run demo:research` | Local read-only product/docs page. Shows observation, structured summary, trace, metrics, and safety report. | No | No |
| `npm run demo:match` | Read-only Alibaba multi-page job scraping/matching preset. Shows coarse/final ranking and threshold behavior. | Optional | No |
| `npm run alibaba:apply` | Flagship complex workflow through the optional Claude Code adapter. | Yes | Usually |

## Resume Ingestion v2

For CLI and Web UI runs, pass a local resume path with `--resume` or upload it
in the Web UI. Current user-facing inputs are `.pdf`, `.json`, and `.txt`.
Text PDFs are extracted with `pdfjs-dist`; JSON can be either the legacy
profile or `resume-profile/v2`; TXT is parsed from plain text. Scanned or
image-heavy PDFs are best-effort and are reported with warnings rather than
treated as perfectly parsed.

```bash
cd packages/web-buddy
npm run fill -- https://your-recruiting-site.example/apply --resume /path/to/resume.pdf
npm run test:resume-ingest
```

The v2 SDK parser returns field-level `confidence` and short sanitized
`evidence`, then converts back to the compatible profile consumed by matching
and filling code. Do not store raw resume text, screenshots, cookies, or model
keys in git.

## Multi-Page Job Matching

`match`, `auto-apply`, and the guarded Alibaba matching pipeline use a two-stage
flow: fast list crawl, deterministic coarse score, detail enrichment for Top N,
optional LLM rerank when a model key is configured, and a threshold decision
before entering any application flow.

```bash
cd packages/web-buddy
npm run demo:match -- \
  --resume /path/to/resume.pdf \
  --max-pages 5 \
  --max-crawl-jobs 100 \
  --max-jobs 10 \
  --match-threshold 0.45
```

Runs write `job-candidates-coarse.json` and `job-candidates-final.json` under
the trace artifacts directory, with legacy copies under `output/<runId>/` for
older review scripts.

## Permission Modes

Set permission mode either on the command line or through `.env`:

```bash
npm run fill -- https://your-recruiting-site.example/apply --permission-mode review
PERMISSION_MODE=trusted npm run demo:match -- --resume /path/to/resume.pdf
```

Modes:

- `safe`: default. Ask at high-risk workflow boundaries.
- `review`: auto-allow selected non-final L3 actions; keep sensitive gates.
- `trusted`: auto-allow more non-final application-flow actions on a trusted
  local machine; keep sensitive gates.
- `autopilot`: most permissive non-final mode, but final submit is still gated
  unless an explicit SDK-level final-submit override is provided.

`HUMAN_GATE_MODE=auto` is a non-interactive handoff/testing mode. It is not a
real final-submit authorization.

## Final Submit Boundary

`final_submit` is a hard safety boundary for real external sites. If a site
uses an online-resume or direct-submit page with only an agreement checkbox and
an apply button, the runtime records `direct-submit-review.json`, explains that
there are no fillable fields, and stops before the final submission step.
Local sandbox benchmarks may submit only to localhost-style fixtures.

## Optional Web UI

```bash
cd packages/web-buddy
npm run web
```

Open `http://localhost:5178` to configure a model, upload a resume, run local
demos or fill workflows, and watch events, screenshots, and traces.

## Docker / Compose

Use Docker when you want Node, Playwright Chromium, system browser libraries,
the Web UI runtime, and the optional Claude runtime adapter packaged together.

```bash
# Build the local image.
docker compose build

# Start the Web UI.
docker compose up agent
```

Open `http://localhost:5178`. The container writes traces and sessions back to
the host `output/` directory, and uses host `tmp/` for uploaded/generated
resumes.

Run local checks from the same image:

```bash
docker compose run --rm agent npm --prefix packages/web-buddy run test:e2e-auto-apply
docker compose run --rm agent npm --prefix packages/web-buddy run demo:research
docker compose run --rm agent node packages/web-buddy/dist/cli/demo.js demo-form --headless --auto-gate
docker compose run --rm agent npm --prefix packages/web-buddy run report:safety
```

For model-backed runs, keep credentials in the ignored root `.env`; Compose
forwards the supported variables listed in `docker-compose.yml`. Docker runs
headless by default. If you need to watch a visible browser, run the command on
the host instead of inside the container.

## Qwen / Bailian Model Test

Alibaba Cloud Model Studio / Bailian can be used through its OpenAI-compatible
API. Put one of these blocks in the ignored root `.env`:

```env
# DashScope public compatible endpoint.
MODEL_PROVIDER=openai
DASHSCOPE_API_KEY=your_api_key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen-plus
MODEL_ENABLE_THINKING=false
```

```env
# Bailian workspace endpoint. Replace <workspace-id> with the workspace value
# shown in the Model Studio console.
MODEL_PROVIDER=openai
DASHSCOPE_API_KEY=your_api_key
DASHSCOPE_BASE_URL=https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen-plus
MODEL_ENABLE_THINKING=false
```

Then verify plain chat and function/tool calling before running a full agent:

```bash
cd packages/web-buddy
npm run test:model
```

## Optional Job Application Workflow

For a real recruiting site, log in manually once and then run the generic fill
mode:

```bash
cd packages/web-buddy
npm run login -- https://your-recruiting-site.example/
MODEL_API_KEY=your_api_key npm run fill -- https://your-recruiting-site.example/apply
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
