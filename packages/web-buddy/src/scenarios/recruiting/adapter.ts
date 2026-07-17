import { emptyRunMetrics } from '../../metrics/schema.js'
import { runWebTask } from '../../sdk/web-task.js'
import type { AgentRunResult, RunOptions } from '../../sdk/orchestrator.js'
import type {
  CompletionCriterion,
  EvidenceRef,
  TaskContract,
  WebTaskResult,
  WebTaskRuntimeOutcome,
} from '../../task/contracts.js'
import type { WebBuddyTaskType } from '../../workflow/completion-gate.js'

export type LegacyRecruitingExecutor = (options: RunOptions) => Promise<AgentRunResult>

export async function runRecruitingCompatibilityTask(
  options: RunOptions,
  executeLegacy: LegacyRecruitingExecutor,
): Promise<AgentRunResult> {
  const runId = options.runId ?? `legacy-recruiting-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')}`
  let legacyResult: AgentRunResult | undefined
  const contract = recruitingTaskContract(options.taskType ?? defaultLegacyTaskType(options.mode))
  const webResult = await runWebTask({
    schemaVersion: 'web-task-input/v1',
    goal: {
      instruction: options.taskPrompt ?? legacyGoal(options),
      scenario: 'recruiting',
      metadata: { legacyMode: options.mode ?? 'fill' },
    },
    contract,
    runId,
    revision: contract.revision,
    runtime: {
      driver: {
        async execute(request): Promise<WebTaskRuntimeOutcome> {
          legacyResult = await executeLegacy({ ...options, runId })
          const status = legacyStatus(legacyResult)
          const evidence = status === 'completed' ? [legacyResultEvidence(request.input.runId, request.input.revision, legacyResult)] : []
          return {
            status,
            summary: legacyResult.message,
            evidence,
            artifacts: [],
            metrics: emptyRunMetrics({
              runId: request.input.runId,
              sessionId: legacyResult.session?.sessionId,
              source: 'sdk',
              scenario: 'recruiting',
              profile: 'legacy-adapter',
            }),
            ...(legacyResult.session ? {
              sessionRef: {
                schemaVersion: 'session-ref/v1',
                provider: 'legacy-agent-session',
                id: legacyResult.session.sessionId,
                runId: request.input.runId,
                attempt: 1,
              },
            } : {}),
          }
        },
      },
    },
  })
  if (!legacyResult) throw new Error(`Recruiting compatibility runtime did not produce a legacy result: ${webResult.summary}`)
  return mapWebTaskResultToLegacy(webResult, legacyResult)
}

export function recruitingTaskContract(taskType: WebBuddyTaskType): TaskContract {
  return {
    schemaVersion: 'web-task-contract/v1',
    contractId: `recruiting-${taskType}-compatibility`,
    revision: 0,
    criteria: [
      ...legacyTaskCriteria(taskType),
      {
        id: 'legacy-result',
        kind: 'evidence_present',
        description: 'The recruiting scenario adapter must produce a verified terminal result.',
        evidenceKinds: ['legacy_recruiting_result'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      },
    ],
  }
}

export function legacyTaskCriteria(taskType: WebBuddyTaskType): CompletionCriterion[] {
  if (taskType === 'explore') {
    return [{
      id: 'legacy-page-observed',
      kind: 'evidence_present',
      description: 'Observe the target page through the Main runtime.',
      evidenceKinds: ['legacy_recruiting_result'],
      minCount: 1,
      allowedAuthorities: ['main_runtime'],
    }]
  }
  if (taskType === 'apply_entry') {
    return [{
      id: 'legacy-application-entry',
      kind: 'evidence_present',
      description: 'Verify the recruiting application entry state.',
      evidenceKinds: ['legacy_recruiting_result'],
      minCount: 1,
      allowedAuthorities: ['main_runtime'],
    }]
  }
  if (taskType === 'final_review') {
    return [{
      id: 'legacy-final-review-confirmation',
      kind: 'human_confirmation',
      description: 'Final review requires explicit human confirmation.',
      confirmationKind: 'final_review',
    }]
  }
  return [{
    id: 'legacy-form-draft',
    kind: 'evidence_present',
    description: 'Verify the recruiting form draft through the scenario adapter.',
    evidenceKinds: ['legacy_recruiting_result'],
    minCount: 1,
    allowedAuthorities: ['main_runtime'],
  }]
}

function mapWebTaskResultToLegacy(webResult: WebTaskResult, legacy: AgentRunResult): AgentRunResult {
  if (webResult.status === 'failed' && legacy.finalState !== 'error') {
    return { ...legacy, finalState: 'error', message: webResult.summary }
  }
  return legacy
}

function legacyResultEvidence(runId: string, revision: number, result: AgentRunResult): EvidenceRef {
  const createdAt = new Date().toISOString()
  return {
    schemaVersion: 'evidence-ref/v1',
    id: `legacy-result-${runId}`,
    kind: 'legacy_recruiting_result',
    summary: result.message,
    authority: 'main_runtime',
    origin: 'derived',
    trust: 'trusted_runtime',
    sensitivity: 'internal',
    provenance: { capturedAt: createdAt, parentContentIds: [], runId, ...(result.session ? { sessionId: result.session.sessionId } : {}) },
    freshness: { validity: 'current', revision },
    independentlyObserved: true,
    spoofableTextOnly: false,
    binding: { runId, revision },
    verifier: 'recruiting-scenario-adapter/v1',
    verificationStatus: 'verified',
    createdAt,
  }
}

function legacyStatus(result: AgentRunResult): WebTaskRuntimeOutcome['status'] {
  if (result.finalState === 'error') return 'failed'
  if (['blocked', 'login_required', 'no_jobs', 'no_match', 'stopped_at_submit', 'direct_submit_review'].includes(result.finalState)) return 'blocked'
  return 'completed'
}

function defaultLegacyTaskType(mode: RunOptions['mode']): WebBuddyTaskType {
  return mode === 'raw' || mode === 'match' || mode === 'demo-research' ? 'explore' : 'fill_form'
}

function legacyGoal(options: RunOptions): string {
  if (options.mode === 'demo-research') return 'Run the offline read-only research demo.'
  if (options.mode === 'match') return 'Match the resume to visible job postings and stop before application handoff.'
  return 'Run the legacy recruiting workflow through the generic WebTask compatibility adapter.'
}
