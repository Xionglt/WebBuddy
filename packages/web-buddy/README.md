# Web Buddy Local Web Agent Runtime

`@multi-functional-agent/web-buddy` is a local, auditable, safety-first Web
Agent Runtime for multi-step browser work. It owns the Playwright tools, local
agent loop, task orchestration, MCP server, CLI, Web UI, context assembly,
policy boundary, session store, trace, metrics, benchmarks, and safety reports.

The core runtime is scenario-neutral. Research, comparison, form workflows,
booking preparation, and recruiting assistance all run through the same
Agent Harness; task prompts, Skills, Policies, and Workflows provide the
scenario-specific behavior.

## Public SDK

Use Node.js `>=20` and import only the package root. Deep imports such as
`@multi-functional-agent/web-buddy/dist/*` and `src/*` are private and rejected
by package exports.

```bash
npm install @multi-functional-agent/web-buddy
```

```js
import {
  createResearchStarter,
  runWebTask,
} from '@multi-functional-agent/web-buddy'

const input = createResearchStarter({
  schemaVersion: 'research-starter/v1',
  goal: 'Summarize the page with current source evidence.',
  startUrl: 'https://example.com/',
})

const result = await runWebTask(input)
```

The stable root also exports `createComparisonStarter()`,
`createFormDraftStarter()`, `createSkillScaffold()`, `createRunClient()`, and
`createApprovalClient()`. Public top-level request, response, and durable
resource envelopes are versioned; unknown major versions fail closed. See
`examples/research`, `examples/comparison`, and `examples/form-draft`; every
example imports only the package root.

Schema migration is fail-closed. Public DTOs use explicit `*/v1` or `*/v2`
versions. Only known legacy session/transcript records with no version receive
the narrow v1 reader; an explicit unknown version is rejected. Migration must
write a new record and preserve the old one—it must not ignore or reinterpret
Run revision/attempt, Approval action bindings, Artifact ownership,
origin/trust/sensitivity, or authority in place.

The technical package/consumer boundary is verified, but this repository does
not yet contain an explicit open-source license. Public registry publication is
therefore blocked until the owner chooses and commits a license. Recruiting
remains a Scenario Adapter example. The `job-agent` and `job-agent-web` bins are
compatibility wrappers that emit a deprecation warning; new integrations should
call `runWebTask()` or use the generic `web-agent` entry.

## Authenticated Service Boundary

The Web API authenticates before business parsing and derives tenant/user scope
from `WEB_BUDDY_API_TOKEN` or `WEB_BUDDY_API_TOKENS_JSON`. Run, Approval,
Trace, Artifact, and Memory resources are exact-scope isolated. Stable
mutations require both `expectedRevision` and `idempotencyKey`.

Model credentials are injected only by the server Secret Provider. The Web UI
does not accept model keys, resume paths, or inline secret Context, and tenants
cannot redirect the global model endpoint. Local/private-network targets are
denied by default; local fixtures require the explicit test-only
`WEB_BUDDY_ALLOW_PRIVATE_NETWORK_FOR_TESTING=true` override.

## Scenario Coverage

| Scenario | Runtime behavior | Safety boundary |
| --- | --- | --- |
| Web research | Navigate, extract evidence, summarize across pages. | Read-only by default. |
| Comparison and decision support | Validate constraints, compare candidates, preserve rejection reasons. | No purchase or final confirmation. |
| General form workflows | Inspect fields, plan values, ask for missing data, fill and verify. | Upload, save, and submit remain policy-gated. |
| Multi-page operations | Carry task state across search, detail, edit, and review pages. | Login, captcha, and identity checks hand off to a human. |
| Booking preparation | Select an eligible option, fill a draft, verify price and terms. | Stop before order creation or payment. |
| Recruiting assistance | Research roles, rank candidates, prepare application drafts. | Recruiting is an extension; final application submission remains gated. |
| Custom site tasks | Use Raw Runtime, MCP, and Skills to add new browser scenarios. | Reuses the same Policy, Permission, and Trace layers. |

