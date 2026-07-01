# Phase 3 Plan 2 Contracts Audit

> Role: Baseline Contracts agent
>
> Scope: implementation-prep audit only. This document defines contracts and
> ownership boundaries for later agents. No runtime source code was changed.

## Current State

### ResumeProfile

Source: `packages/web-buddy/src/sdk/resume.ts`

Current canonical resume shape:

```ts
interface ResumeExperience {
  company?: string
  title?: string
  period?: string
  summary?: string
}

interface ResumeEducation {
  school?: string
  degree?: string
  major?: string
  period?: string
}

interface ResumeProfile {
  name?: string
  email?: string
  phone?: string
  location?: string
  summary?: string
  skills: string[]
  experience: ResumeExperience[]
  education: ResumeEducation[]
  keywords: string[]
  source: 'pdf' | 'json' | 'txt'
}
```

Runtime flow:

- `readResume(filePath)` supports `.json`, `.txt`, `.pdf`.
- `.pdf` path uses `extractTextFromPdf()` with `pdfjs-dist`, then `parseResumeText()`.
- `parseResumeText()` is deterministic heuristics: email/phone regex, first plausible short line as name, skill dictionary, date range experience heuristic, education keyword heuristic.
- `orchestrator.ensureResume()` calls `readResume()`, generates a sample PDF when missing, writes only a trace summary of name/skill count.
- `matchJobs()` consumes `skills` and `keywords`.
- `refineMatchesWithLlm()` consumes `skills`, `experience`, and `education` only for reranking prompt context.
- Form fill paths consume the same `ResumeProfile`; therefore v1 must remain valid.

Important gap:

- There is no confidence/evidence model.
- There is no structured LLM resume parser.
- There is no `docx`, image, HTML, or scanned PDF path.
- The existing `source` enum is too narrow for Plan 2.

### JobPosting and MatchScore

Source: `packages/web-buddy/src/sdk/matcher.ts`

Current job and match shapes:

```ts
interface JobPosting {
  id: string
  title: string
  category?: string
  location?: string
  updated?: string
  detailUrl?: string
  applicationUrl?: string
  searchText: string
  tags: string[]
}

interface MatchScore {
  job: JobPosting
  score: number
  reason: string
  matchedSkills: string[]
  missingSkills: string[]
}
```

Runtime flow:

- `matchJobs(profile, jobs)` is pure and deterministic.
- Score is only skill/tag overlap, normalized to `0..1`.
- `refineMatchesWithLlm()` accepts existing `MatchScore[]`, reranks a shortlist, and can append LLM rationale to `reason`. It does not currently change scores.
- There is no threshold contract. `orchestrator.ts` only stops when best score is missing or `<= 0`.

Alibaba-specific extension:

```ts
interface ScrapedJob extends JobPosting {
  detailUrl?: string
  positionId?: string
}
```

Source: `packages/web-buddy/src/sdk/alibaba.ts`

Current Alibaba flow:

- `scrapeJobList()` opens a single list URL and parses visible cards from body text.
- List jobs get ids like `alibaba-1`; `positionId` and `detailUrl` are usually absent at list stage.
- `scrapeJobDetail()` clicks by title, then extracts `positionId` from detail URL and appends detail text into `searchText`.
- `attemptApply()` opens detail, asks a human gate for `high_risk_action`, checks a single checkbox if present, clicks `投递简历`, then reports `reachedLogin` or `reachedForm`.

Important gap:

- No multi-page crawl.
- No coarse/final artifact.
- No stable dedupe contract.
- Detail opening can still drift when title matching or page reuse behaves unexpectedly.
- `attemptApply()` does not distinguish apply-entry from a direct-submit boundary after login.

### Orchestrator

Source: `packages/web-buddy/src/sdk/orchestrator.ts`

Key exposed shapes:

```ts
type AgentMode =
  | 'raw'
  | 'fill'
  | 'match'
  | 'alibaba-apply'
  | 'demo-form'
  | 'demo-research'
  | 'auto-apply'

type FinalState =
  | 'completed'
  | 'resume_parsed'
  | 'no_jobs'
  | 'no_match'
  | 'login_required'
  | 'login_ok'
  | 'filled'
  | 'submitted'
  | 'stopped_at_submit'
  | 'blocked'
  | 'error'
```

Current call relations:

- `runJobApplicationAgent()` loads config, creates `HumanGate`, `LlmGateway`, `TraceRecorder`, and session recorder.
- All non-research modes call `ensureResume()`.
- `match` and `alibaba-apply` call `scrapeJobList()`, local match, top-N detail enrichment, optional LLM rerank.
- `alibaba-apply` calls `attemptApply()` before agent-loop filling.
- Generic LLM filling uses `runAgentLoop()` with `safetyMode: 'guarded'`, except `raw` uses `safetyMode: 'raw'`.
- `auto-apply` is a local/generic structured fixture path and only allows deterministic final submit on local URLs.

Important gap:

- There is no final-score threshold.
- There is no direct submit final state. Direct-submit currently collapses into unclear application state or later `blocked`.
- There is no artifact writing for resume v2 or job candidates, except ad hoc `research-summary.json`.

### Model and Config

Sources: `packages/web-buddy/src/sdk/config.ts`, `packages/web-buddy/src/sdk/llm.ts`

Current config:

- `ModelConfig.provider`: `'openai' | 'anthropic'`
- `HumanLoopConfig.mode`: `'cli' | 'auto'`
- `HumanLoopConfig.autoApproveRisk`: `Array<'L0' | 'L1' | 'L2'>`
- `AgentConfig.maxJobsToDetail`: current Top-N detail setting.
- No `permissionMode`.
- No match thresholds.
- No resume ingest config.

Current LLM gateway:

- `chat()`, `chatWithTools()`, `generateJson<T>()`, `ask()`.
- `generateJson()` uses JSON mode where possible and falls back to extracting first `{...}` block.
- No image/multimodal helper yet.

Important gap:

- Plan 2 can use `generateJson()` for text resume parsing without changing `LlmGateway`.
- Scanned/image PDF support needs either a future multimodal helper or a separate ingestor adapter.

### PolicyDecision

Source: `packages/web-buddy/src/policy/policy-engine.ts`

Current policy shapes:

```ts
type AgentSafetyMode = 'guarded' | 'raw'
type PolicyAction = 'allow' | 'gate' | 'block' | 'auto_confirm'
type PolicyRiskLevel = 'low' | 'medium' | 'high' | 'critical'

interface PolicyDecision {
  action: PolicyAction
  riskLevel: PolicyRiskLevel
  reason: string
  gateKind?: GateKind
  requiresFreshContext?: boolean
}

interface PolicyEngineDecision extends PolicyDecision {
  schemaVersion: 'policy-decision/v1'
  policyCode: string
  ruleId: string
  workflowPhase?: WorkflowPhase
  auditTags: string[]
}
```

Current behavior:

- Risk `L0/L1/L2` maps to policy `allow`.
- Risk `L3/L4` maps to `gate`, unless stale context maps to `block`.
- `safetyMode: 'raw'` plus click-like tools maps to `auto_confirm`.
- Workflow phase refines gate kind:
  - `login_required` -> `login`
  - `captcha_required` -> `captcha`
  - `job_detail` or `entering_application` plus apply text -> `high_risk_action`
  - `reviewing` or `ready_for_final_submit` plus submit text -> `final_submit`

Call relation:

- `runtime/local/agent-loop.ts` calls `decideToolPolicy()` before each tool execution.
- It records `policy_decision` into agent trace events and session transcript.
- Metrics and safety report currently aggregate policy decisions from agent-trace events.

Important gap:

- Policy has no `PermissionMode`.
- Apply-entry is represented as `gateKind: 'high_risk_action'`, not a distinct gate kind.
- `raw` mode can currently auto-confirm a submit-like click; do not treat existing `raw` as Plan 2 `autopilot` without an explicit migration.

### PermissionDecision

Sources: `packages/web-buddy/src/permission/permission-types.ts`, `packages/web-buddy/src/permission/permission-rules.ts`

Current permission shapes:

```ts
type PermissionAction = 'allow' | 'ask' | 'deny'

type PermissionDecisionSource =
  | 'policy'
  | 'default_rule'
  | 'runtime_rule'
  | 'session_rule'
  | 'config_rule'
  | 'user'

type PermissionRememberScope = 'once' | 'session' | 'always'

interface PermissionDecision {
  schemaVersion: 'permission-decision/v1'
  requestId: string
  action: PermissionAction
  source: PermissionDecisionSource
  ruleId: string
  policyCode?: string
  policyRuleId?: string
  risk?: RiskLevel
  riskLevel: PolicyRiskLevel
  reason: string
  decidedAt: string
  gateKind?: GateKind
  requiresFreshContext?: boolean
  rememberable: boolean
  remember: PermissionRememberPolicy
  auditTags: string[]
}
```

