#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextCompactor } from '../dist/context/compaction.js'
import { COMPACTED_RUN_CONTEXT_PREFIX } from '../dist/context/run-summary.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-context-compaction-'))
const originalCwd = process.cwd()

try {
  const traceDir = join(root, 'output', 'traces')
  mkdirSync(traceDir, { recursive: true })
  const poisonedTracePage = join(traceDir, 'page-state-latest.json')
  const poisonedRootPage = join(root, 'page-state-latest.json')
  const poisonedRootForm = join(root, 'form-state-latest.json')
  writeFileSync(poisonedTracePage, JSON.stringify({ title: 'POISON TRACE PAGE' }))
  writeFileSync(poisonedRootPage, JSON.stringify({ title: 'POISON ROOT PAGE' }))
  writeFileSync(poisonedRootForm, JSON.stringify({ fields: [{ label: 'POISON FORM FIELD' }] }))
  assert(existsSync(poisonedTracePage), 'poisoned trace artifact should exist')

  process.chdir(root)

  const fixedNow = new Date('2026-06-29T08:00:00.000Z')
  const compactor = new ContextCompactor({
    now: () => fixedNow,
    maxRecentActions: 3,
    maxPermissions: 4,
    maxApprovals: 4,
    maxEvidenceItems: 3,
  })

  const workflowState = {
    schemaVersion: 'workflow-state/v1',
    phase: 'ready_for_final_submit',
    confidence: 'high',
    reason: 'Application form is open and a submit candidate is visible.',
    updatedAt: '2026-06-29T07:59:00.000Z',
    humanHandoffRequired: true,
    blocker: 'Final submit requires human approval.',
  }
  const workflowBefore = structuredClone(workflowState)

  const latestContext = {
    schemaVersion: 'context-snapshot/v1',
    sessionId: 'compact-session',
    goal: 'Apply to the saved job without final submission.',
    page: {
      schemaVersion: 'page-state/v1',
      url: 'https://jobs.example.test/apply',
      title: 'Frontend Engineer Application',
      pageType: 'form',
      interactiveCount: 8,
      formCount: 1,
      linkCount: 2,
      buttonCount: 3,
      inputCount: 4,
      textSummary: 'Live memory page summary with application fields, resume upload, and submit controls.',
      updatedAt: '2026-06-29T07:58:30.000Z',
    },
    form: {
      schemaVersion: 'form-state/v1',
      url: 'https://jobs.example.test/apply',
      fields: [
        field(0, 'Full name', 'Zhang San', true),
        field(1, 'Email', '', true),
        field(2, 'Resume', '', false, { tag: 'input', type: 'file' }),
      ],
      missingRequired: [field(1, 'Email', '', true)],
      filledFields: [field(0, 'Full name', 'Zhang San', true)],
      submitCandidates: [
        { tag: 'button', type: 'submit', role: 'button', text: 'Submit application', risk: 'L4', visible: true },
      ],
      uploadHints: [
        { tag: 'input', type: 'file', text: 'Resume upload', accept: '.pdf', visible: true },
      ],
      visibleErrors: ['Email is required.'],
      updatedAt: '2026-06-29T07:58:45.000Z',
    },
    taskState: {
      schemaVersion: 'task-state/v1',
      goal: 'Apply to the saved job without final submission.',
      phase: 'filling',
      knownBlockers: ['User must approve final submit.'],
      completionCriteria: ['Required fields reviewed', 'Final submit is not clicked'],
      updatedAt: '2026-06-29T07:59:00.000Z',
    },
    workflowState,
    freshness: {
      pageStateUpdatedAt: '2026-06-29T07:58:30.000Z',
      formStateUpdatedAt: '2026-06-29T07:58:45.000Z',
      pageStateAgeMs: 90_000,
      formStateAgeMs: 75_000,
      pageStateStale: true,
      formStateStale: true,
      staleAfterMs: 30_000,
    },
    resumeSummary: 'name: Zhang San\nemail: zhangsan@example.com',
    recentActions: [
      recent(1, 'browser_snapshot', 'ok', 'Initial page snapshot.'),
      recent(2, 'browser_click', 'warn', 'Opened the application form.', 'L3'),
      recent(3, 'browser_form_snapshot', 'ok', 'Captured required fields.'),
      recent(4, 'browser_click', 'blocked', 'Final submit blocked by approval gate.', 'L4'),
    ],
    safetyNotes: [
      'NEVER submit a final application.',
      'Uploads and final submission must rely on recorded approval state.',
    ],
    blockers: ['Final submit requires human approval.'],
    updatedAt: '2026-06-29T08:00:00.000Z',
  }

  const messages = [
    { role: 'system', content: 'system context' },
    { role: 'user', content: 'OLD_NOISE_SHOULD_NOT_SURVIVE '.repeat(2000) },
  ]
  const permissionRequest = {
    schemaVersion: 'permission-request/v1',
    requestId: 'perm-submit',
    runId: 'compact-run',
    sessionId: 'compact-session',
    turnId: 'turn-7',
    step: 4,
    requestedAt: '2026-06-29T07:59:30.000Z',
    subject: {
      kind: 'tool_call',
      toolCallId: 'call-submit',
      toolName: 'browser_click',
      args: { ref: 'e7', text: 'Submit application' },
      argBrief: 'ref=e7 text=Submit application',
      toolCategory: 'action',
    },
    risk: 'L4',
    riskLevel: 'critical',
    currentUrl: 'https://jobs.example.test/apply',
    workflowPhase: 'ready_for_final_submit',
    gateKind: 'final_submit',
    policy: {
      schemaVersion: 'policy-decision/v1',
      action: 'gate',
      policyCode: 'policy.workflow.final_submit',
      ruleId: 'policy.workflow.final_submit.v1',
      reason: 'Final submit requires human approval.',
      auditTags: ['action:gate', 'risk:critical', 'gate:final_submit'],
    },
  }
  const permissionDecision = {
    schemaVersion: 'permission-decision/v1',
    requestId: 'perm-submit',
    action: 'ask',
    source: 'policy',
    ruleId: 'permission.policy.ask.v1',
    policyCode: 'policy.workflow.final_submit',
    policyRuleId: 'policy.workflow.final_submit.v1',
    risk: 'L4',
    riskLevel: 'critical',
    reason: 'Final submit requires human approval.',
    decidedAt: '2026-06-29T07:59:31.000Z',
    gateKind: 'final_submit',
    rememberable: false,
    remember: { supportedScopes: ['once'], defaultScope: 'once' },
    auditTags: ['action:ask', 'risk:critical', 'gate:final_submit'],
  }
  const approval = {
    schemaVersion: 'approval-request/v1',
    id: 'approval-submit',
    approvalId: 'approval-submit',
    permissionRequestId: 'perm-submit',
    runId: 'compact-run',
    sessionId: 'compact-session',
    turnId: 'turn-7',
    toolCallId: 'call-submit',
    status: 'denied',
    kind: 'final_submit',
    gateKind: 'final_submit',
    risk: 'L4',
    riskLevel: 'critical',
    title: 'Final submission',
    message: 'Approve final submit?',
    reason: 'Final submit requires human approval.',
    context: { url: 'https://jobs.example.test/apply', toolName: 'browser_click' },
    allowedDecisions: ['approve', 'decline', 'takeover'],
    createdAt: '2026-06-29T07:59:32.000Z',
    updatedAt: '2026-06-29T07:59:40.000Z',
    resolvedAt: '2026-06-29T07:59:40.000Z',
    resolution: {
      schemaVersion: 'approval-resolution/v1',
      id: 'approval-submit-resolution',
      approvalId: 'approval-submit',
      permissionRequestId: 'perm-submit',
      status: 'denied',
      decision: 'decline',
      source: 'user',
      reason: 'User declined final submission.',
      resolvedAt: '2026-06-29T07:59:40.000Z',
      decidedAt: '2026-06-29T07:59:40.000Z',
    },
  }
  const workflowEvidence = [
    {
      schemaVersion: 'workflow-evidence/v1',
      id: 'evidence-page-old',
      kind: 'page',
      summary: 'Job detail page was inspected before entering the application.',
      source: 'browser_snapshot',
      confidence: 'medium',
      phase: 'job_detail',
      sessionId: 'compact-session',
      runId: 'compact-run',
      turnId: 'turn-5',
      ts: '2026-06-29T07:57:00.000Z',
      data: { rawText: 'THIS_RAW_EVIDENCE_DATA_SHOULD_NOT_SURVIVE' },
    },
    {
      schemaVersion: 'workflow-evidence/v1',
      id: 'evidence-form',
      kind: 'form',
      summary: 'Form evidence: Full name is filled and Email is still missing.',
      source: 'browser_form_snapshot',
      confidence: 'high',
      phase: 'reviewing',
      sessionId: 'compact-session',
      runId: 'compact-run',
      turnId: 'turn-6',
      ts: '2026-06-29T07:58:46.000Z',
      metadata: { missingRequiredCount: 1 },
    },
    {
      schemaVersion: 'workflow-evidence/v1',
      id: 'evidence-policy-final-submit',
      kind: 'policy',
      summary: 'Final submit gate evaluated browser_click on Submit application and required approval.',
      source: 'policy_engine',
      confidence: 'high',
      phase: 'ready_for_final_submit',
      sessionId: 'compact-session',
      runId: 'compact-run',
      turnId: 'turn-7',
      toolCallId: 'call-submit',
      ts: '2026-06-29T07:59:31.000Z',
    },
    {
      schemaVersion: 'workflow-evidence/v1',
      id: 'evidence-approval-denied',
      kind: 'approval',
      summary: 'User declined final submission approval; manual handoff remains required.',
      source: 'approval_queue',
      confidence: 'high',
      phase: 'ready_for_final_submit',
      sessionId: 'compact-session',
      runId: 'compact-run',
      turnId: 'turn-7',
      toolCallId: 'call-submit',
      ts: '2026-06-29T07:59:40.000Z',
    },
  ]
  const evidenceSnapshot = {
    schemaVersion: 'evidence-store-snapshot/v1',
    version: 1,
    generatedAt: '2026-06-29T07:59:50.000Z',
    total: workflowEvidence.length,
    kinds: ['page', 'form', 'policy', 'approval'],
    countsByKind: { page: 1, form: 1, policy: 1, approval: 1 },
    evidence: workflowEvidence,
    byKind: {
      page: [workflowEvidence[0]],
      form: [workflowEvidence[1]],
      policy: [workflowEvidence[2]],
      approval: [workflowEvidence[3]],
    },
    all: workflowEvidence,
  }
  const workflowEvaluation = {
    finalSubmitBlocker: 'Final submit is blocked until the human explicitly takes over.',
    missingCriteria: [
      {
        id: 'ready-for-final-submit-requires-user-confirm',
        description: 'Human confirmation for final submission is missing.',
        reason: 'The user declined the approval request.',
        evidenceKinds: ['user_confirm'],
        required: true,
      },
      'Completion evidence must show that the final submit button was not clicked.',
    ],
    humanHandoffReason: 'Human must review and submit manually because this is a final application submission.',
    completionCriteria: [
      'Required fields reviewed',
      'Final submit is not clicked',
    ],
    satisfiedCriteria: [
      {
        id: 'form-reviewed',
        description: 'Application form was reviewed before the final submit gate.',
        evidenceKinds: ['form', 'policy'],
      },
    ],
    blocked: true,
    done: false,
    reason: 'Ready for manual final submit but not permitted to click the final submission control.',
    evaluatedAt: '2026-06-29T07:59:50.000Z',
  }

  const input = {
    sessionId: 'compact-session',
    runId: 'compact-run',
    turnId: 'turn-7',
    step: 5,
    goal: 'Apply to the saved job without final submission.',
    messages,
    latestContext,
    workflowState,
    recentActions: latestContext.recentActions,
    blockers: ['Final submit requires human approval.'],
    permissionRequests: [permissionRequest],
    permissionDecisions: [permissionDecision],
    approvals: [approval],
    evidence: evidenceSnapshot,
    workflowEvaluation,
    safetyNotes: ['NEVER submit a final application.'],
    nextActionHints: ['Ask the user before final submission.'],
  }

  const result = compactor.compact(input)
  const secondResult = compactor.compact(input)

  assert.deepEqual(secondResult, result, 'compaction should be deterministic for the same input and clock')
  assert.equal(result.schemaVersion, 'context-compaction-result/v1')
  assert.equal(result.summary.schemaVersion, 'compact-run-summary/v1')
  assert.equal(result.summary.summaryId, 'compact_compact-session_compact-run_turn-7_2026-06-29T08_00_00_000Z')
  assert.equal(result.summary.goal, 'Apply to the saved job without final submission.')
  assert.equal(result.summary.workflow.phase, 'ready_for_final_submit')
  assert.equal(result.summary.workflow.blocker, 'Final submit requires human approval.')
  assert.equal(result.summary.page.title, 'Frontend Engineer Application')
  assert.equal(result.summary.form.fieldCount, 3)
  assert.equal(result.summary.form.missingRequiredCount, 1)
  assert(result.summary.form.missingRequiredLabels.includes('Email'), 'missing required label should be retained')
  assert.equal(result.summary.form.submitCandidateCount, 1)
  assert.equal(result.summary.form.uploadHintCount, 1)
  assert.deepEqual(result.summary.recentActions.map((action) => action.step), [2, 3, 4])
  assert.equal(result.summary.recentActions.at(-1).status, 'blocked')
  assert.equal(result.summary.permissions[0].requestId, 'perm-submit')
  assert.equal(result.summary.permissions[0].action, 'ask')
  assert.equal(result.summary.permissions[0].policyAction, 'gate')
  assert.equal(result.summary.permissions[0].gateKind, 'final_submit')
  assert.equal(result.summary.approvals[0].status, 'denied')
  assert.equal(result.summary.approvals[0].decision, 'decline')
  assert.equal(result.summary.evidence.total, 4)
  assert.deepEqual(result.summary.evidence.countsByKind, { page: 1, form: 1, policy: 1, approval: 1 })
  assert.deepEqual(result.summary.evidence.recentKeyEvidence.map((item) => item.id), [
    'evidence-form',
    'evidence-policy-final-submit',
    'evidence-approval-denied',
  ])
  assert.equal(result.summary.evidence.recentKeyEvidence[1].toolCallId, 'call-submit')
  assert.equal(result.summary.evidence.recentKeyEvidence[1].source, 'policy_engine')
  assert.equal(result.summary.evidence.recentKeyEvidence[2].phase, 'ready_for_final_submit')
  assert(result.summary.evidence.recentKeyEvidence.every((item) => item.data === undefined), 'evidence retention should keep summaries, not raw payloads')
  assert(!JSON.stringify(result.summary.evidence).includes('THIS_RAW_EVIDENCE_DATA_SHOULD_NOT_SURVIVE'), 'evidence summary should not retain raw data payloads')
  assert.equal(result.summary.completion.finalSubmitBlocker, 'Final submit is blocked until the human explicitly takes over.')
  assert.equal(result.summary.completion.missingCriteria.length, 2)
  assert(result.summary.completion.missingCriteria.some((criterion) => criterion.description.includes('Human confirmation')), 'missing completion criteria should be retained')
  assert.equal(result.summary.completion.humanHandoffReason, 'Human must review and submit manually because this is a final application submission.')
  assert.equal(result.summary.completion.blocked, true)
  assert.equal(result.summary.completion.done, false)
  assert(result.summary.safetyNotes.includes('NEVER submit a final application.'))
  assert(result.summary.nextActionHints.some((hint) => hint.includes('Ask the user')), 'provided next hint should be retained')
  assert(result.summary.nextActionHints.some((hint) => hint.includes('missing criteria')), 'completion hint should preserve missing criteria')
  assert(result.summary.nextActionHints.some((hint) => hint.includes('Refresh page state')), 'stale page hint should be generated')
  assert.equal(result.summary.source.inputMessageCount, messages.length)

  assert.equal(result.compactedMessage.role, 'user')
  assert(result.compactedMessage.content.startsWith(COMPACTED_RUN_CONTEXT_PREFIX))
  const renderedJsonStart = result.compactedMessage.content.indexOf('{\n')
  assert(renderedJsonStart > 0, 'compacted message should render the structured summary JSON')
  assert.deepEqual(JSON.parse(result.compactedMessage.content.slice(renderedJsonStart)), result.summary)
  assert(!result.compactedMessage.content.includes('OLD_NOISE_SHOULD_NOT_SURVIVE'), 'old message content should not be copied into compact summary')
  assert(!result.compactedMessage.content.includes('POISON TRACE PAGE'), 'compactor must not read trace page artifacts')
  assert(!result.compactedMessage.content.includes('POISON ROOT PAGE'), 'compactor must not read page-state-latest.json')
  assert(!result.compactedMessage.content.includes('POISON FORM FIELD'), 'compactor must not read form-state-latest.json')
  assert(result.compactedMessage.content.includes('Final submit is blocked until the human explicitly takes over.'), 'compacted message must preserve final submit blocker')
  assert(result.compactedMessage.content.includes('Human confirmation for final submission is missing.'), 'compacted message must preserve missing criteria')
  assert(result.compactedMessage.content.includes('Human must review and submit manually'), 'compacted message must preserve human handoff reason')
  assert(result.compactedMessage.content.includes('Final submit gate evaluated browser_click'), 'compacted message must preserve recent key evidence')
  assert.deepEqual(workflowState, workflowBefore, 'compactor must not mutate workflow state')
  assert(result.stats.estimatedInputTokensBefore > result.stats.estimatedInputTokensAfter, 'large old history should compact smaller than input messages')
  assert.equal(result.stats.retainedRecentActionCount, 3)
  assert.equal(result.stats.retainedPermissionCount, 1)
  assert.equal(result.stats.retainedApprovalCount, 1)

  const { evidence, workflowEvaluation: _workflowEvaluation, ...legacyInput } = input
  const legacyResult = compactor.compact(legacyInput)
  assert.equal(legacyResult.summary.evidence, undefined, 'legacy compaction should omit evidence summary without evidence input')
  assert.equal(legacyResult.summary.completion, undefined, 'legacy compaction should omit completion summary without workflowEvaluation input')

  console.log('context-compaction-test: PASS')
} finally {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
}

function field(index, label, value, required, overrides = {}) {
  return {
    index,
    label,
    tag: 'input',
    type: 'text',
    value,
    required,
    filled: Boolean(value),
    disabled: false,
    readonly: false,
    invalid: required && !value,
    ...overrides,
  }
}

function recent(step, toolName, status, observation, risk) {
  return {
    step,
    toolName,
    argumentsSummary: `ref=e${step}`,
    status,
    ...(risk ? { risk } : {}),
    observation,
    at: `2026-06-29T07:59:0${step}.000Z`,
  }
}
