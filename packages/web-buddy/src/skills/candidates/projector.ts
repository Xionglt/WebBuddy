import { createHash } from 'node:crypto'
import {
  lstat,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertProjectedSkillEvidence,
  assertSkillGenerationRequest,
  type ProjectedSkillEvidenceV1,
  type SkillGenerationRequestV1,
  type ValidationFindingV1,
} from './contracts.js'

const REQUIRED_TRACE_FILES = ['session.json', 'spans.jsonl', 'events.jsonl', 'DONE'] as const
const EXCLUDED_REUSABLE_TOOLS = new Set(['agent_done', 'ask_user'])
const REDACTION_MARKER = /\[(?:redacted|email:redacted|phone:redacted|path:redacted|REDACTED:[^\]]*)\]/i
const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024
const MAX_TRACE_RECORDS = 4096
const MAX_PROJECTED_ITEMS = 64

export type SkillEvidenceProjectionResult =
  | { eligible: true; evidence: ProjectedSkillEvidenceV1 }
  | { eligible: false; findings: ValidationFindingV1[] }

export async function projectSkillEvidence(input: {
  traceDir: string
  request: SkillGenerationRequestV1
}): Promise<SkillEvidenceProjectionResult> {
  try {
    assertSkillGenerationRequest(input.request)
  } catch (error) {
    return ineligible('INVALID_GENERATION_REQUEST', '$.request', errorMessage(error))
  }

  try {
    return await projectEligibleEvidence(input)
  } catch (error) {
    if (error instanceof ProjectionError) {
      return ineligible(error.code, error.path, error.message)
    }
    throw error
  }
}

