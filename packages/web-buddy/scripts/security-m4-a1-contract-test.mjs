#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'

const distUrl = new URL('../dist/agents/multi-agent-contracts.js', import.meta.url)
const sourceUrl = new URL('../src/agents/multi-agent-contracts.ts', import.meta.url)
const fixtureUrl = new URL('./fixtures/security/m4-a1-adversarial.json', import.meta.url)
const useSource = process.env.WEB_BUDDY_TEST_SOURCE === '1'
const contracts = await import(useSource || !existsSync(distUrl) ? sourceUrl : distUrl)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))

const {
  AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION,
  AGENT_INVOCATION_RESULT_SCHEMA_VERSION,
  MULTI_AGENT_ROLE_SCHEMA_VERSION,
  MultiAgentContractError,
  sealAgentContextEnvelope,
  validateAgentInvocationResult,
  validateMultiAgentRole,
} = contracts

if (fixture.schemaVersion !== 'security-m4-a1-adversarial/v1') {
  throw new Error(`Unsupported fixture schema: ${String(fixture.schemaVersion)}`)
}

const runId = fixture.runId
const runRevision = fixture.runRevision
const binding = {
  schemaVersion: 'agent-invocation-binding/v1',
  invocationId: 'invocation-m4-a1-security',
  taskId: 'task-m4-a1-security',
  runId,
  runRevision,
  attempt: 2,
  parentActionSeq: 17,
  sessionRef: {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: 'session-m4-a1-security',
    runId,
    attempt: 2,
  },
}

const results = []

const researcher = role('researcher', 'research.summarize', 'research_report', 'research-report/v1')
const safetyReviewer = role('safety-reviewer', 'safety.review', 'safety_verdict', 'safety-verdict/v1')
const verifier = role('verification-agent', 'evidence.assess', 'evidence_assessment', 'evidence-assessment/v1')

for (const candidate of [researcher, safetyReviewer, verifier]) {
  expectAccept(`${candidate.id}: bounded role`, () => validateMultiAgentRole(candidate))
}

for (const [name, mutation] of [
  ['browser write', { browserWrite: true }],
  ['live page', { livePageAccess: true }],
  ['approval resolution', { canResolveApproval: true }],
  ['memory write', { canWriteMemory: true }],
  ['completion authority', { authoritativeCompletionEvidence: true }],
  ['browser tool', { allowedTools: [...researcher.allowedTools, 'browser_click'] }],
]) {
  expectReject(`Main Agent remains sole Browser/decision owner: ${name}`, () => {
    validateMultiAgentRole({ ...researcher, ...mutation })
  }, ['AUTHORITY_VIOLATION', 'CAPABILITY_VIOLATION'])
}

const researcherEnvelope = envelope(researcher)
const safetyEnvelope = envelope(safetyReviewer)
const verifierEnvelope = envelope(verifier)

const researcherArtifact = outputArtifact(
  researcher,
  'research-output',
  'research_report',
  'research-report/v1',
)
const safetyArtifact = outputArtifact(
  safetyReviewer,
  'safety-output',
  'safety_verdict',
  'safety-verdict/v1',
)
const verificationArtifact = outputArtifact(
  verifier,
  'verification-output',
  'evidence_assessment',
  'evidence-assessment/v1',
)

expectAccept('baseline Researcher Artifact remains advisory', () => {
  validateAgentInvocationResult(result(researcher, researcherArtifact), researcherEnvelope)
})
expectEqual('baseline subagent Artifact authority=false', researcherArtifact.authoritativeCompletionEvidence, false)
expectEqual('baseline subagent Artifact requires Main verification', researcherArtifact.requiresMainWorkflowVerification, true)

expectReject('malicious Researcher cannot smuggle a new system instruction in ArtifactRef fields', () => {
  validateAgentInvocationResult(
    result(researcher, { ...researcherArtifact, ...fixture.attacks.researcherInstructionSmuggling }),
    researcherEnvelope,
  )
}, ['INVALID_CONTRACT', 'AUTHORITY_VIOLATION', 'ARTIFACT_CONTRACT_VIOLATION'])

expectReject('Safety Reviewer cannot smuggle approved or ApprovalBinding in ArtifactRef fields', () => {
  validateAgentInvocationResult(
    result(safetyReviewer, { ...safetyArtifact, ...fixture.attacks.safetyApprovalSmuggling }),
    safetyEnvelope,
  )
}, ['INVALID_CONTRACT', 'AUTHORITY_VIOLATION', 'ARTIFACT_CONTRACT_VIOLATION'])
expectReject('Safety Reviewer cannot directly claim Approval resolution authority', () => {
  validateMultiAgentRole({ ...safetyReviewer, canResolveApproval: true })
}, ['AUTHORITY_VIOLATION'])

