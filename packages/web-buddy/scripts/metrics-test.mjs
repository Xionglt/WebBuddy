import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRunManifest,
  writeRunManifest,
} from '../dist/metrics/trace-inputs.js'
import { aggregateMetrics } from '../dist/metrics/aggregate.js'
import { generateAndWriteMetrics } from '../dist/metrics/writer.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-metrics-'))

try {
  const outputDir = join(root, 'output')

  // Manifest + agent-trace spans path.
  {
    const runId = 'runtime-metrics'
    const sessionId = `claude_${runId}`
    const runDir = join(outputDir, 'claude-runtime', runId)
    const traceDir = join(outputDir, 'traces', sessionId)
    mkdirSync(runDir, { recursive: true })
    mkdirSync(traceDir, { recursive: true })

    const sessionJson = join(traceDir, 'session.json')
    const spansJsonl = join(traceDir, 'spans.jsonl')
    const eventsJsonl = join(traceDir, 'events.jsonl')
    const stdoutLog = join(runDir, 'stdout.log')
    const stderrLog = join(runDir, 'stderr.log')
    const runLog = join(runDir, 'run-events.log')
    const prompt = join(runDir, 'prompt.redacted.txt')

    writeFileSync(sessionJson, JSON.stringify({
      schemaVersion: 'agent-trace/v1',
      sessionId,
      runId,
      source: 'claude-runtime',
      scenario: 'generic-web',
      profile: 'debug',
      status: 'success',
      startedAt: '2026-06-23T00:00:00.000Z',
      endedAt: '2026-06-23T00:00:02.500Z',
      totals: {
        spans: 5,
        llmCalls: 1,
        toolCalls: 1,
        mcpToolCalls: 2,
        screenshots: 1,
      },
    }))
    writeFileSync(spansJsonl, [
      span({ spanType: 'llm_call', name: 'llm.chat' }),
      span({ spanType: 'tool_call', name: 'browser_snapshot', toolName: 'browser_snapshot' }),
      span({ spanType: 'mcp_tool_call', name: 'browser_click', toolName: 'browser_click' }),
      span({ spanType: 'mcp_tool_call', name: 'browser_wait', toolName: 'browser_wait' }),
      span({ spanType: 'screenshot', name: 'page_screenshot' }),
    ].join('\n') + '\n')
    writeFileSync(eventsJsonl, `${JSON.stringify({ event: 'WEB_HANDOFF_WAITING', data: {} })}\n`)
    writeFileSync(stdoutLog, 'hello stdout')
    writeFileSync(stderrLog, 'warn')
    writeFileSync(runLog, 'event')
    writeFileSync(prompt, 'prompt text')
    writeRunManifest(buildRunManifest({
      runId,
      sessionId,
      source: 'claude-runtime',
      scenario: 'generic-web',
      profile: 'debug',
      runDir,
      traceDir,
      files: {
        sessionJson,
        spansJsonl,
        eventsJsonl,
        stdoutLog,
        stderrLog,
        runLog,
        prompt,
      },
    }))

    const result = generateAndWriteMetrics({ runId, outputDir })
    assert.equal(result.path, join(traceDir, 'metrics.json'))
    assert.equal(existsSync(result.path), true)
    assert.equal(result.metrics.runDir, runDir)
    assert.equal(result.metrics.traceDir, traceDir)
    assert.equal(result.metrics.profile, 'debug')
    assert.equal(result.metrics.status, 'completed')
    assert.equal(result.metrics.durationMs, 2500)
    assert.equal(result.metrics.llmCalls, 1)
    assert.equal(result.metrics.toolCalls, 1)
    assert.equal(result.metrics.mcpToolCalls, 2)
    assert.equal(result.metrics.observationToolCalls, 1)
    assert.equal(result.metrics.actionToolCalls, 2)
    assert.equal(result.metrics.humanToolCalls, 0)
    assert.equal(result.metrics.evalToolCalls, 0)
    assert.equal(result.metrics.browserSnapshots, 1)
    assert.equal(result.metrics.browserClicks, 1)
    assert.equal(result.metrics.browserWaits, 1)
    assert.equal(result.metrics.screenshots, 1)
    assert.equal(result.metrics.manualHandoffs, 1)
    assert.equal(result.metrics.stdoutBytes, Buffer.byteLength('hello stdout'))
    assert.equal(JSON.parse(readFileSync(result.path, 'utf8')).schemaVersion, 'run-metrics/v1')
  }

  // Legacy trace path counts browser actions only when spans are absent.
  {
    const runId = 'legacy-metrics'
    const sessionId = `run_${runId}`
    const traceDir = join(outputDir, 'traces', sessionId)
    const legacyTraceDir = join(outputDir, runId)
    mkdirSync(traceDir, { recursive: true })
    mkdirSync(legacyTraceDir, { recursive: true })

    writeFileSync(join(traceDir, 'session.json'), JSON.stringify({
      sessionId,
      runId,
      source: 'trace-recorder',
      scenario: 'demo-form',
      profile: 'benchmark',
      status: 'cancelled',
      startedAt: '2026-06-23T00:00:00.000Z',
      endedAt: '2026-06-23T00:00:01.000Z',
      totals: {},
    }))
    writeFileSync(join(legacyTraceDir, 'trace.jsonl'), [
      JSON.stringify({ step: 1, phase: 'agent_loop', action: 'browser_snapshot()', status: 'ok' }),
      JSON.stringify({ step: 2, phase: 'agent_loop', action: 'browser_type(ref)', status: 'warn', screenshotPath: 'shot.png' }),
    ].join('\n') + '\n')
    writeFileSync(join(legacyTraceDir, 'summary.json'), JSON.stringify({
      runId,
      steps: 2,
      screenshots: 1,
      finalStatus: 'warn',
    }))

    const result = generateAndWriteMetrics({ runId, outputDir, source: 'local-runtime' })
    assert.equal(result.metrics.source, 'local-runtime')
    assert.equal(result.metrics.scenario, 'demo-form')
    assert.equal(result.metrics.profile, 'benchmark')
    assert.equal(result.metrics.status, 'incomplete')
    assert.equal(result.metrics.durationMs, 1000)
    assert.equal(result.metrics.legacySteps, 2)
    assert.equal(result.metrics.toolCalls, 2)
    assert.equal(result.metrics.observationToolCalls, 1)
    assert.equal(result.metrics.actionToolCalls, 1)
    assert.equal(result.metrics.humanToolCalls, 0)
    assert.equal(result.metrics.evalToolCalls, 0)
    assert.equal(result.metrics.browserSnapshots, 1)
    assert.equal(result.metrics.browserTypes, 1)
    assert.equal(result.metrics.screenshots, 1)
  }

  // Missing files are reflected as warnings; aggregation still returns metrics.
  {
    const metrics = aggregateMetrics({
      runId: 'missing',
      source: 'unknown',
      files: {},
      warnings: ['missing fixture'],
    })
    assert.equal(metrics.status, 'unknown')
    assert.equal(metrics.observationToolCalls, 0)
    assert.equal(metrics.actionToolCalls, 0)
    assert.equal(metrics.humanToolCalls, 0)
    assert.equal(metrics.evalToolCalls, 0)
    assert.deepEqual(metrics.warnings, ['missing fixture'])
  }

  console.log('metrics-test: PASS')
} finally {
  rmSync(root, { recursive: true, force: true })
}

function span(input) {
  return JSON.stringify({
    schemaVersion: 'agent-trace/v1',
    sessionId: 'test',
    spanId: `span_${Math.random().toString(16).slice(2)}`,
    status: 'success',
    startedAt: '2026-06-23T00:00:00.000Z',
    endedAt: '2026-06-23T00:00:00.100Z',
    latencyMs: 100,
    ...input,
  })
}
