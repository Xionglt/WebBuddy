import type { FormFieldState, FormState, SubmitCandidate, UploadHint } from '../observation/form-state.js'
import type { PageFacts, PageButtonFact } from '../observation/page-facts.js'
import type { PageState } from '../observation/page-state.js'
import { createDefaultTaskState, type TaskState } from '../task/task-state.js'
import type { WorkflowState } from '../workflow/workflow-state.js'
import { normalizeLines, oneLine, truncateText } from './budget.js'
import type { ContextFreshness, ContextRecentAction, ContextSnapshot, PromptSection, PromptSectionId } from './types.js'

export const PROMPT_SECTION_ORDER: PromptSectionId[] = [
  'SYSTEM_ROLE',
  'SAFETY_RULES',
  'TASK',
  'TASK_STATE',
  'WORKFLOW_STATE',
  'RESUME_SUMMARY',
  'CURRENT_PAGE_STATE',
  'CURRENT_FORM_STATE',
  'FILL_PLAN',
  'RECENT_ACTIONS',
  'NEXT_ACTION_RULES',
]

export const SYSTEM_PROMPT_SECTION_IDS: PromptSectionId[] = ['SYSTEM_ROLE', 'SAFETY_RULES']
export const USER_PROMPT_SECTION_IDS: PromptSectionId[] = PROMPT_SECTION_ORDER.filter(
  (id) => !SYSTEM_PROMPT_SECTION_IDS.includes(id),
)

export interface PromptSectionBudgetOptions {
  sectionMaxChars?: Partial<Record<PromptSectionId, number>>
  totalMaxChars?: number
}

const DEFAULT_SECTION_MAX_CHARS: Record<PromptSectionId, number> = {
  SYSTEM_ROLE: 1400,
  SAFETY_RULES: 1800,
  TASK: 1400,
  TASK_STATE: 900,
  WORKFLOW_STATE: 900,
  RESUME_SUMMARY: 2200,
  CURRENT_PAGE_STATE: 1800,
  CURRENT_FORM_STATE: 2800,
  FILL_PLAN: 1800,
  RECENT_ACTIONS: 1800,
  NEXT_ACTION_RULES: 1200,
}

const SECTION_TITLES: Record<PromptSectionId, string> = {
  SYSTEM_ROLE: 'SYSTEM_ROLE',
  SAFETY_RULES: 'SAFETY_RULES',
  TASK: 'TASK',
  TASK_STATE: 'TASK_STATE',
  WORKFLOW_STATE: 'WORKFLOW_STATE',
  RESUME_SUMMARY: 'RESUME_SUMMARY',
  CURRENT_PAGE_STATE: 'CURRENT_PAGE_STATE',
  CURRENT_FORM_STATE: 'CURRENT_FORM_STATE',
  FILL_PLAN: 'FILL_PLAN',
  RECENT_ACTIONS: 'RECENT_ACTIONS',
  NEXT_ACTION_RULES: 'NEXT_ACTION_RULES',
}

export function buildPromptSections(
  snapshot: ContextSnapshot,
  options: PromptSectionBudgetOptions = {},
): PromptSection[] {
  const sections = PROMPT_SECTION_ORDER.map((id) => ({
    id,
    title: SECTION_TITLES[id],
    content: renderSectionContent(id, snapshot),
  })).map((section) => ({
    ...section,
    content: truncateText(
      section.content,
      options.sectionMaxChars?.[section.id] ?? DEFAULT_SECTION_MAX_CHARS[section.id],
    ),
  }))

  return fitSectionsToTotal(sections, options.totalMaxChars)
}

export function renderPromptSections(sections: PromptSection[]): string {
  return sections.map((section) => `## ${section.title}\n${section.content}`).join('\n\n')
}

export function selectPromptSections(sections: PromptSection[], ids: PromptSectionId[]): PromptSection[] {
  const wanted = new Set(ids)
  return sections.filter((section) => wanted.has(section.id))
}

