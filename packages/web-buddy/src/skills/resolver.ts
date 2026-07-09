import type {
  LoadedSkill,
  RequiredSkillCompletionCriterion,
  RequiredSkillMemoryQuery,
  RequiredSkillPolicyHint,
  ResolvedSkillContext,
  SafetyInvariant,
  SafetyInvariantDigest,
  SkillDefinition,
  SkillResolutionInput,
} from './types.js'

const RUNTIME_INVARIANTS: SafetyInvariant[] = [
  'no_final_submit',
  'stop_if_uncertain_final_submit',
  'no_auto_login',
  'no_auto_captcha',
  'no_auto_upload_resume',
  'no_auto_save_or_overwrite_profile',
]

export function resolveSkills(skills: LoadedSkill[], input: SkillResolutionInput): ResolvedSkillContext {
  const resolvedAt = (input.now ?? new Date()).toISOString()
  const hits = skills
    .map((skill, index) => ({ skill, index, reason: hitReason(skill.definition, input) }))
    .filter((hit) => hit.reason)
    .sort((a, b) => a.skill.definition.priority - b.skill.definition.priority || a.index - b.index)

  const ignoredRelaxations = ignoredRelaxationsFor(hits.map((hit) => hit.skill.definition))
  const allowed = hits.filter((hit) => !attemptsRelaxation(hit.skill.definition))

  return {
    schemaVersion: 'resolved-skill-context/v1',
    runId: input.runId,
    sessionId: input.sessionId,
    resolvedAt,
    skills: allowed.map((hit) => ({
      id: hit.skill.definition.id,
      source: hit.skill.definition.scope,
      reason: hit.reason || 'matched',
      priority: hit.skill.definition.priority,
      loadMode: skillLoadMode(hit.skill.definition),
      bodyHash: hit.skill.definition.bodyHash,
    })),
    promptSections: allowed.flatMap((hit) => (hit.skill.definition.promptSections ?? []).map((section) => ({
      id: section.id,
      title: section.title ?? section.id,
      content: [section.summary, section.body].filter(Boolean).join('\n'),
    }))),
    policyHints: allowed.flatMap((hit) => withSkillId(hit.skill.definition.policyHints, hit.skill.definition.id)),
    completionCriteria: allowed.flatMap((hit) => withSkillId(hit.skill.definition.completionCriteria, hit.skill.definition.id)),
    memoryQueries: allowed.flatMap((hit) => withSkillId(hit.skill.definition.memoryQueries, hit.skill.definition.id)),
    safetyInvariantDigest: safetyDigest(allowed.map((hit) => hit.skill.definition), ignoredRelaxations),
  }
}

function skillLoadMode(skill: SkillDefinition): 'manifest_only' | 'body_loaded' {
  return (skill.promptSections ?? []).some((section) => section.body) ? 'body_loaded' : 'manifest_only'
}

export function hitReason(skill: SkillDefinition, input: SkillResolutionInput): string | undefined {
  if (skill.autoload) return 'autoload'
  const triggers = skill.triggers
  if (!triggers) return undefined
  if (input.taskType && triggers.taskTypes?.includes(input.taskType)) return `taskType:${input.taskType}`
  if (input.workflowPhase && triggers.workflowPhases?.includes(input.workflowPhase)) return `workflowPhase:${input.workflowPhase}`
  const url = input.url
  if (url) {
    const parsed = safeUrl(url)
    const host = parsed?.hostname.toLowerCase()
    if (host && triggers.domains?.some((domain) => domainMatches(host, domain))) return `domain:${host}`
    if (triggers.urlPatterns?.some((pattern) => urlPatternMatches(url, pattern))) return `urlPattern:${urlPatternSummary(url, triggers.urlPatterns)}`
  }
  return undefined
}

function safetyDigest(
  skills: SkillDefinition[],
  ignoredRelaxations: SafetyInvariantDigest['ignoredRelaxations'],
): SafetyInvariantDigest {
  const gates = new Map<string, SafetyInvariantDigest['effectiveGates'][number]>()
  for (const invariant of RUNTIME_INVARIANTS) {
    gates.set(invariant, { invariant, gateKind: gateKindForInvariant(invariant), source: 'runtime' })
  }
  for (const skill of skills) {
    if (skill.scope !== 'managed' && skill.scope !== 'builtin') continue
    for (const rule of skill.hardRules ?? []) {
      gates.set(rule.invariant, { invariant: rule.invariant, gateKind: rule.gateKind, source: 'managed_skill' })
    }
  }
  return {
    schemaVersion: 'safety-invariant-digest/v1',
    enforcedByRuntime: [...RUNTIME_INVARIANTS],
    effectiveGates: [...gates.values()],
    ignoredRelaxations,
  }
}

function attemptsRelaxation(skill: SkillDefinition): boolean {
  if (skill.scope === 'managed' || skill.scope === 'builtin') return false
  return (skill.policyHints ?? []).some((hint) =>
    hint.action === 'hint' && hint.invariant && RUNTIME_INVARIANTS.includes(hint.invariant),
  )
}

function ignoredRelaxationsFor(skills: SkillDefinition[]): SafetyInvariantDigest['ignoredRelaxations'] {
  const ignored: SafetyInvariantDigest['ignoredRelaxations'] = []
  for (const skill of skills) {
    if (skill.scope === 'managed' || skill.scope === 'builtin') continue
    for (const hint of skill.policyHints ?? []) {
      if (hint.action === 'hint' && hint.invariant && RUNTIME_INVARIANTS.includes(hint.invariant)) {
        ignored.push({
          skillId: skill.id,
          invariant: hint.invariant,
          reason: 'Project/user skills may not relax runtime safety invariants.',
        })
      }
    }
  }
  return ignored
}

function withSkillId<T extends { skillId?: string }>(items: T[] | undefined, skillId: string): Array<T & { skillId: string }> {
  return (items ?? []).map((item) => ({ ...item, skillId })) as Array<T & { skillId: string }>
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function domainMatches(host: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\*\./, '')
  return host === normalized || host.endsWith(`.${normalized}`)
}

function urlPatternMatches(url: string, pattern: string): boolean {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`, 'i').test(url)
}

function urlPatternSummary(url: string, patterns: string[]): string {
  return patterns.find((pattern) => urlPatternMatches(url, pattern)) ?? url
}

function gateKindForInvariant(invariant: SafetyInvariant): SafetyInvariantDigest['effectiveGates'][number]['gateKind'] {
  switch (invariant) {
    case 'no_auto_login':
      return 'login'
    case 'no_auto_captcha':
      return 'captcha'
    case 'no_auto_upload_resume':
      return 'upload_resume'
    case 'no_auto_save_or_overwrite_profile':
      return 'save_resume'
    case 'no_final_submit':
    case 'stop_if_uncertain_final_submit':
      return 'final_submit'
  }
}
