#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const sourceUrl = new URL('../src/public/index.ts', import.meta.url)
const distUrl = new URL('../dist/public/index.js', import.meta.url)
const useSource = process.env.WEB_BUDDY_TEST_SOURCE === '1' || !existsSync(distUrl)
if (useSource) await installSourceResolver()
const sdk = await import(useSource ? sourceUrl : distUrl)

for (const forbidden of [
  'runJobApplicationAgent',
  'RunOptions',
  'AgentRunResult',
  'RuntimeOptions',
  'WebTaskRuntimeDriver',
  'RunService',
  'FileRunStore',
  'FileApprovalStore',
]) {
  assert.equal(forbidden in sdk, false, `${forbidden} leaked through public exports`)
}

assert.equal(sdk.PUBLIC_SDK_VERSION, '1.0.0')
assert.equal(sdk.PUBLIC_SCHEMA_COMPATIBILITY.policy, 'reject_unknown_major')

const research = sdk.createResearchStarter({
  schemaVersion: 'research-starter/v1',
  goal: 'Summarize the fixture.',
  startUrl: 'https://example.com/',
  runId: 'run-public-research',
})
const researchSnapshot = sdk.snapshotWebTaskInput(research)
assert.equal(researchSnapshot.schemaVersion, 'web-task-input-snapshot/v1')
assert.equal('driver' in (research.runtime ?? {}), false)
assert.deepEqual(research.contract.requiredEvidence?.[0]?.origins, ['web'])
assert.deepEqual(
  research.policy.rules.find((rule) => rule.id === 'starter-allow-read-only-navigation'),
  {
    id: 'starter-allow-read-only-navigation',
    actionKinds: ['navigate'],
    decision: 'allow',
    destinationOrigins: ['https://example.com'],
    requireApprovalBinding: false,
  },
)
assert(research.policy.rules.some((rule) => rule.id === 'starter-deny-write-actions' && rule.decision === 'deny'))

const crossOriginResearch = sdk.createResearchStarter({
  schemaVersion: 'research-starter/v1',
  goal: 'Compare bounded sources.',
  startUrl: 'https://example.com/',
  allowedNavigationOrigins: ['https://example.com', 'https://www.iana.org'],
})
assert.deepEqual(crossOriginResearch.policy.rules[0].destinationOrigins, [
  'https://example.com',
  'https://www.iana.org',
])
assert.throws(
  () => sdk.createResearchStarter({
    schemaVersion: 'research-starter/v1',
    goal: 'Reject an unbounded origin shape.',
    startUrl: 'https://example.com/',
    allowedNavigationOrigins: ['https://www.iana.org/domains'],
  }),
  /exact HTTP\(S\) origin/,
)

const comparison = sdk.createComparisonStarter({
  schemaVersion: 'comparison-starter/v1',
  goal: 'Compare two fixtures.',
  capturedAt: '2026-07-18T00:00:00.000Z',
  options: [
    { schemaVersion: 'comparison-option/v1', id: 'one', label: 'One', facts: { price: 1 } },
    { schemaVersion: 'comparison-option/v1', id: 'two', label: 'Two', facts: { price: 2 } },
  ],
})
assert.equal(comparison.contract.criteria[0].kind, 'artifact_present')
assert.equal(comparison.contextItems.length, 2)

const form = sdk.createFormDraftStarter({
  schemaVersion: 'form-draft-starter/v1',
  goal: 'Draft only.',
  startUrl: 'https://example.com/form',
  capturedAt: '2026-07-18T00:00:00.000Z',
  fields: [{
    schemaVersion: 'form-draft-field/v1',
    field: 'name',
    value: 'Ada',
    sensitivity: 'personal',
  }],
})
assert(form.contract.criteria.some((criterion) => (
  criterion.kind === 'action_boundary' && criterion.outcome === 'not_performed'
)))
assert(form.policy.rules.some((rule) => (
  rule.decision === 'ask'
  && rule.actionKinds.includes('type_or_paste')
  && rule.destinationOrigins?.includes('https://example.com')
)))
assert.throws(
  () => sdk.createFormDraftStarter({
    schemaVersion: 'form-draft-starter/v1',
    goal: 'Unsafe',
    startUrl: 'https://example.com/form',
    fields: [{
      schemaVersion: 'form-draft-field/v1',
      field: 'password',
      value: 'secret',
      sensitivity: 'secret',
    }],
  }),
  (error) => error.code === 'INVALID_CONTRACT',
)

