#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const fixtureUrl = new URL('./fixtures/security/m4-a2-security.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))
if (fixture.schemaVersion !== 'security-m4-a2/v1') {
  throw new Error(`Unsupported M4-A2 fixture schema: ${String(fixture.schemaVersion)}`)
}

const useSource = process.env.WEB_BUDDY_TEST_SOURCE === '1'
if (useSource) await installSourceResolver()
const a1DistUrl = new URL('../dist/agents/multi-agent-contracts.js', import.meta.url)
const a1SourceUrl = new URL('../src/agents/multi-agent-contracts.ts', import.meta.url)
const a1 = await import(useSource || !existsSync(a1DistUrl) ? a1SourceUrl : a1DistUrl)
const a2Url = resolveA2ModuleUrl()
if (!a2Url) {
  console.error(
    'security-m4-a2-test: A2_TEST_DEPENDENCY_MISSING — export the built-in role registry from one documented candidate module or set WEB_BUDDY_A2_MODULE.',
  )
  process.exit(2)
}
const a2 = await import(a2Url)

const {
  AGENT_INVOCATION_RESULT_SCHEMA_VERSION,
  MultiAgentContractError,
  multiAgentDigest,
  sealAgentContextEnvelope,
  validateAgentInvocationResult,
  validateMultiAgentRole,
} = a1

const results = []
const registry = extractRoleRegistry(a2)
const roles = registry.list()
check('A2 exposes a scheduler runtime binding', () => {
  assert.equal(typeof a2.getBuiltInRoleRuntimeBinding, 'function')
})
check('A2 exposes closed task metadata creation/parsing', () => {
  assert.equal(typeof a2.createBuiltInRoleTaskMetadata, 'function')
  assert.equal(typeof a2.parseBuiltInRoleTaskMetadata, 'function')
})
check('A2 exposes role output payload validation', () => {
  assert.equal(typeof a2.validateBuiltInRoleOutputPayload, 'function')
})
const expectedRoleIds = fixture.roles.map((role) => role.id).sort()
check('registry exposes exactly the six A2 roles', () => {
  assert.deepEqual(roles.map((role) => role.id).sort(), expectedRoleIds)
})

