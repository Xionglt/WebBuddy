import { observationManager } from '../observation/observation-manager.js'
import type { ResumeProfile } from '../sdk/resume.js'
import type {
  ContextFreshness,
  ContextRecentAction,
  ContextSnapshot,
  ContextSnapshotInput,
  ObservationProvider,
} from './types.js'

export interface ContextManagerOptions {
  observationProvider?: ObservationProvider
  maxRecentActions?: number
  staleAfterMs?: number
}

const DEFAULT_MAX_RECENT_ACTIONS = 12
export const DEFAULT_STALE_AFTER_MS = 30_000

export class ContextManager {
  private readonly provider: ObservationProvider
  private readonly maxRecentActions: number
  private readonly staleAfterMs: number

  constructor(options: ContextManagerOptions = {}) {
    this.provider = options.observationProvider ?? observationManager
    this.maxRecentActions = options.maxRecentActions ?? DEFAULT_MAX_RECENT_ACTIONS
    this.staleAfterMs = normalizeStaleAfterMs(options.staleAfterMs)
  }

  async createSnapshot(input: ContextSnapshotInput): Promise<ContextSnapshot> {
    const [page, form] = await Promise.all([
      this.provider.getPageState(input.sessionId),
      this.provider.getFormState(input.sessionId),
    ])
    const updatedAt = input.updatedAt ?? new Date().toISOString()

    return {
      schemaVersion: 'context-snapshot/v1',
      sessionId: input.sessionId,
      goal: input.goal,
      page,
      form,
      ...(input.taskState ? { taskState: input.taskState } : {}),
      ...(input.workflowState ? { workflowState: input.workflowState } : {}),
      freshness: buildContextFreshness({
        pageStateUpdatedAt: page?.updatedAt,
        formStateUpdatedAt: form?.updatedAt,
        snapshotUpdatedAt: updatedAt,
        staleAfterMs: this.staleAfterMs,
      }),
      resumeSummary: input.resumeSummary,
      recentActions: trimRecentActions(input.recentActions ?? [], this.maxRecentActions),
      safetyNotes: [...(input.safetyNotes ?? [])],
      blockers: [...(input.blockers ?? [])],
      ...(input.extraContext ? { extraContext: input.extraContext } : {}),
      updatedAt,
    }
  }
}

export const contextManager = new ContextManager()

export function summarizeResumeProfile(profile: ResumeProfile): string {
  const exp = profile.experience
    .slice(0, 4)
    .map((item) => `- ${item.title || ''} @ ${item.company || ''} (${item.period || ''})`)
    .join('\n')
  const edu = profile.education
    .slice(0, 2)
    .map((item) => `- ${item.degree || ''} ${item.major || ''} @ ${item.school || ''}`)
    .join('\n')
  return [
    `name: ${profile.name || '(unknown)'}`,
    `email: ${profile.email || '(unknown)'}`,
    `phone: ${profile.phone || '(unknown)'}`,
    `location: ${profile.location || '(unknown)'}`,
    `skills: ${profile.skills.join(', ') || '(none)'}`,
    profile.summary ? `summary: ${profile.summary}` : '',
    exp ? `experience:\n${exp}` : '',
    edu ? `education:\n${edu}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function trimRecentActions(actions: ContextRecentAction[], maxActions = DEFAULT_MAX_RECENT_ACTIONS): ContextRecentAction[] {
  return actions.slice(Math.max(0, actions.length - maxActions))
}

interface BuildContextFreshnessInput {
  pageStateUpdatedAt?: string
  formStateUpdatedAt?: string
  snapshotUpdatedAt: string
  staleAfterMs: number
}

function buildContextFreshness(input: BuildContextFreshnessInput): ContextFreshness {
  const snapshotTimeMs = parseTimeMs(input.snapshotUpdatedAt) ?? Date.now()
  const page = freshnessForSource(input.pageStateUpdatedAt, snapshotTimeMs, input.staleAfterMs)
  const form = freshnessForSource(input.formStateUpdatedAt, snapshotTimeMs, input.staleAfterMs)

  return {
    ...(input.pageStateUpdatedAt ? { pageStateUpdatedAt: input.pageStateUpdatedAt } : {}),
    ...(input.formStateUpdatedAt ? { formStateUpdatedAt: input.formStateUpdatedAt } : {}),
    ...(page.ageMs === undefined ? {} : { pageStateAgeMs: page.ageMs }),
    ...(form.ageMs === undefined ? {} : { formStateAgeMs: form.ageMs }),
    pageStateStale: page.stale,
    formStateStale: form.stale,
    staleAfterMs: input.staleAfterMs,
  }
}

function freshnessForSource(
  sourceUpdatedAt: string | undefined,
  snapshotTimeMs: number,
  staleAfterMs: number,
): { ageMs?: number; stale: boolean } {
  const sourceTimeMs = parseTimeMs(sourceUpdatedAt)
  if (sourceTimeMs === undefined) return { stale: true }

  const ageMs = Math.max(0, snapshotTimeMs - sourceTimeMs)
  return {
    ageMs,
    stale: ageMs > staleAfterMs,
  }
}

function parseTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeStaleAfterMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_STALE_AFTER_MS
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_STALE_AFTER_MS
}