async function projectEligibleEvidence(input: {
  traceDir: string
  request: SkillGenerationRequestV1
}): Promise<SkillEvidenceProjectionResult> {
  const traceDirInput = resolve(input.traceDir)
  const traceRootStats = await lstatOrProjection(traceDirInput, 'TRACE_NOT_FOUND', '$.traceDir')
  if (traceRootStats.isSymbolicLink() || !traceRootStats.isDirectory()) {
    throw projectionError('UNSAFE_TRACE_DIRECTORY', '$.traceDir', 'Trace directory must be a real directory.')
  }
  const traceRoot = await realpath(traceDirInput)
  const required = Object.fromEntries(await Promise.all(
    REQUIRED_TRACE_FILES.map(async (name) => [
      name,
      await safeTraceFile(traceRoot, name),
    ]),
  )) as Record<(typeof REQUIRED_TRACE_FILES)[number], string>

  const requestPath = await safeTraceFile(
    traceRoot,
    join('skill-learning', 'requests', `${input.request.requestId}.json`),
  )
  const persistedRequest = parseJson(
    await readFile(requestPath, 'utf8'),
    'GENERATION_REQUEST_JSON_INVALID',
    '$.request',
  )
  try {
    assertSkillGenerationRequest(persistedRequest)
  } catch (error) {
    throw projectionError('GENERATION_REQUEST_INVALID', '$.request', errorMessage(error))
  }
  if (canonicalJson(persistedRequest) !== canonicalJson(input.request)) {
    throw projectionError(
      'GENERATION_REQUEST_MISMATCH',
      '$.request',
      'Persisted generation request does not match the supplied request.',
    )
  }

  const sessionRaw = await readFile(required['session.json'], 'utf8')
  const spansRaw = await readFile(required['spans.jsonl'], 'utf8')
  const eventsRaw = await readFile(required['events.jsonl'], 'utf8')
  const session = asRecord(parseJson(sessionRaw, 'TRACE_SESSION_JSON_INVALID', '$.session'))
  const spans = parseJsonl(spansRaw, '$.spans')
  const events = parseJsonl(eventsRaw, '$.events')
  validateTraceIdentity(session, spans, events, input.request)
  rejectUnsafeTracePayloads(session, spans, events)

  const outcome = await loadUniqueOutcomeArtifact(traceRoot, input.request)
  const runtimeSessionId = await validateOutcome(outcome, input.request, traceRoot)

  const resolvedPath = await safeTraceFile(traceRoot, join('artifacts', 'resolved-skills.json'))
  const resolvedRaw = await readFile(resolvedPath, 'utf8')
  const resolved = asRecord(parseJson(
    resolvedRaw,
    'RESOLVED_SKILLS_JSON_INVALID',
    '$.resolvedSkills',
  ))
  validateResolvedSkills(resolved, input.request, runtimeSessionId)
  validateSkillResolutionEvent(events, runtimeSessionId)

  const successfulSpans = spans.filter((span) => {
    const item = asRecord(span)
    return (item.spanType === 'tool_call' || item.spanType === 'mcp_tool_call')
      && item.status === 'success'
      && typeof item.toolName === 'string'
      && !EXCLUDED_REUSABLE_TOOLS.has(item.toolName)
  })
  if (successfulSpans.length === 0) {
    throw projectionError(
      'NO_REUSABLE_TOOL_STEP',
      '$.spans',
      'Trace does not contain a reusable successful tool step.',
    )
  }
  assertItemLimit(successfulSpans, '$.spans')

  const outcomeContent = asRecord(outcome.envelope.content)
  const actionItems = arrayOfRecords(outcomeContent.actions, '$.outcome.actions')
  assertItemLimit(actionItems, '$.outcome.actions')
  const actions = actionItems.map((action, index) => ({
    actionKind: requiredString(action.actionKind, `$.outcome.actions[${index}].actionKind`),
    outcome: requiredString(action.outcome, `$.outcome.actions[${index}].outcome`),
  }))
  const resolvedSkillItems = arrayOfRecords(resolved.skills, '$.resolvedSkills.skills')
  assertItemLimit(resolvedSkillItems, '$.resolvedSkills.skills')
  const evidence: ProjectedSkillEvidenceV1 = {
    schemaVersion: 'projected-skill-evidence/v1',
    runId: input.request.runId,
    revision: input.request.revision,
    sessionId: input.request.sessionId,
    attempt: input.request.attempt,
    task: inferBoundedTaskContext(resolvedSkillItems),
    successfulTools: successfulSpans.map((span, index) => {
      const item = asRecord(span)
      return {
        sequence: index + 1,
        toolName: requiredString(item.toolName, `$.spans[${index}].toolName`),
        ...(typeof item.toolCategory === 'string' && item.toolCategory.trim()
          ? { toolCategory: bounded(item.toolCategory, `$.spans[${index}].toolCategory`) }
          : {}),
      }
    }),
    actions,
    resolvedSkills: resolvedSkillItems.map((skill, index) => ({
      id: requiredString(skill.id, `$.resolvedSkills.skills[${index}].id`),
      source: requiredString(skill.source, `$.resolvedSkills.skills[${index}].source`),
      reason: normalizedSkillReason(skill.reason),
      ...(typeof skill.bodyHash === 'string' ? { bodyHash: skill.bodyHash } : {}),
    })),
    source: {
      outcomeArtifactId: input.request.outcomeArtifactId,
      outcomeSha256: input.request.outcomeSha256,
      traceSha256: hashNamedFiles([
        ['session.json', sessionRaw],
        ['spans.jsonl', spansRaw],
        ['events.jsonl', eventsRaw],
      ]),
      resolvedSkillsSha256: sha256(resolvedRaw),
    },
  }
  try {
    assertProjectedSkillEvidence(evidence)
  } catch (error) {
    throw projectionError('PROJECTED_EVIDENCE_INVALID', '$.evidence', errorMessage(error))
  }
  return { eligible: true, evidence }
}

interface LocatedOutcome {
  path: string
  runtimeSessionDirectory: string
  envelope: Record<string, unknown>
}

