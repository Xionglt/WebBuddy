import type { FormFieldState, FormState, SubmitCandidate, UploadHint } from '../observation/form-state.js'
import type { PageState } from '../observation/page-state.js'
import { normalizeLines, oneLine, truncateText } from './budget.js'
import type { ContextRecentAction, ContextSnapshot, PromptSection, PromptSectionId } from './types.js'

export const PROMPT_SECTION_ORDER: PromptSectionId[] = [
  'SYSTEM_ROLE',
  'SAFETY_RULES',
  'TASK',
  'RESUME_SUMMARY',
  'CURRENT_PAGE_STATE',
  'CURRENT_FORM_STATE',
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
  RESUME_SUMMARY: 2200,
  CURRENT_PAGE_STATE: 1800,
  CURRENT_FORM_STATE: 2800,
  RECENT_ACTIONS: 1800,
  NEXT_ACTION_RULES: 1200,
}

const SECTION_TITLES: Record<PromptSectionId, string> = {
  SYSTEM_ROLE: 'SYSTEM_ROLE',
  SAFETY_RULES: 'SAFETY_RULES',
  TASK: 'TASK',
  RESUME_SUMMARY: 'RESUME_SUMMARY',
  CURRENT_PAGE_STATE: 'CURRENT_PAGE_STATE',
  CURRENT_FORM_STATE: 'CURRENT_FORM_STATE',
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
    case 'RESUME_SUMMARY':
      return snapshot.resumeSummary || '(no resume summary provided)'
    case 'CURRENT_PAGE_STATE':
      return renderPageState(snapshot.page)
    case 'CURRENT_FORM_STATE':
      return renderFormState(snapshot.form)
    case 'RECENT_ACTIONS':
      return renderRecentActions(snapshot.recentActions)
    case 'NEXT_ACTION_RULES':
      return [
        'Read the current context and choose exactly one next tool call.',
        'Use browser_snapshot when page refs may be stale or missing.',
        'Use browser_form_snapshot when labels, required fields, selected options, upload hints, or submit candidates are unclear.',
        'Fill only fields that can be mapped confidently from the resume and visible page information.',
        'Follow SAFETY_RULES before any click, submit-like action, credential flow, captcha, payment, or identity-proof step.',
        'Call agent_done when the task is complete or blocked.',
      ].join('\n')
  }
}

function renderSafetyRules(notes: string[], blockers: string[]): string {
  const lines = notes.length > 0 ? notes.map((note) => `- ${note}`) : ['- No additional safety notes were supplied.']
  if (blockers.length > 0) {
    lines.push('', 'Current blockers:')
    lines.push(...blockers.map((blocker) => `- ${blocker}`))
  }
  return lines.join('\n')
}

function renderPageState(page?: PageState): string {
  if (!page) {
    return '(no PageState in ObservationProvider memory yet; call browser_snapshot or use the latest page view fallback)'
  }
  return normalizeLines([
    `schemaVersion: ${page.schemaVersion}`,
    `url: ${page.url || '(unknown)'}`,
    `title: ${page.title || '(untitled)'}`,
    `pageType: ${page.pageType}`,
    `counts: interactive=${page.interactiveCount}, forms=${page.formCount}, links=${page.linkCount}, buttons=${page.buttonCount}, inputs=${page.inputCount}`,
    `textSummary: ${page.textSummary || '(empty)'}`,
    `updatedAt: ${page.updatedAt}`,
  ])
}

function renderFormState(form?: FormState): string {
  if (!form) {
    return '(no FormState in ObservationProvider memory yet; call browser_form_snapshot if form details are needed)'
  }

  return normalizeLines([
    `schemaVersion: ${form.schemaVersion}`,
    `url: ${form.url || '(unknown)'}`,
    `fieldCount: ${form.fields.length}`,
    `filledFieldsCount: ${form.filledFields.length}`,
    `missingRequiredCount: ${form.missingRequired.length}`,
    '',
    'filledFields:',
    renderFieldList(form.filledFields),
    '',
    'missingRequired:',
    renderFieldList(form.missingRequired),
    '',
    'submitCandidates:',
    renderSubmitCandidates(form.submitCandidates),
    form.uploadHints?.length ? `\nuploadHints:\n${renderUploadHints(form.uploadHints)}` : undefined,
    form.visibleErrors?.length ? `\nvisibleErrors:\n${form.visibleErrors.map((error) => `- ${oneLine(error, 180)}`).join('\n')}` : undefined,
    `updatedAt: ${form.updatedAt}`,
  ])
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

function renderRecentActions(actions: ContextRecentAction[]): string {
  if (actions.length === 0) return '(none yet)'
  return actions.map((action) => {
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

function fitSectionsToTotal(sections: PromptSection[], totalMaxChars?: number): PromptSection[] {
  if (!totalMaxChars || totalMaxChars <= 0) return sections

  let next = sections.map((section) => ({ ...section }))
  let renderedLength = renderPromptSections(next).length
  if (renderedLength <= totalMaxChars) return next

  const shrinkOrder: PromptSectionId[] = [
    'RECENT_ACTIONS',
    'CURRENT_PAGE_STATE',
    'CURRENT_FORM_STATE',
    'RESUME_SUMMARY',
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
