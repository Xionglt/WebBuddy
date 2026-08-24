#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionRecorder, FileSessionStore } from '../dist/session/index.js'
import { FileToolResultStore } from '../dist/tools/tool-result-store.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-m6-persistence-'))
const secret = 'm6_exact_secret_Z9x7Q2'
const replacement = '[REDACTED:service-secret]'
const priorTraceMode = process.env.AGENT_TRACE_MODE
process.env.AGENT_TRACE_MODE = 'full'

try {
  const sanitize = (value) => replaceExact(value, secret, replacement)

  const artifactStore = new FileToolResultStore({
    rootDir: join(root, 'artifacts'),
    sanitize,
  })
  await assert.rejects(
    artifactStore.write({
      runId: 'm6-persistence',
      sessionId: 'm6-persistence-session',
      toolCallId: 'secret-artifact',
      toolName: 'fixture',
      kind: 'generic_json',
      content: { value: secret },
      sensitivity: 'secret',
    }),
    /SECRET_ARTIFACT_REJECTED/,
  )
  const artifactRef = await artifactStore.write({
    runId: 'm6-persistence',
    sessionId: 'm6-persistence-session',
    toolCallId: 'redacted-artifact',
    toolName: 'fixture',
    kind: 'generic_json',
    content: { value: secret, authorization: `Bearer ${secret}` },
    sensitivity: 'internal',
    summary: `fixture ${secret}`,
    metadata: { pageUrl: `https://example.test/?marker=${secret}` },
  })
  assert.equal(artifactRef.redaction?.status, 'redacted')
  assert.equal(JSON.stringify(await artifactStore.read(artifactRef)).includes(secret), false)

  const trace = new TraceRecorder(join(root, 'trace-output'), {
    runId: 'm6-persistence-trace',
    source: 'test',
    scenario: 'persistence-boundary',
    profile: 'deterministic',
    goal: `goal ${secret}`,
    sanitize,
  })
  trace.record({
    phase: 'fixture',
    action: `action ${secret}`,
    observation: `observation ${secret}`,
    url: `https://example.test/?marker=${secret}`,
    status: 'blocked',
  })
  trace.agentTrace?.recordEvent('raw-direct-event', { nested: secret })
  const span = trace.agentTrace?.startSpan({
    spanType: 'tool_call',
    name: 'raw-direct-span',
    input: { nested: secret },
  })
  span?.end({ status: 'failed', errorMessage: `failure ${secret}`, output: { nested: secret } })
  trace.agentTrace?.writeArtifact('direct-string-artifact.txt', `artifact ${secret}`)
  trace.finish()

  const sessionStore = new FileSessionStore({
    rootDir: join(root, 'sessions'),
    sanitize,
  })
  const session = await sessionStore.create({
    sessionId: 'm6-persistence-session',
    runId: 'm6-persistence',
    source: 'test',
    goal: `session goal ${secret}`,
  })
  const recorder = new FileSessionRecorder(sessionStore, session)
  await recorder.event({
    type: 'runtime_warning',
    message: `event ${secret}`,
    data: { nested: secret },
  })
  await recorder.transcript({
    type: 'assistant_message',
    content: { text: secret },
  })
  await recorder.workflow({ blocker: secret })
  await recorder.updateStatus('blocked', { blockedReason: `blocked ${secret}` })

  const persisted = await readTree(root)
  assert.equal(persisted.includes(secret), false, 'secret marker reached an ordinary persistence surface')
  assert(persisted.includes(replacement), 'fixture did not exercise the exact-secret sanitizer')
} finally {
  if (priorTraceMode === undefined) delete process.env.AGENT_TRACE_MODE
  else process.env.AGENT_TRACE_MODE = priorTraceMode
  await rm(root, { recursive: true, force: true })
}

console.log('security-m6-persistence-boundary-test: PASS (write-time redaction and secret artifact rejection)')

function replaceExact(value, needle, replacementValue) {
  if (typeof value === 'string') return value.split(needle).join(replacementValue)
  if (Array.isArray(value)) return value.map((item) => replaceExact(item, needle, replacementValue))
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return value
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceExact(item, needle, replacementValue)]),
    )
  }
  return value
}

async function readTree(directory) {
  let combined = ''
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) combined += await readTree(path)
    else if (entry.isFile()) combined += await readFile(path, 'utf8').catch(() => '')
  }
  return combined
}
