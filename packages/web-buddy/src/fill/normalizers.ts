import type { FormFieldOption } from '../observation/form-state.js'
import type { ResumeEducation, ResumeExperience } from '../sdk/resume.js'

export interface OptionMatch {
  optionValue: string
  optionLabel: string
  score: number
}

export function normalizePhone(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const digits = value.replace(/[^\d+]/g, '')
  if (digits.startsWith('+86') && digits.length > 3) return digits.slice(3)
  if (digits.startsWith('0086') && digits.length > 4) return digits.slice(4)
  return digits || undefined
}

export function normalizeDate(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const match = value.match(/(\d{4})[.\-/年\s]*(\d{1,2})?/)
  if (!match) return value
  const year = match[1]
  const month = match[2] ? match[2].padStart(2, '0') : '01'
  return `${year}-${month}`
}

export function normalizeText(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[，。；：、（）()[\]{}|\/\\_\-+.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function matchOption(value: string | undefined, options: FormFieldOption[] | undefined): OptionMatch | undefined {
  const source = normalizeText(value)
  if (!source || !options?.length) return undefined

  let best: OptionMatch | undefined
  for (const option of options) {
    const label = option.label || option.value
    const normalizedLabel = normalizeText(label)
    const normalizedValue = normalizeText(option.value)
    const score = Math.max(
      stringScore(source, normalizedLabel),
      stringScore(source, normalizedValue),
      stringScore(normalizedLabel, source),
      stringScore(normalizedValue, source),
    )
    if (!best || score > best.score) {
      best = { optionValue: option.value, optionLabel: label, score }
    }
  }

  return best && best.score >= 0.55 ? best : undefined
}

export function deriveYearsOfExperience(experience: ResumeExperience[] | undefined, now = new Date()): number | undefined {
  if (!experience?.length) return undefined
  let totalMonths = 0
  for (const item of experience) {
    const range = parsePeriodRange(item.period, now)
    if (!range) continue
    totalMonths += Math.max(0, monthIndex(range.end) - monthIndex(range.start) + 1)
  }
  if (totalMonths <= 0) return undefined
  return Math.max(1, Math.round(totalMonths / 12))
}

export function pickHighestDegree(education: ResumeEducation[] | undefined): string | undefined {
  if (!education?.length) return undefined
  const ranked = education
    .map((item) => ({ item, rank: degreeRank(item.degree) }))
    .sort((a, b) => b.rank - a.rank)
  return ranked[0]?.item.degree || education[0]?.degree
}

export function composeSelfIntro(input: {
  summary?: string
  skills?: string[]
  experience?: ResumeExperience[]
  maxLen?: number
}): string | undefined {
  const parts = [
    input.summary,
    input.experience?.[0]?.summary,
    input.skills?.length ? `Skills: ${input.skills.slice(0, 8).join(', ')}` : undefined,
  ].filter((part): part is string => Boolean(part?.trim()))
  if (!parts.length) return undefined
  const maxLen = input.maxLen ?? 220
  const text = parts.join(' ')
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text
}

function stringScore(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15
  const aTokens = new Set(a.split(' ').filter(Boolean))
  const bTokens = new Set(b.split(' ').filter(Boolean))
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length
  if (intersection > 0) return intersection / Math.max(aTokens.size, bTokens.size)
  return levenshteinScore(a, b)
}

function levenshteinScore(a: string, b: string): number {
  const distance = levenshtein(a, b)
  return 1 - distance / Math.max(a.length, b.length)
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = Array.from({ length: b.length + 1 }, () => 0)
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : Math.min(prev[j - 1], prev[j], curr[j - 1]) + 1
    }
    prev.splice(0, prev.length, ...curr)
  }
  return prev[b.length]
}

function degreeRank(degree: string | undefined): number {
  const text = normalizeText(degree)
  if (/博士|phd|doctor/.test(text)) return 5
  if (/硕士|master|mba/.test(text)) return 4
  if (/本科|学士|bachelor|bs|ba/.test(text)) return 3
  if (/大专|专科|associate/.test(text)) return 2
  if (/高中|中专/.test(text)) return 1
  return 0
}

function parsePeriodRange(period: string | undefined, now: Date): { start: Date; end: Date } | undefined {
  if (!period) return undefined
  const matches = [...period.matchAll(/(\d{4})(?:[.\-/年\s]*(\d{1,2}))?/g)]
  if (!matches.length) return undefined
  const start = dateFromMatch(matches[0])
  const hasPresent = /至今|现在|present|now|current/i.test(period)
  const end = hasPresent ? now : dateFromMatch(matches[matches.length - 1])
  return { start, end }
}

function dateFromMatch(match: RegExpMatchArray): Date {
  const year = Number(match[1])
  const month = Math.max(1, Math.min(12, Number(match[2] ?? '1')))
  return new Date(Date.UTC(year, month - 1, 1))
}

function monthIndex(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}
