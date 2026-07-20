#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWebTaskRuntimeDriver,
  listGenericWebTaskToolDefs,
} from '../dist/sdk/web-task.js'
import { loadConfig } from '../dist/sdk/config.js'
import {
  FileSessionRecorder,
  FileSessionStore,
  restoreSessionState,
} from '../dist/session/index.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-generic-resume-runtime-'))
const traceRoot = join(root, 'trace')
const previousEnvironment = Object.fromEntries([
  'TRACE_OUT_DIR',
  'MODEL_API_KEY',
  'OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
].map((key) => [key, process.env[key]]))
try {
  process.env.TRACE_OUT_DIR = traceRoot
  delete process.env.MODEL_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN

  const runId = 'generic-resume-runtime-run'
  const sessionId = 'generic-resume-runtime-session'
  const store = new FileSessionStore({ rootDir: join(traceRoot, 'sessions') })
  const session = await store.create({
    sessionId,
    runId,
    source: 'web',
    goal: 'Restore a read-only observation task.',
    mode: 'generic-web-task',
    traceRunId: runId,
  })
  const recorder = new FileSessionRecorder(store, session)
  await recorder.transcript({ type: 'user_message', content: 'Inspect the current page.' })
  await recorder.transcript({
    type: 'tool_call',
    toolCallId: 'unsettled-write-call',
    name: 'browser_click',
    args: { ref: 'e9' },
  })
  const restored = await restoreSessionState({ session })
  const beforeTranscript = await readFile(session.transcriptPath, 'utf8')
  const config = loadConfig()
  config.model.apiKey = null
  config.model.authToken = null
  config.trace.outDir = traceRoot
  const sessionRef = {
    schemaVersion: 'session-ref/v1',
    provider: 'file-session-store',
    id: sessionId,
    runId,
    attempt: 2,
  }
  const snapshot = snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId,
    revision: 4,
    goal: { instruction: 'Restore a read-only observation task.' },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'generic-resume-runtime-contract',
      revision: 4,
      criteria: [{
        id: 'observed',
        kind: 'evidence_present',
        description: 'Observe the current page after recovery.',
        evidenceKinds: ['page'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
    },
    policy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'deny',
      rules: [],
    },
  })
  let readySession
  const driver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId,
    restoredSession: restored,
    readOnlyAuthority: true,
    onSessionReady(value) { readySession = value },
  })
  const outcome = await driver.execute({
    schemaVersion: 'web-task-runtime-request/v1',
    input: snapshot,
    contextItems: [],
    runtime: {
      executionContext: {
        schemaVersion: 'run-execution-context/v1',
        runRevision: 5,
        attempt: 2,
        sessionRef,
        recoveryMode: 'read_only_reobserve/v1',
      },
    },
    emit() {},
  })
  assert.equal(outcome.status, 'blocked', 'no-key recovery fixture should stop without browser writes')
  assert.deepEqual(outcome.sessionRef, sessionRef)
  assert.equal(readySession.sessionId, sessionId)
  assert.equal(
    await readFile(session.transcriptPath, 'utf8'),
    beforeTranscript,
    'recovery must reuse rather than recreate or truncate the durable transcript',
  )

  const recoveryDefs = listGenericWebTaskToolDefs(true)
  assert(recoveryDefs.some((tool) => tool.name === 'browser_snapshot'))
  assert(recoveryDefs.some((tool) => tool.name === 'agent_done'))
  assert(recoveryDefs.every((tool) => tool.execution.readOnly || tool.name === 'agent_done'))
  for (const forbidden of [
    'browser_open',
    'browser_click',
    'browser_click_text',
    'browser_type',
    'browser_fill_by_label',
    'browser_select',
    'browser_upload_file',
  ]) {
    assert.equal(recoveryDefs.some((tool) => tool.name === forbidden), false, `${forbidden} leaked into recovery`)
  }

  const unsafeDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId,
    restoredSession: restored,
    readOnlyAuthority: false,
  })
  const unsafeOutcome = await unsafeDriver.execute({
    schemaVersion: 'web-task-runtime-request/v1',
    input: snapshot,
    contextItems: [],
    runtime: {
      executionContext: {
        schemaVersion: 'run-execution-context/v1',
        runRevision: 5,
        attempt: 2,
        sessionRef,
        recoveryMode: 'read_only_reobserve/v1',
      },
    },
    emit() {},
  })
  assert.equal(unsafeOutcome.status, 'failed')
  assert.match(unsafeOutcome.summary, /read-only authority/)

  console.log('generic-web-task-resume-runtime-test: PASS')
} finally {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
}
