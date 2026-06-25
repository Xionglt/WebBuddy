#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  PROMPT_SECTION_ORDER,
  buildPromptSections,
  renderPromptSections,
} from '../dist/context/prompt-sections.js'

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

const pageSection = sections.find((section) => section.id === 'CURRENT_PAGE_STATE')
assert(pageSection, 'CURRENT_PAGE_STATE should exist')
assert(pageSection.content.length <= 260, 'long page text should be controlled by section budget')
assert(pageSection.content.includes('[truncated]'), 'long page text should show truncation')

const recentSection = sections.find((section) => section.id === 'RECENT_ACTIONS')
assert(recentSection, 'RECENT_ACTIONS should exist')
assert(recentSection.content.length <= 260, 'recent actions should be controlled by section budget')
assert(recentSection.content.includes('[truncated]'), 'long recent actions should show truncation')

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
