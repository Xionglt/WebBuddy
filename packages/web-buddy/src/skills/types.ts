import type { PromptSection, PromptSectionId } from '../context/types.js'

export type SkillScope = 'managed' | 'builtin' | 'project' | 'user'
export type SkillLoadMode = 'manifest_only' | 'body_loaded'
export type SkillPolicyAction = 'block' | 'gate' | 'tighten' | 'hint'

export type SafetyInvariant =
  | 'no_final_submit'
  | 'stop_if_uncertain_final_submit'
  | 'no_auto_login'
  | 'no_auto_captcha'
  | 'no_auto_upload_resume'
  | 'no_auto_save_or_overwrite_profile'

export interface SkillDefinition {
  schemaVersion: 'web-buddy-skill/v1'
  id: string
  name: string
  scope: SkillScope
  sourceUri: string
  priority: number
  autoload?: boolean
  triggers?: SkillTriggers
  provides?: SkillProvides
  hardRules?: SkillHardRule[]
  promptSections?: SkillPromptSection[]
  policyHints?: SkillPolicyHint[]
  completionCriteria?: SkillCompletionCriterion[]
  memoryQueries?: SkillMemoryQuery[]
  bodyHash?: string
  loadedAt?: string
}

export interface SkillTriggers {
  taskTypes?: string[]
  domains?: string[]
  urlPatterns?: string[]
  workflowPhases?: string[]
  toolNames?: string[]
}

export interface SkillProvides {
  promptSections?: PromptSectionId[]
  policyHints?: boolean
  completionCriteria?: boolean
  memoryQueries?: boolean
}

export interface SkillHardRule {
  invariant: SafetyInvariant
  gateKind: 'login' | 'captcha' | 'upload_resume' | 'save_resume' | 'final_submit' | 'high_risk_action'
  action: Extract<SkillPolicyAction, 'block' | 'gate'>
  cannotBeOverridden: true
  reason: string
}

export interface SkillPromptSection {
  id: PromptSectionId
  title?: string
  summary?: string
  body?: string
}

export interface SkillPolicyHint {
  id: string
  skillId?: string
  action: SkillPolicyAction
  gateKind?: SkillHardRule['gateKind']
  invariant?: SafetyInvariant
  reason: string
  appliesWhen?: Record<string, unknown>
}

export interface SkillCompletionCriterion {
  id: string
  skillId?: string
  kind: 'required_evidence' | 'blocker_evidence' | 'done_signal' | 'site_boundary'
  description: string
  evidenceKeys: string[]
  severity: 'info' | 'warn' | 'block'
}

export interface SkillMemoryQuery {
  id: string
  skillId?: string
  scope: 'session' | 'project' | 'user'
  topics: string[]
  maxResults: number
}

export interface ResolvedSkillRef {
  id: string
  source: SkillScope
  reason: string
  priority: number
  loadMode: SkillLoadMode
  bodyHash?: string
}

export interface ResolvedSkillContext {
  schemaVersion: 'resolved-skill-context/v1'
  runId: string
  sessionId: string
  resolvedAt: string
  skills: ResolvedSkillRef[]
  promptSections: PromptSection[]
  policyHints: RequiredSkillPolicyHint[]
  completionCriteria: RequiredSkillCompletionCriterion[]
  memoryQueries: RequiredSkillMemoryQuery[]
  safetyInvariantDigest: SafetyInvariantDigest
}

export type RequiredSkillPolicyHint = SkillPolicyHint & { skillId: string }
export type RequiredSkillCompletionCriterion = SkillCompletionCriterion & { skillId: string }
export type RequiredSkillMemoryQuery = SkillMemoryQuery & { skillId: string }

export interface SafetyInvariantDigest {
  schemaVersion: 'safety-invariant-digest/v1'
  enforcedByRuntime: SafetyInvariant[]
  effectiveGates: Array<{ invariant: SafetyInvariant; gateKind: SkillHardRule['gateKind']; source: 'runtime' | 'managed_skill' }>
  ignoredRelaxations: Array<{ skillId: string; invariant: SafetyInvariant; reason: string }>
}

export interface SkillResolutionInput {
  runId: string
  sessionId: string
  goal: string
  taskType?: string
  safetyMode?: 'guarded' | 'raw'
  url?: string
  workflowPhase?: string
  now?: Date
}

export interface LoadedSkill {
  definition: SkillDefinition
  body: string
}