expectReject('Verification Agent cannot smuggle authoritative completion evidence fields', () => {
  validateAgentInvocationResult(
    result(verifier, { ...verificationArtifact, ...fixture.attacks.verificationCompletionSmuggling }),
    verifierEnvelope,
  )
}, ['INVALID_CONTRACT', 'AUTHORITY_VIOLATION', 'ARTIFACT_CONTRACT_VIOLATION'])
expectReject('Verification Agent cannot set the defined completion-authority flag', () => {
  validateAgentInvocationResult(
    result(verifier, { ...verificationArtifact, authoritativeCompletionEvidence: true }),
    verifierEnvelope,
  )
}, ['AUTHORITY_VIOLATION'])

expectReject('stale Artifact revision cannot overwrite the current task', () => {
  validateAgentInvocationResult(
    result(researcher, {
      ...researcherArtifact,
      binding: { ...researcherArtifact.binding, revision: runRevision - 1 },
    }),
    researcherEnvelope,
  )
}, ['STALE_REVISION'])
expectReject('foreign-run Artifact cannot overwrite the current task', () => {
  validateAgentInvocationResult(
    result(researcher, {
      ...researcherArtifact,
      binding: { ...researcherArtifact.binding, runId: 'run-foreign' },
    }),
    researcherEnvelope,
  )
}, ['BINDING_MISMATCH'])
expectReject('foreign-session Artifact cannot overwrite the current task', () => {
  validateAgentInvocationResult(
    result(researcher, {
      ...researcherArtifact,
      binding: {
        ...researcherArtifact.binding,
        sessionRef: { ...researcherArtifact.binding.sessionRef, id: 'session-foreign' },
      },
    }),
    researcherEnvelope,
  )
}, ['BINDING_MISMATCH'])
expectReject('foreign producer cannot publish a Researcher Artifact', () => {
  validateAgentInvocationResult(
    result(researcher, {
      ...researcherArtifact,
      producer: { id: 'foreign-researcher', version: researcher.version },
    }),
    researcherEnvelope,
  )
}, ['BINDING_MISMATCH'])
expectReject('Artifact payload schema must match the output contract', () => {
  validateAgentInvocationResult(
    result(researcher, { ...researcherArtifact, payloadSchemaVersion: 'research-report/v0' }),
    researcherEnvelope,
  )
}, ['ARTIFACT_CONTRACT_VIOLATION'])
expectReject('subagent Artifact cannot upgrade trust or origin', () => {
  validateAgentInvocationResult(
    result(researcher, { ...researcherArtifact, origin: 'system', trust: 'trusted_runtime' }),
    researcherEnvelope,
  )
}, ['AUTHORITY_VIOLATION'])

expectReject('output Artifact must retain current input provenance', () => {
  validateAgentInvocationResult(
    result(researcher, { ...researcherArtifact, parentArtifactIds: [] }),
    researcherEnvelope,
  )
}, ['BINDING_MISMATCH', 'ARTIFACT_CONTRACT_VIOLATION'])
expectReject('output Artifact cannot claim a foreign parent', () => {
  validateAgentInvocationResult(
    result(researcher, { ...researcherArtifact, parentArtifactIds: ['artifact-foreign'] }),
    researcherEnvelope,
  )
}, ['BINDING_MISMATCH', 'ARTIFACT_CONTRACT_VIOLATION'])
expectReject('input Artifact cannot self-assert system provenance', () => {
  sealAgentContextEnvelope(envelopeInput(researcher, {
    ...inputArtifact(),
    origin: 'system',
    trust: 'trusted_runtime',
    producer: { id: 'unverified-importer', version: '0.0.0' },
  }))
}, ['AUTHORITY_VIOLATION', 'BINDING_MISMATCH', 'ARTIFACT_CONTRACT_VIOLATION', 'INVALID_CONTRACT'])

const passed = results.filter((item) => item.status === 'PASS').length
for (const item of results) {
  const detail = item.detail ? ` — ${item.detail}` : ''
  console.log(`${item.status} ${item.name}${detail}`)
}
console.log(`security-m4-a1-contract-test: ${passed}/${results.length} security assertions passed`)
if (passed !== results.length) process.exitCode = 1

function role(id, capability, outputKind, outputSchema) {
  return {
    schemaVersion: MULTI_AGENT_ROLE_SCHEMA_VERSION,
    id,
    version: '1.0.0',
    capabilities: ['context.read', 'artifact.read', capability],
    authority: 'recommend_only',
    allowedTools: ['artifact_read_json', 'artifact_list_refs'],
    inputArtifactContracts: [artifactContract('input', `${id}-input`, 'page_snapshot', 'page-snapshot/v1')],
    outputArtifactContracts: [artifactContract('output', `${id}-output`, outputKind, outputSchema)],
    livePageAccess: false,
    browserWrite: false,
    canResolveApproval: false,
    canWriteMemory: false,
    authoritativeCompletionEvidence: false,
    requiresMainWorkflowVerification: true,
  }
}

