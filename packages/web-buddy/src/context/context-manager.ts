import { observationManager } from '../observation/observation-manager.js'
import type { ResumeProfile } from '../sdk/resume.js'
import type { ContextRecentAction, ContextSnapshot, ContextSnapshotInput, ObservationProvider } from './types.js'

export interface ContextManagerOptions {
  observationProvider?: ObservationProvider
  maxRecentActions?: number
}

const DEFAULT_MAX_RECENT_ACTIONS = 12

export class ContextManager {
  private readonly provider: ObservationProvider
  private readonly maxRecentActions: number

  constructor(options: ContextManagerOptions = {}) {
    this.provider = options.observationProvider ?? observationManager
    this.maxRecentActions = options.maxRecentActions ?? DEFAULT_MAX_RECENT_ACTIONS
  }

  async createSnapshot(input: ContextSnapshotInput): Promise<ContextSnapshot> {
    const [page, form] = await Promise.all([
      this.provider.getPageState(input.sessionId),
      this.provider.getFormState(input.sessionId),
    ])

    return {
      schemaVersion: 'context-snapshot/v1',
      sessionId: input.sessionId,
      goal: input.goal,
      page,
      form,
      resumeSummary: input.resumeSummary,
      recentActions: trimRecentActions(input.recentActions ?? [], this.maxRecentActions),
      safetyNotes: [...(input.safetyNotes ?? [])],
      blockers: [...(input.blockers ?? [])],
      ...(input.extraContext ? { extraContext: input.extraContext } : {}),
      updatedAt: input.updatedAt ?? new Date().toISOString(),
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
