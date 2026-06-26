#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  PROMPT_SECTION_ORDER,
  buildPromptSections,
  renderPromptSections,
} from '../dist/context/prompt-sections.js'
import { measurePromptSections } from '../dist/context/metrics.js'

const longText = Array.from({ length: 80 }, (_, i) => `long-page-text-${i}`).join(' ')
const longObservation = Array.from({ length: 80 }, (_, i) => `recent-action-observation-${i}`).join(' ')

const snapshot = {
  schemaVersion: 'context-snapshot/v1',
  sessionId: 'prompt-test',
  goal: 'Fill the application draft.',
  page: {
    schemaVersion: 'page-state/v1',
    url: 'https://example.test/apply',
    title: 'Application Draft',
    pageType: 'form',
    interactiveCount: 8,
    formCount: 1,
    linkCount: 1,
    buttonCount: 2,
    inputCount: 4,
    textSummary: longText,
    updatedAt: '2026-06-25T00:00:00.000Z',
  },
  form: {
    schemaVersion: 'form-state/v1',
    url: 'https://example.test/apply',
    fields: [
      field(0, 'Name', 'Zhang San', true),
      field(1, 'Email', '', true),
      field(2, 'City', 'Hangzhou', false),
    ],
    filledFields: [field(0, 'Name', 'Zhang San', true), field(2, 'City', 'Hangzhou', false)],
    missingRequired: [field(1, 'Email', '', true)],
    submitCandidates: [
      { tag: 'button', type: 'submit', text: 'Submit application', risk: 'L3', visible: true },
      { tag: 'button', type: 'button', text: 'Save draft', risk: 'L1', visible: true },
    ],
    uploadHints: [{ tag: 'input', type: 'file', text: 'Upload resume', visible: true, accept: '.pdf' }],
    visibleErrors: ['Email is required'],
    updatedAt: '2026-06-25T00:00:00.000Z',
  },
  taskState: {
    schemaVersion: 'task-state/v1',
    goal: 'Fill the application draft.',
    phase: 'reviewing',
    knownBlockers: ['Final submit requires human approval'],
    completionCriteria: ['Name and email are filled', 'Draft is ready for review'],
    updatedAt: '2026-06-25T00:00:02.000Z',
  },
  workflowState: {
    schemaVersion: 'workflow-state/v1',
    phase: 'reviewing',
    confidence: 'medium',
    reason: 'All required fields appear filled and submit candidates are visible.',
    updatedAt: '2026-06-25T00:00:02.500Z',
  },
  freshness: {
    pageStateUpdatedAt: '2026-06-25T00:00:00.000Z',
    formStateUpdatedAt: '2026-06-25T00:00:00.000Z',
    pageStateAgeMs: 3000,
    formStateAgeMs: 3000,
    pageStateStale: false,
    formStateStale: false,
    staleAfterMs: 30_000,
  },
  resumeSummary: 'name: Zhang San\nemail: zhangsan@example.com',
  recentActions: [
    {
      step: 1,
      toolName: 'browser_snapshot',
      argumentsSummary: '(no args)',
      status: 'ok',
      observation: longObservation,
      at: '2026-06-25T00:00:01.000Z',
    },
    {
      step: 2,
      toolName: 'browser_type',
      argumentsSummary: 'ref=e1, text=Zhang San',
      status: 'ok',
      observation: longObservation,
      at: '2026-06-25T00:00:02.000Z',
    },
  ],
  safetyNotes: ['Never click final submit.'],
  blockers: [],
  updatedAt: '2026-06-25T00:00:03.000Z',
}

const sections = buildPromptSections(snapshot, {
  sectionMaxChars: {
    CURRENT_PAGE_STATE: 260,
    RECENT_ACTIONS: 260,
  },
})

assert.deepEqual(sections.map((section) => section.id), PROMPT_SECTION_ORDER, 'prompt section order must be stable')
assert.deepEqual(
  PROMPT_SECTION_ORDER.slice(0, 6),
  ['SYSTEM_ROLE', 'SAFETY_RULES', 'TASK', 'TASK_STATE', 'WORKFLOW_STATE', 'RESUME_SUMMARY'],
  'WORKFLOW_STATE should render after TASK_STATE and before RESUME_SUMMARY',
)

const rendered = renderPromptSections(sections)
let previousIndex = -1
for (const id of PROMPT_SECTION_ORDER) {
  const index = rendered.indexOf(`## ${id}`)
  assert(index > previousIndex, `${id} should render after the previous section`)
  previousIndex = index
}

