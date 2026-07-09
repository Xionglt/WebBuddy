import type { PromptSection, PromptSectionId } from '../context/types.js'
import type { ResolvedSkillContext } from './types.js'

export function renderSkillPromptSection(context: ResolvedSkillContext | undefined, id: PromptSectionId): string[] {
  if (!context) return []
  return context.promptSections
    .filter((section) => section.id === id)
    .flatMap((section) => section.content.split('\n').map((line) => line.trim()).filter(Boolean))
}

export function skillPromptSections(context: ResolvedSkillContext | undefined): PromptSection[] {
  return context?.promptSections ?? []
}

export function renderResolvedSkillsSummary(context: ResolvedSkillContext | undefined): string {
  if (!context || context.skills.length === 0) return '(no skills resolved)'
  return context.skills
    .map((skill) => `- ${skill.id} (${skill.source}, ${skill.reason}, priority=${skill.priority})`)
    .join('\n')
}

