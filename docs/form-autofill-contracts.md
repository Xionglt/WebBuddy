# Web-Buddy Form Autofill Contracts

Status: implemented (updated 2026-07-03). The contracts below are now wired into
the running agent loop: the new tools are registered, `ask_user` has an
`info_request`-style human input channel, the field planner and fill ledger drive
prompt context, and the completion gate enforces fill-completeness. This document
records where each contract lives and the invariants that must stay true.

## Type Contracts

| Contract | File | Purpose |
| --- | --- | --- |
| `ProfileStore` | `packages/web-buddy/src/context/profile-store.ts` | Read-only access to full `ResumeProfileV2` sections, with legacy resume fallback. Future `resume_query` should read this store only. |
| `AnswerStore` | `packages/web-buddy/src/context/answer-store.ts` | Session-scoped answers collected through future `ask_user`. It records answers by field label or `fieldKey`; it is not a safety approval store. |
| `FieldPlan` / `PlannedField` | `packages/web-buddy/src/fill/field-plan.ts` | Structured field-to-value plan. It records `fieldKey`, `controlKind`, value source, normalization, confidence, and whether user input is needed. |
| `FillLedger` / `FillLedgerSummary` | `packages/web-buddy/src/fill/fill-ledger.ts` | Persistent fill progress memory for planned, verified, failed, skipped, and user-needed fields. |
| `FormCoverage` | `packages/web-buddy/src/observation/form-state.ts` | Optional form scroll/audit coverage evidence: top/bottom reached, segment count, total fields seen, and audited field keys. |
| `requiredConfidence` | `packages/web-buddy/src/observation/form-state.ts` and fill contracts | Optional numeric confidence (`0..1`) for required-field inference. `required: true` remains the legacy boolean. |
| `fieldKey` | `packages/web-buddy/src/observation/form-state.ts` | Stable field identity shared by observation, plans, and ledger entries. Absent means legacy snapshots have not produced a stable key yet. |

`AgentLoopInput.resumeV2` is now an optional read-only input in
`packages/web-buddy/src/runtime/local/agent-loop.ts`. No planner is invoked and
no tool behavior changes until future phases explicitly wire it in.

## Module Boundaries

Wired into the running loop (behavior now active):

- `packages/web-buddy/src/runtime/local/agent-loop.ts`: builds `ProfileStore`/`AnswerStore`, seeds the `FillLedger`, injects `profileStore`/`answerStore`/`fieldPlan`/`fillLedgerSummary`/`humanInput`/`llm` into the tool context, refreshes `FieldPlan` via `ensureFieldPlan`, and updates the ledger after `browser_set_field`.
- `packages/web-buddy/src/workflow/completion-gate.ts`: `fillCompletenessCriteria` returns `reject` when `pendingRequired`/`failed`/`needsUser` remain, coverage did not scroll to bottom, or the current resume is not uploaded. It still never clicks final submit.
- `packages/web-buddy/src/tools/catalog.ts` and `packages/web-buddy/src/tools/local-adapter.ts`: register and handle `resume_query`, `plan_form_fill`, `ask_user`, `browser_form_audit`, `browser_inspect_options`, and `browser_set_field`.
- `packages/web-buddy/src/sdk/human.ts`: `HumanGate.requestInfo` provides the `ask_user` channel (`CliHumanGate` prompts stdin; `ScriptedHumanGate` replays scripted answers). `AutoHumanGate` intentionally omits it so `ask_user` fails closed.

Supporting contracts:

- `packages/web-buddy/src/context/profile-store.ts`, `packages/web-buddy/src/context/answer-store.ts`
- `packages/web-buddy/src/fill/field-plan.ts`, `field-planner.ts`, `normalizers.ts`, `fill-ledger.ts`
- `packages/web-buddy/src/browser/form-collector.ts`, `form-audit.ts`, `inspect-options.ts`, `set-field.ts`
- `packages/web-buddy/src/observation/form-state.ts` optional metadata (`fieldKey`, `controlKind`, `requiredConfidence`, `FormCoverage`)
- `packages/web-buddy/src/context/types.ts` prompt-context slots (`fieldPlan`, `fillLedgerSummary`, `answerSummary`, `FILL_PLAN` section)
- `packages/web-buddy/src/workflow/workflow-state.ts` proof fields (`fillLedgerSummary`, `formCoverage`, `currentResumeUploaded`)

Must NOT change without an explicit safety review:

- `packages/web-buddy/src/policy/*` and `packages/web-buddy/src/permission/*`: do not relax gates or permission behavior. `ask_user` stays L0 and must remain separate from `gate.confirm`.

## Safety Invariants

- `final_submit` is still not automatically executed.
- Existing tools remain available; no old tool is removed or renamed.
- All new fields are optional, so legacy snapshots, traces, and tests remain valid.
- New autofill behavior must be enabled progressively by future tool registration,
  prompt wiring, and completion criteria changes.
- `AnswerStore` is for missing information, not for approving risky actions.

## Test Matrix

| Stage | Scope | Acceptance commands |
| --- | --- | --- |
| Contracts only | Types compile; no behavior change | `cd packages/web-buddy && npm run build` |
| Safety regression | Final submit, upload, save, and workflow gates unchanged | `cd packages/web-buddy && npm run test:policy-engine && npm run test:agent-runtime-workflow && npm run test:completion-gate && npm run test:direct-submit-flow` |
| Tool compatibility | Existing browser/form/upload tools still present | `cd packages/web-buddy && npm run test:tool-catalog && npm run test:tool-execution-service && npm run test:observation` |
| Context compatibility | Optional `fieldPlan` and ledger context slots do not break prompt assembly | `cd packages/web-buddy && npm run test:context && npm run test:prompt-sections` |
| Phase 1 | `resume_query`, `ask_user`, `ProfileStore`, `AnswerStore` | `cd packages/web-buddy && npm run build && node ./scripts/resume-query-test.mjs && node ./scripts/ask-user-flow-test.mjs` |
| Phase 2 | `FieldPlanner`, normalizers, enum matching | `cd packages/web-buddy && npm run build && node ./scripts/field-planner-test.mjs` |
| Phase 3 | `browser_form_audit`, option inspection, `browser_set_field` | `cd packages/web-buddy && npm run build && node ./scripts/form-audit-test.mjs && node ./scripts/inspect-options-test.mjs && node ./scripts/set-field-test.mjs` |
| Phase 4 | `FillLedger`, form coverage criteria, pre-submit proof | `cd packages/web-buddy && npm run test:completion-gate && npm run test:agent-runtime-workflow` |

Note: the Phase 3 browser tests require a real Chromium (`npx playwright install`) and cannot run in a browserless sandbox.

## Phase Acceptance Notes

Phase 1 is accepted only when information retrieval is read-only and `ask_user`
cannot be mistaken for permission to approve `final_submit`, upload, or save.

Phase 2 is accepted only when low-confidence fields produce `skipReason` or
`needsUser` instead of a write action.

Phase 3 is accepted only when old fill tools still work and new set-field logic
is opt-in.

Phase 4 is accepted only when completion gets stricter before final submit; it
must not create any path that clicks final submit automatically.
