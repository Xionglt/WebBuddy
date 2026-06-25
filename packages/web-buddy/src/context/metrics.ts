import { DEFAULT_TRUNCATION_MARKER } from './budget.js'
import type { PromptSection, PromptSectionId } from './types.js'

export interface ContextSelectionMetrics {
  contextBuilds: number
  contextChars: number
  contextTruncations: number
  recentActionsIncluded: number
  pageStateAgeMs?: number
  formStateAgeMs?: number
  promptSectionChars: Partial<Record<PromptSectionId, number>>
}

export interface MeasurePromptSectionsOptions {
  contextBuilds?: number
  pageStateAgeMs?: number
  formStateAgeMs?: number
}

export function measurePromptSections(
  sections: PromptSection[],
  options: MeasurePromptSectionsOptions = {},
): ContextSelectionMetrics {
  const promptSectionChars: Partial<Record<PromptSectionId, number>> = {}
  let contextTruncations = 0
  let recentActionsIncluded = 0

  for (const section of sections) {
    promptSectionChars[section.id] = section.content.length
    if (isTruncated(section.content)) contextTruncations += 1
    if (section.id === 'RECENT_ACTIONS') {
      recentActionsIncluded = countRecentActions(section.content)
    }
  }

  return {
    contextBuilds: options.contextBuilds ?? 1,
    contextChars: renderedPromptChars(sections),
    contextTruncations,
    recentActionsIncluded,
    ...(finiteNumber(options.pageStateAgeMs) === undefined ? {} : { pageStateAgeMs: options.pageStateAgeMs }),
    ...(finiteNumber(options.formStateAgeMs) === undefined ? {} : { formStateAgeMs: options.formStateAgeMs }),
    promptSectionChars,
  }
}

function renderedPromptChars(sections: PromptSection[]): number {
  return sections.reduce((total, section, index) => {
    const separatorChars = index === 0 ? 0 : 2
    return total + separatorChars + `## ${section.title}\n${section.content}`.length
  }, 0)
}

function isTruncated(content: string): boolean {
  return content.includes(DEFAULT_TRUNCATION_MARKER) || /\btruncated\b/i.test(content)
}

function countRecentActions(content: string): number {
  return content.match(/^\s*-\s+step=/gm)?.length ?? 0
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
