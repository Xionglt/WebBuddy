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

  const outcome = result.artifacts.find((artifact) => (
    artifact.kind === 'runtime_outcome'
    && artifact.payloadSchemaVersion === 'generic-runtime-outcome/v1'
    && artifact.binding.runId === result.runId
    && artifact.binding.revision === result.revision
  ))
  if (!outcome) return { status: 'skipped' }

  const sessionId = result.sessionRef?.id ?? result.metrics.sessionId
  const attempt = result.sessionRef?.attempt ?? 1
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
  })
  const requestPath = await store.writeRequest(result.metrics.traceDir, request)
  return { status: 'persisted', requestPath }
}
