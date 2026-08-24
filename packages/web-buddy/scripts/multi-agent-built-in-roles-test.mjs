#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUILT_IN_AGENT_ROLE_IDS,
  createBuiltInRoleTaskMetadata,
  getBuiltInAgentRole,
  getBuiltInRoleRuntimeBinding,
  listBuiltInAgentRoles,
  parseBuiltInRoleTaskMetadata,
  toBuiltInRoleEnvelopeBinding,
  validateBuiltInRoleOutputPayload,
} from '../src/agents/built-in-roles.ts'
import { validateMultiAgentRole } from '../src/agents/multi-agent-contracts.ts'
import { createRoleScopedContextCatalog } from '../src/agents/context-catalog.ts'
import { AsyncTaskRuntime } from '../src/agents/async-task-runtime.ts'
import { FileTaskGraphStore } from '../src/agents/task-graph-store.ts'
import { AgentTaskScheduler } from '../src/agents/task-scheduler.ts'
import { RunnerRegistry } from '../src/agents/runner-registry.ts'
import { TaskNotificationQueue } from '../src/agents/task-notification-queue.ts'
import { createLocalTools } from '../src/tools/local-adapter.ts'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-m4-a2-'))
const sessionId = 'session-m4-a2'
const runId = 'run-m4-a2'

