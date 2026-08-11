import { createHash } from 'node:crypto'
import type { ContentSensitivity, JsonObject } from '../task/contracts.js'
import type { MemoryLifecycleRecord } from './memory-lifecycle.js'
import type {
  EvidenceBoundedWebMemory,
  WebMemoryGovernanceDecision,
  WebMemoryEffect,
} from './web-memory-governance.js'

export const BROWSER_SCENARIO_CAPSULE_SCHEMA_VERSION = 'browser-scenario-capsule/v1' as const

export type BrowserScenarioCapsuleAtom = JsonObject & {
  entryId: string
  revision: number
  memoryKey?: string
  statement: string
  governance: WebMemoryGovernanceDecision
  evidenceRef: JsonObject & {
    source: EvidenceBoundedWebMemory['evidence']['source']
    capturedAt: string
    contentId?: string
    quoteHash?: string
  }
}

export type BrowserScenarioCapsule = JsonObject & {
  schemaVersion: typeof BROWSER_SCENARIO_CAPSULE_SCHEMA_VERSION
  capsuleId: string
  applicability: JsonObject & {
    urlOrigin?: string
    pathPattern?: string
    workflow?: string
    pageType?: string
  }
  preferences: BrowserScenarioCapsuleAtom[]
  restrictiveConstraints: BrowserScenarioCapsuleAtom[]
  procedures: BrowserScenarioCapsuleAtom[]
  atomRefs: Array<JsonObject & { entryId: string; revision: number }>
  latestEvidenceAt: string
}

export interface GovernedScenarioMemory {
  record: Readonly<MemoryLifecycleRecord>
  memory: EvidenceBoundedWebMemory
  governance: WebMemoryGovernanceDecision
}

export interface ProjectedBrowserScenarioCapsule {
  capsule: BrowserScenarioCapsule
  records: ReadonlyArray<Readonly<MemoryLifecycleRecord>>
  sensitivity: ContentSensitivity
  expiresAt?: string
}

/**
 * Build L2 scenario views deterministically from governed L1 atoms. Capsules
 * contain no model-authored facts and remain reconstructable from atomRefs.
 */
export function projectBrowserScenarioCapsules(
  memories: ReadonlyArray<GovernedScenarioMemory>,
): ProjectedBrowserScenarioCapsule[] {
  const groups = new Map<string, GovernedScenarioMemory[]>()
  for (const item of memories) {
    const key = scenarioKey(item.memory)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }

  return [...groups.values()].map((items) => {
    const sorted = [...items].sort((left, right) => (
      effectOrder(left.memory.effect) - effectOrder(right.memory.effect)
      || left.memory.memoryKey?.localeCompare(right.memory.memoryKey ?? '')
      || left.record.entryId.localeCompare(right.record.entryId)
    ))
    const applicability = scenarioApplicability(sorted[0].memory)
    const atoms = sorted.map(toCapsuleAtom)
    const latestEvidenceAt = sorted
      .map((item) => item.memory.evidence.capturedAt)
      .sort()
      .at(-1)!
    const capsuleBody = {
      schemaVersion: BROWSER_SCENARIO_CAPSULE_SCHEMA_VERSION,
      applicability,
      preferences: atomsForEffect(sorted, atoms, 'preference'),
      restrictiveConstraints: atomsForEffect(sorted, atoms, 'restrictive_constraint'),
      procedures: atomsForEffect(sorted, atoms, 'procedure'),
      atomRefs: sorted.map((item) => ({
        entryId: item.record.entryId,
        revision: item.record.revision,
      })),
      latestEvidenceAt,
    }
    return {
      capsule: {
        ...capsuleBody,
        capsuleId: `scenario-${sha256(JSON.stringify(capsuleBody)).slice(0, 24)}`,
      },
      records: sorted.map((item) => item.record),
      sensitivity: highestSensitivity(sorted.map((item) => item.record.sensitivity)),
      ...minimumExpiry(sorted.map((item) => item.record.expiresAt)),
    }
  })
}

function toCapsuleAtom(item: GovernedScenarioMemory): BrowserScenarioCapsuleAtom {
  return {
    entryId: item.record.entryId,
    revision: item.record.revision,
    ...(item.memory.memoryKey ? { memoryKey: item.memory.memoryKey } : {}),
    statement: item.memory.statement,
    governance: item.governance,
    evidenceRef: {
      source: item.memory.evidence.source,
      capturedAt: item.memory.evidence.capturedAt,
      ...(item.memory.evidence.contentId ? { contentId: item.memory.evidence.contentId } : {}),
      ...(item.memory.evidence.quoteHash ? { quoteHash: item.memory.evidence.quoteHash } : {}),
    },
  }
}

function atomsForEffect(
  items: ReadonlyArray<GovernedScenarioMemory>,
  atoms: ReadonlyArray<BrowserScenarioCapsuleAtom>,
  effect: WebMemoryEffect,
): BrowserScenarioCapsuleAtom[] {
  return atoms.filter((_, index) => items[index].memory.effect === effect)
}

function scenarioApplicability(memory: EvidenceBoundedWebMemory): BrowserScenarioCapsule['applicability'] {
  const pageType = memory.evidence.pageFingerprint?.pageType
  return {
    ...(memory.applicability?.urlOrigin ? { urlOrigin: memory.applicability.urlOrigin } : {}),
    ...(memory.applicability?.pathPattern ? { pathPattern: memory.applicability.pathPattern } : {}),
    ...(memory.applicability?.workflow ? { workflow: memory.applicability.workflow } : {}),
    ...(pageType ? { pageType } : {}),
  }
}

function scenarioKey(memory: EvidenceBoundedWebMemory): string {
  return JSON.stringify(scenarioApplicability(memory))
}

function effectOrder(effect: WebMemoryEffect): number {
  if (effect === 'restrictive_constraint') return 0
  if (effect === 'preference') return 1
  if (effect === 'procedure') return 2
  return 3
}

function highestSensitivity(values: ReadonlyArray<ContentSensitivity>): ContentSensitivity {
  const levels: ContentSensitivity[] = ['public', 'internal', 'personal', 'auth', 'secret']
  return values.reduce((highest, value) => (
    levels.indexOf(value) > levels.indexOf(highest) ? value : highest
  ), 'public')
}

function minimumExpiry(values: ReadonlyArray<string | undefined>): { expiresAt?: string } {
  const expiresAt = values.filter((value): value is string => Boolean(value)).sort()[0]
  return expiresAt ? { expiresAt } : {}
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