const formSection = sections.find((section) => section.id === 'CURRENT_FORM_STATE')
assert(formSection, 'CURRENT_FORM_STATE should exist')
assert(formSection.content.includes('filledFields:'), 'filledFields should enter prompt')
assert(formSection.content.includes('Zhang San'), 'filled field values should enter prompt')
assert(formSection.content.includes('missingRequired:'), 'missingRequired should enter prompt')
assert(formSection.content.includes('Email'), 'missing required labels should enter prompt')
assert(formSection.content.includes('submitCandidates:'), 'submitCandidates should enter prompt')
assert(formSection.content.includes('Submit application'), 'submit candidate text should enter prompt')
assert(formSection.content.includes('freshness: ageMs=3000 stale=false'), 'form freshness should enter prompt')

const taskStateSection = sections.find((section) => section.id === 'TASK_STATE')
assert(taskStateSection, 'TASK_STATE should exist')
assert(taskStateSection.content.includes('schemaVersion: task-state/v1'), 'TaskState schema should enter prompt')
assert(taskStateSection.content.includes('phase: reviewing'), 'TaskState phase should enter prompt')
assert(taskStateSection.content.includes('Final submit requires human approval'), 'TaskState blockers should enter prompt')
assert(taskStateSection.content.includes('Draft is ready for review'), 'TaskState completion criteria should enter prompt')

const workflowStateSection = sections.find((section) => section.id === 'WORKFLOW_STATE')
assert(workflowStateSection, 'WORKFLOW_STATE should exist')
assert(workflowStateSection.content.includes('schemaVersion: workflow-state/v1'), 'WorkflowState schema should enter prompt')
assert(workflowStateSection.content.includes('phase: reviewing'), 'WorkflowState phase should enter prompt')
assert(workflowStateSection.content.includes('confidence: medium'), 'WorkflowState confidence should enter prompt')
assert(workflowStateSection.content.includes('humanHandoffRequired: false'), 'WorkflowState handoff cue should enter prompt')

const defaultTaskStateSection = findSection(buildPromptSections({ ...snapshot, taskState: undefined }), 'TASK_STATE')
assert(defaultTaskStateSection.content.includes('phase: observing'), 'missing taskState should render a default observing state')

const pageSection = sections.find((section) => section.id === 'CURRENT_PAGE_STATE')
assert(pageSection, 'CURRENT_PAGE_STATE should exist')
assert(pageSection.content.length <= 260, 'long page text should be controlled by section budget')
assert(pageSection.content.includes('[truncated]'), 'long page text should show truncation')

const recentSection = sections.find((section) => section.id === 'RECENT_ACTIONS')
assert(recentSection, 'RECENT_ACTIONS should exist')
assert(recentSection.content.length <= 260, 'recent actions should be controlled by section budget')
assert(recentSection.content.includes('[truncated]'), 'long recent actions should show truncation')

const fullSections = buildPromptSections(snapshot, {
  sectionMaxChars: {
    CURRENT_PAGE_STATE: 10000,
    RECENT_ACTIONS: 10000,
  },
})
const fullMetrics = measurePromptSections(fullSections)
assert.equal(fullMetrics.contextBuilds, 1, 'context build count should default to one measured build')
assert.equal(fullMetrics.contextChars, renderPromptSections(fullSections).length, 'context chars should match rendered sections length')
assert.equal(fullMetrics.recentActionsIncluded, 2, 'recent action count should be measurable')
assert(fullMetrics.promptSectionChars.CURRENT_FORM_STATE > 0, 'section chars should be measured by section id')

const fullPageSection = fullSections.find((section) => section.id === 'CURRENT_PAGE_STATE')
assert(fullPageSection?.content.includes('freshness: ageMs=3000 stale=false'), 'page freshness should enter prompt')

const budgetedMetrics = measurePromptSections(sections)
assert(budgetedMetrics.contextTruncations >= 2, 'section truncations should be measurable')
assert.equal(budgetedMetrics.promptSectionChars.CURRENT_PAGE_STATE, pageSection.content.length, 'page section chars should match section content length')

const longSafetyNote = Array.from({ length: 40 }, (_, i) => `routine-safety-note-${i}`).join(' ')
const blockerSections = buildPromptSections({
  ...snapshot,
  safetyNotes: [longSafetyNote],
  blockers: ['Human approval gate denied final submit.'],
}, {
  sectionMaxChars: {
    SAFETY_RULES: 140,
  },
})
const blockerSafetySection = findSection(blockerSections, 'SAFETY_RULES')
assert(blockerSafetySection.content.includes('Current blockers:'), 'blocker heading should survive tight safety budget')
assert(blockerSafetySection.content.includes('Human approval gate'), 'blocker text should survive tight safety budget')