async function loadUniqueOutcomeArtifact(
  traceRoot: string,
  request: SkillGenerationRequestV1,
): Promise<LocatedOutcome> {
  const storeRoot = join(traceRoot, 'artifacts', 'tool-results')
  const rootStats = await lstatOrProjection(
    storeRoot,
    'OUTCOME_ARTIFACT_NOT_FOUND',
    '$.outcome',
  )
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw projectionError(
      'UNSAFE_OUTCOME_ARTIFACT_PATH',
      '$.outcome',
      'Tool-result artifact root must be a real directory.',
    )
  }
  const canonicalStoreRoot = await realpath(storeRoot)
  const matches: LocatedOutcome[] = []
  for (const sessionEntry of await readdir(canonicalStoreRoot, { withFileTypes: true })) {
    if (sessionEntry.isSymbolicLink()) {
      throw projectionError(
        'UNSAFE_OUTCOME_ARTIFACT_PATH',
        '$.outcome',
        'Outcome artifact session directories cannot be symbolic links.',
      )
    }
    if (!sessionEntry.isDirectory()) continue
    const sessionDir = join(canonicalStoreRoot, sessionEntry.name)
    const runDir = join(sessionDir, request.runId)
    let runStats
    try {
      runStats = await lstat(runDir)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    if (runStats.isSymbolicLink() || !runStats.isDirectory()) {
      throw projectionError(
        'UNSAFE_OUTCOME_ARTIFACT_PATH',
        '$.outcome',
        'Outcome run directory must be a real directory.',
      )
    }
    const canonicalRunDir = await realpath(runDir)
    assertWithin(canonicalRunDir, canonicalStoreRoot, 'UNSAFE_OUTCOME_ARTIFACT_PATH', '$.outcome')
    const candidatePath = join(canonicalRunDir, `${request.outcomeArtifactId}.json`)
    let candidateStats
    try {
      candidateStats = await lstat(candidatePath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    if (candidateStats.isSymbolicLink() || !candidateStats.isFile()) {
      throw projectionError(
        'UNSAFE_OUTCOME_ARTIFACT_PATH',
        '$.outcome',
        'Outcome artifact must be a regular file.',
      )
    }
    assertFileSize(candidateStats.size, '$.outcome')
    const canonicalCandidate = await realpath(candidatePath)
    assertWithin(canonicalCandidate, canonicalStoreRoot, 'UNSAFE_OUTCOME_ARTIFACT_PATH', '$.outcome')
    const raw = await readFile(canonicalCandidate, 'utf8')
    const envelope = asRecord(parseJson(raw, 'OUTCOME_ARTIFACT_JSON_INVALID', '$.outcome'))
    matches.push({
      path: canonicalCandidate,
      runtimeSessionDirectory: sessionEntry.name,
      envelope,
    })
  }
  if (matches.length === 0) {
    throw projectionError(
      'OUTCOME_ARTIFACT_NOT_FOUND',
      '$.outcome',
      'No outcome artifact matches this request.',
    )
  }
  if (matches.length !== 1) {
    throw projectionError(
      'OUTCOME_ARTIFACT_AMBIGUOUS',
      '$.outcome',
      'More than one outcome artifact matches this request.',
    )
  }
  return matches[0]
}

async function validateOutcome(
  outcome: LocatedOutcome,
  request: SkillGenerationRequestV1,
  traceRoot: string,
): Promise<string> {
  const envelope = outcome.envelope
  if (envelope.schemaVersion !== 'stored-tool-result/v1') {
    throw projectionError(
      'OUTCOME_ARTIFACT_SCHEMA_MISMATCH',
      '$.outcome.schemaVersion',
      'Outcome envelope uses an unsupported schema.',
    )
  }
  const ref = asRecord(envelope.ref)
  const content = asRecord(envelope.content)
  const runtimeSessionId = requiredString(ref.sessionId, '$.outcome.ref.sessionId')
  if (
    ref.schemaVersion !== 'tool-result-artifact-ref/v1'
    || ref.artifactId !== request.outcomeArtifactId
    || ref.runId !== request.runId
    || runtimeSessionId !== outcome.runtimeSessionDirectory
    || ref.toolName !== 'generic_runtime'
    || ref.kind !== 'generic_json'
    || ref.sha256 !== request.outcomeSha256
  ) {
    throw projectionError(
      'OUTCOME_ARTIFACT_BINDING_MISMATCH',
      '$.outcome.ref',
      'Outcome artifact ref does not match the generation request.',
    )
  }
  const redactionStatus = asRecord(ref.redaction).status
  if (
    ref.sensitivity === 'secret'
    || redactionStatus === 'redacted'
    || redactionStatus === 'contains_sensitive'
  ) {
    throw projectionError(
      'SOURCE_REDACTED',
      '$.outcome.ref.redaction',
      'Outcome artifact contains redacted or sensitive evidence.',
    )
  }
  const bytes = Buffer.from(JSON.stringify(content))
  if (
    ref.bytes !== bytes.length
    || sha256(bytes) !== request.outcomeSha256
  ) {
    throw projectionError(
      'OUTCOME_ARTIFACT_INTEGRITY_MISMATCH',
      '$.outcome',
      'Outcome artifact content does not match its byte length and digest.',
    )
  }
  if (
    content.schemaVersion !== 'generic-runtime-outcome/v1'
    || content.runId !== request.runId
    || content.revision !== request.revision
  ) {
    throw projectionError(
      'OUTCOME_IDENTITY_MISMATCH',
      '$.outcome.content',
      'Outcome content does not match request run and revision.',
    )
  }
  if (content.status !== 'completed') {
    throw projectionError(
      'OUTCOME_NOT_COMPLETED',
      '$.outcome.content.status',
      'Only completed runtime outcomes are eligible.',
    )
  }
  if (content.sessionRef !== undefined) {
    const sessionRef = asRecord(content.sessionRef)
    if (
      sessionRef.schemaVersion !== 'session-ref/v1'
      || sessionRef.id !== request.sessionId
      || sessionRef.runId !== request.runId
      || sessionRef.attempt !== request.attempt
      || runtimeSessionId !== request.sessionId
    ) {
      throw projectionError(
        'OUTCOME_SESSION_MISMATCH',
        '$.outcome.content.sessionRef',
        'Durable session binding does not match the generation request.',
      )
    }
  } else if (request.sessionId !== request.traceSessionId || request.attempt !== 1) {
    throw projectionError(
      'OUTCOME_SESSION_MISMATCH',
      '$.request.sessionId',
      'Non-durable outcomes must use the trace session and first attempt.',
    )
  }
  if (typeof ref.uri !== 'string' || !isAbsolute(ref.uri)) {
    throw projectionError(
      'OUTCOME_ARTIFACT_BINDING_MISMATCH',
      '$.outcome.ref.uri',
      'Outcome artifact locator must be an absolute local path.',
    )
  }
  let resolvedUri: string
  try {
    resolvedUri = await realpath(ref.uri)
  } catch {
    throw projectionError(
      'OUTCOME_ARTIFACT_BINDING_MISMATCH',
      '$.outcome.ref.uri',
      'Outcome artifact locator does not resolve to a file.',
    )
  }
  assertWithin(resolvedUri, traceRoot, 'UNSAFE_OUTCOME_ARTIFACT_PATH', '$.outcome.ref.uri')
  if (outcome.path !== resolvedUri) {
    throw projectionError(
      'OUTCOME_ARTIFACT_BINDING_MISMATCH',
      '$.outcome.ref.uri',
      'Outcome artifact locator does not match the discovered file.',
    )
  }
  return runtimeSessionId
}

function validateTraceIdentity(
  session: Record<string, unknown>,
  spans: unknown[],
  events: unknown[],
  request: SkillGenerationRequestV1,
): void {
  if (
    session.schemaVersion !== 'agent-trace/v1'
    || session.runId !== request.runId
    || session.sessionId !== request.traceSessionId
  ) {
    throw projectionError(
      'TRACE_IDENTITY_MISMATCH',
      '$.session',
      'Trace session does not match the generation request.',
    )
  }
  if (session.status !== 'success') {
    throw projectionError(
      'TRACE_NOT_SUCCESSFUL',
      '$.session.status',
      'Trace must be finalized with success.',
    )
  }
  for (const [index, spanValue] of spans.entries()) {
    const span = asRecord(spanValue)
    if (
      span.schemaVersion !== 'agent-trace/v1'
      || span.sessionId !== request.traceSessionId
      || typeof span.spanType !== 'string'
      || typeof span.name !== 'string'
      || typeof span.status !== 'string'
    ) {
      throw projectionError(
        'TRACE_SPAN_INVALID',
        `$.spans[${index}]`,
        'Trace span is missing required identity or status fields.',
      )
    }
    if (
      (span.spanType === 'tool_call' || span.spanType === 'mcp_tool_call')
      && typeof span.toolName !== 'string'
    ) {
      throw projectionError(
        'TRACE_SPAN_INVALID',
        `$.spans[${index}].toolName`,
        'Tool span is missing toolName.',
      )
    }
  }
  for (const [index, eventValue] of events.entries()) {
    const event = asRecord(eventValue)
    if (
      event.schemaVersion !== 'agent-trace/v1'
      || event.sessionId !== request.traceSessionId
      || typeof event.event !== 'string'
    ) {
      throw projectionError(
        'TRACE_EVENT_INVALID',
        `$.events[${index}]`,
        'Trace event is missing required identity fields.',
      )
    }
  }
}

function rejectUnsafeTracePayloads(
  session: Record<string, unknown>,
  spans: unknown[],
  events: unknown[],
): void {
  const values = [session, ...spans, ...events]
  if (values.some((value) => containsTruncatedPayload(value))) {
    throw projectionError(
      'TRACE_PAYLOAD_TRUNCATED',
      '$.trace',
      'Trace contains truncated payload evidence.',
    )
  }
  if (values.some((value) => REDACTION_MARKER.test(JSON.stringify(value)))) {
    throw projectionError(
      'SOURCE_REDACTED',
      '$.trace',
      'Trace contains redaction markers.',
    )
  }
  if (values.some((value) => containsRedactedArtifact(value))) {
    throw projectionError(
      'SOURCE_REDACTED',
      '$.events',
      'A referenced tool-result artifact contains redacted or sensitive data.',
    )
  }
}

function validateResolvedSkills(
  resolved: Record<string, unknown>,
  request: SkillGenerationRequestV1,
  runtimeSessionId: string,
): void {
  if (
    resolved.schemaVersion !== 'resolved-skill-context/v1'
    || resolved.runId !== request.runId
    || resolved.sessionId !== runtimeSessionId
  ) {
    throw projectionError(
      'RESOLVED_SKILLS_IDENTITY_MISMATCH',
      '$.resolvedSkills',
      'Resolved Skill context does not match the runtime outcome identity.',
    )
  }
  arrayOfRecords(resolved.skills, '$.resolvedSkills.skills')
}

function validateSkillResolutionEvent(events: unknown[], runtimeSessionId: string): void {
  const resolution = events
    .map((event) => asRecord(event))
    .find((event) => event.event === 'skill_resolution')
  if (!resolution) {
    throw projectionError(
      'SKILL_RESOLUTION_EVENT_MISSING',
      '$.events',
      'Trace is missing the Skill resolution event.',
    )
  }
  const data = tracePayloadValue(resolution.data, '$.events.skill_resolution.data')
  const item = asRecord(data)
  if (item.sessionId !== runtimeSessionId) {
    throw projectionError(
      'RESOLVED_SKILLS_IDENTITY_MISMATCH',
      '$.events.skill_resolution.data.sessionId',
      'Skill resolution event does not match the runtime session.',
    )
  }
}

function inferBoundedTaskContext(
  skills: Record<string, unknown>[],
): ProjectedSkillEvidenceV1['task'] {
  const task: ProjectedSkillEvidenceV1['task'] = {}
  for (const skill of skills) {
    if (typeof skill.reason !== 'string') continue
    const separator = skill.reason.indexOf(':')
    if (separator <= 0) continue
    const key = skill.reason.slice(0, separator)
    const rawValue = skill.reason.slice(separator + 1).trim()
    if (!rawValue || rawValue.length > 120) continue
    if (key === 'taskType' && task.taskType === undefined && /^[a-zA-Z0-9._-]+$/.test(rawValue)) {
      task.taskType = rawValue
    }
    if (
      key === 'workflowPhase'
      && task.workflowPhase === undefined
      && /^[a-zA-Z0-9._-]+$/.test(rawValue)
    ) {
      task.workflowPhase = rawValue
    }
    if (
      key === 'domain'
      && task.domain === undefined
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)*[a-z0-9](?:[a-z0-9-]{0,62})$/i.test(rawValue)
    ) {
      task.domain = rawValue.toLowerCase()
    }
  }
  return task
}

function normalizedSkillReason(value: unknown): string {
  if (value === 'autoload' || value === 'matched') return value
  if (typeof value !== 'string') return 'matched'
  const separator = value.indexOf(':')
  if (separator <= 0) return 'matched'
  const key = value.slice(0, separator)
  const rawValue = value.slice(separator + 1).trim()
  if (
    (key === 'taskType' || key === 'workflowPhase')
    && rawValue.length > 0
    && rawValue.length <= 120
    && /^[a-zA-Z0-9._-]+$/.test(rawValue)
  ) {
    return `${key}:${rawValue}`
  }
  if (
    key === 'domain'
    && rawValue.length <= 120
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)*[a-z0-9](?:[a-z0-9-]{0,62})$/i.test(rawValue)
  ) {
    return `domain:${rawValue.toLowerCase()}`
  }
  if (key === 'urlPattern') return 'urlPattern:matched'
  return 'matched'
}