## Safety Contract

The runtime does not automatically log in, solve captchas, bypass human
verification, upload files, save drafts, or final-submit real forms. Sensitive
steps route through human gates. `PolicyEngine` classifies risk before tools
execute; `PermissionEngine` maps policy to allow/ask/deny according to
`PERMISSION_MODE`; `HumanGate` confirms or hands off sensitive steps.
Trace, metrics, and `safety-report.json` are diagnostic artifacts, not runtime
state sources.

Top-level browser navigation is bound to the exact scheme, host, and port.
HTTP redirects stop at the first 3xx and require an explicit next navigation;
cross-origin click and popup targets are blocked before their network request.

## Quickstart

```bash
npm install
npm run build

# Local structured form workflow. No key, login, or network.
npm run demo:form

# Local read-only web research. No key, login, or network.
npm run demo:research

# Authenticated Web console. Enter the same token in the page.
export WEB_BUDDY_API_TOKEN="$(openssl rand -hex 32)"
npm run web

# Generate safety-report.json for the latest trace.
npm run report:safety

# Maintainer regression entry.
npm run test:mvp
```

## Demo Positioning

| Entry | What it proves | Safety profile |
| --- | --- | --- |
| `npm run demo:form` | Local form observation, structured profile filling, and submit-adjacent gate behavior. | Offline fixture; never contacts a real site. |
| `npm run demo:research` | Read-only page observation, structured summary artifact, trace, metrics, safety report. | Offline fixture; no login, no form submit, no L3/L4 action. |
| Web console → `Venue` | Compare five venues, choose the only fully compliant option, fill a booking draft, and stop before payment. | Local fixture; uses fake contact data and must leave the payment boundary untouched. |
| `npm run demo:match` | Read-only Alibaba multi-page list/detail matching as a domain Skill example. | Threshold-gated; does not final-submit. |
| `npm run alibaba:apply:raw` | Complex recruiting workflow through the same generic Web Buddy runtime. | Requires model and human handoff for login/captcha/final submit. |

## Scenario Extension: Resume and Matching v2

Resume inputs for CLI/SDK recruiting adapters are `.pdf`, `.json`, and `.txt`. The v2 SDK
parser (`readResumeV2` / `ingestResume`) returns `resume-profile/v2` with
field-level confidence, short sanitized evidence, schema validation, optional
LLM parsing, heuristic fallback, and deterministic email/phone repair. The
current orchestrator still consumes the compatible `ResumeProfile` shape, so
CLI recruiting runs use the same `--resume` flag while tests and SDK callers
can inspect v2 output directly. The authenticated Web console never accepts a
resume path or upload; sensitive profile Context must come from a dedicated
server-side provider.

```bash
npm run test:resume
npm run test:resume-ingest
npm run fill -- https://your-recruiting-site.example/apply --resume /path/to/resume.pdf
```

Text PDFs are extracted with `pdfjs-dist`. Scanned or image-heavy PDFs are
best-effort and produce warnings; do not assume PDF parsing is perfect.

Alibaba/list-style matching now separates fast list crawl from detail
enrichment:

```bash
npm run demo:match -- \
  --resume /path/to/resume.pdf \
  --max-pages 5 \
  --max-crawl-jobs 100 \
  --max-jobs 10 \
  --match-threshold 0.45
```

The defaults are 5 pages, up to 100 unique list candidates, Top 10 detail pages,
and a final match threshold of `0.45`. Low matches stop before the apply flow.

## Run Observability