const noisyFilledFields = Array.from({ length: 16 }, (_, i) => field(i, `Optional profile field with verbose label ${i}`, `verbose value ${i}`, false))
const missingRequiredSections = buildPromptSections({
  ...snapshot,
  form: {
    ...snapshot.form,
    fields: [...noisyFilledFields, field(99, 'Email', '', true)],
    filledFields: noisyFilledFields,
    missingRequired: [field(99, 'Email', '', true)],
  },
}, {
  sectionMaxChars: {
    CURRENT_FORM_STATE: 150,
    CURRENT_PAGE_STATE: 150,
  },
})
const missingRequiredSection = findSection(missingRequiredSections, 'CURRENT_FORM_STATE')
assert(missingRequiredSection.content.includes('missingRequired:'), 'missingRequired heading should survive tight form budget')
assert(missingRequiredSection.content.includes('Email'), 'missing required label should survive tight form budget')

const recentPrioritySections = buildPromptSections({
  ...snapshot,
  recentActions: [
    {
      step: 1,
      toolName: 'browser_wait',
      argumentsSummary: 'ms=1000',
      status: 'ok',
      observation: longObservation,
      at: '2026-06-25T00:00:01.000Z',
    },
    {
      step: 2,
      toolName: 'browser_snapshot',
      argumentsSummary: '(no args)',
      status: 'ok',
      observation: longObservation,
      at: '2026-06-25T00:00:02.000Z',
    },
    {
      step: 3,
      toolName: 'browser_click',
      argumentsSummary: 'ref=e9',
      status: 'ok',
      risk: 'L3',
      observation: 'High-risk submit candidate seen.',
      at: '2026-06-25T00:00:03.000Z',
    },
    {
      step: 4,
      toolName: 'browser_type',
      argumentsSummary: 'ref=e1, text=zhangsan@example.com',
      status: 'error',
      observation: 'Field ref was stale.',
      at: '2026-06-25T00:00:04.000Z',
    },
    {
      step: 5,
      toolName: 'browser_click',
      argumentsSummary: 'ref=e10',
      status: 'blocked',
      risk: 'L4',
      observation: 'Final submit blocked by safety gate.',
      at: '2026-06-25T00:00:05.000Z',
    },
  ],
}, {
  sectionMaxChars: {
    RECENT_ACTIONS: 520,
  },
})
const priorityRecentSection = findSection(recentPrioritySections, 'RECENT_ACTIONS')
assert(priorityRecentSection.content.includes('status=blocked'), 'blocked recent action should survive tight recent-actions budget')
assert(priorityRecentSection.content.includes('Final submit blocked'), 'blocked recent action observation should survive tight recent-actions budget')
assert(priorityRecentSection.content.includes('status=error'), 'error recent action should survive tight recent-actions budget')
assert(priorityRecentSection.content.includes('risk=L3'), 'high-risk recent action should survive tight recent-actions budget')
const firstOrdinaryActionIndex = firstPresentIndex(priorityRecentSection.content, ['tool=browser_snapshot', 'tool=browser_wait'])
assert(firstOrdinaryActionIndex < 0 || priorityRecentSection.content.indexOf('status=blocked') < firstOrdinaryActionIndex, 'blocked actions should render before ordinary ok actions')
assert(firstOrdinaryActionIndex < 0 || priorityRecentSection.content.indexOf('status=error') < firstOrdinaryActionIndex, 'error actions should render before ordinary ok actions')
assert(firstOrdinaryActionIndex < 0 || priorityRecentSection.content.indexOf('risk=L3') < firstOrdinaryActionIndex, 'high-risk actions should render before ordinary ok actions')

console.log('prompt-sections-test: PASS')

function field(index, label, value, required) {
  return {
    index,
    label,
    tag: 'input',
    type: 'text',
    value,
    required,
    filled: Boolean(value),
    disabled: false,
    readonly: false,
    invalid: required && !value,
  }
}

function findSection(sections, id) {
  const section = sections.find((candidate) => candidate.id === id)
  assert(section, `${id} should exist`)
  return section
}

function firstPresentIndex(content, needles) {
  const indexes = needles.map((needle) => content.indexOf(needle)).filter((index) => index >= 0)
  return indexes.length ? Math.min(...indexes) : -1
}