function tracePayloadValue(value: unknown, path: string): unknown {
  const payload = asRecord(value)
  if (!['undefined', 'null', 'text', 'json'].includes(String(payload.kind))) {
    throw projectionError('TRACE_EVENT_INVALID', path, 'Trace payload uses an unsupported kind.')
  }
  if (payload.truncated === true) {
    throw projectionError('TRACE_PAYLOAD_TRUNCATED', path, 'Trace payload was truncated.')
  }
  return payload.value
}

function containsTruncatedPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (!Array.isArray(value)) {
    const item = value as Record<string, unknown>
    if (
      item.truncated === true
      && typeof item.kind === 'string'
      && ['undefined', 'null', 'text', 'json'].includes(item.kind)
    ) {
      return true
    }
  }
  return Object.values(value).some((item) => containsTruncatedPayload(item))
}

function containsRedactedArtifact(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (!Array.isArray(value)) {
    const item = value as Record<string, unknown>
    if (item.schemaVersion === 'tool-result-artifact-ref/v1') {
      const redaction = item.redaction && typeof item.redaction === 'object'
        ? item.redaction as Record<string, unknown>
        : {}
      if (
        item.sensitivity === 'secret'
        || redaction.status === 'redacted'
        || redaction.status === 'contains_sensitive'
      ) {
        return true
      }
    }
  }
  return Object.values(value).some((item) => containsRedactedArtifact(item))
}