function renderSectionContent(id: PromptSectionId, snapshot: ContextSnapshot): string {
  switch (id) {
    case 'SYSTEM_ROLE':
      return [
        'You are an autonomous browser automation agent using a local Playwright runtime.',
        'Drive the browser only through the provided tools.',
        'When a browser snapshot includes element refs like [e1] or [e2], use those exact refs in browser_click, browser_type, browser_select, and related tools.',
        'Operate from the task, current ObservationManager memory state, tool observations, and visible website information.',
      ].join('\n')
    case 'SAFETY_RULES':
      return renderSafetyRules(snapshot.safetyNotes, snapshot.blockers)
    case 'TASK':
      return normalizeLines([
        `goal: ${snapshot.goal}`,
        snapshot.extraContext ? `extraContext:\n${snapshot.extraContext}` : undefined,
        `sessionId: ${snapshot.sessionId}`,
        `updatedAt: ${snapshot.updatedAt}`,
      ])
    case 'TASK_STATE':
      return renderTaskState(snapshot.taskState ?? createDefaultTaskState({
        goal: snapshot.goal,
        updatedAt: snapshot.updatedAt,
      }))
    case 'WORKFLOW_STATE':
      return renderWorkflowState(snapshot.workflowState)
    case 'RESUME_SUMMARY':
      return snapshot.resumeSummary || '(no resume summary provided)'
    case 'CURRENT_PAGE_STATE':
      return renderPageState(snapshot.page, snapshot.freshness)
    case 'CURRENT_FORM_STATE':
      return renderFormState(snapshot.form, snapshot.freshness)
    case 'FILL_PLAN':
      return renderFillPlan(snapshot)
    case 'RECENT_ACTIONS':
      return renderRecentActions(snapshot.recentActions)
    case 'NEXT_ACTION_RULES':
      return [
        'Read the current context and choose exactly one next tool call.',
        'Use browser_snapshot when page refs may be stale or missing.',
        'Use browser_form_snapshot when labels, required fields, selected options, upload hints, or submit candidates are unclear.',
        'If FILL_PLAN is missing or stale on a fillable form, call plan_form_fill before setting fields.',
        'When FILL_PLAN has a fillable intendedValue, write it into the matching field first; prefer browser_set_field when available, otherwise use browser_fill_by_label, browser_type, browser_select, or browser_select_by_text as appropriate.',
        'If a field lacks resume details beyond RESUME_SUMMARY, call resume_query for the relevant full resume section before leaving it blank.',
        'If a field needs information that is not in the resume and cannot be inferred from the page, call ask_user with the planned question before filling it.',
        'Do not call agent_done while FillLedger shows pendingRequired fields unless you are blocked and explain exactly which required fields remain.',
        'Follow SAFETY_RULES before any click, submit-like action, credential flow, captcha, payment, or identity-proof step.',
        'Call agent_done when the task is complete or blocked.',
      ].join('\n')
  }
}

function renderFillPlan(snapshot: ContextSnapshot): string {
  if (!snapshot.fieldPlan && !snapshot.fillLedgerSummary && !snapshot.answerSummary) {
    return '(no FieldPlan, FillLedgerSummary, or AnswerSummary in runtime context yet)'
  }

  return normalizeLines([
    snapshot.fieldPlan
      ? [
          `fieldPlan: ${snapshot.fieldPlan.planned.length} planned field(s), updatedAt=${snapshot.fieldPlan.updatedAt}`,
          snapshot.fieldPlan.sourceFormUrl ? `sourceFormUrl: ${snapshot.fieldPlan.sourceFormUrl}` : undefined,
          snapshot.fieldPlan.fieldCount === undefined ? undefined : `fieldCount: ${snapshot.fieldPlan.fieldCount}`,
          'plannedFields:',
          renderPlannedFields(snapshot.fieldPlan.planned),
        ].filter(Boolean).join('\n')
      : 'fieldPlan: (not available)',
    snapshot.fillLedgerSummary
      ? [
          `fillLedgerSummary: total=${snapshot.fillLedgerSummary.total}`,
          `verified=${snapshot.fillLedgerSummary.verified}`,
          `failed=${snapshot.fillLedgerSummary.failed}`,
          `needsUser=${snapshot.fillLedgerSummary.needsUser}`,
          `skipped=${snapshot.fillLedgerSummary.skipped}`,
          `pendingRequired=${snapshot.fillLedgerSummary.pendingRequired}`,
          `updatedAt=${snapshot.fillLedgerSummary.updatedAt}`,
        ].join(', ')
      : 'fillLedgerSummary: (not available)',
    snapshot.answerSummary ? `answerSummary:\n${snapshot.answerSummary}` : undefined,
  ])
}

