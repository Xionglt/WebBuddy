import type { Page } from 'playwright'
import type { ElementRef, PageSnapshot, SnapshotRecord, StoredRef } from '../types.js'
import { detectElementRisk } from './risk.js'

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="searchbox"], [role="checkbox"], [role="radio"], [role="menuitem"], summary'

const DEFAULT_MAX_ELEMENTS = 80

function hashText(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return `h${Math.abs(hash)}`
}

function summarizeText(text: string, max = 240): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}...`
}

export async function buildSnapshot(
  page: Page,
  options?: { maxElements?: number },
): Promise<SnapshotRecord> {
  const maxElements = options?.maxElements ?? DEFAULT_MAX_ELEMENTS
  const url = page.url()
  const title = await page.title()

  const rawElements = await page.$$eval(
    INTERACTIVE_SELECTOR,
    (nodes, limit) => {
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          rect.height > 0
        )
      }

      const getLabel = (el: Element) => {
        const aria = el.getAttribute('aria-label') || ''
        const placeholder = (el as HTMLInputElement).placeholder || ''
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
        const associated = el.id
          ? document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || ''
          : ''
        return aria || associated || placeholder || text
      }

      const getRole = (el: Element) => el.getAttribute('role') || undefined
      const getCss = (el: Element) => {
        if (el.id) return `#${CSS.escape(el.id)}`
        const tag = el.tagName.toLowerCase()
        const name = getLabel(el)
        if (name) return `${tag}:has-text("${name.slice(0, 40)}")`
        return tag
      }
      const getXPath = (el: Element) => {
        const parts: string[] = []
        let current: Element | null = el
        while (current && current.nodeType === 1 && current.tagName.toLowerCase() !== 'html') {
          let index = 1
          let sibling = current.previousElementSibling
          while (sibling) {
            if (sibling.tagName === current.tagName) index++
            sibling = sibling.previousElementSibling
          }
          parts.unshift(`${current.tagName.toLowerCase()}[${index}]`)
          current = current.parentElement
        }
        return `/${parts.join('/')}`
      }

      const results: Array<{
        role?: string
        name: string
        text: string
        tag: string
        value?: string
        disabled: boolean
        visible: boolean
        typeAttr?: string | null
        css: string
        xpath: string
        aria?: string
      }> = []

      for (const node of nodes) {
        if (!isVisible(node)) continue
        const tag = node.tagName.toLowerCase()
        const name = getLabel(node)
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
        const input = node as HTMLInputElement
        results.push({
          role: getRole(node),
          name,
          text: text.slice(0, 120),
          tag,
          value: 'value' in input ? String(input.value ?? '') : undefined,
          disabled: (node as HTMLButtonElement).disabled === true,
          visible: true,
          typeAttr: node.getAttribute('type'),
          css: getCss(node),
          xpath: getXPath(node),
          aria: node.getAttribute('aria-label') || undefined,
        })
        if (results.length >= limit) break
      }
      return results
    },
    maxElements,
  )

  const totalCount = await page.locator(INTERACTIVE_SELECTOR).count()
  const truncated = totalCount > rawElements.length

  const elements: ElementRef[] = []
  const refMap = new Map<string, StoredRef>()

  rawElements.forEach((item, index) => {
    const ref = `e${index + 1}`
    const risk = detectElementRisk({
      tag: item.tag,
      role: item.role,
      name: item.name,
      text: item.text,
      typeAttr: item.typeAttr,
    })

    const element: ElementRef = {
      ref,
      role: item.role,
      name: item.name || undefined,
      text: item.text || undefined,
      tag: item.tag,
      value: item.value || undefined,
      disabled: item.disabled,
      visible: item.visible,
      risk,
      locatorHints: {
        aria: item.aria,
        text: item.name || item.text,
        css: item.css,
        xpath: item.xpath,
      },
      fingerprint: {
        textHash: hashText(item.name || item.text || item.tag),
        domPathHash: hashText(item.xpath),
        ariaHash: item.aria ? hashText(item.aria) : undefined,
      },
    }

    elements.push(element)
    refMap.set(ref, {
      ref,
      role: item.role,
      name: item.name,
      text: item.text,
      tag: item.tag,
      css: item.css,
      xpath: item.xpath,
      aria: item.aria,
      risk,
    })
  })

  const bodyText = await page.locator('body').innerText().catch(() => '')
  const snapshotId = `snap_${Date.now()}`

  const snapshot: PageSnapshot = {
    snapshotId,
    url,
    title,
    textSummary: summarizeText(bodyText),
    elements,
    stats: {
      elementCount: totalCount,
      interactiveCount: elements.length,
      truncated,
    },
  }

  return { snapshot, refMap }
}
