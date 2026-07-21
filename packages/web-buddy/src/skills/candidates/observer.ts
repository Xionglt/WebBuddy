import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { WebTaskResult } from '../../task/contracts.js'
import type { SkillGenerationRequestV1 } from './contracts.js'
import {
  FileSkillCandidateStore,
  defaultSkillCandidateRoot,
  generationRequestId,
} from './store.js'

export type SkillLearningObservation =
  | { status: 'disabled' | 'skipped' }
  | { status: 'persisted'; requestPath: string }

export async function observeCompletedWebTaskResult(
  result: WebTaskResult,
  options: {
    env?: Record<string, string | undefined>
    store?: FileSkillCandidateStore
    now?: () => Date
  } = {},
): Promise<SkillLearningObservation> {
  const env = options.env ?? process.env
  if (env.WEB_BUDDY_SKILL_LEARNING_ENABLED !== 'true') return { status: 'disabled' }
  if (result.status !== 'completed' || result.ownerScope) return { status: 'skipped' }
  if (!result.metrics.traceDir || !result.metrics.sessionId) return { status: 'skipped' }

  const sessionId = result.sessionRef?.id ?? result.metrics.sessionId
  const attempt = result.sessionRef?.attempt ?? 1
  const outcomes = result.artifacts.filter((artifact) => (
    artifact.kind === 'runtime_outcome'
    && artifact.payloadSchemaVersion === 'generic-runtime-outcome/v1'
    && artifact.binding.runId === result.runId
    && artifact.binding.revision === result.revision
    && (result.sessionRef
      ? artifact.binding.sessionRef?.id === sessionId
        && artifact.binding.sessionRef?.runId === result.runId
        && artifact.binding.sessionRef?.attempt === attempt
      : artifact.binding.sessionRef === undefined)
  ))
  if (outcomes.length !== 1) return { status: 'skipped' }
  const outcome = outcomes[0]

  const requestSeed = {
    runId: result.runId,
    revision: result.revision,
    sessionId,
    attempt,
    outcomeArtifactId: outcome.id,
    outcomeSha256: outcome.sha256,
  }
  const request: SkillGenerationRequestV1 = {
    schemaVersion: 'skill-generation-request/v1',
    requestId: generationRequestId(requestSeed),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    ...requestSeed,
    traceSessionId: result.metrics.sessionId,
    resultStatus: 'completed',
    requestedScope: 'project',
  }
  const store = options.store ?? new FileSkillCandidateStore({
    rootDir: defaultSkillCandidateRoot(env),
    now: options.now,
    env,
  })
  const existingPath = join(
    result.metrics.traceDir,
    'skill-learning',
    'requests',
    `${request.requestId}.json`,
  )
  try {
    const existing = await store.readRequest(existingPath)
    const { createdAt: _existingCreatedAt, ...existingBound } = existing
    const { createdAt: _requestCreatedAt, ...requestBound } = request
    if (!isDeepStrictEqual(existingBound, requestBound)) {
      throw new Error('GENERATION_REQUEST_CONFLICT: request id is bound to different evidence')
    }
    return { status: 'persisted', requestPath: existingPath }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  const requestPath = await store.writeRequest(result.metrics.traceDir, request)
  return { status: 'persisted', requestPath }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}