async function safeTraceFile(traceRoot: string, relativePath: string): Promise<string> {
  const path = join(traceRoot, relativePath)
  const stats = await lstatOrProjection(path, fileMissingCode(relativePath), `$.trace.${relativePath}`)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw projectionError(
      'UNSAFE_TRACE_FILE',
      `$.trace.${relativePath}`,
      'Trace evidence must be a regular file.',
    )
  }
  assertFileSize(stats.size, `$.trace.${relativePath}`)
  const canonicalPath = await realpath(path)
  assertWithin(canonicalPath, traceRoot, 'UNSAFE_TRACE_FILE', `$.trace.${relativePath}`)
  return canonicalPath
}

function fileMissingCode(relativePath: string): string {
  return relativePath === 'DONE' ? 'TRACE_INCOMPLETE' : 'TRACE_FILE_MISSING'
}

async function lstatOrProjection(path: string, code: string, findingPath: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw projectionError(code, findingPath, 'Required evidence is missing.')
    }
    throw error
  }
}

function parseJson(raw: string, code: string, path: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw projectionError(code, path, 'Evidence file contains invalid JSON.')
  }
}

function parseJsonl(raw: string, path: string): unknown[] {
  const values: unknown[] = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      values.push(JSON.parse(line))
    } catch {
      throw projectionError(
        'TRACE_JSONL_INVALID',
        `${path}[${index}]`,
        'Trace JSONL contains an invalid line.',
      )
    }
    if (values.length > MAX_TRACE_RECORDS) {
      throw evidenceTooLarge(path)
    }
  }
  return values
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw projectionError('EVIDENCE_SCHEMA_INVALID', '$.evidence', 'Expected a JSON object.')
  }
  return value as Record<string, unknown>
}