function artifactContract(direction, contractId, artifactKind, payloadSchemaVersion) {
  return {
    schemaVersion: AGENT_ARTIFACT_CONTRACT_SCHEMA_VERSION,
    contractId,
    direction,
    artifactKinds: [artifactKind],
    payloadSchemaVersions: [payloadSchemaVersion],
    mediaTypes: ['application/json'],
    minCount: 1,
    maxCount: 1,
    immutableRequired: true,
    freshness: 'current_run_revision',
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function envelope(roleValue) {
  return sealAgentContextEnvelope(envelopeInput(roleValue, inputArtifact()))
}

function envelopeInput(roleValue, artifactValue) {
  return {
    envelopeId: `envelope-${roleValue.id}`,
    role: roleValue,
    binding,
    objective: contextItem(`objective-${roleValue.id}`),
    contextItems: [],
    inputArtifacts: [artifactValue],
    allowedTools: roleValue.allowedTools,
    budget: {
      schemaVersion: 'agent-execution-budget/v1',
      maxInputTokens: 2_000,
      maxOutputTokens: 500,
      maxTurns: 4,
      maxToolCalls: 6,
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
  }
}

function contextItem(id) {
  return {
    schemaVersion: 'context-item/v1',
    id,
    kind: 'agent_objective',
    content: { task: 'Review current immutable inputs and return only an advisory Artifact.' },
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: 'internal',
    provenance: { capturedAt: '2026-07-17T02:00:00.000Z', parentContentIds: [], runId },
    allowedUses: ['subagent'],
    freshness: { validity: 'current', revision: runRevision },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: {
      policyId: 'security-m4-a1/v1',
      status: 'unchanged',
      redactedFields: [],
      instructionNeutralized: false,
      transformedFrom: [],
    },
    integrity: { immutable: true, digestVerified: true },
  }
}

function inputArtifact() {
  return artifactBase({
    id: 'input-page-current',
    kind: 'page_snapshot',
    payloadSchemaVersion: 'page-snapshot/v1',
    producer: { id: 'main-runtime', version: '1.0.0' },
    origin: 'tool',
    trust: 'untrusted_external',
    requiresMainWorkflowVerification: false,
    parentArtifactIds: [],
  })
}

function outputArtifact(roleValue, id, kind, payloadSchemaVersion) {
  return artifactBase({
    id,
    kind,
    payloadSchemaVersion,
    producer: { id: roleValue.id, version: roleValue.version },
    origin: 'subagent',
    trust: 'non_authoritative',
    requiresMainWorkflowVerification: true,
    parentArtifactIds: ['input-page-current'],
  })
}

function artifactBase(overrides) {
  return {
    schemaVersion: 'artifact-ref/v1',
    id: 'artifact',
    kind: 'generic',
    payloadSchemaVersion: 'generic/v1',
    mediaType: 'application/json',
    byteLength: 128,
    sha256: 'a'.repeat(64),
    createdAt: '2026-07-17T02:00:00.000Z',
    immutable: true,
    locator: `artifact:${overrides.id}`,
    producer: { id: 'main-runtime', version: '1.0.0' },
    parentEvidenceIds: [],
    parentArtifactIds: [],
    origin: 'artifact',
    trust: 'derived_untrusted',
    sensitivity: 'internal',
    retention: { scope: 'run', deleteWithSession: true },
    binding: {
      runId,
      revision: runRevision,
      sessionRef: binding.sessionRef,
      actionSeq: binding.parentActionSeq,
    },
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
    redaction: { status: 'not_required', policyId: 'security-m4-a1/v1' },
    scanner: { status: 'clean', scannerId: 'security-m4-a1/v1' },
    ...overrides,
  }
}

function result(roleValue, artifactValue) {
  return {
    schemaVersion: AGENT_INVOCATION_RESULT_SCHEMA_VERSION,
    resultId: `result-${roleValue.id}`,
    roleId: roleValue.id,
    roleVersion: roleValue.version,
    binding,
    startedAt: '2026-07-17T02:00:01.000Z',
    finishedAt: '2026-07-17T02:00:02.000Z',
    outcome: 'succeeded',
    outputArtifacts: [artifactValue],
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function expectAccept(name, operation) {
  try {
    operation()
    results.push({ name, status: 'PASS' })
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: describe(error) })
  }
}

function expectReject(name, operation, expectedCodes) {
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

function expectEqual(name, actual, expected) {
  if (Object.is(actual, expected)) results.push({ name, status: 'PASS' })
  else results.push({ name, status: 'FAIL', detail: `expected ${String(expected)}, got ${String(actual)}` })
}

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