const scaffold = sdk.createSkillScaffold({
  schemaVersion: 'public-skill-scaffold-request/v1',
  id: 'fixture-skill',
  version: '1.0.0',
  name: 'Fixture Skill',
  description: 'A read-only fixture skill.',
  taskKinds: ['research'],
})
assert.equal(scaffold.schemaVersion, 'public-skill-scaffold/v1')
assert(Object.isFrozen(scaffold.manifest))
assert.equal(sdk.validateSkillManifest(scaffold.manifest).id, 'fixture-skill')
assert.throws(
  () => sdk.validateSkillManifest({
    ...scaffold.manifest,
    capabilities: ['browser.click'],
  }),
  (error) => error.code === 'INVALID_CONTRACT',
)
assert.throws(
  () => sdk.validateSkillManifest({
    ...scaffold.manifest,
    schemaVersion: 'public-skill-manifest/v999',
  }),
  (error) => error.code === 'UNSUPPORTED_SCHEMA_VERSION',
)

assert.throws(
  () => sdk.validatePolicyHookDecision({
    schemaVersion: 'public-policy-hook-decision/v1',
    decision: 'allow',
    reason: 'forged',
    auditTags: [],
  }),
  (error) => error.code === 'INVALID_CONTRACT',
)

const tenantScope = {
  schemaVersion: 'service-scope/v1',
  kind: 'tenant',
  tenantId: 'tenant-a',
  userId: 'user-a',
}
assert.equal(sdk.serviceScopeKey(tenantScope), 'tenant:tenant-a:user:user-a')
assert.equal(sdk.validateServiceStoreQuery({
  schemaVersion: 'service-store-query/v1',
  scope: tenantScope,
  resourceKind: 'run',
  limit: 25,
}).scope.userId, 'user-a')
assert.throws(
  () => sdk.assertServiceScopeAccess(tenantScope, { ...tenantScope, tenantId: 'tenant-b' }),
  (error) => error.code === 'SCOPE_MISMATCH',
)
const quota = sdk.evaluateQuota(
  {
    schemaVersion: 'quota-limit/v1',
    scope: tenantScope,
    dimension: 'concurrent_runs',
    maximum: 2,
  },
  {
    schemaVersion: 'quota-usage/v1',
    scope: tenantScope,
    dimension: 'concurrent_runs',
    used: 1,
    reserved: 1,
    measuredAt: '2026-07-18T00:00:00.000Z',
  },
  1,
  new Date('2026-07-18T00:00:01.000Z'),
)
assert.equal(quota.decision, 'deny')
assert.equal(quota.reasonCode, 'quota_exceeded')