function arrayOfRecords(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw projectionError('EVIDENCE_SCHEMA_INVALID', path, 'Expected an array.')
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw projectionError('EVIDENCE_SCHEMA_INVALID', `${path}[${index}]`, 'Expected an object.')
    }
    return item as Record<string, unknown>
  })
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw projectionError('EVIDENCE_SCHEMA_INVALID', path, 'Expected a non-empty string.')
  }
  return value
}

function bounded(value: string, path: string): string {
  if (value.length > 120) {
    throw projectionError('EVIDENCE_SCHEMA_INVALID', path, 'Projected string exceeds 120 characters.')
  }
  return value
}

function assertFileSize(size: number, path: string): void {
  if (size > MAX_EVIDENCE_FILE_BYTES) throw evidenceTooLarge(path)
}

function assertItemLimit(values: unknown[], path: string): void {
  if (values.length > MAX_PROJECTED_ITEMS) throw evidenceTooLarge(path)
}

function evidenceTooLarge(path: string): ProjectionError {
  return projectionError(
    'EVIDENCE_TOO_LARGE',
    path,
    'Evidence exceeds the Candidate Plane input limit.',
  )
}

function hashNamedFiles(files: Array<[string, string]>): string {
  const hash = createHash('sha256')
  for (const [name, content] of files) {
    hash.update(name)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertWithin(path: string, root: string, code: string, findingPath: string): void {
  const relation = relative(root, path)
  if (
    relation !== ''
    && (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation))
  ) {
    throw projectionError(code, findingPath, 'Evidence path escapes its allowed root.')
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const item = value as Record<string, unknown>
  return `{${Object.keys(item).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(item[key])}`
  )).join(',')}}`
}

function ineligible(code: string, path: string, message: string): SkillEvidenceProjectionResult {
  return {
    eligible: false,
    findings: [{
      schemaVersion: 'skill-candidate-finding/v1',
      severity: 'blocker',
      code,
      path,
      message,
    }],
  }
}

class ProjectionError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message)
  }
}

function projectionError(code: string, path: string, message: string): ProjectionError {
  return new ProjectionError(code, path, message)
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
