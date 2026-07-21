#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emptyRunMetrics } from '../dist/metrics/schema.js'
import { runWebTask } from '../dist/sdk/web-task.js'
import { observeCompletedWebTaskResult } from '../dist/skills/candidates/index.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-skill-learning-observer-'))
const previousFlag = process.env.WEB_BUDDY_SKILL_LEARNING_ENABLED
const previousRoot = process.env.WEB_BUDDY_SKILL_CANDIDATE_ROOT

try {
  process.env.WEB_BUDDY_SKILL_CANDIDATE_ROOT = join(root, 'candidate-plane')

  const disabledTrace = await traceDirectory('disabled')
  delete process.env.WEB_BUDDY_SKILL_LEARNING_ENABLED
  const disabled = await runCompletedTask('observer-disabled', disabledTrace)
  assert.equal(disabled.status, 'completed')
  assert.equal((await requestFiles(disabledTrace)).length, 0)
  const configuredSkillRoot = join(root, 'configured-project-skills')
  await assert.rejects(
    observeCompletedWebTaskResult(disabled, {
      env: {
        WEB_BUDDY_SKILL_LEARNING_ENABLED: 'true',
        WEB_BUDDY_SKILL_CANDIDATE_ROOT: join(configuredSkillRoot, 'candidates'),
        WEB_BUDDY_PROJECT_SKILL_ROOTS: configuredSkillRoot,
      },
    }),
    /CANDIDATE_STORE_OVERLAPS_SKILL_ROOT/,
  )

  const enabledTrace = await traceDirectory('enabled')
  process.env.WEB_BUDDY_SKILL_LEARNING_ENABLED = 'true'
  const enabled = await runCompletedTask('observer-enabled', enabledTrace)
  assert.equal(enabled.status, 'completed')
  const enabledRequests = await requestFiles(enabledTrace)
  assert.equal(enabledRequests.length, 1)
  const request = JSON.parse(await readFile(join(
    enabledTrace,
    'skill-learning',
    'requests',
    enabledRequests[0],
  ), 'utf8'))
  assert.equal(request.schemaVersion, 'skill-generation-request/v1')
  assert.equal(request.runId, enabled.runId)
  assert.equal(request.revision, enabled.revision)
  assert.equal(request.sessionId, `run_${enabled.runId}`)
  assert.equal(request.traceSessionId, `run_${enabled.runId}`)
  assert.equal(request.attempt, 1)
  assert.equal(request.resultStatus, 'completed')
  assert.equal(request.requestedScope, 'project')
  assert.equal('goal' in request, false)
  assert.equal('summary' in request, false)
  assert.equal('ownerScope' in request, false)
  assert.equal('traceDir' in request, false)
  assert.match(request.requestId, /^request_[a-f0-9]{24}$/)
  const repeated = await Promise.all([
    observeCompletedWebTaskResult(enabled, {
      env: process.env,
      now: () => new Date('2099-01-01T00:00:00.000Z'),
    }),
    observeCompletedWebTaskResult(enabled, {
      env: process.env,
      now: () => new Date('2099-01-01T00:00:01.000Z'),
    }),
  ])
  assert(repeated.every((observation) => observation.status === 'persisted'))
  assert.equal((await requestFiles(enabledTrace)).length, 1)

  const blockedTrace = await traceDirectory('blocked')
  const blocked = await runCompletedTask('observer-outer-blocked', blockedTrace, {
    missingCompletionEvidence: true,
  })
  assert.equal(blocked.status, 'blocked')
  assert.equal((await requestFiles(blockedTrace)).length, 0)

  const missingTraceDir = join(root, 'missing-trace')
  const failOpen = await runCompletedTask('observer-fail-open', missingTraceDir)
  assert.equal(failOpen.status, 'completed')

  const scopedTrace = await traceDirectory('owner-scoped')
  const ownerScoped = await runCompletedTask('observer-owner-scoped', scopedTrace, {
    ownerScope: {
      schemaVersion: 'owner-scope/v1',
      tenantId: 'tenant-one',
      userId: 'user-one',
    },
  })
  assert.equal(ownerScoped.status, 'completed')
  assert.equal((await requestFiles(scopedTrace)).length, 0)

  const durableTrace = await traceDirectory('durable')
  const durableSessionRef = {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: 'observer-durable-session',
    runId: 'observer-durable',
    attempt: 3,
  }
  const durable = await runCompletedTask('observer-durable', durableTrace, {
    sessionRef: durableSessionRef,
    includePriorAttemptOutcome: true,
  })
  assert.equal(durable.status, 'completed')
  const durableRequestFile = (await requestFiles(durableTrace))[0]
  const durableRequest = JSON.parse(await readFile(join(
    durableTrace,
    'skill-learning',
    'requests',
    durableRequestFile,
  ), 'utf8'))
  assert.equal(durableRequest.sessionId, durableSessionRef.id)
  assert.equal(durableRequest.traceSessionId, `run_${durable.runId}`)
  assert.equal(durableRequest.attempt, 3)
  assert.equal(durableRequest.outcomeArtifactId, `outcome-${durable.runId}-current`)

  console.log('skill-learning-observer-test: PASS')
} finally {
  if (previousFlag === undefined) delete process.env.WEB_BUDDY_SKILL_LEARNING_ENABLED
  else process.env.WEB_BUDDY_SKILL_LEARNING_ENABLED = previousFlag
  if (previousRoot === undefined) delete process.env.WEB_BUDDY_SKILL_CANDIDATE_ROOT
  else process.env.WEB_BUDDY_SKILL_CANDIDATE_ROOT = previousRoot
  await rm(root, { recursive: true, force: true })
}

