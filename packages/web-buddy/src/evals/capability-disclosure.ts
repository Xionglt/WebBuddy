import { estimateToolSchemas } from '../kernel/token-budget.js'
import { toolsForSafetyMode } from '../runtime/local/agent-loop.js'
import type { ToolRegistry } from '../runtime/local/tool-registry.js'
import { listLocalToolDefs } from '../tools/catalog.js'

const TASK_TYPES = ['explore', 'apply_entry', 'fill_form', 'final_review'] as const
const SAFETY_MODES = ['guarded', 'raw'] as const
const ASYNC_TOOLS = [
  'agent_task_spawn',
  'agent_task_status',
  'agent_task_wait',
  'agent_task_result',
  'agent_task_cancel',
] as const

const PROFILE_TOOLS: Readonly<Record<CapabilityTaskType, readonly string[]>> = {
  explore: [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_click_text',
    'browser_wait',
    'browser_screenshot',
    'browser_press_key',
    'ask_user',
    'agent_done',
  ],
  apply_entry: [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_click_text',
    'browser_form_snapshot',
    'browser_form_audit',
    'browser_inspect_options',
    'browser_wait',
    'browser_screenshot',
    'browser_press_key',
    'ask_user',
    'agent_done',
  ],
  fill_form: [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_click_text',
    'browser_form_snapshot',
    'browser_form_audit',
    'browser_inspect_options',
    'resume_query',
    'plan_form_fill',
    'ask_user',
    'browser_upload_file',
    'browser_fill_by_label',
    'browser_select_by_text',
    'browser_set_field',
    'browser_type',
    'browser_press_key',
    'browser_select',
    'browser_wait',
    'browser_screenshot',
    'agent_done',
  ],
  final_review: [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_click_text',
    'browser_form_snapshot',
    'browser_form_audit',
    'browser_wait',
    'browser_screenshot',
    'ask_user',
    'agent_done',
  ],
}

export type CapabilityTaskType = typeof TASK_TYPES[number]
export type CapabilitySafetyMode = typeof SAFETY_MODES[number]

export interface CapabilityDisclosureCase {
  id: string
  sources: CapabilityDisclosureSource[]
  taskType: CapabilityTaskType
  safetyMode: CapabilitySafetyMode
  asyncTasks: boolean
  requiredTools: string[]
}

export interface CapabilityDisclosureSource {
  path: string
  start: string
  end: string
}

export interface CapabilityDisclosureSuite {
  schemaVersion: 'capability-disclosure-suite/v1'
  cases: CapabilityDisclosureCase[]
}

interface CapabilityDisclosureMetrics {
  caseCount: number
  requiredToolRecall: number
  fullSchemaTokens: number
  selectedSchemaTokens: number
  schemaTokenReduction: number
}

export interface CapabilityDisclosureCaseResult extends CapabilityDisclosureMetrics {
  id: string
  taskType: CapabilityTaskType
  safetyMode: CapabilitySafetyMode
  asyncTasks: boolean
  fullTools: string[]
  selectedTools: string[]
  requiredTools: string[]
  missingRequiredTools: string[]
}

export interface CapabilityDisclosureReport extends CapabilityDisclosureMetrics {
  schemaVersion: 'capability-disclosure-report/v1'
  cases: CapabilityDisclosureCaseResult[]
  byTaskType: Record<CapabilityTaskType, CapabilityDisclosureMetrics>
  findings: string[]
}

export function assertCapabilityDisclosureSuite(value: unknown): asserts value is CapabilityDisclosureSuite {
  const suite = closedObject(value, new Set(['schemaVersion', 'cases']), 'suite')
  if (suite.schemaVersion !== 'capability-disclosure-suite/v1') {
    throw new Error(`Unsupported capability disclosure suite: ${String(suite.schemaVersion)}`)
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error('Capability disclosure suite cases must be non-empty.')
  }
  const knownTools = new Set(listLocalToolDefs().map((tool) => tool.name))
  const ids = new Set<string>()
  for (const [index, candidate] of suite.cases.entries()) {
    const evalCase = closedObject(
      candidate,
      new Set(['id', 'sources', 'taskType', 'safetyMode', 'asyncTasks', 'requiredTools']),
      `cases[${index}]`,
    )
    const id = requiredString(evalCase.id, `cases[${index}].id`)
    if (ids.has(id)) throw new Error(`Duplicate capability disclosure case id: ${id}`)
    ids.add(id)
    if (!Array.isArray(evalCase.sources) || evalCase.sources.length === 0) {
      throw new Error(`${id}.sources must be a non-empty array.`)
    }
    for (const [sourceIndex, candidateSource] of evalCase.sources.entries()) {
      const source = closedObject(candidateSource, new Set(['path', 'start', 'end']), `${id}.sources[${sourceIndex}]`)
      const path = requiredString(source.path, `${id}.sources[${sourceIndex}].path`)
      requiredString(source.start, `${id}.sources[${sourceIndex}].start`)
      requiredString(source.end, `${id}.sources[${sourceIndex}].end`)
      if (!/^scripts\/[a-z0-9][a-z0-9-]*\.mjs$/i.test(path)) {
        throw new Error(`${id}: invalid source reference ${path}`)
      }
    }
    if (!TASK_TYPES.includes(evalCase.taskType as CapabilityTaskType)) {
      throw new Error(`${id}.taskType is invalid.`)
    }
    if (!SAFETY_MODES.includes(evalCase.safetyMode as CapabilitySafetyMode)) {
      throw new Error(`${id}.safetyMode is invalid.`)
    }
    if (typeof evalCase.asyncTasks !== 'boolean') throw new Error(`${id}.asyncTasks must be boolean.`)
    const requiredTools = stringArray(evalCase.requiredTools, `${id}.requiredTools`)
    for (const tool of requiredTools) {
      if (!knownTools.has(tool)) throw new Error(`${id}: unknown required tool ${tool}`)
    }
  }
}

