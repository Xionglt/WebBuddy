import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { generationRequestId } from '../dist/skills/candidates/index.js'

export async function writeSkillCandidateFixture(root, options = {}) {
  const runId = options.runId ?? 'skill-candidate-projector-run'
  const revision = options.revision ?? 4
  const traceSessionId = options.traceSessionId ?? `run_${runId}`
  const resultSessionId = options.resultSessionId ?? traceSessionId
  const runtimeSessionId = options.runtimeSessionId ?? `web-task-${runId}`
  const attempt = options.attempt ?? 1
  const outcomeArtifactId = options.outcomeArtifactId ?? 'outcome-skill-candidate-projector'
  const traceDir = join(root, options.name ?? 'passing')
  const artifactsDir = join(traceDir, 'artifacts')
  const requestDir = join(traceDir, 'skill-learning', 'requests')
  const outcomeDir = join(artifactsDir, 'tool-results', runtimeSessionId, runId)
  await mkdir(requestDir, { recursive: true })
  await mkdir(outcomeDir, { recursive: true })

  const session = {
    schemaVersion: 'agent-trace/v1',
    sessionId: traceSessionId,
    runId,
    source: 'sdk',
    scenario: 'generic-web-task',
    profile: 'generic',
    cwd: '/fixture/project',
    status: 'success',
    startedAt: '2026-07-21T08:00:00.000Z',
    endedAt: '2026-07-21T08:01:00.000Z',
    redactionMode: 'redacted',
    totals: {
      spans: 3,
      llmCalls: 0,
      toolCalls: 3,
      mcpToolCalls: 0,
      skillCalls: 0,
      screenshots: 0,
    },
  }
  const marker = options.traceRedacted ? '[REDACTED:token]' : 'RAW_INPUT_MUST_NOT_PROJECT'
  const spans = [
    traceSpan({
      traceSessionId,
      spanId: 'span-browser-open',
      toolName: 'browser_open',
      toolCategory: 'browser',
      input: { marker, path: 'fixture/private.txt' },
    }),
    traceSpan({
      traceSessionId,
      spanId: 'span-browser-snapshot',
      toolName: 'browser_snapshot',
      toolCategory: 'browser',
      input: { pageText: 'PRIVATE_PAGE_TEXT_MUST_NOT_PROJECT' },
    }),
    traceSpan({
      traceSessionId,
      spanId: 'span-agent-done',
      toolName: 'agent_done',
      toolCategory: 'control',
      input: { summary: 'PRIVATE_SUMMARY_MUST_NOT_PROJECT' },
    }),
  ]
  for (let index = spans.length; index < (options.spanCount ?? spans.length); index += 1) {
    spans.push(traceSpan({
      traceSessionId,
      spanId: `span-fixture-${index}`,
      toolName: `fixture_tool_${index}`,
      toolCategory: 'fixture',
      input: { index },
    }))
  }
  const sourceArtifact = {
    schemaVersion: 'tool-result-artifact-ref/v1',
    artifactId: 'source-tool-result',
    runId,
    sessionId: runtimeSessionId,
    toolCallId: 'call-browser-open',
    toolName: 'browser_open',
    kind: 'generic_json',
    uri: join(outcomeDir, 'source-tool-result.json'),
    mediaType: 'application/json',
    bytes: 10,
    sha256: '9'.repeat(64),
    createdAt: '2026-07-21T08:00:20.000Z',
    retention: { scope: 'run', deleteWithSession: true },
    sensitivity: 'internal',
    redaction: {
      status: options.sourceArtifactRedacted ? 'redacted' : 'not_needed',
    },
  }
  const events = [
    traceEvent(traceSessionId, 'tool_result', {
      step: 1,
      toolName: 'browser_open',
      ok: true,
      ...(options.sourceArtifactRedacted ? { artifact: sourceArtifact } : {}),
      observation: 'RAW_OBSERVATION_MUST_NOT_PROJECT',
    }),
    traceEvent(traceSessionId, 'skill_resolution', {
      schemaVersion: 'skill-resolution-event/v1',
      sessionId: runtimeSessionId,
      skillHits: 1,
      skills: [{ id: 'builtin.explore', reason: 'taskType:explore' }],
      artifactPath: join(artifactsDir, 'resolved-skills.json'),
    }),
  ]
  for (let index = events.length; index < (options.eventCount ?? events.length); index += 1) {
    events.push(traceEvent(traceSessionId, 'fixture_event', { index }))
  }
  const resolvedSkillCount = options.resolvedSkillCount ?? 1
  const resolvedSkills = {
    schemaVersion: 'resolved-skill-context/v1',
    runId,
    sessionId: options.resolvedSessionId ?? runtimeSessionId,
    resolvedAt: '2026-07-21T08:00:10.000Z',
    skills: Array.from({ length: resolvedSkillCount }, (_, index) => ({
      id: index === 0 ? 'builtin.explore' : `builtin.fixture.${index}`,
      source: 'builtin',
      reason: index === 0 ? options.resolvedReason ?? 'taskType:explore' : 'matched',
      priority: 100,
      loadMode: 'manifest_only',
      bodyHash: '2'.repeat(64),
    })),
    promptSections: [{
      id: 'NEXT_ACTION_RULES',
      title: 'Private rules',
      content: 'PRIVATE_SKILL_PROMPT_MUST_NOT_PROJECT',
    }],
    policyHints: [],
    completionCriteria: [],
    memoryQueries: [],
    safetyInvariantDigest: {
      schemaVersion: 'safety-invariant-digest/v1',
      enforcedByRuntime: [],
      effectiveGates: [],
      ignoredRelaxations: [],
    },
  }
  const outcomeContent = {
    schemaVersion: 'generic-runtime-outcome/v1',
    runId,
    revision,
    status: options.outcomeStatus ?? 'completed',
    summary: 'PRIVATE_OUTCOME_SUMMARY_MUST_NOT_PROJECT',
    actions: Array.from({ length: options.actionCount ?? 1 }, (_, index) => ({
      actionKind: index === 0 ? 'navigate' : `fixture_action_${index}`,
      outcome: 'performed',
    })),
    ...(options.durableSession
      ? {
          sessionRef: {
            schemaVersion: 'session-ref/v1',
            provider: 'file-session-store',
            id: resultSessionId,
            runId,
            attempt,
          },
        }
      : {}),
  }
  const outcomeBytes = Buffer.from(JSON.stringify(outcomeContent))
  const outcomeSha256 = createHash('sha256').update(outcomeBytes).digest('hex')
  const outcomeRef = {
    schemaVersion: 'tool-result-artifact-ref/v1',
    artifactId: outcomeArtifactId,
    runId,
    sessionId: runtimeSessionId,
    toolCallId: `runtime-outcome:${attempt}`,
    toolName: 'generic_runtime',
    kind: 'generic_json',
    uri: join(outcomeDir, `${outcomeArtifactId}.json`),
    mediaType: 'application/json',
    bytes: outcomeBytes.length,
    sha256: outcomeSha256,
    createdAt: '2026-07-21T08:01:00.000Z',
    retention: { scope: 'run', deleteWithSession: true },
    sensitivity: 'internal',
    redaction: { status: 'not_needed' },
  }
  const outcomeEnvelope = {
    schemaVersion: 'stored-tool-result/v1',
    ref: outcomeRef,
    content: outcomeContent,
    ...(options.outcomePaddingBytes
      ? { fixturePadding: 'x'.repeat(options.outcomePaddingBytes) }
      : {}),
  }
  const requestSeed = {
    runId,
    revision,
    sessionId: resultSessionId,
    attempt,
    outcomeArtifactId,
    outcomeSha256,
  }
  const request = {
    schemaVersion: 'skill-generation-request/v1',
    requestId: generationRequestId(requestSeed),
    createdAt: '2026-07-21T08:01:01.000Z',
    ...requestSeed,
    traceSessionId,
    resultStatus: 'completed',
    requestedScope: 'project',
  }

  await writeJson(join(traceDir, 'session.json'), session)
  await writeJsonl(join(traceDir, 'spans.jsonl'), spans)
  if (options.spansPaddingBytes) {
    await writeFile(
      join(traceDir, 'spans.jsonl'),
      ` ${' '.repeat(options.spansPaddingBytes)}`,
      { encoding: 'utf8', flag: 'a' },
    )
  }
  await writeJsonl(join(traceDir, 'events.jsonl'), events)
  await writeJson(join(artifactsDir, 'resolved-skills.json'), resolvedSkills)
  const outcomePath = join(outcomeDir, `${outcomeArtifactId}.json`)
  await writeJson(outcomePath, outcomeEnvelope)
  const requestPath = join(requestDir, `${request.requestId}.json`)
  await writeJson(requestPath, request)
  if (!options.missingDone) await writeFile(join(traceDir, 'DONE'), '', 'utf8')

  if (options.duplicateOutcome) {
    const duplicateDir = join(artifactsDir, 'tool-results', 'duplicate-runtime-session', runId)
    await mkdir(duplicateDir, { recursive: true })
    await writeJson(join(duplicateDir, `${outcomeArtifactId}.json`), outcomeEnvelope)
  }

  return {
    traceDir,
    request,
    requestPath,
    outcomePath,
    runtimeSessionId,
  }
}