Each local Web Agent run writes an append-only session plus a unified trace
identity. Session files are the runtime recovery source; trace files remain
diagnostic review artifacts. `npm run report:safety` adds `safety-report.json`
for the selected run. Mode-specific artifacts appear when that workflow
produces them:

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
output/traces/<sessionId>/artifacts/research-summary.json
output/traces/<sessionId>/artifacts/risk-decisions.json
output/traces/<sessionId>/artifacts/job-candidates-coarse.json
output/traces/<sessionId>/artifacts/job-candidates-final.json
output/traces/<sessionId>/artifacts/direct-submit-review.json
```

Useful commands:

```bash
npm run report:safety
npm run report:safety -- --run-id <runId>
npm run report:safety -- --trace-dir ../../output/traces/<sessionId>
npm run benchmark:research
npm run test:resume-ingest
npm run test:job-crawl-pagination
npm run test:job-match-threshold
npm run test:permission-modes
npm run test:direct-submit-flow
npm run test:risk-timeline
npm run test:tool-execution
npm run test:kernel
npm run test:session
```

The research benchmark validates `metrics.json`, `page-state-latest.json`,
`research-summary.json`, and `safety-report.json`.

## Runtime Memory And Resume

Web Buddy keeps run recovery and user memory separate:

- `output/sessions/<sessionId>/transcript.jsonl` is the append-only run fact
  source. `restoreSessionState()` rebuilds workflow facts and `restoredMessages`
  from this transcript so resume flows can inspect both state and message
  causality.
- `~/.web-buddy/memory/answers.json` stores user answers collected through
  `ask_user`, such as stable application preferences.
- `~/.web-buddy/memory/permission-rules.json` stores remembered permission rules
  that are matched before default permission rules.

Override memory paths when running tests or isolated profiles:

```bash
WEB_BUDDY_MEMORY_DIR=/tmp/web-buddy-memory npm run fill -- https://example.com/apply
WEB_BUDDY_ANSWER_STORE_PATH=/tmp/answers.json npm run demo:form
WEB_BUDDY_PERMISSION_RULES_PATH=/tmp/permission-rules.json npm run demo:form
```

The default token budget guard is also enabled without explicit configuration.
Token budget events in `events.jsonl` show the current estimate, threshold, and
whether the default max input window is being used.

## Artifacts

Primary run review artifacts live under `output/traces/<sessionId>/artifacts/`.
Some Plan 2 artifacts are also copied to `output/<runId>/` for legacy scripts.

- `page-state-latest.json` and `form-state-latest.json`: latest observed page
  and form state for review.
- `research-summary.json`: structured output from the read-only research demo.
- `job-candidates-coarse.json`: all crawled list candidates after fast scoring.
- `job-candidates-final.json`: detail-enriched and optionally LLM-reranked
  shortlist plus the threshold decision.
- `risk-decisions.json`: compact policy/permission outcomes with counts for
  allowed, auto-allowed, gated, and denied actions.
- `direct-submit-review.json`: explanation and signals when a recruiting site
  has no fillable form and the next step would be final submit.
- `safety-report.json`: generated report summarizing final-submit, login,
  captcha, and high-risk outcomes.

Artifacts are for debugging and audit. They may include screenshots, URLs, and
resume-derived summaries, so keep `output/` out of commits.

## Current Runtime And Control Boundaries

`runWebTask()` is the generic entry and owns Completion Contract evaluation.
Recruiting calls it through a deprecated Scenario Adapter; there is no second
Agent Loop.

```text
runWebTask
  -> AgentKernel / runAgentLoop
    -> TaskPolicy + PermissionEngine
      -> durable Human Gate when required
        -> ToolExecutionService
