#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalAsyncTaskRuntime } from '../dist/agents/local-async-runtime-factory.js'
import { loadConfig } from '../dist/sdk/config.js'
import { FileSessionRecorder, FileSessionStore } from '../dist/session/index.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-local-async-'))

try {
  const sessionStore = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const session = await sessionStore.create({
    sessionId: 'local-async-session',
    runId: 'local-async-run',
    source: 'test',
    goal: 'Research two candidate products and compare their evidence.',
  })
  const recorder = new FileSessionRecorder(sessionStore, session)
  await recorder.transcriptDurably({
    type: 'tool_result',
    toolCallId: 'snapshot-current',
    name: 'browser_snapshot',
    ok: true,
    result: {
      observation: 'Candidate A has verified sales evidence; Candidate B has incomplete evidence.',
      pageChanged: false,
    },
  })
  const config = loadConfig({
    trace: { outDir: join(root, 'output') },
    agent: {
      asyncTasks: {
        enabled: true,
        maxQueuedTasks: 8,
        maxConcurrentReadOnlyLlmTasks: 2,
        maxConcurrentDeterministicTasks: 1,
        notificationWaitMs: 1_000,
      },
    },
  })
  const runtime = await createLocalAsyncTaskRuntime({
    session: recorder,
    config,
    llm: scriptedRoleLlm(),
    goal: session.goal,
  })
  await runtime.initialize()

  const research = await runtime.spawnBuiltInRole({
    roleId: 'researcher',
    title: 'Research candidate evidence',
    goal: 'Extract source-linked facts and uncertainties.',
    idempotencyKey: 'research:candidates:v1',
    actionBinding: { kind: 'browser_action', sourceActionSeq: 0 },
  })
  assert.equal(research.outcome, 'created')
  const researchResult = await waitForResult(runtime, research.task.id)
  assert.equal(researchResult.status, 'completed')
  const researchRef = researchResult.outputRefs.find((ref) => ref.artifactKind === 'research_report')
  assert(researchRef, 'research output must be materialized as an immutable research_report')

  const comparison = await runtime.spawnBuiltInRole({
    roleId: 'comparison',
    title: 'Compare researched candidates',
    goal: 'Use the research artifact to compare candidates on consistent criteria.',
    requestedArtifactIds: [researchRef.artifactId],
    idempotencyKey: 'comparison:candidates:v1',
    actionBinding: { kind: 'browser_action', sourceActionSeq: 0 },
  })
  assert.equal(comparison.outcome, 'created')
  const comparisonResult = await waitForResult(runtime, comparison.task.id)
  assert.equal(comparisonResult.status, 'completed')
  assert(comparisonResult.outputRefs.some((ref) => ref.artifactKind === 'comparison_report'))

  await assert.rejects(
    runtime.spawnBuiltInRole({
      roleId: 'form-planner',
      title: 'Disabled rollout role',
      goal: 'This role is intentionally outside the local read-only rollout.',
      idempotencyKey: 'form-planner:disabled:v1',
      actionBinding: { kind: 'browser_action', sourceActionSeq: 0 },
    }),
    /only enables researcher, comparison/,
  )

  const readiness = await runtime.completionReadiness()
  assert.equal(readiness.state, 'eligible_for_main_verification')
  await runtime.resumeAttachment()
  const manifestText = await readFile(join(session.outputDir, 'async-artifacts', 'manifest.jsonl'), 'utf8')
  assert.match(manifestText, /"artifactKind":"research_report"/)
  assert.match(manifestText, /"artifactKind":"comparison_report"/)
  assert.match(manifestText, /"artifactKind":"context_envelope"/)
  assert.match(manifestText, /"artifactKind":"task_graph_checkpoint"/)
  assert.match(manifestText, /observation-browser_snapshot-snapshot-current/)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(JSON.stringify({
  schemaVersion: 'local-async-runtime-test/v1',
  passed: true,
  assertions: [
    'default local factory assembles a durable read-only runtime',
    'Researcher and Comparison materialize immutable role artifacts',
    'artifactIds provide an explicit stage handoff',
    'recent read-only Main Agent observations become isolated immutable inputs',
    'disabled rollout roles fail closed',
    'Context Envelopes and graph checkpoints persist under the session',
  ],
}, null, 2))

async function waitForResult(runtime, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await runtime.tick()
    const result = await runtime.result(taskId)
    if (result.available || result.status === 'failed' || result.status === 'killed') return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${taskId}.`)
}

function scriptedRoleLlm() {
  return {
    async chatWithTools(messages) {
      const request = JSON.parse(messages.findLast((message) => message.role === 'user').content)
      const roleId = request.builtInRole?.roleId
      const evidenceRefs = request.selectedContext.length > 0
        ? [{ kind: 'context_item', contextItemId: request.selectedContext[0].id }]
        : []
      assert(evidenceRefs.length > 0, 'local Context Envelope must select at least one immutable context item')
      const payload = roleId === 'researcher'
        ? { findings: ['candidate facts'], sources: [evidenceRefs[0].contextItemId], uncertainties: [] }
        : roleId === 'comparison'
          ? { criteria: ['evidence quality'], comparisons: ['candidate A vs candidate B'], recommendation: 'candidate A' }
          : {}
      return {
        content: JSON.stringify({
          summary: `${roleId} completed`,
          recommendations: ['main agent should verify'],
          evidenceRefs,
          uncertainties: [],
          roleOutput: {
            artifactKind: request.builtInRole.outputArtifactKind,
            payloadSchemaVersion: request.builtInRole.outputPayloadSchemaVersion,
            payload,
          },
        }),
        toolCalls: [],
      }
    },
  }
}