for (const expected of fixture.roles) {
  const role = roles.find((candidate) => candidate.id === expected.id)
  check(`${expected.id}: role exists`, () => assert(role))
  if (!role) continue

  check(`${expected.id}: role contract validates`, () => validateMultiAgentRole(role))
  check(`${expected.id}: registry authority is immutable across caller mutation`, () => {
    const probe = registry.list().find((candidate) => candidate.id === expected.id)
    assert(probe)
    const expectedDigest = multiAgentDigest(probe)
    if (Object.isFrozen(probe)) {
      assertDeepFrozen(probe, expected.id)
    } else {
      probe.browserWrite = true
      probe.allowedTools.push('browser_click')
    }
    const reloaded = registry.list().find((candidate) => candidate.id === expected.id)
    assert(reloaded)
    assert.equal(reloaded.browserWrite, false)
    assert(!reloaded.allowedTools.includes('browser_click'))
    assert.equal(multiAgentDigest(reloaded), expectedDigest)
  })
  check(`${expected.id}: required bounded capability`, () => {
    assert(role.capabilities.includes(expected.requiredCapability))
  })
  check(`${expected.id}: required output Artifact kind`, () => {
    assert(role.outputArtifactContracts.some((contract) => contract.artifactKinds.includes(expected.requiredOutputKind)))
  })
  check(`${expected.id}: Main Agent remains sole Browser/decision writer`, () => {
    assert(['read_only', 'recommend_only'].includes(role.authority))
    assert.equal(role.livePageAccess, false)
    assert.equal(role.browserWrite, false)
    assert.equal(role.canResolveApproval, false)
    assert.equal(role.canWriteMemory, false)
    assert.equal(role.authoritativeCompletionEvidence, false)
    assert.equal(role.requiresMainWorkflowVerification, true)
    assert(role.allowedTools.every((tool) => !fixture.forbiddenTools.includes(tool)))
    assert(role.allowedTools.every((tool) => !tool.startsWith('browser_')))
  })
  check(`${expected.id}: scheduler binding stays on a read-only runner`, () => {
    const runtimeBinding = a2.getBuiltInRoleRuntimeBinding(expected.id)
    assert(fixture.allowedRuntimeTaskKinds.includes(runtimeBinding.runtimeTaskKind))
    assert.equal(runtimeBinding.roleDigest, multiAgentDigest(role))
    assert.equal(runtimeBinding.role.browserWrite, false)
    assert.equal(runtimeBinding.role.livePageAccess, false)
    assert.equal(runtimeBinding.output.artifactKind, expected.requiredOutputKind)
  })
  check(`${expected.id}: exact scheduler metadata round-trips`, () => {
    const metadata = a2.createBuiltInRoleTaskMetadata({
      roleId: expected.id,
      goal: `Run bounded ${expected.id} analysis.`,
      requestedArtifactIds: ['input-current'],
    })
    assert.deepEqual(a2.parseBuiltInRoleTaskMetadata(metadata), metadata)
  })
  expectError(
    `${expected.id}: scheduler metadata rejects role-digest escalation`,
    () => {
      const metadata = a2.createBuiltInRoleTaskMetadata({
        roleId: expected.id,
        goal: `Run bounded ${expected.id} analysis.`,
      })
      a2.parseBuiltInRoleTaskMetadata({ ...metadata, roleDigest: 'b'.repeat(64) })
    },
  )
  expectError(
    `${expected.id}: scheduler metadata rejects browser-writer remapping`,
    () => {
      const metadata = a2.createBuiltInRoleTaskMetadata({
        roleId: expected.id,
        goal: `Run bounded ${expected.id} analysis.`,
      })
      a2.parseBuiltInRoleTaskMetadata({ ...metadata, runtimeTaskKind: 'main_browser_step' })
    },
  )

  for (const [field, value] of Object.entries(fixture.forbiddenRoleFields)) {
    expectContractError(
      `${expected.id}: rejects privilege escalation through ${field}`,
      () => validateMultiAgentRole({ ...structuredClone(role), [field]: value }),
      ['AUTHORITY_VIOLATION'],
    )
  }
  expectContractError(
    `${expected.id}: rejects browser tool escalation`,
    () => validateMultiAgentRole({
      ...structuredClone(role),
      allowedTools: [...role.allowedTools, 'browser_click'],
    }),
    ['CAPABILITY_VIOLATION'],
  )

  if (expected.id === 'safety-reviewer') {
    check('safety-reviewer: ordinary advisory verdict payload validates', () => {
      a2.validateBuiltInRoleOutputPayload(expected.id, {
        verdict: 'allow',
        reasons: [],
        reviewedActionIds: [],
      })
    })
    check(
      'safety-reviewer: payload approval claim cannot alter runtime authority',
      () => assertPayloadCannotElevate(expected.id, {
        verdict: 'allow',
        reasons: [],
        reviewedActionIds: [],
        approved: true,
        approvalBinding: {
          schemaVersion: 'approval-binding/v1',
          decision: 'approved',
        },
      }),
    )
  }
  if (expected.id === 'verification') {
    check('verification: ordinary advisory assessment payload validates', () => {
      a2.validateBuiltInRoleOutputPayload(expected.id, {
        assessment: 'verified',
        evidenceIds: [],
        gaps: [],
      })
    })
    check(
      'verification: payload completion claim cannot alter runtime authority',
      () => assertPayloadCannotElevate(expected.id, {
        assessment: 'verified',
        evidenceIds: [],
        gaps: [],
        authoritativeCompletionEvidence: true,
        evidenceAuthority: 'main_runtime',
      }),
    )
  }

  const scenario = invocationScenario(role)
  check(`${expected.id}: current bound Artifact result is advisory`, () => {
    validateAgentInvocationResult(scenario.result, scenario.envelope)
    assert.equal(scenario.result.authoritativeCompletionEvidence, false)
    assert.equal(scenario.result.requiresMainWorkflowVerification, true)
    assert(scenario.result.outputArtifacts.every((artifact) =>
      artifact.origin === 'subagent'
      && artifact.trust === 'non_authoritative'
      && artifact.authoritativeCompletionEvidence === false
      && artifact.requiresMainWorkflowVerification === true))
  })

  expectContractError(
    `${expected.id}: stale Artifact revision is rejected`,
    () => validateAgentInvocationResult(
      mutateFirstOutput(scenario.result, (artifact) => ({
        ...artifact,
        binding: { ...artifact.binding, revision: scenario.binding.runRevision - 1 },
      })),
      scenario.envelope,
    ),
    ['STALE_REVISION'],
  )
  expectContractError(
    `${expected.id}: foreign-run Artifact is rejected`,
    () => validateAgentInvocationResult(
      mutateFirstOutput(scenario.result, (artifact) => ({
        ...artifact,
        binding: { ...artifact.binding, runId: 'run-foreign-a2' },
      })),
      scenario.envelope,
    ),
    ['BINDING_MISMATCH'],
  )
  expectContractError(
    `${expected.id}: foreign invocation result is rejected`,
    () => validateAgentInvocationResult({
      ...scenario.result,
      binding: { ...scenario.result.binding, invocationId: 'invocation-foreign-a2' },
    }, scenario.envelope),
    ['BINDING_MISMATCH'],
  )
  expectContractError(
    `${expected.id}: foreign producer cannot publish an Artifact`,
    () => validateAgentInvocationResult(
      mutateFirstOutput(scenario.result, (artifact) => ({
        ...artifact,
        producer: { id: 'foreign-role', version: role.version },
      })),
      scenario.envelope,
    ),
    ['BINDING_MISMATCH'],
  )
  expectContractError(
    `${expected.id}: result cannot elevate completion authority`,
    () => validateAgentInvocationResult({
      ...scenario.result,
      authoritativeCompletionEvidence: true,
    }, scenario.envelope),
    ['AUTHORITY_VIOLATION'],
  )
  expectContractError(
    `${expected.id}: output Artifact cannot elevate trust`,
    () => validateAgentInvocationResult(
      mutateFirstOutput(scenario.result, (artifact) => ({
        ...artifact,
        origin: 'system',
        trust: 'trusted_runtime',
      })),
      scenario.envelope,
    ),
    ['AUTHORITY_VIOLATION', 'ARTIFACT_CONTRACT_VIOLATION'],
  )

  expectContractError(
    `${expected.id}: scheduler rejects result after its deadline`,
    () => validateAgentInvocationResult({
      ...scenario.result,
      finishedAt: '2026-07-17T02:01:00.001Z',
    }, scenario.envelope),
    ['TIMEOUT'],
  )
  expectContractError(
    `${expected.id}: scheduler budget cannot exceed its timeout`,
    () => sealAgentContextEnvelope({
      ...unsignedEnvelope(scenario.envelope),
      budget: {
        ...scenario.envelope.budget,
        timeoutMs: 10_000,
        deadlineAt: '2026-07-17T02:01:00.000Z',
      },
    }),
    ['BUDGET_EXCEEDED'],
  )

  const cancellation = cancellationFor(scenario.binding)
  expectContractError(
    `${expected.id}: success arriving after cancellation is rejected`,
    () => validateAgentInvocationResult(scenario.result, scenario.envelope, cancellation),
    ['CANCELLED'],
  )
  check(`${expected.id}: exactly bound cancelled result is accepted`, () => {
    validateAgentInvocationResult({
      ...scenario.result,
      resultId: `${scenario.result.resultId}-cancelled`,
      outcome: 'cancelled',
      outputArtifacts: [],
      cancellationRequestId: cancellation.requestId,
    }, scenario.envelope, cancellation)
  })
  expectContractError(
    `${expected.id}: foreign cancellation cannot cancel the current invocation`,
    () => validateAgentInvocationResult(scenario.result, scenario.envelope, {
      ...cancellation,
      runRevision: scenario.binding.runRevision - 1,
    }),
    ['BINDING_MISMATCH'],
  )
}

