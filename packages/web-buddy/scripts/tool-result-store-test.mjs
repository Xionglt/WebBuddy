#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileToolResultStore } from '../dist/tools/tool-result-store.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-tool-result-store-'))

try {
  const store = new FileToolResultStore({
    rootDir: join(root, 'tool-results'),
    now: () => new Date('2026-07-09T00:00:00.000Z'),
  })

  const content = {
    rows: [
      { index: 1, value: 'alpha' },
      { index: 2, value: 'beta' },
    ],
    note: 'recoverable full payload',
  }

  const ref = await store.write({
    runId: 'run-tool-result-store-test',
    sessionId: 'session-tool-result-store-test',
    toolCallId: 'call-001',
    toolName: 'test_tool',
    kind: 'generic_json',
    content,
    sensitivity: 'internal',
    retention: { scope: 'session' },
    summary: 'two rows',
    metadata: {
      pageUrl: 'https://example.test/form',
      workflowPhase: 'fill_form',
      riskLevel: 'L1',
      policyCode: 'policy.low_risk.allow',
    },
  })

  assert.equal(ref.schemaVersion, 'tool-result-artifact-ref/v1')
  assert.equal(ref.runId, 'run-tool-result-store-test')
  assert.equal(ref.sessionId, 'session-tool-result-store-test')
  assert.equal(ref.toolCallId, 'call-001')
  assert.equal(ref.kind, 'generic_json')
  assert.equal(ref.mediaType, 'application/json')
  assert.equal(ref.createdAt, '2026-07-09T00:00:00.000Z')
  assert.equal(ref.retention.scope, 'session')
  assert.equal(ref.sensitivity, 'internal')
  assert.equal(ref.redaction.status, 'not_needed')
  assert.equal(ref.summary, 'two rows')
  assert(ref.bytes > 0)
  assert.match(ref.sha256, /^[a-f0-9]{64}$/)
  assert(existsSync(ref.uri), 'artifact envelope should be written to disk')
  assert.equal(await store.exists(ref), true)

  const envelope = await store.read(ref)
  assert.equal(envelope.schemaVersion, 'stored-tool-result/v1')
  assert.deepEqual(envelope.content, content)
  assert.deepEqual(envelope.ref, ref)
  assert.deepEqual(envelope.metadata, {
    pageUrl: 'https://example.test/form',
    workflowPhase: 'fill_form',
    riskLevel: 'L1',
    policyCode: 'policy.low_risk.allow',
  })

  await assert.rejects(
    () => store.read({ ...ref, sha256: '0'.repeat(64) }),
    /ref mismatch/,
  )

  const originalEnvelopeText = readFileSync(ref.uri, 'utf8')
  const originalEnvelope = JSON.parse(originalEnvelopeText)

  writeFileSync(ref.uri, `${JSON.stringify({
    ...originalEnvelope,
    ref: { ...originalEnvelope.ref, sessionId: 'tampered-session' },
  }, null, 2)}\n`)
  await assert.rejects(
    () => store.read(ref),
    /ref mismatch/,
  )

  writeFileSync(ref.uri, `${JSON.stringify({
    ...originalEnvelope,
    content: { ...content, note: 'tampered full payload' },
  }, null, 2)}\n`)
  await assert.rejects(
    () => store.read(ref),
    /integrity check failed/,
  )

  writeFileSync(ref.uri, originalEnvelopeText)
  assert.deepEqual((await store.read(ref)).content, content)

  const screenshotRef = await store.write({
    runId: 'run-tool-result-store-test',
    sessionId: 'session-tool-result-store-test',
    toolCallId: 'call-002',
    toolName: 'browser_screenshot',
    kind: 'browser_screenshot',
    content: Buffer.from('fake-png-bytes'),
    sensitivity: 'personal',
  })
  assert.equal(screenshotRef.mediaType, 'image/png')
  const screenshotEnvelope = await store.read(screenshotRef)
  assert.deepEqual(screenshotEnvelope.content, {
    encoding: 'base64',
    data: Buffer.from('fake-png-bytes').toString('base64'),
  })

  console.log('tool-result-store-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
