# Phase 3 Plan 2 Completion Explanation

Date: 2026-07-01

Role: Docs and Operator Guide agent

## Scope Read

This pass read the required Plan 2 sources before editing docs:

- `PLAN/phase3/plan2.md`
- `PLAN/phase3/plan2-qa-report.md`
- `README.md`
- `packages/web-buddy/README.md`
- `docs/full-experience-guide.md`
- `docs/safety-model.md`

It also checked package scripts, CLI flags, config defaults, permission rules,
resume ingestion code, matcher code, direct-submit detection, and risk-decision
artifact code to keep the docs aligned with current implementation.

## What Plan 2 Adds For Operators

Plan 2 moves the job-application experience closer to a real guarded workflow:

- Resume ingestion now has a v2 SDK path with schema validation, confidence,
  short sanitized evidence, optional LLM parsing, heuristic fallback, and
  deterministic email/phone repair. Current CLI/Web UI resume inputs are
  `.pdf`, `.json`, and `.txt`; the orchestrator still consumes the compatible
  `ResumeProfile` shape.
- Matching now supports fast multi-page list crawling, deterministic coarse
  ranking, Top N detail enrichment, optional LLM rerank when a model key is
  configured, and a threshold decision before entering an application flow.
- Permission modes are available as `safe`, `review`, `trusted`, and
  `autopilot`. They affect which eligible non-final high-risk actions can be
  auto-allowed.
- Risk decisions are written as reviewable artifacts, including counts for
  allowed, auto-allowed, gated, and denied actions.
- Direct-submit pages are recognized as their own review state when the page
  has no fillable application form and the next step would be final submit.

## Safety Boundary

The final-submit boundary remains intact.

- `safe`, `review`, and `trusted` ask at `final_submit`.
- `autopilot` still asks at `final_submit` by default.
- Within PermissionEngine-managed tool calls, the only rule that can allow
  `final_submit` requires both autopilot mode and an explicit SDK/runtime
  `allowFinalSubmit: true`; this is not exposed as the normal CLI/env default.
- Local/sandbox benchmark submit allowances are separate localhost-only test
  behavior and do not apply to real external sites.
- Login, captcha, upload, save-resume, and final-submit remain sensitive gates.
- The project does not bypass login, captcha, QR, SMS, or other verification.
- PDF and resume extraction are best-effort; scanned or image-heavy PDFs must
  be reviewed and are not guaranteed to parse correctly.

## Documentation Updated

- `README.md`
  - Added Resume Ingestion v2 usage.
  - Added multi-page job matching usage and threshold flags.
  - Added permission mode usage.
  - Added final-submit and direct-submit-review safety boundary.

- `packages/web-buddy/README.md`
  - Added Resume and Matching v2 operator notes.
  - Expanded script registry with Plan 2 tests.
  - Added artifact guide for candidates, risk decisions, and direct-submit
    review.
  - Added troubleshooting for resume quality, no-match, direct-submit review,
    permission modes, model account errors, no-TTY browser behavior, and live
    DOM drift.

- `docs/full-experience-guide.md`
  - Updated Chinese and English flows from resume upload to matching to
    direct-submit review.
  - Added matching flags, permission-mode examples, new artifacts, and safety
    notes.

- `docs/safety-model.md`
  - Added PermissionEngine and permission modes.
  - Explained auto-allow versus final-submit hard gate.
  - Added direct-submit review boundary and risk-decision artifacts.

## QA Status From Integration Report

`PLAN/phase3/plan2-qa-report.md` reports passing local coverage for:

- `npm run build`
- `npm run test:resume`
- `npm run test:resume-ingest`
- `npm run test:matcher`
- `npm run test:job-crawl-pagination`
- `npm run test:job-match-threshold`
- `npm run test:permission-modes`
- `npm run test:direct-submit-flow`
- `npm run test:risk-timeline`
- `npm run test:e2e-auto-apply`
- `npm run benchmark:research`
- `npm run test:mvp` after the local benchmark fixture was adjusted

The QA report also notes that `npm run test:model` failed because the configured
external DashScope/Qwen account returned an account/billing availability error,
not because of a local integration failure.

## Operator Handoff Checklist

Before a real-site verification run:

1. Use a controlled account, authorized resume, and intended job target.
2. Start headful and keep the browser visible.
3. Use `--resume`, `--max-pages`, `--max-crawl-jobs`, `--max-jobs`, and
   `--match-threshold` deliberately.
4. Review `job-candidates-final.json` before entering an application flow.
5. Keep `final_submit` gated; do not treat `HUMAN_GATE_MODE=auto` as final
   submit authorization.
6. Complete login, captcha, QR, SMS, or verification manually.
7. If `direct_submit_review` appears, inspect `direct-submit-review.json` and
   stop unless a human explicitly chooses to continue.
8. Review `risk-decisions.json` and `safety-report.json` after the run.

## Remaining Risks

- Live recruiting-site DOM can drift even when local fixtures pass.
- Model-backed resume parsing and LLM rerank depend on provider availability.
- Resume extraction quality varies by file layout; scanned PDFs remain a
  review-required case.
- The guarded local runtime and optional Claude Code adapter are different
  paths; safety claims in the docs refer to the Web Buddy guarded runtime unless
  the adapter is explicitly named.

## Docs Pass Verification

Docs changed only. Final verification for this docs pass:

- `npm run build` from `packages/web-buddy`: PASS.
