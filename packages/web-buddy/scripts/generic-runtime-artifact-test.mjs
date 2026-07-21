#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebTaskRuntimeDriver } from '../dist/sdk/web-task.js'
import { loadConfig } from '../dist/sdk/config.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-generic-runtime-artifact-'))

try {
  const config = loadConfig()
  config.model.apiKey = null
  config.model.authToken = null
  config.trace.outDir = root
  const ownerScope = {
    schemaVersion: 'owner-scope/v1',
    tenantId: 'artifact-test-tenant',
    userId: 'artifact-test-user',
  }
  const sessionRef = {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: 'generic-runtime-artifact-session',
    runId: 'generic-runtime-artifact-run',
    attempt: 1,
  }
  const snapshot = snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId: sessionRef.runId,
    revision: 4,
    sessionRef,
    ownerScope,
    goal: { instruction: 'Produce an auditable generic runtime result.' },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'generic-runtime-artifact-contract',
      revision: 4,
      criteria: [noSubmitCriterion()],
    },
  })
  const request = {
    schemaVersion: 'web-task-runtime-request/v1',
    input: snapshot,
    contextItems: [],
    emit() {},
  }

  const blocked = await createWebTaskRuntimeDriver({ config }).execute(request)
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.artifacts.length, 1)
  await assertRuntimeArtifact(blocked.artifacts[0], {
    root,
    runId: snapshot.runId,
    revision: snapshot.revision,
    status: 'blocked',
    summary: blocked.summary,
    sessionRef,
    ownerScope,
  })

  const failedRunId = 'generic-runtime-artifact-failed-run'
  const failedSessionRef = { ...sessionRef, id: 'generic-runtime-artifact-failed-session', runId: failedRunId }
  const failedSnapshot = snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId: failedRunId,
    revision: 7,
    sessionRef: failedSessionRef,
    ownerScope,
    goal: { instruction: 'Reject unsafe recovery setup.' },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'generic-runtime-artifact-failed-contract',
      revision: 7,
      criteria: [noSubmitCriterion()],
    },
  })
  const failed = await createWebTaskRuntimeDriver({ config }).execute({
    ...request,
    input: failedSnapshot,
    runtime: {
      executionContext: {
        schemaVersion: 'run-execution-context/v1',
        runRevision: 8,
        attempt: 2,
        sessionRef: { ...failedSessionRef, attempt: 2 },
        recoveryMode: 'read_only_reobserve/v1',
      },
    },
  })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.artifacts.length, 1)
  await assertRuntimeArtifact(failed.artifacts[0], {
    root,
    runId: failedSnapshot.runId,
    revision: failedSnapshot.revision,
    status: 'failed',
    summary: failed.summary,
    sessionRef: { ...failedSessionRef, attempt: 2 },
    ownerScope,
  })

  const model = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: 'The generic runtime is complete.',
          tool_calls: [{
            id: 'generic-runtime-artifact-done',
            type: 'function',
            function: {
              name: 'agent_done',
              arguments: JSON.stringify({ summary: 'Generic runtime completed.', blocked: false }),
            },
          }],
        },
      }],
    }))
  })
  try {
    await listen(model)
    const completedRunId = 'generic-runtime-artifact-completed-run'
    const completedConfig = structuredClone(config)
    completedConfig.model.apiKey = 'fixture-model-key'
    completedConfig.model.baseUrl = `http://127.0.0.1:${model.address().port}`
    completedConfig.agent.maxSteps = 1
    const completedSnapshot = snapshotWebTaskInput({
      schemaVersion: 'web-task-input/v1',
      runId: completedRunId,
      revision: 2,
      ownerScope,
      goal: { instruction: 'Complete without submitting.' },
      contract: {
        schemaVersion: 'web-task-contract/v1',
        contractId: 'generic-runtime-artifact-completed-contract',
        revision: 2,
        criteria: [noSubmitCriterion()],
      },
    })
    const completed = await createWebTaskRuntimeDriver({ config: completedConfig }).execute({
      ...request,
      input: completedSnapshot,
    })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.artifacts.length, 1)
    await assertRuntimeArtifact(completed.artifacts[0], {
      root,
      runId: completedSnapshot.runId,
      revision: completedSnapshot.revision,
      status: 'completed',
      summary: completed.summary,
      sessionRef: completed.sessionRef,
      ownerScope,
    })
  } finally {
    await new Promise((resolve, reject) => model.close((error) => error ? reject(error) : resolve()))
  }

  console.log('generic-runtime-artifact-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function assertRuntimeArtifact(ref, expected) {
  assert.equal(ref.schemaVersion, 'artifact-ref/v1')
  assert.equal(ref.kind, 'runtime_outcome')
  assert.equal(ref.payloadSchemaVersion, 'generic-runtime-outcome/v1')
  assert.equal(ref.requiresMainWorkflowVerification, true)
  assert.equal(ref.authoritativeCompletionEvidence, false)
  assert.deepEqual(ref.binding, {
    runId: expected.runId,
    revision: expected.revision,
    ...(expected.sessionRef ? { sessionRef: expected.sessionRef } : {}),
  })
  assert.deepEqual(ref.ownerScope, expected.ownerScope)

  assert.equal(ref.locator, `artifact:${ref.id}`)
  const sessionId = expected.sessionRef?.id ?? `web-task-${expected.runId}`
  const path = join(
    expected.root,
    'traces',
    `run_${expected.runId}`,
    'artifacts',
    'tool-results',
    sessionId,
    expected.runId,
    `${ref.id}.json`,
  )
  const envelope = JSON.parse(await readFile(path, 'utf8'))
  const bytes = Buffer.from(JSON.stringify(envelope.content))
  assert.equal(ref.byteLength, bytes.length)
  assert.equal(ref.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(envelope.content, {
    schemaVersion: 'generic-runtime-outcome/v1',
    runId: expected.runId,
    revision: expected.revision,
    status: expected.status,
    summary: expected.summary,
    actions: [{ actionKind: 'submit', outcome: 'not_performed' }],
    ...(expected.sessionRef ? { sessionRef: expected.sessionRef } : {}),
  })
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function noSubmitCriterion() {
  return {
    id: 'no-submit',
    kind: 'action_boundary',
    description: 'The generic runtime must not submit.',
    actionKinds: ['submit'],
    outcome: 'not_performed',
  }
}