function renderPlannedFields(fields: NonNullable<ContextSnapshot['fieldPlan']>['planned']): string {
  if (fields.length === 0) return '- (none)'
  const shown = fields.slice(0, 24)
  const lines = shown.map((field) => {
    const needsUser = field.needsUser
      ? `needsUser="${oneLine(field.needsUser.question, 140)}"${field.needsUser.options?.length ? ` options=[${field.needsUser.options.map((option) => oneLine(option, 40)).join(', ')}]` : ''}`
      : 'needsUser=false'
    const pendingRequired = Boolean(field.required && (field.needsUser || field.intendedValue === null || field.intendedValue === ''))
    const parts = [
      `#${field.fieldIndex}`,
      oneLine(field.label || field.fieldKey || '(unlabeled)', 100),
      `fieldKey=${field.fieldKey}`,
      `control=${field.controlKind}`,
      field.required === undefined ? '' : `required=${field.required}`,
      `suggestedValue=${formatPlannedValue(field.intendedValue)}`,
      `source=${field.valueSource}`,
      field.sourceRef ? `sourceRef=${oneLine(field.sourceRef, 80)}` : '',
      field.normalization ? `normalization=${oneLine(field.normalization, 80)}` : '',
      `confidence=${field.confidence}`,
      needsUser,
      `pendingRequired=${pendingRequired}`,
      field.optionMatched ? `optionMatched="${oneLine(field.optionMatched.optionLabel || field.optionMatched.optionValue, 80)}" score=${field.optionMatched.score}` : '',
      field.skipReason ? `skipReason="${oneLine(field.skipReason, 120)}"` : '',
    ].filter(Boolean)
    return `- ${parts.join(' | ')}`
  })
  if (fields.length > shown.length) lines.push(`- ... (${fields.length - shown.length} more planned fields)`)
  return lines.join('\n')
}

function formatPlannedValue(value: string | string[] | null): string {
  if (value === null) return '(none)'
  if (Array.isArray(value)) return `[${value.map((item) => `"${oneLine(item, 80)}"`).join(', ')}]`
  return `"${oneLine(value, 140)}"`
}

function renderSafetyRules(notes: string[], blockers: string[]): string {
  const lines: string[] = []
  if (blockers.length > 0) {
    lines.push('Current blockers:')
    lines.push(...blockers.map((blocker) => `- ${blocker}`))
    lines.push('')
  }
  lines.push(...(notes.length > 0 ? notes.map((note) => `- ${note}`) : ['- No additional safety notes were supplied.']))
  return lines.join('\n')
}

function renderTaskState(taskState: TaskState): string {
  return normalizeLines([
    `schemaVersion: ${taskState.schemaVersion}`,
    `goal: ${taskState.goal}`,
    `phase: ${taskState.phase}`,
    'knownBlockers:',
    renderStringList(taskState.knownBlockers),
    '',
    'completionCriteria:',
    renderStringList(taskState.completionCriteria),
    `updatedAt: ${taskState.updatedAt}`,
  ])
}