Current rule order:

1. `policy.action === 'block'` -> deny.
2. `policy.action === 'auto_confirm'` -> allow.
3. `final_submit` -> ask.
4. upload or `upload_resume` -> ask.
5. login/captcha workflow handoff -> ask.
6. policy gate -> ask.
7. high risk fallback -> ask.
8. policy allow -> allow.
9. default allow.

Call relation:

- `agent-loop` creates `PermissionRequest` from each `PolicyEngineDecision`.
- `PermissionEngine.decide()` returns `PermissionDecision`.
- `ask` enqueues an approval and calls `HumanGate.confirm()`.
- `allow` executes the tool without approval.
- `deny` blocks.
- Permission decisions are recorded as agent trace `permission_decision` events and session transcript entries.

Important gap:

- No permission mode table.
- `HumanLoopConfig.mode: 'auto'` is not the same concept as Plan 2 permission mode.
- `AutoHumanGate` currently approves `high_risk_action`, but that still records as `ask` plus approval, not as permission-mode auto-allow.

### WorkflowState

Source: `packages/web-buddy/src/workflow/workflow-state.ts`

Current workflow shape:

```ts
type WorkflowPhase =
  | 'observing'
  | 'selecting_job'
  | 'job_detail'
  | 'entering_application'
  | 'login_required'
  | 'captcha_required'
  | 'editing_resume'
  | 'filling_application'
  | 'reviewing'
  | 'ready_for_final_submit'
  | 'done'
  | 'blocked'

type WorkflowConfidence = 'low' | 'medium' | 'high'

interface WorkflowState {
  schemaVersion: 'workflow-state/v1'
  phase: WorkflowPhase
  confidence: WorkflowConfidence
  reason: string
  updatedAt: string
  humanHandoffRequired?: boolean
  blocker?: string
  lastTransition?: {
    from: WorkflowPhase
    to: WorkflowPhase
    reason: string
    at: string
  }
}
```

Call relation:

- `createInitialWorkflowState()` starts at `observing`.
- `workflow-transition.ts` infers login, captcha, filling, reviewing, ready-for-final-submit, done, and blocked.
- `workflow-definition.ts` declares phase evidence and handoff requirements.
- `workflow-engine.ts` wraps transition output with blockers and evidence criteria.
- `agent-loop` stores workflow snapshots, evidence, evaluations, and uses workflow state in policy input.
- Initial or refreshed login/captcha states trigger workflow handoff. `ready_for_final_submit` is blocked through policy/completion-gate paths, not the initial login/captcha handoff helper.

Important gap:

- No `direct_submit_review` phase.
- Current form heuristics require fields for `reviewing`; checkbox plus submit with no fields is not modeled.
- Completion gate only has special handling for `ready_for_final_submit` and `blocked`.

## Proposed Contracts

### ResumeProfileV2

Add v2 without replacing v1. Recommended location: new `packages/web-buddy/src/sdk/resume-types.ts`, re-exported from `resume.ts` and `orchestrator.ts`.

```ts
export type ResumeSourceType =
  | 'pdf-text'
  | 'pdf-image'
  | 'docx'
  | 'txt'
  | 'json'
  | 'html'

export interface FieldValue<T> {
  value: T
  confidence: number // 0..1
  evidence?: string
}

export interface ResumeProjectExperience {
  name?: string
  role?: string
  period?: string
  summary?: string
  technologies?: string[]
}

export interface ResumeProfileV2 {
  schemaVersion: 'resume-profile/v2'
  name?: FieldValue<string>
  email?: FieldValue<string>
  phone?: FieldValue<string>
  location?: FieldValue<string>
  summary?: FieldValue<string>
  targetRoles: FieldValue<string[]>
  skills: FieldValue<string[]>
  projects: FieldValue<ResumeProjectExperience[]>
  experience: FieldValue<ResumeExperience[]>
  education: FieldValue<ResumeEducation[]>
  keywords: FieldValue<string[]>
  seniority?: FieldValue<string>
  source: {
    path?: string
    type: ResumeSourceType
    extractionWarnings: string[]
    textLength?: number
    parser: 'heuristic' | 'llm' | 'llm_with_heuristic_repair' | 'json'
  }
}
```

Minimum runtime API:

