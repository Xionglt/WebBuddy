# Phase 3 Plan 2 Integration QA Report

Date: 2026-07-01

Role: Integration QA agent

## Scope Read

- Read `PLAN/phase3/plan2.md`.
- Read `PLAN/phase3/plan2-contracts-audit.md`.
- Checked for standalone Agent 01-06 handoff summaries. None were present in the repository beyond the baseline contracts audit and the shared handoff format in `PLAN/phase3/plan2-multi-agent-prompts.md`.
- Read `packages/web-buddy/package.json` scripts.
- Read `README.md`.
- Read `docs/full-experience-guide.md`.
- Also checked `packages/web-buddy/README.md` for package-level demo and safety expectations.

## Passed Tests

All commands were run from `packages/web-buddy` unless noted.

| Command | Result | Notes |
| --- | --- | --- |
| `npm run build` | PASS | Build completed successfully. |
| `npm run test:resume` | PASS | Legacy resume parsing still works. |
| `npm run test:resume-ingest` | PASS | Resume v2 fixtures and no-key fallback passed. |
| `npm run test:matcher` | PASS | Legacy matcher regression passed. |
| `npm run test:job-crawl-pagination` | PASS | Uses a local paginated fixture server, scans/dedupes pages, opens only Top N details. |
| `npm run test:job-match-threshold` | PASS | Local fixture verifies low/strict thresholds stop before apply and high match can proceed in sandbox. |
| `npm run test:permission-modes` | PASS | Safe/trusted/autopilot behavior verified; final submit remains ask by default. |
| `npm run test:direct-submit-flow` | PASS | Local file fixtures cover direct-submit, normal form, and login wall cases. |
| `npm run test:risk-timeline` | PASS | Risk decisions artifact and counters passed. |
| `npm run test:e2e-auto-apply` | PASS | Local sandbox auto-apply still submits only to localhost fixture. |
| `npm run benchmark:research` | PASS | Read-only local research benchmark passed. |
| `npm run test:mvp` | PASS after fix | Full MVP regression passed after the small benchmark fixture fix below. |

Additional old-demo checks:

- `npm run demo:research`: completed successfully with final state `completed`; process was stopped afterward because the CLI keeps the browser open when no TTY is attached.
- `demo-form --headless` with model keys cleared: completed successfully with final state `stopped_at_submit`; no submit occurred.

Script registry check:

- Verified all required scripts exist in `packages/web-buddy/package.json`: `build`, `test:model`, `test:resume`, `test:resume-ingest`, `test:matcher`, `test:job-crawl-pagination`, `test:job-match-threshold`, `test:permission-modes`, `test:direct-submit-flow`, `test:risk-timeline`, `test:e2e-auto-apply`, `benchmark:research`, and `test:mvp`.

## Failed Tests and Fixes

### `npm run test:model`

Result: FAILED due to external model account state.

The local `.env` has model keys, so the test was run. The provider returned HTTP 400 from DashScope/Qwen:

```text
Access denied ... code "Arrearage"
```

No code fix was made because this is an account/billing availability issue, not an integration failure.

### Initial `npm run test:mvp`

Result: FAILED on `benchmark:simple`.

Failure:

```text
AssertionError: benchmark expected page-state-latest.json
```

Root cause: the new default match threshold correctly stopped low matches before apply, but the old local `simple-apply` positive fixture scored only `0.39`, below the `0.45` apply threshold. Because the run stopped at `no_match`, it never produced final PageState/FormState artifacts.

Fix:

- Updated `packages/web-buddy/benchmarks/mock-pages/simple-apply.html` to include additional sample-resume technologies (`Next.js`, `Vue`, `Docker`, `Kubernetes`) in the local positive job card tags and description.
- Did not change the global threshold or permission defaults.

Verification after fix:

- `npm run benchmark:simple`: PASS.
- `npm run test:mvp`: PASS.

## Local Fixture Coverage for Real-Site Features

Verified that real-site-related behavior has local fixture coverage and does not depend on live Alibaba:

- `test:job-crawl-pagination` starts a local HTTP job board with paginated list pages, detail pages, duplicate titles, and a deliberate detail mismatch.
- `test:job-match-threshold` starts a local HTTP job board and local application endpoints to verify threshold gating before any apply page is opened.
- `test:direct-submit-flow` uses local HTML fixtures under `scripts/fixtures/direct-submit-flow/` for checkbox-plus-submit direct flow, ordinary forms, and login walls.
- `test:e2e-auto-apply` uses a local sandbox job board and local POST endpoint.
- `test:resume-ingest` uses local resume fixtures under `scripts/fixtures/resumes/`.

No real Alibaba application was submitted.

## Safety Defaults and Final Submit Gate

Final-submit default remains gated.

Evidence:

- `loadConfig()` defaults `human.permissionMode` to `safe`.
- `loadConfig()` defaults `human.allowFinalSubmit` to `false`.
- `PermissionEngine` defaults to `permissionMode: 'safe'` and `allowFinalSubmit: false`.
- `finalSubmitRule()` returns `ask` for `final_submit` unless both `permissionMode === 'autopilot'` and `allowFinalSubmit === true`.
- `permissionModeAutoAllowRule()` excludes sensitive gates including `final_submit`, `login`, `captcha`, and uploads.
- Policy maps submit-like clicks in `direct_submit_review` to `final_submit`.
- `test:permission-modes` asserts trusted final submit asks and autopilot final submit still asks by default.

Conclusion: `final_submit` is still gated by default.

## Remaining Risks

- Model-backed smoke test is not verified until the DashScope/Qwen account state is fixed.
- No standalone Agent 01-06 handoff summary files were found, so QA relied on the contracts audit, prompts, changed files, and tests.
- Live Alibaba DOM can still drift. Local fixtures cover expected semantics, but manual real-site verification is still required.
- The pdfjs warning about `standardFontDataUrl` appears during resume-related checks but did not fail tests.
- CLI demos complete successfully, but in no-TTY runs they keep the browser open until the process is stopped.

## Manual Real-Site Verification Checklist

- Use a controlled account and start with dry-run/headful observation. Do not enable any final-submit override.
- Confirm Alibaba list crawl scans at least 5 pages or up to 100 jobs and writes candidate artifacts.
- Confirm coarse Top N and final Top N are plausible for the uploaded resume.
- Confirm low-score jobs stop before entering application flow.
- Confirm `trusted` mode can auto-allow apply-entry/non-final L3 actions, while login, captcha, upload, and final submit still ask.
- Confirm direct-submit pages with agreement checkbox plus `投递简历` are reported as `direct_submit_review`.
- Confirm the agent stops before final submit and explains that the page has no fillable form because it uses online-resume/direct-submit semantics.
- Confirm risk timeline and `risk-decisions.json` show allowed/auto-allowed/asked decisions without raw secrets, cookies, storage state, or raw resume text.
- Only perform a real final submit with explicit human authorization and an account/job where that action is intended.