function renderWorkflowState(workflowState: WorkflowState | undefined): string {
  if (!workflowState) return '(no WorkflowState in runtime working set yet)'

  return normalizeLines([
    `schemaVersion: ${workflowState.schemaVersion}`,
    `phase: ${workflowState.phase}`,
    `confidence: ${workflowState.confidence}`,
    `humanHandoffRequired: ${workflowState.humanHandoffRequired ? 'true' : 'false'}`,
    `reason: ${workflowState.reason}`,
    workflowState.blocker ? `blocker: ${workflowState.blocker}` : undefined,
    workflowState.lastTransition
      ? `lastTransition: ${workflowState.lastTransition.from} -> ${workflowState.lastTransition.to} at ${workflowState.lastTransition.at}; reason=${workflowState.lastTransition.reason}`
      : undefined,
    workflowState.formCoverage
      ? `formCoverage: scrolledBottom=${workflowState.formCoverage.scrolledBottom}, segments=${workflowState.formCoverage.segments}, totalFieldsSeen=${workflowState.formCoverage.totalFieldsSeen}, updatedAt=${workflowState.formCoverage.updatedAt}`
      : undefined,
    workflowState.fillLedgerSummary
      ? `fillLedgerSummary: pendingRequired=${workflowState.fillLedgerSummary.pendingRequired}, verified=${workflowState.fillLedgerSummary.verified}, failed=${workflowState.fillLedgerSummary.failed}, needsUser=${workflowState.fillLedgerSummary.needsUser}, skipped=${workflowState.fillLedgerSummary.skipped}, total=${workflowState.fillLedgerSummary.total}`
      : undefined,
    workflowState.currentResumeUploaded === undefined ? undefined : `currentResumeUploaded: ${workflowState.currentResumeUploaded}`,
    `updatedAt: ${workflowState.updatedAt}`,
  ])
}

function renderPageState(page: PageState | undefined, freshness: ContextFreshness | undefined): string {
  if (!page) {
    return normalizeLines([
      '(no PageState in ObservationProvider memory yet; call browser_snapshot or use the latest page view fallback)',
      renderFreshnessCue('page', freshness),
    ])
  }
  return normalizeLines([
    `schemaVersion: ${page.schemaVersion}`,
    `url: ${page.url || '(unknown)'}`,
    `title: ${page.title || '(untitled)'}`,
    `pageType: ${page.pageType}`,
    `counts: interactive=${page.interactiveCount}, forms=${page.formCount}, links=${page.linkCount}, buttons=${page.buttonCount}, inputs=${page.inputCount}`,
    page.facts ? `facts:\n${renderPageFacts(page.facts)}` : undefined,
    renderFreshnessCue('page', freshness),
    `textSummary: ${page.textSummary || '(empty)'}`,
    `updatedAt: ${page.updatedAt}`,
  ])
}

function renderFormState(form: FormState | undefined, freshness: ContextFreshness | undefined): string {
  if (!form) {
    return normalizeLines([
      '(no FormState in ObservationProvider memory yet; call browser_form_snapshot if form details are needed)',
      renderFreshnessCue('form', freshness),
    ])
  }

  return normalizeLines([
    `schemaVersion: ${form.schemaVersion}`,
    `missingRequiredCount: ${form.missingRequired.length}`,
    'missingRequired:',
    renderFieldList(form.missingRequired),
    '',
    `url: ${form.url || '(unknown)'}`,
    `fieldCount: ${form.fields.length}`,
    `filledFieldsCount: ${form.filledFields.length}`,
    renderFreshnessCue('form', freshness),
    '',
    'filledFields:',
    renderFieldList(form.filledFields),
    '',
    'submitCandidates:',
    renderSubmitCandidates(form.submitCandidates),
    form.uploadHints?.length ? `\nuploadHints:\n${renderUploadHints(form.uploadHints)}` : undefined,
    form.facts ? `\nfacts:\n${renderPageFacts(form.facts)}` : undefined,
    form.visibleErrors?.length ? `\nvisibleErrors:\n${form.visibleErrors.map((error) => `- ${oneLine(error, 180)}`).join('\n')}` : undefined,
    `updatedAt: ${form.updatedAt}`,
  ])
}