```ts
export interface ResumeIngestOptions {
  llm?: LlmGateway
  sourcePath?: string
  now?: () => Date
}

export async function readResumeV2(
  filePath: string,
  options?: ResumeIngestOptions,
): Promise<ResumeProfileV2 | null>

export function resumeV2ToLegacyProfile(profile: ResumeProfileV2): ResumeProfile
```

Compatibility rules:

- `readResume()` keeps returning `ResumeProfile`.
- Existing `ResumeProfile.source` remains `'pdf' | 'json' | 'txt'`.
- New orchestrator usage should call `readResumeV2()` only after Agent 01 provides fallback.
- Artifact path: `artifacts/resume-profile-v2.json`.
- Do not write raw resume text into logs or general artifacts. Evidence snippets should be short and non-sensitive.

### JobCandidate Coarse/Final Artifacts

Recommended location: new `packages/web-buddy/src/sdk/job-candidates.ts` or `matcher.ts` if kept small.

```ts
export type JobCandidateStage = 'coarse' | 'final'
export type JobCandidateSource = 'alibaba-dom' | 'generic-dom' | 'network'
export type JobCandidateDecision =
  | 'reject_below_threshold'
  | 'shortlist_for_detail'
  | 'eligible_to_apply'
  | 'selected'
  | 'stop_no_match'

export interface JobCandidateScore {
  coarseScore: number
  detailScore?: number
  llmScore?: number
  finalScore: number
  threshold: number
  decision: JobCandidateDecision
}

export interface JobCandidate {
  schemaVersion: 'job-candidate/v1'
  stage: JobCandidateStage
  id: string
  source: JobCandidateSource
  title: string
  category?: string
  location?: string
  updated?: string
  positionId?: string
  detailUrl?: string
  applicationUrl?: string
  tags: string[]
  matchedSkills: string[]
  missingSkills: string[]
  score: JobCandidateScore
  reason: string
  detailFetched: boolean
}

export interface JobCandidatesArtifact {
  schemaVersion: 'job-candidates/v1'
  stage: JobCandidateStage
  generatedAt: string
  scannedCount: number
  detailFetchCount: number
  thresholds: {
    minApplyScore: number
    minReviewScore: number
  }
  selectedJobId?: string
  candidates: JobCandidate[]
}
```

Artifact paths:

- `artifacts/job-candidates-coarse.json`
- `artifacts/job-candidates-final.json`

Compatibility rules:

- Keep `JobPosting` and `MatchScore` as the matcher interop layer.
- Add converters from `MatchScore` to `JobCandidate`; do not make old tests depend on artifact fields.
- Threshold default should match Plan 2: below `0.25` reject/continue, `0.25..0.45` review-only, `>=0.45` apply-eligible.
- `finalScore` should be the field orchestrator uses for apply decision once v2 is wired.

### PermissionMode

Recommended location: `packages/web-buddy/src/permission/permission-types.ts` or a new `permission-mode.ts` re-exported by `permission/index.ts`.

```ts
export type PermissionMode = 'safe' | 'review' | 'trusted' | 'autopilot'

export interface PermissionModeConfig {
  mode: PermissionMode
  allowFinalSubmit: boolean // default false
}
```

Recommended minimal plumbing:

- Add `permissionMode?: PermissionMode` to `AgentConfig.human`.
- Add `PERMISSION_MODE=safe|review|trusted|autopilot` and CLI `--permission-mode`.
- Pass mode into `PermissionEngine` via `PermissionEngineOptions`, and expose it in `PermissionRuleContext`.
- Add `permissionMode?: PermissionMode` to `PermissionDecision` so audit artifacts do not need to infer it later.
- Keep default as `safe`, preserving current guarded behavior.

Recommended behavior table:

| Mode | Apply entry / non-final L3 | Login/captcha | Upload | L4 | Final submit |
| --- | --- | --- | --- | --- | --- |
| `safe` | ask | ask | ask | ask | ask |
| `review` | allow apply-entry and ordinary non-final L3 | ask | ask | ask | ask |
| `trusted` | allow apply-entry and most L3 | ask | ask | ask | ask |
| `autopilot` | allow most non-final actions | ask unless explicitly changed later | ask unless explicitly changed later | ask | ask unless `allowFinalSubmit` is true |

Important distinction:

- `safetyMode: 'raw'` is an existing low-level compatibility switch.
- `PermissionMode` is a user-facing policy profile.
- Do not silently map Plan 2 `autopilot` to current `raw`, because current `raw` can auto-confirm submit-like clicks.

