import { getActiveTrace } from '../agent-trace/index.js'
import { measurePromptSections, type ContextSelectionMetrics } from '../context/metrics.js'
import { contextManager } from '../context/context-manager.js'
import {
  buildPromptSections,
  renderPromptSections,
  selectPromptSections,
  SYSTEM_PROMPT_SECTION_IDS,
  USER_PROMPT_SECTION_IDS,
} from '../context/prompt-sections.js'
import type { ContextRecentAction, ContextSnapshot, PromptSection } from '../context/types.js'
import { loadSkills, resolveSkills, renderSkillPromptSection } from '../skills/index.js'
import { createDefaultTaskState } from '../task/task-state.js'
import type { AgentSafetyMode, PromptAssemblerInput } from './types.js'
import { renderContextItemsForPrompt } from '../task/context-provider.js'

export function safetyNotesFor(mode: AgentSafetyMode = 'guarded'): string[] {
  if (mode === 'raw') {
    return [
      'Operate from the task and visible website information; navigate, search, filter, compare pages, click, type, upload/select, save, and submit only when needed for the user goal.',
      'Use browser_snapshot whenever page refs may be stale. Use browser_screenshot when visual inspection would help.',
      'If the site requires a human-only credential, SMS code, captcha, payment, or identity proof that cannot be completed with available page information, stop and summarize exactly what blocked you.',
      'For any element marked risk=L3 or risk=L4, the system may require human approval before the action runs.',
      'If the task context says the current local resume file must be uploaded, an existing on-site resume is not sufficient by itself. First find the site resume/profile/application upload area, upload or re-upload the current resume file, save required changes, then continue the application flow.',
      'Application-entry buttons such as 投递简历/立即投递/Apply may open the application flow; do not treat seeing that button as task completion. Stop only before true final submission controls such as 确认投递/提交申请/final submit.',
    ]
  }

  return renderSkillPromptSection(resolveSkills(loadSkills(), {
    runId: 'compat-safety-notes',
    sessionId: 'compat-safety-notes',
    goal: '',
    safetyMode: mode,
  }), 'SAFETY_RULES')
}

export class PromptAssembler {
  private readonly promptSectionCache = new WeakMap<ContextSnapshot, PromptSectionCacheEntry>()

  async buildLoopContext(
    input: PromptAssemblerInput,
    recentActions: ContextRecentAction[],
    blockers: string[],
  ): Promise<ContextSnapshot> {
    const updatedAt = new Date().toISOString()
    const snapshot = await contextManager.createSnapshot({
      sessionId: input.ctx.sessionId,
      goal: input.goal,
      contextItems: input.contextItems,
      contextSummary: renderContextItemsForPrompt(input.contextItems ?? []),
      recentActions,
      blockers,
      extraContext: input.extraContext,
      taskState: input.taskState ?? createDefaultTaskState({ goal: input.goal, updatedAt }),
      workflowState: input.workflowState,
      runMemory: input.runMemory,
      relevantMemories: input.relevantMemories,
      fieldPlan: input.fieldPlan,
      fillLedgerSummary: input.fillLedgerSummary,
      answerSummary: input.answerSummary,
      agentTasks: input.agentTasks,
      updatedAt,
    })
    const resolvedSkillContext = resolveSkills(loadSkills(), {
      runId: process.env.AGENT_RUN_ID || input.ctx.sessionId,
      sessionId: input.ctx.sessionId,
      goal: input.goal,
      taskType: input.taskType,
      safetyMode: input.safetyMode ?? 'guarded',
      url: snapshot.page?.url,
      workflowPhase: snapshot.workflowState?.phase,
      now: new Date(updatedAt),
    })
    snapshot.resolvedSkillContext = resolvedSkillContext
    snapshot.safetyNotes = [
      ...renderSkillPromptSection(resolvedSkillContext, 'SAFETY_RULES'),
      ...safetyNotesFor(input.safetyMode ?? 'guarded').filter((note) => input.safetyMode === 'raw'),
    ]
    recordSkillResolution(snapshot)
    return snapshot
  }