function renderFreshnessCue(kind: 'page' | 'form', freshness: ContextFreshness | undefined): string {
  const ageMs = kind === 'page' ? freshness?.pageStateAgeMs : freshness?.formStateAgeMs
  const stale = kind === 'page' ? freshness?.pageStateStale : freshness?.formStateStale
  const updatedAt = kind === 'page' ? freshness?.pageStateUpdatedAt : freshness?.formStateUpdatedAt

  return [
    'freshness:',
    `ageMs=${ageMs ?? '(unknown)'}`,
    `stale=${stale ?? '(unknown)'}`,
    `updatedAt=${updatedAt ?? '(none)'}`,
    `staleAfterMs=${freshness?.staleAfterMs ?? '(unknown)'}`,
  ].join(' ')
}

function renderFieldList(fields: FormFieldState[]): string {
  if (fields.length === 0) return '- (none)'
  const shown = fields.slice(0, 24)
  const lines = shown.map((field) => {
    const parts = [
      `#${field.index}`,
      oneLine(field.label || field.name || field.id || field.placeholder || '(unlabeled)', 100),
      field.tag ? `tag=${field.tag}` : '',
      field.type ? `type=${field.type}` : '',
      field.role ? `role=${field.role}` : '',
      `required=${field.required}`,
      `filled=${field.filled}`,
      field.disabled ? 'disabled=true' : '',
      field.readonly ? 'readonly=true' : '',
      field.invalid ? 'invalid=true' : '',
      field.value ? `value="${oneLine(field.value, 140)}"` : '',
      field.error ? `error="${oneLine(field.error, 140)}"` : '',
      field.options?.length ? `options=[${field.options.slice(0, 8).map((option) => `${oneLine(option.label || option.value, 40)}${option.selected ? '*' : ''}`).join(', ')}]` : '',
    ].filter(Boolean)
    return `- ${parts.join(' | ')}`
  })
  if (fields.length > shown.length) lines.push(`- ... (${fields.length - shown.length} more fields)`)
  return lines.join('\n')
}

function renderSubmitCandidates(candidates: SubmitCandidate[]): string {
  if (candidates.length === 0) return '- (none)'
  const shown = candidates.slice(0, 16)
  const lines = shown.map((candidate) => {
    const parts = [
      oneLine(candidate.text || '(no text)', 120),
      `tag=${candidate.tag}`,
      candidate.type ? `type=${candidate.type}` : '',
      candidate.role ? `role=${candidate.role}` : '',
      candidate.risk ? `risk=${candidate.risk}` : '',
      candidate.visible === undefined ? '' : `visible=${candidate.visible}`,
    ].filter(Boolean)
    return `- ${parts.join(' | ')}`
  })
  if (candidates.length > shown.length) lines.push(`- ... (${candidates.length - shown.length} more candidates)`)
  return lines.join('\n')
}

function renderUploadHints(hints: UploadHint[]): string {
  const shown = hints.slice(0, 12)
  const lines = shown.map((hint) => {
    const parts = [
      oneLine(hint.text || '(file input)', 100),
      `tag=${hint.tag}`,
      hint.type ? `type=${hint.type}` : '',
      hint.accept ? `accept=${hint.accept}` : '',
      hint.visible === undefined ? '' : `visible=${hint.visible}`,
    ].filter(Boolean)
    return `- ${parts.join(' | ')}`
  })
  if (hints.length > shown.length) lines.push(`- ... (${hints.length - shown.length} more upload hints)`)
  return lines.join('\n')
}

function renderPageFacts(facts: PageFacts): string {
  return normalizeLines([
    `- hasAgreementCheckbox=${facts.hasAgreementCheckbox}`,
    `- agreementChecked=${facts.agreementChecked}`,
    `- hasApplicationQuotaDialog=${facts.hasApplicationQuotaDialog}`,
    facts.quotaDialogText ? `- quotaDialogText="${oneLine(facts.quotaDialogText, 180)}"` : undefined,
    `- hasRealUploadInput=${facts.hasRealUploadInput}`,
    `- uploadCandidateCount=${facts.uploadCandidateCount}`,
    facts.visibleBlockingDialog.present
      ? `- visibleBlockingDialog=${facts.visibleBlockingDialog.kind || 'unknown'} "${oneLine(facts.visibleBlockingDialog.text || '', 180)}"`
      : '- visibleBlockingDialog=false',
    `- submitLikeButtons: ${renderFactButtonsInline(facts.submitLikeButtons)}`,
    `- likelyApplyEntryButtons: ${renderFactButtonsInline(facts.likelyApplyEntryButtons)}`,
    `- likelyFinalSubmitButtons: ${renderFactButtonsInline(facts.likelyFinalSubmitButtons)}`,
  ])
}