### RiskDecision Artifact

Recommended location: `packages/web-buddy/src/policy/risk-decision.ts` or `policy-audit.ts` if kept small.

```ts
export type RiskDecisionOutcome =
  | 'allowed'
  | 'auto_allowed'
  | 'asked'
  | 'denied'
  | 'blocked'
  | 'human_approved'
  | 'human_declined'
  | 'human_takeover'

export interface RiskDecision {
  schemaVersion: 'risk-decision/v1'
  id: string
  at: string
  runId: string
  sessionId: string
  turnId?: string
  step: number
  toolCallId?: string
  toolName?: string
  actionLabel?: string
  url?: string
  risk?: RiskLevel
  riskLevel: PolicyRiskLevel
  gateKind?: GateKind
  workflowPhase?: WorkflowPhase
  permissionMode: PermissionMode
  policy: {
    action: PolicyAction
    policyCode: string
    ruleId: string
    reason: string
  }
  permission?: {
    action: PermissionAction
    ruleId: string
    source: PermissionDecisionSource
    reason: string
  }
  outcome: RiskDecisionOutcome
  auditTags: string[]
}

export interface RiskDecisionsArtifact {
  schemaVersion: 'risk-decisions/v1'
  generatedAt: string
  decisions: RiskDecision[]
  summary: {
    allowed: number
    autoAllowed: number
    asked: number
    denied: number
    blocked: number
  }
}
```

Artifact path:

- `artifacts/risk-decisions.json`

Compatibility rules:

- Prefer deriving this from existing `policy_decision`, `permission_decision`, and approval events instead of making trace artifacts a runtime state source.
- Do not store raw tool args, cookies, API keys, storage state paths, or resume raw text.
- CLI compact output can be generated from the same `RiskDecision` object.

### direct_submit_review Workflow State

Extend `WorkflowPhase`:

```ts
type WorkflowPhase =
  | /* existing phases */
  | 'direct_submit_review'
```

Meaning:

- The site is past login/captcha.
- There are no meaningful fillable application fields.
- There is an agreement checkbox or application notice.
- There is a submit/apply button that would likely perform the real application submission.
- The agent must explain the direct-submit mode and stop before final submit by default.

Recommended workflow definition:

```ts
{
  id: 'direct_submit_review',
  phase: 'direct_submit_review',
  title: 'Direct submit review',
  objective: 'Review a no-form direct-submit application boundary before final submission.',
  allowedNextPhases: ['ready_for_final_submit', 'blocked', 'done'],
  requiredEvidenceKinds: ['page', 'form', 'policy'],
  humanHandoffRequired: true,
}
```

Recommended transition rule:

- If `form.fields.length === 0`.
- And `form.submitCandidates` contains submit/apply text or risk `L3/L4`.
- And page/form text contains agreement/notice terms such as `同意`, `申请工作需知`, `agreement`, `notice`.
- And page is not login/captcha.
- Then transition to `direct_submit_review` with `humanHandoffRequired: true`, `blocker: 'Direct-submit application requires final-submit review.'`.

Policy refinement:

- In `direct_submit_review`, submit/apply-like clicks must map to `gateKind: 'final_submit'`.
- Completion gate should block successful completion in `direct_submit_review` unless explicit user confirmation evidence exists.
- `FinalState` should gain `direct_submit_review` or map to `stopped_at_submit` with an explicit message. Prefer adding `direct_submit_review` for trace/UI clarity.

## File Ownership Map

### Agent 01: Resume Ingestion v2

Owns:

- `packages/web-buddy/src/sdk/resume.ts`
- `packages/web-buddy/src/sdk/resume-types.ts` (new, preferred)
- `packages/web-buddy/src/sdk/resume-ingest.ts` (new, optional)
- `packages/web-buddy/src/sdk/llm.ts` only for a small helper if strictly needed
- `packages/web-buddy/scripts/resume-ingest-test.mjs` (new)
- `packages/web-buddy/scripts/fixtures/resumes/*` (new)
- `packages/web-buddy/package.json` only to add its test script

Avoids:

- `matcher.ts`, `alibaba.ts`, `permission/*`, `policy/*`, `workflow/*`.
- `orchestrator.ts` except a later integration agent explicitly switches to v2.

### Agent 02: Resume Fixtures and Parser QA

Owns:

- `packages/web-buddy/scripts/resume-ingest-test.mjs`
- `packages/web-buddy/scripts/fixtures/resumes/*`

May make small fixes in:

- `packages/web-buddy/src/sdk/resume.ts`
- `packages/web-buddy/src/sdk/resume-ingest.ts`
- `packages/web-buddy/src/sdk/resume-types.ts`

Avoids:

- Job matching, policy, permission, workflow, CLI behavior.

### Agent 03: Job Crawl and Matching v2

Owns:

- `packages/web-buddy/src/sdk/alibaba.ts`
- `packages/web-buddy/src/sdk/matcher.ts`
- `packages/web-buddy/src/sdk/job-candidates.ts` (new, preferred)
- `packages/web-buddy/src/sdk/orchestrator.ts` only for job crawl/match integration and threshold stop
- `packages/web-buddy/scripts/job-crawl-pagination-test.mjs` (new)
- `packages/web-buddy/scripts/job-match-threshold-test.mjs` (new)
- `packages/web-buddy/package.json` only to add those scripts

Avoids:

- Resume parser internals.
- Permission mode and policy mode behavior.
- Direct-submit workflow detection.

### Agent 04: Permission Modes

Owns:

- `packages/web-buddy/src/sdk/config.ts`
- `packages/web-buddy/src/permission/*`
- `packages/web-buddy/src/policy/policy-engine.ts` only if policy input needs `permissionMode` or apply-entry tagging
- `packages/web-buddy/src/cli/demo.ts`
- `configs/agent.env.example`
- `packages/web-buddy/scripts/permission-modes-test.mjs` (new)
- `packages/web-buddy/package.json` only to add the script

May need narrow plumbing in:

- `packages/web-buddy/src/runtime/local/agent-loop.ts` to pass config/mode into `PermissionEngine`.
- `packages/web-buddy/src/sdk/orchestrator.ts` to pass configured mode into the loop.

Avoids:

- `resume.ts`, `matcher.ts`, `alibaba.ts` job crawl behavior, web UI.

### Agent 05: Direct Submit Flow

Owns:

- `packages/web-buddy/src/workflow/workflow-state.ts`
- `packages/web-buddy/src/workflow/workflow-definition.ts`
- `packages/web-buddy/src/workflow/workflow-transition.ts`
- `packages/web-buddy/src/workflow/workflow-engine.ts`
- `packages/web-buddy/src/workflow/completion-gate.ts`
- `packages/web-buddy/src/sdk/alibaba.ts` only for direct-submit detection and safer `attemptApply()` semantics
- `packages/web-buddy/src/sdk/orchestrator.ts` only for final state/message integration
- `packages/web-buddy/scripts/direct-submit-flow-test.mjs` (new)
- `packages/web-buddy/package.json` only to add the script

May touch:

- `packages/web-buddy/src/policy/policy-engine.ts` only to classify `direct_submit_review` clicks as `final_submit`.

Avoids:

- Resume ingestion and job ranking.
- Permission mode table, except respecting existing mode behavior.

### Agent 06: Risk Timeline and Web UI

Owns:

- `packages/web-buddy/src/policy/policy-audit.ts`
- `packages/web-buddy/src/policy/risk-decision.ts` (new, preferred)
- `packages/web-buddy/src/policy/safety-report.ts`
- `packages/web-buddy/src/metrics/*` if summary counters need extension
- `packages/web-buddy/src/sdk/trace.ts` only for artifact writing helpers
- `packages/web-buddy/src/web/server.ts`
- `packages/web-buddy/src/web/public/index.html`
- `packages/web-buddy/scripts/risk-timeline-test.mjs` (new)
- `packages/web-buddy/package.json` only to add the script

Avoids:

- Changing default permission behavior.
- Rewriting `agent-loop`; derive timeline from recorded policy/permission/approval events when possible.

### Agent 07: Integration QA

Owns:

- `PLAN/phase3/plan2-qa-report.md` (new)
- Small test-fix patches only, after all implementation agents.

Avoids:

- New feature work and architecture rewrites.

### Agent 08: Docs

Owns:

- `README.md`
- `packages/web-buddy/README.md`
- `docs/*` relevant to safety/full experience
- `PLAN/phase3/*` summary docs

Avoids:

- Runtime behavior changes.

## Test Ownership Map

Existing scripts that should remain green:

- `test:resume`
- `test:matcher`
- `test:policy`
- `test:policy-engine`
- `test:permission-engine`
- `test:approval-queue`
- `test:workflow`
- `test:completion-gate`
- `test:metrics`
- `test:safety-report`
- `test:e2e-auto-apply`
- `test:mvp`

Required new scripts:

| Script | Owner | Required coverage |
| --- | --- | --- |
| `test:resume-ingest` | Agent 01/02 | v2 schema, v1 compatibility, no-key fallback, fake LLM success, malformed JSON fallback, fixtures |
| `test:job-crawl-pagination` | Agent 03 | local multi-page fixture, dedupe, detail Top-N, no real Alibaba dependency |
| `test:job-match-threshold` | Agent 03 | reject below `0.25`, review-only `0.25..0.45`, apply-eligible `>=0.45`, artifact shape |
| `test:permission-modes` | Agent 04 | safe asks L3, trusted allows apply-entry, final submit asks, login/captcha ask, autopilot does not default final submit |
| `test:direct-submit-flow` | Agent 05 | checkbox plus submit plus no fields -> `direct_submit_review`; normal form unaffected; login wall unaffected |
| `test:risk-timeline` | Agent 06 | risk-decisions artifact, auto-allowed/gated/denied counters, no raw secrets, UI/server data shape |

Optional aliases only if the implementation wants more granularity:

- `test:resume-llm-parser`
- `test:resume-ingest-fixtures`

Recommendation: keep those as coverage sections inside `test:resume-ingest` unless splitting materially improves runtime or debuggability.

## Breaking-Change Risks

1. Replacing `ResumeProfile` directly would break matcher, form fill, tests, and SDK consumers. Keep v1 stable and add v2 plus conversion.
2. Changing `ResumeProfile.source` to include v2 source strings would break current assertions such as `source === 'pdf'`. Keep v1 source enum unchanged.
3. Moving matching from `MatchScore.score` to `finalScore` can silently bypass old stop logic. Orchestrator should make the threshold decision explicit and trace it.
4. `refineMatchesWithLlm()` currently reranks but does not rescore. A final ranking contract must say whether LLM can change only order or also score.
5. Alibaba `attemptApply()` currently checks a checkbox and clicks `投递简历` after an apply-entry gate. On a logged-in direct-submit page, that may be a final-submit action. Agent 05 should fix this before any permission mode makes apply-entry easier to auto-allow.
6. Current `raw` safety mode can auto-confirm submit-like clicks. Permission modes must not inherit this behavior accidentally.
7. `HumanLoopConfig.mode === 'auto'` and `PermissionMode` are separate concepts. Merging them would confuse CI/demo auto gates with user-facing risk policy.
8. Adding `direct_submit_review` requires updates beyond `workflow-state.ts`: workflow definition, transition, engine handoff/blocker logic, policy gate classification, completion gate, tests, and prompt sections may all need awareness.
9. Risk timeline should not make trace artifacts runtime state. It should be a derived artifact/report from runtime events.
10. Multiple agents may need `orchestrator.ts` and `agent-loop.ts`. Treat those as integration files with narrow, sequenced edits.
11. Package scripts are currently the registry for tests. Later agents may edit `package.json`, but this baseline agent did not.
12. The working tree already contains unrelated modified files. Later agents must avoid reverting user changes.

## Recommended Implementation Order

1. Land this contracts audit.
2. Agent 01 adds `ResumeProfileV2`, `readResumeV2()`, fallback behavior, and `test:resume-ingest`.
3. Agent 02 adds resume fixtures and expands `test:resume-ingest`.
4. Agent 03 adds coarse/final job candidate artifacts, pagination crawl, dedupe, thresholds, and matcher tests.
5. Agent 04 adds `PermissionMode` config/CLI/permission rules. Keep default `safe`. Do not weaken `final_submit`.
6. Agent 05 fixes direct-submit semantics before real-site trusted/autopilot demos. This should include the safer `attemptApply()` boundary.
7. Agent 06 derives risk-decisions artifacts and Web/CLI timeline from policy/permission/approval events.
8. Agent 07 runs integration QA and writes `plan2-qa-report.md`.
9. Agent 08 updates docs after QA confirms behavior and safety defaults.

Minimum sequencing constraint:

- Agent 05 must run after Agent 04 if it needs permission mode semantics, and after Agent 03 if it consumes job/apply decision artifacts.
- Agent 06 should run after Agent 04/05 so the risk timeline includes permission mode and direct-submit states.