export function evaluateCapabilityDisclosure(input: {
  suite: CapabilityDisclosureSuite
  registry: ToolRegistry
}): CapabilityDisclosureReport {
  assertCapabilityDisclosureSuite(input.suite)
  const cases = input.suite.cases.map((evalCase): CapabilityDisclosureCaseResult => {
    const full = toolsForSafetyMode(input.registry, evalCase.safetyMode, evalCase.asyncTasks)
    const profile = new Set([
      ...PROFILE_TOOLS[evalCase.taskType],
      ...(evalCase.asyncTasks ? ASYNC_TOOLS : []),
    ])
    const selected = full.filter((tool) => profile.has(tool.function.name))
    const fullTools = full.map((tool) => tool.function.name)
    const selectedTools = selected.map((tool) => tool.function.name)
    const selectedNames = new Set(selectedTools)
    const missingRequiredTools = evalCase.requiredTools.filter((tool) => !selectedNames.has(tool))
    const fullSchemaTokens = estimateToolSchemas(full).toolSchemaTokens
    const selectedSchemaTokens = estimateToolSchemas(selected).toolSchemaTokens
    return {
      id: evalCase.id,
      taskType: evalCase.taskType,
      safetyMode: evalCase.safetyMode,
      asyncTasks: evalCase.asyncTasks,
      fullTools,
      selectedTools,
      requiredTools: [...evalCase.requiredTools],
      missingRequiredTools,
      ...metrics({
        caseCount: 1,
        requiredCount: evalCase.requiredTools.length,
        missingCount: missingRequiredTools.length,
        fullSchemaTokens,
        selectedSchemaTokens,
      }),
    }
  })
  const overall = aggregate(cases)
  const byTaskType = Object.fromEntries(TASK_TYPES.map((taskType) => [
    taskType,
    aggregate(cases.filter((item) => item.taskType === taskType)),
  ])) as Record<CapabilityTaskType, CapabilityDisclosureMetrics>
  const findings = TASK_TYPES.flatMap((taskType) => {
    const item = byTaskType[taskType]
    if (item.caseCount === 0) return [`${taskType}: no frozen cases; no reduction claim is available.`]
    return item.schemaTokenReduction < 0.3
      ? [`${taskType}: schema token reduction ${(item.schemaTokenReduction * 100).toFixed(1)}% is below 30%.`]
      : []
  })
  return {
    schemaVersion: 'capability-disclosure-report/v1',
    ...overall,
    cases,
    byTaskType,
    findings,
  }
}

function aggregate(cases: readonly CapabilityDisclosureCaseResult[]): CapabilityDisclosureMetrics {
  return metrics({
    caseCount: cases.length,
    requiredCount: cases.reduce((sum, item) => sum + item.requiredTools.length, 0),
    missingCount: cases.reduce((sum, item) => sum + item.missingRequiredTools.length, 0),
    fullSchemaTokens: cases.reduce((sum, item) => sum + item.fullSchemaTokens, 0),
    selectedSchemaTokens: cases.reduce((sum, item) => sum + item.selectedSchemaTokens, 0),
  })
}

function metrics(input: {
  caseCount: number
  requiredCount: number
  missingCount: number
  fullSchemaTokens: number
  selectedSchemaTokens: number
}): CapabilityDisclosureMetrics {
  return {
    caseCount: input.caseCount,
    requiredToolRecall: input.requiredCount === 0 ? 1 : (input.requiredCount - input.missingCount) / input.requiredCount,
    fullSchemaTokens: input.fullSchemaTokens,
    selectedSchemaTokens: input.selectedSchemaTokens,
    schemaTokenReduction: input.fullSchemaTokens === 0
      ? 0
      : 1 - input.selectedSchemaTokens / input.fullSchemaTokens,
  }
}

function closedObject(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !keys.has(key))
  if (unknown) throw new Error(`${label} has unknown field ${unknown}.`)
  return record
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`)
  const result = value.map((item, index) => requiredString(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates.`)
  return result
}