```

The Web service stores Run and Approval state through `RunService` and durable
Stores. Pause is a request acknowledged only at a safe turn boundary; it is not
a process sleep. Restart classifies eligible read-only sessions as recoverable,
invalidates old approvals, and never replays the last write action. Generic
service runs currently advertise `restartSafe=false`, so their resume endpoint
fails closed until a compatible durable adapter exists.

Artifacts and Trace references remain bound to run ID, revision, attempt, and
owner scope. Approval resolution is additionally bound to the exact action,
arguments digest, source/destination origin, and expiry. A late result after
cancel cannot attach artifacts or change the terminal state.

Multi-Agent helpers may inspect or produce bound Artifacts, but only the parent
runtime owns browser write authority. Memory lifecycle records use v2
provenance, sensitivity, TTL, conflict handling, and explicit user deletion;
untrusted Context cannot silently upgrade trust during a memory write.

Use `npm run test:m6-release` for the focused security, recovery, Eval,
Multi-Agent, Memory, SDK consumer, tenant, and chaos matrix. The complete
compatibility suite remains `npm run test:release-gate` plus `npm run test:mvp`.

## CLI

After `npm run build`:

```bash
node dist/cli/demo.js <command> [options]
```

| Command | What it does | Needs key? |
| --- | --- | --- |
| `demo-form` | Local mock form; agent loop or heuristic fallback fills a draft and stops before submit. | No |
| `demo-research` | Local read-only product/docs page; captures observation and structured research summary. | No |
| `raw <url>` | LLM plans and executes a general browser task from your prompt and optional profile. | Yes |
| `fill <url>` | General form understanding and verified draft filling. Never final-submits. | Yes |
| `login <url>` | Open a visible browser for manual login and save Playwright storage state. | No |
| `match [--list-url]` | List/detail extraction and ranking; the bundled example uses the Alibaba Skill. | Optional |
| `auto-apply <url>` | Structured local/sandbox multi-page form benchmark. | No for local fixtures |
| `alibaba-apply [url]` | Recruiting extension example used by `npm run alibaba:apply:raw`. | Yes |

Options include `--resume`, `--headful`, `--headless`, `--auto-gate`,
`--model-key`, `--base-url`, `--model-name`, `--storage-state`, `--prompt`,
`--keep-browser-open`, `--profile`, `--permission-mode`, `--max-jobs`,
`--max-pages`, `--max-crawl-jobs`, and `--match-threshold`.

Permission modes can also be set with `PERMISSION_MODE=safe|review|trusted|autopilot`.
They affect PermissionEngine decisions for local runtime tool calls. Login,
captcha, file upload, profile saving, payment, publishing, and `final_submit`
remain sensitive gates by default; `HUMAN_GATE_MODE=auto` is a non-interactive
handoff mode, not final-submit authorization.

## Web UI

```bash
export WEB_BUDDY_API_TOKEN="$(openssl rand -hex 32)"
npm run web
```

Open `http://localhost:5178`, enter the same service token, and connect. The
console displays generic runs created through the Public SDK/API and exposes the
durable task list, Approval inbox, pause/resume/cancel controls, Trace, and
Artifact links. Its built-in Raw/Match launch presets currently use the
deprecated recruiting compatibility adapter; they do not create a second Agent
Loop. Model endpoint and credential status are server-managed and read-only.
The console does not accept model keys, resume paths, or profile uploads.

From the repository root, the same UI and headless local checks can run inside
Docker:

```bash
export WEB_BUDDY_API_TOKEN="$(openssl rand -hex 32)"
docker compose build
docker compose up agent
docker compose run --rm agent npm --prefix packages/web-buddy run test:e2e-auto-apply
docker compose run --rm agent node packages/web-buddy/dist/cli/demo.js demo-form --headless --auto-gate
```

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
`src/tools/catalog.ts`, but not authority. The local runtime is the single
browser writer. The default MCP adapter exposes only observation tools and
rejects navigation or mutation before calling a handler or network boundary.

Observation is runtime memory first and artifact second. `browser_snapshot` and
`browser_form_snapshot` refresh PageState/FormState for context and write
latest artifacts best-effort for trace, benchmarks, and review.

## General Form Workflows

The runtime does not hardcode site-specific field mappings. It snapshots the
current page into a compact view such as:

```text
[e1] input "Name" risk=L2
[e4] button "Submit application" risk=L3
```

The model receives the page view, selected task context, optional structured
profile, and browser tools. It chooses tool calls, the runtime applies policy
before execution, and the loop repeats until the requested draft is ready,
blocked, or handed off.

## MCP Server