  renderSystemContext(snapshot: ContextSnapshot): string {
    const sections = this.promptSectionsFor(snapshot)
    return renderPromptSections(selectPromptSections(sections, SYSTEM_PROMPT_SECTION_IDS))
  }

  renderUserContext(snapshot: ContextSnapshot): string {
    const sections = this.promptSectionsFor(snapshot)
    return renderPromptSections(selectPromptSections(sections, USER_PROMPT_SECTION_IDS))
  }

  renderInitialUserContext(snapshot: ContextSnapshot, firstView: string): string {
    const base = this.renderUserContext(snapshot)
    const pageFallback = firstView
      ? [
          'CURRENT_BROWSER_SNAPSHOT_REFS',
          firstView,
          '',
          'The page is already open. Now act on the task. If the page changes, call browser_snapshot to refresh the refs. Do NOT call browser_open unless you genuinely need a different URL.',
        ].join('\n')
      : [
          'CURRENT_BROWSER_SNAPSHOT_REFS',
          '(no page view yet)',
          '',
          'Begin. Call browser_snapshot (or browser_open with the target URL) to see the page.',
        ].join('\n')
    return `${base}\n\n${pageFallback}`
  }

  private promptSectionsFor(snapshot: ContextSnapshot): PromptSection[] {
    const cached = this.promptSectionCache.get(snapshot)
    if (cached) return cached.sections

    const sections = buildPromptSections(snapshot)
    const metrics = measurePromptSections(sections, {
      pageStateAgeMs: snapshot.freshness.pageStateAgeMs,
      formStateAgeMs: snapshot.freshness.formStateAgeMs,
    })
    this.promptSectionCache.set(snapshot, { sections })
    recordContextSelection(snapshot, metrics, sections)
    return sections
  }
}

export const promptAssembler = new PromptAssembler()

export function buildLoopContext(
  input: PromptAssemblerInput,
  recentActions: ContextRecentAction[],
  blockers: string[],
): Promise<ContextSnapshot> {
  return promptAssembler.buildLoopContext(input, recentActions, blockers)
}

export function renderSystemContext(snapshot: ContextSnapshot): string {
  return promptAssembler.renderSystemContext(snapshot)
}

export function renderUserContext(snapshot: ContextSnapshot): string {
  return promptAssembler.renderUserContext(snapshot)
}

export function renderInitialUserContext(snapshot: ContextSnapshot, firstView: string): string {
  return promptAssembler.renderInitialUserContext(snapshot, firstView)
}

interface PromptSectionCacheEntry {
  sections: PromptSection[]
}

function recordContextSelection(
  snapshot: ContextSnapshot,
  metrics: ContextSelectionMetrics,
  sections: PromptSection[],
): void {
  getActiveTrace()?.recordEvent('context_selection', {
    schemaVersion: 'context-selection-metrics/v1',
    sessionId: snapshot.sessionId,
    snapshotUpdatedAt: snapshot.updatedAt,
    sectionIds: sections.map((section) => section.id),
    ...metrics,
  })
}

function recordSkillResolution(snapshot: ContextSnapshot): void {
  const trace = getActiveTrace()
  const context = snapshot.resolvedSkillContext
  if (!trace || !context) return
  const artifactPath = trace.writeArtifact('resolved-skills.json', JSON.stringify(context, null, 2))
  trace.recordEvent('skill_resolution', {
    schemaVersion: 'skill-resolution-event/v1',
    sessionId: snapshot.sessionId,
    skillHits: context.skills.length,
    skills: context.skills,
    artifactPath,
  })
  for (const skill of context.skills) {
    const span = trace.startSpan({
      spanType: 'skill_call',
      name: 'skill.resolve',
      skillName: skill.id,
      input: { reason: skill.reason, source: skill.source },
    })
    span.end({ status: 'success', output: { loadMode: skill.loadMode, bodyHash: skill.bodyHash } })
  }
}