const passed = results.filter((result) => result.status === 'PASS').length
for (const result of results) {
  console.log(`${result.status} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`)
}
console.log(`security-m4-a2-test: ${passed}/${results.length} assertions passed`)
if (passed !== results.length) process.exitCode = 1

function resolveA2ModuleUrl() {
  const override = process.env.WEB_BUDDY_A2_MODULE
  if (override) {
    return override.startsWith('file:') ? new URL(override) : pathToFileURL(resolve(override))
  }
  const extension = useSource ? 'ts' : 'js'
  const directory = useSource ? '../src/agents/' : '../dist/agents/'
  for (const candidate of fixture.moduleCandidates) {
    const url = new URL(`${directory}${candidate}.${extension}`, import.meta.url)
    if (existsSync(url)) return url
  }
  return undefined
}

function extractRoleRegistry(module) {
  for (const exportName of fixture.roleExportCandidates) {
    if (Array.isArray(module[exportName])) {
      const roles = module[exportName]
      return { list: () => roles }
    }
  }
  for (const exportName of fixture.roleListFunctionCandidates) {
    if (typeof module[exportName] === 'function') {
      const list = () => module[exportName]()
      if (Array.isArray(list())) return { list }
    }
  }
  throw new Error(
    `A2 module does not expose a role array. Expected one of: ${[
      ...fixture.roleExportCandidates,
      ...fixture.roleListFunctionCandidates,
    ].join(', ')}`,
  )
}

