export const DEFAULT_TRUNCATION_MARKER = '...[truncated]'

export function truncateText(value: string, maxChars: number, marker = DEFAULT_TRUNCATION_MARKER): string {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value

  const omitted = value.length - maxChars
  const suffix = `\n${marker} ${omitted} chars`
  const keep = maxChars - suffix.length
  if (keep <= 0) return value.slice(0, maxChars)
  return `${value.slice(0, keep)}${suffix}`
}

export function oneLine(value: unknown, maxChars = 120): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return truncateText(text, maxChars)
}

export function normalizeLines(lines: Array<string | undefined | false | null>): string {
  return lines.filter((line): line is string => Boolean(line && line.trim())).join('\n')
}
