import { createHash } from 'node:crypto'
import type { FormState } from '../../observation/form-state.js'
import type { PageState } from '../../observation/page-state.js'
import type { ToolCall } from '../../tools/tool-contract.js'
import type { WorkflowPhase } from '../../workflow/workflow-state.js'

export interface AgentProgressGuardOptions {
  /** Number of identical no-progress outcomes allowed before forcing a replan. */
  repeatThreshold: number
  /** Number of replan interventions allowed before the run is blocked. */
  maxReplans: number
  /** Tools that are expected to poll, wait, ask, or terminate without page progress. */
  exemptTools: readonly string[]
}

export interface AgentProgressContext {
  url?: string
  workflowPhase: WorkflowPhase
  page?: PageState
  form?: FormState
}

export interface AgentProgressOutcome {
  ok: boolean
  observation: string
  pageChanged?: boolean
  done?: boolean
}

export type AgentProgressDecision =
  | { action: 'allow' }
  | {
      action: 'replan' | 'block'
      fingerprint: string
      repeats: number
      reason: string
    }

interface NoProgressRecord {
  contextSignature: string
  observationSignature: string
  repeats: number
  replans: number
}

const DEFAULT_OPTIONS: AgentProgressGuardOptions = Object.freeze({
  repeatThreshold: 2,
  maxReplans: 1,
  exemptTools: [
    'agent_done',
    'ask_user',
    'browser_snapshot',
    'browser_form_snapshot',
    'browser_form_audit',
    'browser_wait',
    'agent_task_status',
    'agent_task_wait',
    'agent_task_result',
  ],
})

/**
 * Detects exact action loops at a stable execution context. The guard is
 * deliberately conservative: a changed page/form/workflow state or a new
 * observation resets the streak instead of being treated as a loop.
 */
export class AgentProgressGuard {
  private readonly options: AgentProgressGuardOptions
  private readonly records = new Map<string, NoProgressRecord>()

  constructor(options: Partial<AgentProgressGuardOptions> = {}) {
    this.options = {
      repeatThreshold: positiveInteger(options.repeatThreshold, DEFAULT_OPTIONS.repeatThreshold),
      maxReplans: nonNegativeInteger(options.maxReplans, DEFAULT_OPTIONS.maxReplans),
      exemptTools: options.exemptTools ?? DEFAULT_OPTIONS.exemptTools,
    }
  }

  beforeCall(call: ToolCall, context: AgentProgressContext): AgentProgressDecision {
    if (this.options.exemptTools.includes(call.name)) return { action: 'allow' }

    const fingerprint = actionFingerprint(call)
    const record = this.records.get(fingerprint)
    if (!record) return { action: 'allow' }

    const contextSignature = progressContextSignature(context)
    if (record.contextSignature !== contextSignature) {
      this.records.delete(fingerprint)
      return { action: 'allow' }
    }
    if (record.repeats < this.options.repeatThreshold) return { action: 'allow' }

    if (record.replans < this.options.maxReplans) {
      record.replans += 1
      return {
        action: 'replan',
        fingerprint,
        repeats: record.repeats,
        reason: `The same action produced no new state or observation ${record.repeats} times. Replan before retrying it.`,
      }
    }

    return {
      action: 'block',
      fingerprint,
      repeats: record.repeats,
      reason: `The same action was proposed again after a no-progress replan. Stop to avoid an execution loop.`,
    }
  }

  record(
    call: ToolCall,
    before: AgentProgressContext,
    after: AgentProgressContext,
    outcome: AgentProgressOutcome,
  ): void {
    if (this.options.exemptTools.includes(call.name)) return

    const fingerprint = actionFingerprint(call)
    const beforeSignature = progressContextSignature(before)
    const afterSignature = progressContextSignature(after)
    if (outcome.done || outcome.pageChanged || beforeSignature !== afterSignature) {
      this.records.delete(fingerprint)
      return
    }

    const observationSignature = normalizeObservation(outcome.observation)
    const previous = this.records.get(fingerprint)
    if (
      previous &&
      previous.contextSignature === afterSignature &&
      previous.observationSignature === observationSignature
    ) {
      previous.repeats += 1
      return
    }

    this.records.set(fingerprint, {
      contextSignature: afterSignature,
      observationSignature,
      repeats: 1,
      replans: 0,
    })
  }
}

export function actionFingerprint(call: ToolCall): string {
  const canonical = `${call.name}:${stableSerialize(normalizeArguments(call.arguments))}`
  return createHash('sha256').update(canonical).digest('hex')
}

export function progressContextSignature(context: AgentProgressContext): string {
  return stableSerialize({
    url: context.url ?? context.page?.url ?? context.form?.url,
    workflowPhase: context.workflowPhase,
    page: context.page
      ? {
          url: context.page.url,
          title: context.page.title,
          pageType: context.page.pageType,
          textSummary: context.page.textSummary,
          interactiveCount: context.page.interactiveCount,
          formCount: context.page.formCount,
          buttonCount: context.page.buttonCount,
          inputCount: context.page.inputCount,
        }
      : undefined,
    form: context.form
      ? {
          url: context.form.url,
          fields: context.form.fields.map((field) => ({
            index: field.index,
            fieldKey: field.fieldKey,
            value: field.value,
            filled: field.filled,
            checked: field.checked,
            invalid: field.invalid,
            error: field.error,
          })),
          missingRequired: context.form.missingRequired.map((field) => field.fieldKey ?? field.label),
          visibleErrors: context.form.visibleErrors,
        }
      : undefined,
  })
}

function normalizeArguments(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(argumentsValue)) {
    if (key === 'timeoutMs' || key === 'highlight') continue
    normalized[key] = value
  }
  return normalized
}

function normalizeObservation(observation: string): string {
  return observation.replace(/\s+/g, ' ').trim().slice(0, 1_000)
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? value! : fallback
}