async function runCompletedTask(runId, traceDir, options = {}) {
  const revision = 2
  const traceSessionId = `run_${runId}`
  const sessionRef = options.sessionRef
  const artifact = runtimeOutcomeArtifact({
    runId,
    revision,
    sessionRef,
    ownerScope: options.ownerScope,
    artifactId: options.includePriorAttemptOutcome ? `outcome-${runId}-current` : undefined,
  })
  const artifacts = options.includePriorAttemptOutcome
    ? [
        runtimeOutcomeArtifact({
          runId,
          revision,
          sessionRef: { ...sessionRef, attempt: sessionRef.attempt - 1 },
          ownerScope: options.ownerScope,
          artifactId: `outcome-${runId}-prior`,
          sha256: 'b'.repeat(64),
        }),
        artifact,
      ]
    : [artifact]
  return runWebTask({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision,
    goal: { instruction: 'Complete the observer fixture.' },
    contract: options.missingCompletionEvidence
      ? {
          schemaVersion: 'web-task-contract/v1',
          contractId: `${runId}-contract`,
          revision,
          criteria: [{
            id: 'page-evidence',
            kind: 'evidence_present',
            description: 'Observe a page.',
            evidenceKinds: ['page'],
            minCount: 1,
            allowedAuthorities: ['main_runtime'],
          }],
        }
      : {
          schemaVersion: 'web-task-contract/v1',
          contractId: `${runId}-contract`,
          revision,
          criteria: [{
            id: 'no-submit',
            kind: 'action_boundary',
            description: 'Do not submit.',
            actionKinds: ['submit'],
            outcome: 'not_performed',
          }],
        },
    ...(options.ownerScope ? { ownerScope: options.ownerScope } : {}),
    ...(sessionRef ? { sessionRef } : {}),
    runtime: {
      ...(sessionRef
        ? {
            executionContext: {
              schemaVersion: 'run-execution-context/v1',
              runRevision: revision,
              attempt: sessionRef.attempt,
              sessionRef,
            },
          }
        : {}),
      driver: {
        async execute() {
          return {
            status: 'completed',
            summary: 'Observer fixture completed.',
            evidence: [],
            artifacts,
            actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
            metrics: {
              ...emptyRunMetrics({
                runId,
                sessionId: traceSessionId,
                traceDir,
                source: 'sdk',
                scenario: 'observer-fixture',
              }),
              status: 'completed',
            },
            ...(sessionRef ? { sessionRef } : {}),
          }
        },
      },
    },
  })
}

function runtimeOutcomeArtifact({ runId, revision, sessionRef, ownerScope, artifactId, sha256 }) {
  const id = artifactId ?? `outcome-${runId}`
  return {
    schemaVersion: 'artifact-ref/v1',
    id,
    kind: 'runtime_outcome',
    payloadSchemaVersion: 'generic-runtime-outcome/v1',
    mediaType: 'application/json',
    byteLength: 128,
    sha256: sha256 ?? 'a'.repeat(64),
    createdAt: '2026-07-21T09:30:00.000Z',
    immutable: true,
    locator: `artifact:${id}`,
    producer: { id: 'generic-runtime', version: '1' },
    parentEvidenceIds: [],
    parentArtifactIds: [],
    origin: 'artifact',
    trust: 'non_authoritative',
    sensitivity: ownerScope ? 'personal' : 'internal',
    retention: { scope: 'run', deleteWithSession: true },
    ...(ownerScope ? { ownerScope } : {}),
    binding: {
      runId,
      revision,
      ...(sessionRef ? { sessionRef } : {}),
    },
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
    redaction: { status: 'not_required', policyId: 'runtime-persistence-boundary/v1' },
    scanner: { status: 'not_scanned', scannerId: 'not-configured' },
  }
}

async function traceDirectory(name) {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return path
}

async function requestFiles(traceDir) {
  try {
    return (await readdir(join(traceDir, 'skill-learning', 'requests')))
      .filter((name) => name.endsWith('.json'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}