function renderFactButtonsInline(buttons: PageButtonFact[]): string {
  if (buttons.length === 0) return '(none)'
  return buttons
    .slice(0, 8)
    .map((button) => {
      const attrs = [
        oneLine(button.text || '(no text)', 80),
        button.tag ? `tag=${button.tag}` : '',
        button.type ? `type=${button.type}` : '',
        button.role ? `role=${button.role}` : '',
        button.disabled ? 'disabled=true' : '',
      ].filter(Boolean)
      return `[${attrs.join(' | ')}]`
    })
    .join(', ')
}

function renderStringList(values: string[]): string {
  if (values.length === 0) return '- (none)'
  return values.slice(0, 16).map((value) => `- ${oneLine(value, 180)}`).join('\n')
}

function renderRecentActions(actions: ContextRecentAction[]): string {
  if (actions.length === 0) return '(none yet)'
  return prioritizeRecentActions(actions).map((action) => {
    const parts = [
      `step=${action.step}`,
      `tool=${action.toolName}`,
      `args=${oneLine(action.argumentsSummary, 180)}`,
      `status=${action.status}`,
      action.risk ? `risk=${action.risk}` : '',
      action.observation ? `observation="${oneLine(action.observation, 220)}"` : '',
      `at=${action.at}`,
    ].filter(Boolean)
    return `- ${parts.join(' | ')}`
  }).join('\n')
}

function prioritizeRecentActions(actions: ContextRecentAction[]): ContextRecentAction[] {
  return [...actions].sort((a, b) => {
    const priorityDelta = recentActionPriority(b) - recentActionPriority(a)
    if (priorityDelta !== 0) return priorityDelta
    return b.step - a.step
  })
}

function recentActionPriority(action: ContextRecentAction): number {
  let priority = 0
  if (action.status === 'blocked' || action.status === 'error') priority += 100
  else if (action.status === 'warn') priority += 50
  priority += riskPriority(action.risk)
  return priority
}

function riskPriority(risk: ContextRecentAction['risk']): number {
  switch (risk) {
    case 'L4':
      return 40
    case 'L3':
      return 30
    case 'L2':
      return 20
    case 'L1':
      return 10
    default:
      return 0
  }
}

function fitSectionsToTotal(sections: PromptSection[], totalMaxChars?: number): PromptSection[] {
  if (!totalMaxChars || totalMaxChars <= 0) return sections

  let next = sections.map((section) => ({ ...section }))
  let renderedLength = renderPromptSections(next).length
  if (renderedLength <= totalMaxChars) return next

  const shrinkOrder: PromptSectionId[] = [
    'RECENT_ACTIONS',
    'FILL_PLAN',
    'CURRENT_PAGE_STATE',
    'CURRENT_FORM_STATE',
    'RESUME_SUMMARY',
    'WORKFLOW_STATE',
    'TASK_STATE',
    'TASK',
    'NEXT_ACTION_RULES',
    'SAFETY_RULES',
    'SYSTEM_ROLE',
  ]

  for (const id of shrinkOrder) {
    if (renderedLength <= totalMaxChars) break
    const index = next.findIndex((section) => section.id === id)
    if (index < 0) continue
    const overBy = renderedLength - totalMaxChars
    const current = next[index]
    const targetLength = Math.max(80, current.content.length - overBy)
    if (targetLength >= current.content.length) continue
    next[index] = { ...current, content: truncateText(current.content, targetLength) }
    renderedLength = renderPromptSections(next).length
  }

  if (renderedLength > totalMaxChars) {
    next = next.map((section) => ({ ...section, content: truncateText(section.content, 80) }))
  }
  return next
}
