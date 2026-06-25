import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRunManifest,
  resolveTraceInputs,
  writeRunManifest,
} from '../dist/metrics/trace-inputs.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-trace-inputs-'))

try {
  const outputDir = join(root, 'output')

  // Manifest-first Claude runtime path.
  {
    const runId = 'runtime-test'
    const sessionId = `claude_${runId}`
    const runDir = join(outputDir, 'claude-runtime', runId)
    const traceDir = join(outputDir, 'traces', sessionId)
    mkdirSync(runDir, { recursive: true })
    mkdirSync(traceDir, { recursive: true })

    const files = {
      sessionJson: join(traceDir, 'session.json'),
      spansJsonl: join(traceDir, 'spans.jsonl'),
      eventsJsonl: join(traceDir, 'events.jsonl'),
      stdoutLog: join(runDir, 'stdout.log'),
      stderrLog: join(runDir, 'stderr.log'),
      streamJsonl: join(runDir, 'stream.jsonl'),
      runLog: join(runDir, 'run-events.log'),
      prompt: join(runDir, 'prompt.redacted.txt'),
    }
    for (const [name, path] of Object.entries(files)) {
      writeFileSync(path, name.endsWith('Jsonl') ? '' : '{}')
    }
    const manifest = buildRunManifest({
      runId,
      sessionId,
      source: 'claude-runtime',
      scenario: 'generic-web',
      profile: 'debug',
      runDir,
      traceDir,
      files,
    })
    const manifestPath = writeRunManifest(manifest)

    const resolved = resolveTraceInputs({ runId, outputDir })
    assert.equal(resolved.runId, runId)
    assert.equal(resolved.sessionId, sessionId)
    assert.equal(resolved.source, 'claude-runtime')
    assert.equal(resolved.scenario, 'generic-web')
    assert.equal(resolved.profile, 'debug')
    assert.equal(resolved.runDir, runDir)
    assert.equal(resolved.traceDir, traceDir)
    assert.equal(resolved.manifestPath, manifestPath)
    assert.equal(resolved.files.spansJsonl, files.spansJsonl)
    assert.equal(resolved.warnings.length, 0)
  }

  // Legacy SDK path without manifest.
  {
    const runId = 'web-test'
    const sessionId = `run_${runId}`
    const traceDir = join(outputDir, 'traces', sessionId)
    const legacyTraceDir = join(outputDir, runId)
    mkdirSync(traceDir, { recursive: true })
    mkdirSync(legacyTraceDir, { recursive: true })

    const sessionJson = join(traceDir, 'session.json')
    const spansJsonl = join(traceDir, 'spans.jsonl')
    const eventsJsonl = join(traceDir, 'events.jsonl')
    const legacyTraceJsonl = join(legacyTraceDir, 'trace.jsonl')
    const summaryJson = join(legacyTraceDir, 'summary.json')
    writeFileSync(sessionJson, JSON.stringify({
      schemaVersion: 'agent-trace/v1',
      sessionId,
      runId,
      source: 'local-runtime',
      scenario: 'demo-form',
      profile: 'benchmark',
    }))
    writeFileSync(spansJsonl, '')
    writeFileSync(eventsJsonl, '')
    writeFileSync(legacyTraceJsonl, '')
    writeFileSync(summaryJson, '{}')

    const resolved = resolveTraceInputs({ runId, outputDir, source: 'local-runtime' })
    assert.equal(resolved.runId, runId)
    assert.equal(resolved.sessionId, sessionId)
    assert.equal(resolved.source, 'local-runtime')
    assert.equal(resolved.scenario, 'demo-form')
    assert.equal(resolved.profile, 'benchmark')
    assert.equal(resolved.files.sessionJson, sessionJson)
    assert.equal(resolved.files.legacyTraceJsonl, legacyTraceJsonl)
    assert.equal(resolved.files.summaryJson, summaryJson)
  }

  // Missing inputs are warnings, not hard failures.
  {
    const resolved = resolveTraceInputs({ runId: 'missing-run', outputDir, source: 'claude-runtime' })
    assert.equal(resolved.runId, 'missing-run')
    assert.equal(resolved.source, 'claude-runtime')
    assert(resolved.warnings.length > 0, 'missing inputs should produce warnings')
    assert.deepEqual(resolved.files, {})
  }

  console.log('trace-inputs-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}