assert.equal(sdk.validateAuditEvent({
  schemaVersion: 'audit-event/v1',
  eventId: 'audit-1',
  requestId: 'request-1',
  actor: {
    schemaVersion: 'audit-actor/v1',
    actorId: 'user-a',
    scope: tenantScope,
    authentication: 'bearer',
  },
  action: 'run.pause',
  target: { kind: 'run', id: 'run-1' },
  occurredAt: '2026-07-18T00:00:00.000Z',
  result: 'succeeded',
  redaction: 'not_required',
}).action, 'run.pause')
assert.equal(sdk.validateAuditEvent({
  schemaVersion: 'audit-event/v1',
  eventId: 'audit-continuation-1',
  requestId: 'request-continuation-1',
  actor: {
    schemaVersion: 'audit-actor/v1',
    actorId: 'user-a',
    scope: tenantScope,
    authentication: 'bearer',
  },
  action: 'run.continue',
  target: { kind: 'run', id: 'run-1' },
  occurredAt: '2026-07-18T00:00:00.000Z',
  result: 'succeeded',
  redaction: 'redacted',
  metadata: { mode: 'live' },
}).action, 'run.continue')
assert.throws(
  () => sdk.validateAuditEvent({
    schemaVersion: 'audit-event/v1',
    eventId: 'audit-2',
    requestId: 'request-2',
    actor: {
      schemaVersion: 'audit-actor/v1',
      actorId: 'user-a',
      scope: tenantScope,
      authentication: 'bearer',
    },
    action: 'auth.deny',
    target: { kind: 'api' },
    occurredAt: '2026-07-18T00:00:00.000Z',
    result: 'denied',
    redaction: 'redacted',
    metadata: { authorizationToken: 'must-not-persist' },
  }),
  (error) => error.code === 'INVALID_CONTRACT',
)

const transportCalls = []
const runClient = sdk.createRunClient({
  scope: tenantScope,
  transport: {
    async send(request) {
      transportCalls.push(request)
      return {
        schemaVersion: 'public-run-list/v1',
        items: [{
          schemaVersion: 'public-run/v1',
          runId: 'run-1',
          revision: 0,
          attempt: 1,
          state: 'running',
          scope: tenantScope,
          updatedAt: '2026-07-18T00:00:00.000Z',
          pendingContinuation: {
            continuationId: 'continuation-1',
            kind: 'needs_information',
            status: 'pending',
            question: {
              questionId: 'question-1',
              field: 'company_name',
              prompt: 'Which company name should be used?',
              options: ['Example Labs'],
            },
            requestedAt: '2026-07-18T00:00:00.000Z',
            answer: 'must not leak',
          },
          internalStorePath: '/must/not/leak',
        }],
      }
    },
  },
})
const listed = await runClient.list({ schemaVersion: 'run-client-list/v1' })
assert.equal(listed.items.length, 1)
assert.equal('internalStorePath' in listed.items[0], false)
assert.equal(transportCalls[0].scope.tenantId, 'tenant-a')
assert.equal(listed.items[0].pendingContinuation?.question.field, 'company_name')
assert.equal('answer' in listed.items[0].pendingContinuation, false)

const continuationCalls = []
const continuationClient = sdk.createRunClient({
  scope: tenantScope,
  transport: {
    async send(request) {
      continuationCalls.push(request)
      return {
        schemaVersion: 'public-run/v1',
        runId: 'run-1',
        revision: 0,
        attempt: 1,
        state: 'running',
        scope: tenantScope,
        updatedAt: '2026-07-18T00:00:01.000Z',
      }
    },
  },
})
const continued = await continuationClient.continue({
  schemaVersion: 'run-client-continuation/v1',
  runId: 'run-1',
  continuationId: 'continuation-1',
  expectedRevision: 0,
  answer: 'Use Example Labs.',
  intentPatch: 'Keep the task draft-only.',
  idempotencyKey: 'continue-run-1',
})
assert.equal(continued.state, 'running')
assert.equal(
  continuationCalls[0].path,
  '/api/runs/run-1/continuations/continuation-1/resolve',
)
assert.equal(continuationCalls[0].body.answer, 'Use Example Labs.')
assert.equal(continuationCalls[0].body.intentPatch, 'Keep the task draft-only.')

const failed = await sdk.runWebTask({
  ...research,
  contextProviders: [{
    id: 'fixture-provider',
    version: '1.0.0',
    async provide() {
      throw new Error('fixture provider stopped before runtime')
    },
  }],
})
assert.equal(failed.status, 'failed')
assert.match(failed.summary, /fixture provider stopped before runtime/)

console.log(`sdk-public-surface-test: PASS (${useSource ? 'source' : 'dist'})`)

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