export async function removeFixture(path) {
  await rm(path, { recursive: true, force: true })
}

function traceSpan({ traceSessionId, spanId, toolName, toolCategory, input }) {
  return {
    schemaVersion: 'agent-trace/v1',
    sessionId: traceSessionId,
    spanId,
    spanType: 'tool_call',
    name: toolName,
    toolName,
    toolCategory,
    input: tracePayload(input),
    output: tracePayload({ ok: true, raw: 'RAW_OUTPUT_MUST_NOT_PROJECT' }),
    metadata: tracePayload({ private: 'RAW_METADATA_MUST_NOT_PROJECT' }),
    status: 'success',
    startedAt: '2026-07-21T08:00:10.000Z',
    endedAt: '2026-07-21T08:00:11.000Z',
    latencyMs: 1000,
  }
}

function traceEvent(sessionId, event, value) {
  return {
    schemaVersion: 'agent-trace/v1',
    sessionId,
    ts: '2026-07-21T08:00:30.000Z',
    event,
    data: tracePayload(value),
  }
}

function tracePayload(value) {
  const serialized = JSON.stringify(value)
  return {
    kind: 'json',
    value,
    originalBytes: Buffer.byteLength(serialized),
    sha256: createHash('sha256').update(serialized).digest('hex'),
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeJsonl(path, values) {
  await writeFile(path, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8')
}
