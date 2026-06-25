import { contextManager, summarizeResumeProfile } from '../context/context-manager.js'
import {
  buildPromptSections,
  renderPromptSections,
  selectPromptSections,
  SYSTEM_PROMPT_SECTION_IDS,
  USER_PROMPT_SECTION_IDS,
} from '../context/prompt-sections.js'
import type { ContextRecentAction, ContextSnapshot } from '../context/types.js'
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
    'For any element marked risk=L3 or risk=L4, the human must approve before the action runs; you may still request it because the system gates it.',
    'If you hit a login wall or captcha you cannot pass, call agent_done with blocked=true and explain.',
    'Prefer to fill only the fields you can map confidently from the resume. Leave unknown fields untouched.',
  ]
}

export class PromptAssembler {
  async buildLoopContext(
    input: PromptAssemblerInput,
    recentActions: ContextRecentAction[],
    blockers: string[],
  ): Promise<ContextSnapshot> {
    return contextManager.createSnapshot({
      sessionId: input.ctx.sessionId,
      goal: input.goal,
      resumeSummary: summarizeResumeProfile(input.resume),
      recentActions,
      safetyNotes: safetyNotesFor(input.safetyMode ?? 'guarded'),
      blockers,
      extraContext: input.extraContext,
    })
  }

  renderSystemContext(snapshot: ContextSnapshot): string {
    const sections = buildPromptSections(snapshot)
    return renderPromptSections(selectPromptSections(sections, SYSTEM_PROMPT_SECTION_IDS))
  }

  renderUserContext(snapshot: ContextSnapshot): string {
    const sections = buildPromptSections(snapshot)
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
