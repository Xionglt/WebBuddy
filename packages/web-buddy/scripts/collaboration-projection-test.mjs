#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createBuiltInRoleTaskMetadata } from '../dist/agents/built-in-roles.js'
import { projectCollaboration } from '../dist/web/collaboration-projection.js'

const researcher = task({
  id: 'research-source-a',
  roleId: 'researcher',
  title: 'Research source A',
  status: 'failed',
  error: {
    code: 'RESULT_SCHEMA_INVALID',
    category: 'validation',
    retryDisposition: 'never_retry',
    message: 'Structured output did not match.',
  },
})
const comparison = task({
  id: 'compare-results',
  roleId: 'comparison',
  title: 'Compare source findings',
  status: 'completed',
  outputs: [output('comparison-report-1', 'comparison_report')],
})

const projection = projectCollaboration({
  runId: 'run-ui-collaboration',
  sessionId: 'session-ui-collaboration',
  runState: 'running',
  graph: {
    schemaVersion: 'agent-task-graph/v2',
    revision: 9,
    tasks: [researcher, comparison],
  },
  events: [
    event('event-1', 1, 'task_created', researcher.id),
    event('event-2', 2, 'task_failed', researcher.id),
    event('event-3', 3, 'task_completed', comparison.id),
  ],
  artifactRecords: [
    artifact('comparison-report-1', 'comparison_report', 'Comparison grounded in two sources.'),
    artifact('observation-browser_open-source-a', 'runner_result', 'Observed source A.'),
    artifact('context-envelope-hidden', 'context_envelope', 'Internal envelope.'),
    artifact('main-task-seed_hidden', 'runner_result', 'Internal seed.'),
  ],
})

assert.equal(projection.schemaVersion, 'public-collaboration/v1')
assert.equal(projection.graphRevision, 9)
assert.equal(projection.members.find((member) => member.roleId === 'main-agent')?.status, 'working')
assert.equal(projection.members.find((member) => member.roleId === 'researcher')?.status, 'failed')
assert.equal(projection.members.find((member) => member.roleId === 'comparison')?.status, 'done')
assert.equal(projection.tasks.length, 2)
assert.equal(projection.tasks.find((item) => item.id === researcher.id)?.error?.retryDisposition, 'never_retry')
assert.equal(projection.artifacts.length, 2)
assert(projection.artifacts.some((item) => item.artifactKind === 'comparison_report'))
assert(projection.artifacts.some((item) => item.artifactId.startsWith('observation-browser_open')))
assert.equal(projection.activities.at(-1)?.level, 'done')
assert.equal(JSON.stringify(projection).includes('session_artifacts'), false)
assert.equal(JSON.stringify(projection).includes('idempotency-secret'), false)
assert.equal(JSON.stringify(projection).includes('Internal envelope'), false)

console.log('collaboration-projection-test: PASS')

function task({ id, roleId, title, status, error, outputs = [] }) {
  return {
    schemaVersion: 'agent-task/v2',
    id,
    kind: roleId === 'researcher' ? 'candidate_job_research' : 'trace_summarization',
    accessMode: 'read_only',
    capacityClass: 'read_only_llm',
    title,
    priority: 0,
    blockedBy: [],
    blocks: [],
    inputs: [{
      kind: 'goal',
      structuredValue: createBuiltInRoleTaskMetadata({ roleId, goal: title }),
    }],
    outputs,
    attempts: [],
    actionBinding: { kind: 'not_action_bound' },
    idempotency: {
      schemaVersion: 'agent-task-idempotency/v1',
      scope: 'session',
      key: 'idempotency-secret',
      canonicalization: 'web-buddy-task-input-jcs/v1',
      digestAlgorithm: 'sha256',
      inputDigest: '0'.repeat(64),
    },
    attempt: 1,
    maxAttempts: 2,
    timeoutMs: 120000,
    leaseDurationMs: 150000,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:01:00.000Z',
    requiredForCompletion: false,
    terminalPolicy: 'does_not_block',
    ...(error ? { lastError: { schemaVersion: 'async-task-contract-error/v1', occurredAt: '2026-08-14T00:01:00.000Z', ...error } } : {}),
    status,
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function output(artifactId, artifactKind) {
  return {
    schemaVersion: 'agent-task-output/v1',
    outputId: `output-${artifactId}`,
    kind: 'artifact_ref',
    artifactRef: artifactRef(artifactId, artifactKind),
    attempt: 1,
    leaseId: 'lease-1',
    freshness: { kind: 'not_action_bound', validity: 'not_applicable' },
    appendToMainTranscript: false,
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function artifact(artifactId, artifactKind, summary) {
  return {
    schemaVersion: 'session-artifact-record/v1',
    ref: artifactRef(artifactId, artifactKind),
    summary,
    sensitivity: 'user',
  }
}

function artifactRef(artifactId, artifactKind) {
  return {
    schemaVersion: 'immutable-artifact-ref/v1',
    artifactId,
    artifactKind,
    runId: 'run-ui-collaboration',
    sessionId: 'session-ui-collaboration',
    storage: { store: 'session_artifacts', relativeSegments: ['hidden', `${artifactId}.json`] },
    mediaType: 'application/json',
    byteLength: 120,
    sha256: '1'.repeat(64),
    createdAt: '2026-08-14T00:02:00.000Z',
    actionBinding: { kind: 'not_action_bound' },
    immutable: true,
  }
}

function event(eventId, eventSeq, eventType, taskId) {
  return {
    schemaVersion: 'agent-task-event/v1',
    eventId,
    eventSeq,
    eventType,
    taskId,
    occurredAt: `2026-08-14T00:0${eventSeq}:00.000Z`,
  }
}