async function installSourceResolver() {
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
        const typescriptUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
        if (existsSync(typescriptUrl)) return { url: typescriptUrl.href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

function invocationScenario(role) {
  const runId = `run-a2-${role.id}`
  const runRevision = 12
  const binding = {
    schemaVersion: 'agent-invocation-binding/v1',
    invocationId: `invocation-a2-${role.id}`,
    taskId: `task-a2-${role.id}`,
    runId,
    runRevision,
    attempt: 2,
    parentActionSeq: 23,
    sessionRef: {
      schemaVersion: 'session-ref/v1',
      provider: 'file-session-store',
      id: `session-a2-${role.id}`,
      runId,
      attempt: 2,
    },
  }
  const inputArtifacts = artifactsForContracts(role.inputArtifactContracts, {
    role,
    binding,
    direction: 'input',
    sourceIds: [],
  })
  assert(inputArtifacts.length > 0, `${role.id} must consume at least one immutable input Artifact`)
  const envelope = sealAgentContextEnvelope({
    envelopeId: `envelope-a2-${role.id}`,
    role,
    binding,
    objective: contextItem(role.id, runId, runRevision),
    contextItems: [],
    inputArtifacts,
    allowedTools: [...role.allowedTools],
    budget: {
      schemaVersion: 'agent-execution-budget/v1',
      maxInputTokens: 4_000,
      maxOutputTokens: 1_000,
      maxTurns: 6,
      maxToolCalls: 8,
      timeoutMs: 60_000,
      deadlineAt: '2026-07-17T02:01:00.000Z',
    },
    createdAt: '2026-07-17T02:00:00.000Z',
    expiresAt: '2026-07-17T02:01:00.000Z',
    parentHistoryIncluded: false,
    livePageIncluded: false,
    browserWrite: false,
    authoritativeCompletionEvidence: false,
    requiresMainWorkflowVerification: true,
  })
  const outputArtifacts = artifactsForContracts(role.outputArtifactContracts, {
    role,
    binding,
    direction: 'output',
    sourceIds: inputArtifacts.map((artifact) => artifact.id),
  })
  assert(outputArtifacts.length > 0, `${role.id} must publish at least one advisory output Artifact`)
  const result = {
    schemaVersion: AGENT_INVOCATION_RESULT_SCHEMA_VERSION,
    resultId: `result-a2-${role.id}`,
    roleId: role.id,
    roleVersion: role.version,
    binding,
    startedAt: '2026-07-17T02:00:01.000Z',
    finishedAt: '2026-07-17T02:00:02.000Z',
    outcome: 'succeeded',
    outputArtifacts,
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
  return { binding, envelope, result }
}

function artifactsForContracts(contracts, input) {
  return contracts.flatMap((contract, contractIndex) => {
    const count = Math.max(1, contract.minCount)
    return Array.from({ length: count }, (_, artifactIndex) => {
      const id = `${input.direction}-${input.role.id}-${contractIndex}-${artifactIndex}`
      const origin = input.direction === 'output'
        ? 'subagent'
        : contract.allowedOrigins?.[0] ?? 'tool'
      const trust = input.direction === 'output'
        ? 'non_authoritative'
        : contract.allowedTrust?.[0] ?? 'untrusted_external'
      return {
        schemaVersion: 'artifact-ref/v1',
        id,
        kind: contract.artifactKinds[0],
        payloadSchemaVersion: contract.payloadSchemaVersions[0],
        mediaType: contract.mediaTypes[0],
        byteLength: 128,
        sha256: 'a'.repeat(64),
        createdAt: '2026-07-17T02:00:00.000Z',
        immutable: true,
        locator: `artifact:${id}`,
        producer: input.direction === 'output'
          ? { id: input.role.id, version: input.role.version }
          : { id: 'main-runtime', version: '1.0.0' },
        parentEvidenceIds: [],
        parentArtifactIds: input.direction === 'output'
          && (contract.lineage ?? 'at_least_one_current_input') === 'at_least_one_current_input'
          ? [...input.sourceIds]
          : [],
        origin,
        trust,
        sensitivity: 'internal',
        retention: { scope: 'run', deleteWithSession: true },
        binding: {
          runId: input.binding.runId,
          revision: input.binding.runRevision,
          sessionRef: input.binding.sessionRef,
          actionSeq: input.binding.parentActionSeq,
        },
        requiresMainWorkflowVerification: input.direction === 'output' || origin === 'subagent',
        authoritativeCompletionEvidence: false,
        redaction: { status: 'not_required', policyId: 'security-m4-a2/v1' },
        scanner: { status: 'clean', scannerId: 'security-m4-a2/v1' },
      }
    })
  })
}

function contextItem(roleId, runId, revision) {
  return {
    schemaVersion: 'context-item/v1',
    id: `objective-${roleId}`,
    kind: 'agent_objective',
    content: { task: `Produce only the bounded advisory output for ${roleId}.` },
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: 'internal',
    provenance: {
      capturedAt: '2026-07-17T02:00:00.000Z',
      parentContentIds: [],
      runId,
    },
    allowedUses: ['subagent'],
    freshness: { validity: 'current', revision },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: {
      policyId: 'security-m4-a2/v1',
      status: 'unchanged',
      redactedFields: [],
      instructionNeutralized: false,
      transformedFrom: [],
    },
    integrity: { immutable: true, digestVerified: true },
  }
}

function cancellationFor(binding) {
  return {
    schemaVersion: 'agent-cancellation-request/v1',
    requestId: `cancel-${binding.invocationId}`,
    requestedAt: '2026-07-17T02:00:01.500Z',
    reason: 'user',
    runId: binding.runId,
    runRevision: binding.runRevision,
    attempt: binding.attempt,
    invocationId: binding.invocationId,
  }
}

function assertPayloadCannotElevate(roleId, payload) {
  try {
    a2.validateBuiltInRoleOutputPayload(roleId, payload)
  } catch {
    return
  }
  const runtimeBinding = a2.getBuiltInRoleRuntimeBinding(roleId)
  assert.equal(runtimeBinding.role.browserWrite, false)
  assert.equal(runtimeBinding.role.canResolveApproval, false)
  assert.equal(runtimeBinding.role.canWriteMemory, false)
  assert.equal(runtimeBinding.role.authoritativeCompletionEvidence, false)
  assert(runtimeBinding.role.outputArtifactContracts.every((contract) =>
    contract.requiresMainWorkflowVerification === true
    && contract.authoritativeCompletionEvidence === false))
}

function mutateFirstOutput(result, mutation) {
  return {
    ...result,
    outputArtifacts: result.outputArtifacts.map((artifact, index) =>
      index === 0 ? mutation(artifact) : artifact),
  }
}

function unsignedEnvelope(envelope) {
  const { schemaVersion: _schemaVersion, payloadDigest: _payloadDigest, ...input } = envelope
  return structuredClone(input)
}

function assertDeepFrozen(value, path, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert(Object.isFrozen(value), `${path} is mutable`)
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${path}.${key}`, seen)
  }
}

function check(name, operation) {
  try {
    operation()
    results.push({ name, status: 'PASS' })
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: describe(error) })
  }
}

function expectContractError(name, operation, expectedCodes) {
  try {
    operation()
    results.push({ name, status: 'FAIL', detail: 'validator accepted the adversarial input' })
  } catch (error) {
    if (error instanceof MultiAgentContractError && expectedCodes.includes(error.code)) {
      results.push({ name, status: 'PASS', detail: error.code })
    } else {
      results.push({ name, status: 'FAIL', detail: describe(error) })
    }
  }
}

function expectError(name, operation) {
  try {
    operation()
    results.push({ name, status: 'FAIL', detail: 'validator accepted the adversarial input' })
  } catch (error) {
    results.push({ name, status: 'PASS', detail: error instanceof Error ? error.name : 'rejected' })
  }
}

function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
