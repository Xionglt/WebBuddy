import { getActiveTrace } from '../agent-trace/index.js'
import { measurePromptSections, type ContextSelectionMetrics } from '../context/metrics.js'
import { contextManager, summarizeResumeProfile } from '../context/context-manager.js'
import {
  buildPromptSections,
  renderPromptSections,
  selectPromptSections,
  SYSTEM_PROMPT_SECTION_IDS,
  USER_PROMPT_SECTION_IDS,
} from '../context/prompt-sections.js'
import type { ContextRecentAction, ContextSnapshot, PromptSection } from '../context/types.js'
import { createDefaultTaskState } from '../task/task-state.js'
import type { AgentSafetyMode, PromptAssemblerInput } from './types.js'

export function safetyNotesFor(mode: AgentSafetyMode = 'guarded'): string[] {
  if (mode === 'raw') {
    return [
      'Operate from the task and visible website information; navigate, search, filter, compare pages, click, type, upload/select, save, and submit only when needed for the user goal.',
      'Use browser_snapshot whenever page refs may be stale. Use browser_screenshot when visual inspection would help.',
      'If the site requires a human-only credential, SMS code, captcha, payment, or identity proof that cannot be completed with available page information, stop and summarize exactly what blocked you.',
      'For any element marked risk=L3 or risk=L4, the system may require human approval before the action runs.',
    ]
  }

  return [
    'NEVER submit a final application. If you reach the final submit/确认投递/提交申请 button on an application form, do NOT click it; call agent_done with blocked=true.',
    'It is OK to click a job-detail entry button such as 投递简历/Apply only when it merely opens the login/application flow and does not send the completed application.',
    'On Alibaba position-detail pages, if a small checkbox says 申请此职位表明您已阅读并同意 / 申请工作需知 next to 投递简历, check that box before clicking 投递简历. This is an application-entry precondition, not permission to click a true final submit button later.',
    'For any element marked risk=L3 or risk=L4, the human must approve before the action runs; you may still request it because the system gates it.',
    'If you hit a login wall or captcha you cannot pass, call agent_done with blocked=true and explain.',
    'Fill fields from FILL_PLAN first. When a field cannot be mapped, call resume_query for the full resume section or ask_user for missing information before leaving it blank; only leave a field untouched when no resume, derived, or user-answer source exists.',
    'If the task context provides a current resume file path, an existing on-site resume is NOT sufficient by itself. Prefer uploading the current resume file first, through browser_upload_file, before continuing the application flow unless the human explicitly says to reuse the existing on-site resume.',
  ]
}

export class PromptAssembler {
  private readonly promptSectionCache = new WeakMap<ContextSnapshot, PromptSectionCacheEntry>()

  async buildLoopContext(
    input: PromptAssemblerInput,
    recentActions: ContextRecentAction[],
    blockers: string[],
  ): Promise<ContextSnapshot> {
    const updatedAt = new Date().toISOString()
    return contextManager.createSnapshot({
      sessionId: input.ctx.sessionId,
      goal: input.goal,
      resumeSummary: summarizeResumeProfile(input.resume),
      recentActions,
      safetyNotes: safetyNotesFor(input.safetyMode ?? 'guarded'),
      blockers,
      extraContext: input.extraContext,
      taskState: input.taskState ?? createDefaultTaskState({ goal: input.goal, updatedAt }),
      workflowState: input.workflowState,
      fieldPlan: input.fieldPlan,
      fillLedgerSummary: input.fillLedgerSummary,
      answerSummary: input.answerSummary,
      updatedAt,
    })
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
