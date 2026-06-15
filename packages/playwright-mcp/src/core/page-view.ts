import type { PageSnapshot } from '../types.js'

/**
 * Render a PageSnapshot as compact, LLM-friendly text. This is what the model
 * reads to decide which `[ref]` to click/type — mirroring the accessibility-tree
 * snapshot pattern used by hermes/openclaw-style browser agents.
 *
 * Format:
 *   URL: ...
 *   Title: ...
 *   Page text: <truncated body summary>
 *
 *   Interactive elements (use the [ref] id in browser_click/browser_type/...):
 *     [e1] input   "姓名 Name"           risk=L2
 *     [e4] button  "投递申请 Submit"       risk=L3   ← needs confirmation
 */
export function pageView(snapshot: PageSnapshot | undefined | null, maxElements = 60): string {
  if (!snapshot) return '(no snapshot yet — call browser_snapshot or browser_open first)'

  const lines: string[] = []
  lines.push(`URL: ${snapshot.url}`)
  lines.push(`Title: ${snapshot.title || '(untitled)'}`)
  if (snapshot.textSummary) {
    const t = snapshot.textSummary.length > 600
      ? `${snapshot.textSummary.slice(0, 600)}… (+${snapshot.textSummary.length - 600} chars)`
      : snapshot.textSummary
    lines.push(`Page text: ${t.replace(/\n/g, ' ')}`)
  }
  lines.push('')
  lines.push(`Interactive elements — reference these by their [ref] id (risk L3/L4 need confirmation):`)

  const els = snapshot.elements.slice(0, maxElements)
  for (const e of els) {
    const label = [e.name, e.text].filter(Boolean).join(' / ') || '(no label)'
    const truncated = label.length > 48 ? `${label.slice(0, 48)}…` : label
    const flag = e.disabled ? ' [disabled]' : ''
    const risk = e.risk && e.risk !== 'L0' ? `  risk=${e.risk}${e.risk === 'L3' || e.risk === 'L4' ? ' ←confirm' : ''}` : ''
    lines.push(`  [${e.ref}] ${e.role || e.tag}  "${truncated}"${flag}${risk}`)
  }

  if (snapshot.stats.truncated || snapshot.elements.length > els.length) {
    lines.push(`  … (${snapshot.stats.elementCount} interactive elements total; ${els.length} shown)`)
  }
  return lines.join('\n')
}

/** Short one-line summary of the latest snapshot, for trace/logs. */
export function pageSummary(snapshot: PageSnapshot | undefined | null): string {
  if (!snapshot) return 'no snapshot'
  return `${snapshot.title || '(untitled)'} — ${snapshot.stats.interactiveCount} interactive els @ ${snapshot.url.slice(0, 80)}`
}