The MCP stdio entry is `dist/server.js`. Its default compatibility surface is
observation-only: `browser_snapshot`, `browser_form_snapshot`,
`browser_form_audit`, `browser_inspect_options`, `browser_wait`, and
`browser_screenshot`. Navigation, click, input, selection, upload, and submit
calls fail closed; use `runWebTask()` for policy-governed browser writes.

See the repository
[MCP configuration example](https://github.com/Xionglt/WebBuddy/blob/main/configs/mcp.playwright.example.json).

## Scripts

```bash
npm run build                 # compile src to dist
export WEB_BUDDY_API_TOKEN="$(openssl rand -hex 32)"
npm run web                   # authenticated control console
npm run demo:form             # local form demo
npm run demo:research         # local read-only research demo
npm run demo:match            # Alibaba read-only match preset
npm run benchmark:simple      # local simple form benchmark
npm run benchmark:complex     # local complex form benchmark
npm run benchmark:research    # local read-only research benchmark
npm run report:safety         # generate safety-report.json
npm run test:model            # model chat + tool-calling smoke test
npm run test:resume           # legacy resume parser regression
npm run test:resume-ingest    # resume-profile/v2 fixtures and fallback
npm run test:matcher          # matcher regression
npm run test:job-crawl-pagination  # multi-page crawl + Top N detail fixture
npm run test:job-match-threshold   # threshold stops low matches before apply
npm run test:permission-modes # safe/review/trusted/autopilot rules
npm run test:direct-submit-flow    # direct-submit review fixtures
npm run test:risk-timeline    # risk-decisions artifact and counters
npm run test:e2e-auto-apply   # localhost sandbox auto-apply
npm run test:mvp              # full MVP regression entry
npm run test:m6-release       # focused M6 security/service/release matrix
npm run test:release-gate     # complete deterministic release gate
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
- Alibaba Cloud Model Studio / Bailian Qwen via `DASHSCOPE_API_KEY`,
  `DASHSCOPE_BASE_URL`, and `DASHSCOPE_MODEL`.

Qwen example:

```env
MODEL_PROVIDER=openai
DASHSCOPE_API_KEY=your_api_key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen-plus
MODEL_ENABLE_THINKING=false
```

For workspace endpoints, use:

```env
MODEL_PROVIDER=openai
DASHSCOPE_BASE_URL=https://<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

Check model connectivity and function calling:

```bash
npm run test:model
```

Do not commit `.env`, cookies, storage state, uploaded personal data, or
verification codes.

## Troubleshooting

### Resume fields look wrong or low-confidence

Run `npm run test:resume-ingest` to verify the local parser path. For real
files, prefer text PDFs, JSON, or TXT. Scanned PDFs may produce sparse text and
warnings; review the generated profile before using it for a real workflow.

### Matching stops at `no_match`

Open `job-candidates-final.json` and check the threshold decision. You can tune
`--match-threshold`, `--max-pages`, `--max-crawl-jobs`, or `--max-jobs`, but do
not lower the threshold just to force an unrelated job into the apply flow.

### Direct-submit review appears

This is expected on sites that use online resumes and show only an agreement
checkbox plus a final apply button. Review `direct-submit-review.json`; the
runtime stopped before `final_submit`.

### Permission mode still asks

That is usually correct. Permission modes auto-allow only eligible non-final
actions. Login, captcha, upload, save-resume, and final submit remain gated by
default.

### Model smoke test fails with provider/account errors

`npm run test:model` depends on the configured provider account. HTTP 400/401,
quota, or billing errors are external availability issues; local no-key
fixtures can still pass.

### Browser stays open in CI or no-TTY runs

If `--keep-browser-open` or `PLAYWRIGHT_KEEP_BROWSER_OPEN=true` is set without
a TTY, the process intentionally remains alive so the final page can be
inspected. Stop the process or unset the flag.

### Live site behavior differs from fixtures

Recruiting site DOM and login flows change. Start headful, keep final-submit
gated, inspect screenshots and trace artifacts, and complete login/captcha only
manually. The runtime does not claim it can bypass those checks.
