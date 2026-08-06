import { digestCanonicalJson, type JsonValue } from '../task/contracts.js'

export type ExperimentLayer =
  | 'grader_unit'
  | 'harness_contract'
  | 'mechanism_ablation'
  | 'model_e2e'

export type ExperimentHardGate =
  | 'unsafe_actions'
  | 'permission_elevations'
  | 'secret_leaks'
  | 'memory_pollution_writes'
  | 'premature_completion'

export interface ExperimentTaskSet {
  id: string
  version: string
  sha256: string
  scenarioIds: string[]
}

export interface ExperimentConstants {
  harnessFingerprint: string
  taskSetFingerprint: string
  modelFingerprint?: string
  environmentFingerprint?: string
}

export interface ExperimentVariant {
  id: string
  label: string
  modelFingerprint?: string
  mechanismFingerprint?: string
  overrides?: Record<string, JsonValue>
}

export interface ExperimentMetricPlan {
  primary: string[]
  secondary: string[]
  hardGates: ExperimentHardGate[]
}

export interface ExperimentDefinition {
  schemaVersion: 'experiment-definition/v1'
  id: string
  version: string
  layer: ExperimentLayer
  hypothesis: string
  taskSet: ExperimentTaskSet
  repetitions: number
  pairing: 'paired_by_task_and_repetition'
  controlVariantId: string
  constants: ExperimentConstants
  variants: ExperimentVariant[]
  metrics: ExperimentMetricPlan
  createdAt: string
}

export interface ExperimentRunPlan {
  schemaVersion: 'experiment-run-plan/v1'
  experimentId: string
  experimentVersion: string
  definitionSha256: string
  pairId: string
  taskId: string
  repetition: number
  variantId: string
}

const REQUIRED_HARD_GATES = new Set<ExperimentHardGate>([
  'unsafe_actions',
  'permission_elevations',
  'secret_leaks',
  'memory_pollution_writes',
  'premature_completion',
])

export function validateExperimentDefinition(definition: ExperimentDefinition): void {
  if (definition.schemaVersion !== 'experiment-definition/v1') {
    throw new Error(`Unsupported experiment definition schema: ${String(definition.schemaVersion)}.`)
  }
  nonEmpty(definition.id, 'experiment id')
  nonEmpty(definition.version, 'experiment version')
  nonEmpty(definition.hypothesis, 'experiment hypothesis')
  if (!Number.isSafeInteger(definition.repetitions) || definition.repetitions < 1) {
    throw new Error('Experiment repetitions must be a positive integer.')
  }
  if (definition.pairing !== 'paired_by_task_and_repetition') {
    throw new Error('Experiment comparison must be paired by task and repetition.')
  }
  validateTaskSet(definition.taskSet)
  nonEmpty(definition.constants.harnessFingerprint, 'harness fingerprint')
  nonEmpty(definition.constants.taskSetFingerprint, 'task-set fingerprint')
  if (definition.constants.taskSetFingerprint !== definition.taskSet.sha256) {
    throw new Error('Experiment taskSetFingerprint must match taskSet.sha256.')
  }
  if (!Array.isArray(definition.variants) || definition.variants.length === 0) {
    throw new Error('Experiment must define at least one variant.')
  }
  unique(definition.variants.map((variant) => variant.id), 'variant id')
  for (const variant of definition.variants) {
    nonEmpty(variant.id, 'variant id')
    nonEmpty(variant.label, `variant ${variant.id} label`)
  }
  if (!definition.variants.some((variant) => variant.id === definition.controlVariantId)) {
    throw new Error(`Experiment control variant ${definition.controlVariantId} is not defined.`)
  }
  if ((definition.layer === 'mechanism_ablation' || definition.layer === 'model_e2e')
    && definition.variants.length < 2) {
    throw new Error(`${definition.layer} experiments require at least two variants.`)
  }
  validateIsolation(definition)
  validateMetricPlan(definition.metrics)
  if (!Number.isFinite(Date.parse(definition.createdAt))) {
    throw new Error('Experiment createdAt must be an ISO timestamp.')
  }
}

export function buildExperimentRunMatrix(
  definition: ExperimentDefinition,
): ExperimentRunPlan[] {
  validateExperimentDefinition(definition)
  const plans: ExperimentRunPlan[] = []
  const definitionSha256 = digestCanonicalJson(definition)
  for (const taskId of definition.taskSet.scenarioIds) {
    for (let repetition = 1; repetition <= definition.repetitions; repetition += 1) {
      const pairId = `${definition.id}:${definition.version}:${taskId}:${repetition}`
      for (const variant of definition.variants) {
        plans.push({
          schemaVersion: 'experiment-run-plan/v1',
          experimentId: definition.id,
          experimentVersion: definition.version,
          definitionSha256,
          pairId,
          taskId,
          repetition,
          variantId: variant.id,
        })
      }
    }
  }
  return plans
}

function validateIsolation(definition: ExperimentDefinition): void {
  if (definition.layer === 'mechanism_ablation') {
    nonEmpty(definition.constants.modelFingerprint, 'fixed model fingerprint')
    for (const variant of definition.variants) {
      if (variant.modelFingerprint
        && variant.modelFingerprint !== definition.constants.modelFingerprint) {
        throw new Error(
          `Mechanism ablation variant ${variant.id} changes the fixed model fingerprint.`,
        )
      }
      nonEmpty(variant.mechanismFingerprint, `variant ${variant.id} mechanism fingerprint`)
    }
    if (new Set(definition.variants.map((variant) => variant.mechanismFingerprint)).size < 2) {
      throw new Error('Mechanism ablation must compare at least two mechanism fingerprints.')
    }
  }
  if (definition.layer === 'model_e2e') {
    for (const variant of definition.variants) {
      nonEmpty(variant.modelFingerprint, `variant ${variant.id} model fingerprint`)
      if (variant.mechanismFingerprint) {
        throw new Error(
          `Model E2E variant ${variant.id} cannot override the fixed harness mechanism.`,
        )
      }
    }
    if (new Set(definition.variants.map((variant) => variant.modelFingerprint)).size < 2) {
      throw new Error('Model E2E must compare at least two model fingerprints.')
    }
  }
}

function validateMetricPlan(metrics: ExperimentMetricPlan): void {
  if (!metrics.primary.length) throw new Error('Experiment must define a primary metric.')
  unique(metrics.primary, 'primary metric')
  unique(metrics.secondary, 'secondary metric')
  unique(metrics.hardGates, 'hard gate')
  const missing = [...REQUIRED_HARD_GATES].filter((gate) => !metrics.hardGates.includes(gate))
  if (missing.length) {
    throw new Error(`Experiment is missing required hard gates: ${missing.join(', ')}.`)
  }
}

function validateTaskSet(taskSet: ExperimentTaskSet): void {
  nonEmpty(taskSet.id, 'task-set id')
  nonEmpty(taskSet.version, 'task-set version')
  if (!/^[a-f0-9]{64}$/i.test(taskSet.sha256)) {
    throw new Error('Task-set sha256 must be a SHA-256 hex digest.')
  }
  if (!taskSet.scenarioIds.length) throw new Error('Task set must contain at least one scenario.')
  unique(taskSet.scenarioIds, 'scenario id')
  taskSet.scenarioIds.forEach((id) => nonEmpty(id, 'scenario id'))
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`)
}

function nonEmpty(value: string | undefined, label: string): asserts value is string {
  if (!value?.trim()) throw new Error(`${label} is required.`)
}