try {
  const roles = listBuiltInAgentRoles()
  assert.deepEqual(roles.map((role) => role.id), [...BUILT_IN_AGENT_ROLE_IDS])
  for (const role of roles) {
    validateMultiAgentRole(role)
    assert(['read_only', 'recommend_only'].includes(role.authority))
    assert.equal(role.browserWrite, false)
    assert.equal(role.livePageAccess, false)
    assert.equal(role.canResolveApproval, false)
    assert.equal(role.canWriteMemory, false)
    assert.equal(role.authoritativeCompletionEvidence, false)
    assert.equal(role.requiresMainWorkflowVerification, true)
    assert(role.allowedTools.every((tool) => tool.startsWith('artifact_')))
    assert(role.outputArtifactContracts.every((contract) => (
      contract.allowedOrigins?.length === 1
      && contract.allowedOrigins[0] === 'subagent'
      && contract.allowedTrust?.length === 1
      && contract.allowedTrust[0] === 'non_authoritative'
      && contract.lineage === 'at_least_one_current_input'
    )))
  }

  validateBuiltInRoleOutputPayload('form-planner', { fields: [], unknowns: [], warnings: [] })
  validateBuiltInRoleOutputPayload('safety-reviewer', { verdict: 'ask', reasons: [], reviewedActionIds: [] })
  validateBuiltInRoleOutputPayload('verification', { assessment: 'unverified', evidenceIds: [], gaps: [] })
  assert.throws(
    () => validateBuiltInRoleOutputPayload('safety-reviewer', { verdict: 'approved', reasons: [], reviewedActionIds: [] }),
    /allow, ask, or deny/,
  )

  const metadata = createBuiltInRoleTaskMetadata({
    roleId: 'researcher',
    goal: 'Compare immutable source facts.',
    requestedArtifactIds: ['page-current'],
  })
  assert.deepEqual(parseBuiltInRoleTaskMetadata(metadata), metadata)
  assert.throws(
    () => parseBuiltInRoleTaskMetadata({ ...metadata, roleDigest: '0'.repeat(64) }),
    /does not match/,
  )

  const roleBinding = getBuiltInRoleRuntimeBinding('researcher')
  const scoped = createRoleScopedContextCatalog({
    role: roleBinding.role,
    runtimeTaskKind: roleBinding.runtimeTaskKind,
    parentRunId: runId,
    parentSessionId: sessionId,
    catalogRevision: 3,
    candidates: [
      catalogCandidate('admitted', ['candidate_job_research']),
      catalogCandidate('foreign-kind', ['trace_summarization']),
    ],
  })
  assert.equal(scoped.roleId, 'researcher')
  assert.equal(scoped.roleDigest, roleBinding.roleDigest)
  assert.equal(scoped.catalog.items.filter((item) => item.availability === 'selectable').length, 1)
  assert.equal(scoped.catalog.items.filter((item) => item.availability === 'denied'
    && item.deniedReason === 'capability_denied').length, 1)
  assert(scoped.catalog.items.every((item) => (
    item.allowedTaskKinds.length === 1 && item.allowedTaskKinds[0] === 'candidate_job_research'
  )))

  const envelopeRequests = []
  const runtime = createRuntime({
    rootDir: join(root, 'runtime'),
    envelopeRequests,
  })
  await runtime.initialize()

  for (const roleId of BUILT_IN_AGENT_ROLE_IDS) {
    const resolution = await runtime.spawnBuiltInRole({
      taskId: `role-${roleId}`,
      roleId,
      title: `Run ${roleId}`,
      goal: `Return the bounded ${roleId} artifact.`,
      requestedArtifactIds: ['page-current'],
      idempotencyKey: `role:${roleId}:v1`,
      actionBinding: { kind: 'browser_action', sourceActionSeq: 0 },
    })
    assert.equal(resolution.outcome, 'created')
    const projected = await runtime.status(`role-${roleId}`)
    assert.equal(projected.roleId, roleId)
    assert.notEqual(projected.kind, 'main_browser_step')
  }

  for (const roleId of BUILT_IN_AGENT_ROLE_IDS) {
    const terminal = await waitUntilTerminal(runtime, `role-${roleId}`)
    assert.equal(terminal.status, 'completed')
    const result = await runtime.result(`role-${roleId}`)
    assert.equal(result.roleId, roleId)
    assert(result.outputRefs.some((ref) => (
      ref.artifactKind === getBuiltInRoleRuntimeBinding(roleId).output.artifactKind
    )))
    assert.equal(result.requiresMainWorkflowVerification, true)
    assert.equal(result.authoritativeCompletionEvidence, false)
  }
  assert.equal(envelopeRequests.length, BUILT_IN_AGENT_ROLE_IDS.length)
  for (const request of envelopeRequests) {
    assert(request.builtInRole)
    assert.equal(request.builtInRole.runtimeTaskKind, request.task.kind)
    assert.equal(request.builtInRole.role.browserWrite, false)
    assert.equal(request.builtInRole.role.livePageAccess, false)
    assert(request.builtInRole.role.allowedTools.every((tool) => tool.startsWith('artifact_')))
  }

  const spawnTool = createLocalTools().find((tool) => tool.name === 'agent_task_spawn')
  assert(spawnTool)
  assert.deepEqual(spawnTool.parameters.properties.roleId.enum, [...BUILT_IN_AGENT_ROLE_IDS])
  assert.equal(spawnTool.parameters.required.includes('kind'), false)
  const toolResult = await spawnTool.run({
    roleId: 'planner',
    title: 'Plan safely',
    goal: 'Return a plan only.',
    idempotencyKey: 'tool-planner:v1',
  }, { asyncTaskRuntime: runtime })
  assert.match(toolResult.observation, /agent_task_spawn: created/)
  const toolTaskId = toolResult.data.task.id
  assert.equal((await runtime.status(toolTaskId)).roleId, 'planner')
  assert.equal((await waitUntilTerminal(runtime, toolTaskId)).status, 'completed')

  const forged = await spawnTool.run({
    roleId: 'planner',
    kind: 'candidate_job_research',
    title: 'Conflicting authority route',
    goal: 'Should fail.',
    idempotencyKey: 'tool-conflict:v1',
  }, { asyncTaskRuntime: runtime })
  assert.match(forged.observation, /FAILED \(POLICY_VIOLATION\)/)

  const deniedRuntime = createRuntime({
    rootDir: join(root, 'denied-runtime'),
    envelopeRequests: [],
    mutateEnvelope: (envelope) => ({ ...envelope, allowedTools: [...envelope.allowedTools, 'browser_click'] }),
  })
  await deniedRuntime.initialize()
  await assert.rejects(
    deniedRuntime.spawnBuiltInRole({
      roleId: 'researcher',
      title: 'Attempt browser escalation',
      goal: 'Should fail before task commit.',
      idempotencyKey: 'denied-role:v1',
    }),
    (error) => error?.code === 'CONTEXT_POLICY_VIOLATION',
  )
  assert.equal((await deniedRuntime.snapshot()).tasks.length, 0)

  await runtime.abortSession()
  await deniedRuntime.abortSession()
  console.log('multi-agent-built-in-roles-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

function createRuntime({ rootDir, envelopeRequests, mutateEnvelope = (value) => value }) {
  const store = new FileTaskGraphStore({ rootDir })
  const notifications = new TaskNotificationQueue()
  const runner = {
    contractVersion: 'agent-task-runner/v1',
    runnerId: 'm4-a2-read-only-runner',
    runnerVersion: '1.0.0',
    kinds: ['candidate_job_research', 'trace_summarization'],
    capacityClass: 'read_only_llm',
    runnerKind: 'read_only_llm',
    async run(request) {
      const role = request.contextEnvelope.builtInRole
      assert(role)
      return {
        schemaVersion: 'agent-task-run-outcome/v1',
        outcome: 'succeeded',
        result: {
          schemaVersion: 'read-only-subagent-result/v1',
          runIdentity: request.runIdentity,
          runnerId: this.runnerId,
          runnerVersion: this.runnerVersion,
          envelopeId: request.contextEnvelope.envelopeId,
          sourceGraphRevision: request.contextEnvelope.sourceGraphRevision,
          freshness: request.task.actionBinding.kind === 'browser_action'
            ? {
                kind: 'assessed',
                sourceActionSeq: request.task.actionBinding.sourceActionSeq,
                assessedAgainstActionSeq: request.task.actionBinding.sourceActionSeq,
                validity: 'unverified',
              }
            : { kind: 'not_action_bound', validity: 'not_applicable' },
          summary: 'Advisory role output.',
          recommendations: [],
          evidenceRefs: [],
          uncertainties: [],
          roleOutput: {
            schemaVersion: 'built-in-role-output/v1',
            roleId: role.roleId,
            roleVersion: role.roleVersion,
            roleDigest: role.roleDigest,
            artifactKind: role.outputArtifactKind,
            payloadSchemaVersion: role.outputPayloadSchemaVersion,
            payload: rolePayload(role.roleId),
            requiresMainWorkflowVerification: true,
            authoritativeCompletionEvidence: false,
          },
          sidechainTranscriptRef: artifactRef(
            `sidechain-${request.task.id}`,
            'sidechain_transcript',
            request.task.actionBinding,
          ),
          requiresMainWorkflowVerification: true,
          authoritativeCompletionEvidence: false,
        },
      }
    },
  }
  const registry = new RunnerRegistry([runner])
  return new AsyncTaskRuntime({
    sessionId,
    runId,
    store,
    notifications,
    scheduler: (bindings) => new AgentTaskScheduler({
      store,
      notifications,
      registry,
      ...bindings,
      materializeLlmResult: (outcome, task) => ({
        outputRefs: [
          artifactRef(
            `role-output-${outcome.result.runIdentity.taskId}`,
            outcome.result.roleOutput.artifactKind,
            task.actionBinding,
          ),
          outcome.result.sidechainTranscriptRef,
        ],
        freshness: outcome.result.freshness,
      }),
    }),
    contextEnvelopeProvider: async (request) => {
      envelopeRequests.push(structuredClone(request))
      const envelope = contextEnvelope(request)
      return {
        envelope: mutateEnvelope(envelope),
        artifactRef: artifactRef(`envelope-${request.task.id}`, 'context_envelope', request.task.actionBinding),
      }
    },
    defaultTimeoutMs: 2_000,
    defaultLeaseDurationMs: 3_000,
    maxWaitMs: 500,
  })
}

function contextEnvelope(request) {
  const role = request.builtInRole?.role
  assert(role, 'role-aware spawn must bind a built-in role into the Context Envelope request')
  return {
    schemaVersion: 'subagent-context-envelope/v1',
    envelopeId: `envelope-${request.task.id}`,
    taskId: request.task.id,
    taskKind: request.task.kind,
    parentRunId: runId,
    parentSessionId: sessionId,
    createdAt: new Date().toISOString(),
    sourceGraphRevision: request.graph.revision,
    currentActionBinding: request.task.actionBinding,
    objective: projection(request.task.title),
    outputSchemaRef: artifactRef(`schema-${request.task.id}`, 'schema', request.task.actionBinding),
    builtInRole: toBuiltInRoleEnvelopeBinding(request.builtInRole),
    selectorPolicyVersion: 'context-selector-policy/v1',
    catalogManifest: {
      schemaVersion: 'context-catalog-manifest/v1',
      catalogRevision: request.graph.revision,
      catalogDigest: sha256('[]'),
      canonicalization: 'context-catalog-item-ids-jcs/v1',
      candidateItemIds: [],
      candidateCount: 0,
    },
    allowedTools: [...role.allowedTools],
    authorityBoundary: {
      browserWrite: false,
      livePageAccess: false,
      authoritativeCompletionEvidence: false,
      requiresMainWorkflowVerification: true,
      gates: { login: false, captcha: false, upload: false, save: false, finalSubmit: false },
    },
    sensitiveDisclosureGrants: [],
    selectedContext: [],
    omittedContext: [],
    tokenBudget: {
      estimator: 'web-buddy-token-estimator/v1',
      maxInputTokens: 2_000,
      fixedEnvelopeTokens: 100,
      selectedContextTokens: 0,
      usedInputTokens: 100,
      reservedOutputTokens: 500,
    },
    parentHistoryIncluded: false,
  }
}

function catalogCandidate(id, allowedTaskKinds) {
  return {
    provenance: {
      kind: 'workflow',
      workflowId: `workflow-${id}`,
      workflowRunId: runId,
      stateRevision: 1,
      evidenceRefs: [],
      actionBinding: { kind: 'not_action_bound' },
    },
    sensitivity: 'public',
    allowedTaskKinds,
    tokenEstimate: 12,
    retention: 'structured_state',
    actionBinding: { kind: 'not_action_bound' },
    relevanceTerms: [id],
    content: {
      kind: 'context_unit',
      unit: {
        kind: 'structured_projection',
        projectionKind: 'workflow_state',
        sanitizedSummary: projection(id),
        evidenceRefs: [],
      },
    },
  }
}

function projection(text) {
  return {
    schemaVersion: 'sanitized-text-projection/v1',
    text,
    projectionPolicy: 'no_react_history/v1',
    sourceArtifactRefs: [],
    sourceItemCount: 0,
    maxChars: 1_000,
    contentDigest: sha256(text),
  }
}

function rolePayload(roleId) {
  switch (roleId) {
    case 'planner': return { steps: [], assumptions: [], blockers: [] }
    case 'researcher': return { findings: [], sources: [], uncertainties: [] }
    case 'comparison': return { criteria: [], comparisons: [], recommendation: '' }
    case 'form-planner': return { fields: [], unknowns: [], warnings: [] }
    case 'safety-reviewer': return { verdict: 'ask', reasons: [], reviewedActionIds: [] }
    case 'verification': return { assessment: 'unverified', evidenceIds: [], gaps: [] }
    default: throw new Error(`Unknown role ${roleId}`)
  }
}

function artifactRef(artifactId, artifactKind, actionBinding = { kind: 'not_action_bound' }) {
  const bytes = Buffer.from(`${artifactKind}:${artifactId}`)
  return {
    schemaVersion: 'immutable-artifact-ref/v1',
    artifactId,
    artifactKind,
    runId,
    sessionId,
    storage: { store: 'session_artifacts', relativeSegments: [artifactKind, `${artifactId}.json`] },
    mediaType: 'application/json',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: new Date().toISOString(),
    actionBinding,
    immutable: true,
  }
}

async function waitUntilTerminal(runtime, taskId) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const task = await runtime.status(taskId)
    if (['completed', 'failed', 'killed'].includes(task.status)) return task
    await runtime.tick()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Task ${taskId} did not become terminal.`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
