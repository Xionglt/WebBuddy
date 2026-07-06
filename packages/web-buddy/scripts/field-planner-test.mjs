#!/usr/bin/env node
import assert from 'node:assert/strict'
import { AnswerStore } from '../dist/context/answer-store.js'
import { ProfileStore } from '../dist/context/profile-store.js'
import { createDeterministicFieldPlanner, createFieldPlanner } from '../dist/fill/field-planner.js'
import { createLocalTools } from '../dist/tools/local-adapter.js'
import { observationManager } from '../dist/observation/observation-manager.js'

const legacyProfile = {
  name: 'Li Ming',
  email: 'li@example.com',
  phone: '+86 138-0000-1111',
  location: 'Hangzhou',
  summary: 'Full-stack engineer focused on reliable browser automation.',
  skills: ['TypeScript', 'React', 'Playwright', 'Node.js'],
  experience: [
    {
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      period: '2021.01-至今',
      summary: 'Built workflow automation and form filling tools.',
    },
  ],
  education: [
    { school: 'ZJU', degree: '本科', major: 'Computer Science', period: '2017-2021' },
    { school: 'ZJU', degree: '硕士', major: 'Software Engineering', period: '2021-2024' },
  ],
  keywords: [],
  source: 'json',
}

const profileV2 = {
  schemaVersion: 'resume-profile/v2',
  name: { value: 'Li Ming', confidence: 0.95, evidence: 'fixture' },
  email: { value: 'li@example.com', confidence: 0.95, evidence: 'fixture' },
  phone: { value: '+86 138-0000-1111', confidence: 0.95, evidence: 'fixture' },
  location: { value: 'Hangzhou', confidence: 0.9, evidence: 'fixture' },
  summary: { value: legacyProfile.summary, confidence: 0.8, evidence: 'fixture' },
  targetRoles: { value: ['Frontend Engineer'], confidence: 0.8, evidence: 'fixture' },
  seniority: { value: 'Senior', confidence: 0.8, evidence: 'fixture' },
  skills: { value: legacyProfile.skills, confidence: 0.9, evidence: 'fixture' },
  projects: {
    value: [
      {
        name: 'Autofill Console',
        role: 'Tech Lead',
        period: '2024',
        summary: 'Designed a browser form autofill workflow.',
        technologies: ['TypeScript', 'Playwright'],
      },
    ],
    confidence: 0.9,
    evidence: 'fixture',
  },
  experience: { value: legacyProfile.experience, confidence: 0.9, evidence: 'fixture' },
  education: { value: legacyProfile.education, confidence: 0.9, evidence: 'fixture' },
  keywords: { value: ['autofill'], confidence: 0.7, evidence: 'fixture' },
  source: { type: 'json', extractionWarnings: [], parser: 'json' },
}

const fields = [
  field(0, '姓名', 'text', true),
  field(1, '手机号码', 'text', true),
  field(2, '邮箱 Email', 'text', true),
  {
    ...field(3, '城市', 'select_native', true),
    options: [
      { value: 'hz', label: 'Hangzhou / 杭州' },
      { value: 'sh', label: '上海' },
    ],
  },
  {
    ...field(4, '最高学历', 'select_native', true),
    options: [
      { value: 'bachelor', label: '本科' },
      { value: 'master', label: '硕士' },
      { value: 'phd', label: '博士' },
    ],
  },
  field(5, '工作年限', 'text', true),
  field(6, '当前公司', 'text', false),
  field(7, '当前职位', 'text', false),
  field(8, '技能', 'textarea', false),
  field(9, '项目经历', 'textarea', false),
  field(10, '个人简介', 'textarea', true),
  field(11, '期望薪资', 'text', true),
]

const profileStore = new ProfileStore(legacyProfile, profileV2)
const answerStore = new AnswerStore()
answerStore.put({
  field: '期望薪资',
  question: '请提供期望薪资。',
  answer: '30k-40k',
  at: '2026-07-03T00:00:00.000Z',
  source: 'ask_user',
})

const planner = createDeterministicFieldPlanner()
const plan = await planner.plan({
  fields,
  profileStoreAvailable: true,
  answerStoreAvailable: true,
  profileStore,
  answerStore,
  sourceFormUrl: 'https://example.test/apply',
  now: '2026-07-03T00:00:00.000Z',
})

assert.equal(plan.schemaVersion, 'field-plan/v1')
assert.equal(plan.fieldCount, fields.length)
assert.equal(byLabel(plan, '姓名').intendedValue, 'Li Ming')
assert.equal(byLabel(plan, '手机号码').intendedValue, '13800001111')
assert.equal(byLabel(plan, '邮箱 Email').intendedValue, 'li@example.com')
assert.equal(byLabel(plan, '城市').intendedValue, 'Hangzhou / 杭州')
assert.equal(byLabel(plan, '城市').optionMatched.optionValue, 'hz')
assert.equal(byLabel(plan, '最高学历').intendedValue, '硕士')
assert.equal(byLabel(plan, '最高学历').valueSource, 'derived')
assert(Number(byLabel(plan, '工作年限').intendedValue) >= 5)
assert.equal(byLabel(plan, '当前公司').intendedValue, 'Acme')
assert.equal(byLabel(plan, '当前职位').intendedValue, 'Senior Frontend Engineer')
assert.match(byLabel(plan, '技能').intendedValue, /TypeScript/)
assert.match(byLabel(plan, '项目经历').intendedValue, /Autofill Console/)
assert.match(byLabel(plan, '个人简介').intendedValue, /browser automation/)
assert.equal(byLabel(plan, '期望薪资').intendedValue, '30k-40k')
assert.equal(byLabel(plan, '期望薪资').valueSource, 'user_answer')

const missingPlan = await planner.plan({
  fields: [field(20, '到岗时间', 'text', true)],
  profileStoreAvailable: true,
  answerStoreAvailable: false,
  profileStore,
  now: '2026-07-03T00:00:00.000Z',
})
assert.equal(byLabel(missingPlan, '到岗时间').intendedValue, null)
assert(byLabel(missingPlan, '到岗时间').needsUser?.question)

const llmCalls = []
const fakePlannerLlm = {
  hasKey: true,
  async generateJson(system, user, options) {
    llmCalls.push({ system, user, options })
    return {
      planned: [
        {
          fieldKey: 'field_20',
          intendedValue: '两周内',
          valueSource: 'derived',
          sourceRef: 'resume.summary',
          normalization: 'llm:availability',
          confidence: 0.72,
        },
      ],
    }
  },
}
const hybridPlanner = createFieldPlanner({ llm: fakePlannerLlm })
const hybridPlan = await hybridPlanner.plan({
  fields: [
    field(0, '姓名', 'text', true),
    field(20, '到岗时间', 'text', true),
  ],
  profileStoreAvailable: true,
  answerStoreAvailable: true,
  profileStore,
  answerStore,
  llm: fakePlannerLlm,
  now: '2026-07-03T00:00:00.000Z',
})
assert.equal(byLabel(hybridPlan, '姓名').intendedValue, 'Li Ming', 'LLM fallback must not override deterministic fields')
assert.equal(byLabel(hybridPlan, '到岗时间').intendedValue, '两周内')
assert.equal(byLabel(hybridPlan, '到岗时间').normalization, 'llm:availability')
assert.equal(llmCalls.length, 1, 'LLM fallback should be called once for unresolved fields')
assert.equal(llmCalls[0].options.redactTrace, true)

observationManager.refreshFormState({
  sessionId: 'field-planner-tool-test',
  formSnapshot: {
    url: 'https://example.test/apply',
    fields,
    submitCandidates: [],
  },
})
const tool = createLocalTools().find((item) => item.name === 'plan_form_fill')
assert(tool, 'plan_form_fill should be registered as a local tool')
const ctx = {
  sessionId: 'field-planner-tool-test',
  highlight: false,
  trace: {},
  profileStore,
  answerStore,
}
const result = await tool.run({ refresh: true }, ctx)
assert.equal(result.pageChanged, false)
assert.match(result.observation, /created FieldPlan/)
assert.equal(result.data.schemaVersion, 'field-plan/v1')
assert.equal(ctx.fieldPlan.schemaVersion, 'field-plan/v1')
assert.equal(byLabel(ctx.fieldPlan, '姓名').intendedValue, 'Li Ming')

console.log('field-planner-test: PASS')

function field(index, label, controlKind, required) {
  return {
    index,
    fieldKey: `field_${index}`,
    label,
    controlKind,
    required,
    requiredConfidence: required ? 0.95 : 0,
    filled: false,
    disabled: false,
    readonly: false,
    invalid: false,
  }
}

function byLabel(plan, label) {
  const item = plan.planned.find((field) => field.label === label)
  assert(item, `missing planned field ${label}`)
  return item
}
