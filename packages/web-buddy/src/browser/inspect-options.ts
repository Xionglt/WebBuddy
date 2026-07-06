import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRef } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'

export interface InspectedOption {
  value?: string
  label: string
  selected?: boolean
  disabled?: boolean
  level?: number
}

async function markControlByLabel(
  page: import('playwright').Page,
  label: string,
  exact: boolean,
  nth: number,
  marker: string,
) {
  return page.evaluate(
    ({ label: targetLabel, exact: exactMatch, nth: targetIndex, marker: markerValue }) => {
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const target = normalize(targetLabel).toLowerCase()
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const labelFor = (el: Element) => {
        const id = el.getAttribute('id') || el.querySelector('input,textarea,select')?.getAttribute('id')
        if (!id) return ''
        return normalize(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent)
      }
      const rootText = (el: Element) => {
        const root = el.closest('.ant-form-item,label,[class*="form"],[class*="field"],[class*="item"],[class*="row"],[class*="select"],[class*="picker"]') || el.parentElement
        return normalize(root?.textContent).slice(0, 360)
      }
      const labelText = (el: Element) => {
        const input = el.querySelector('input,textarea,select') as HTMLInputElement | null
        return [
          el.getAttribute('aria-label'),
          input?.getAttribute('aria-label'),
          labelFor(el),
          normalize(el.closest('.ant-form-item')?.querySelector('.ant-form-item-label')?.textContent),
          input?.placeholder,
          el.getAttribute('name'),
          input?.getAttribute('name'),
          el.getAttribute('id'),
          input?.getAttribute('id'),
          rootText(el),
        ]
          .map(normalize)
          .filter(Boolean)
          .join(' ')
      }
      const matches = (value: string) => {
        const normalized = normalize(value).toLowerCase()
        return exactMatch ? normalized === target : normalized.includes(target)
      }
      const selector = [
        'select',
        '[role="combobox"]',
        '[aria-haspopup="listbox"]',
        '[aria-haspopup="tree"]',
        '.ant-select',
        '.ant-cascader',
        '.ant-picker',
        '[class*="select__control"]',
        '[class*="Select-control"]',
      ].join(',')
      const scored = Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .map((el) => ({ el, text: labelText(el) }))
        .filter((item) => matches(item.text))
        .sort((a, b) => a.text.length - b.text.length)
      const selected = scored[targetIndex]?.el
      if (!selected) return null
      selected.setAttribute('data-mfa-inspect-options-target', markerValue)
      return {
        tag: selected.tagName.toLowerCase(),
        role: selected.getAttribute('role') || undefined,
        label: scored[targetIndex]?.text.slice(0, 220),
        totalMatches: scored.length,
      }
    },
    { label, exact, nth, marker },
  )
}

export async function browserInspectOptions(input: {
  sessionId?: string
  ref?: string
  label?: string
  exact?: boolean
  nth?: number
  maxOptions?: number
  open?: boolean
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  const maxOptions = input.maxOptions ?? 120
  const exact = input.exact ?? false
  let matchedLabel: string | undefined

  try {
    if (input.ref) {
      const resolved = await resolveRef(session.page, session.latestSnapshot, input.ref)
      if (!resolved.ok) return resolved.failure
      const tagName = await resolved.locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
      if (tagName === 'select') {
        const native = await resolved.locator.evaluate((el) =>
          Array.from((el as HTMLSelectElement).options).map((option) => ({
            value: option.value,
            label: (option.textContent || '').replace(/\s+/g, ' ').trim(),
            selected: option.selected,
            disabled: option.disabled,
          })),
        )
        return toolSuccess(`Inspected ${native.length} native select options.`, {
          ref: input.ref,
          options: native.slice(0, maxOptions),
          multiLevel: false,
          url: session.page.url(),
        })
      }
      if (input.open !== false) await resolved.locator.click({ timeout: input.ref ? 5000 : 3000 }).catch(() => {})
    } else if (input.label) {
      const marker = `mfa-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const match = await markControlByLabel(session.page, input.label, exact, input.nth ?? 0, marker)
      if (!match) {
        return toolFailure('ELEMENT_NOT_FOUND', `No selectable control matched label "${input.label}".`, {
          recoverable: true,
          suggestedNextActions: ['browser_form_snapshot', 'browser_inspect_options'],
        })
      }
      matchedLabel = match.label
      const locator = session.page.locator(`[data-mfa-inspect-options-target="${marker}"]`).first()
      const tagName = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
      if (tagName === 'select') {
        const native = await locator.evaluate((el) =>
          Array.from((el as HTMLSelectElement).options).map((option) => ({
            value: option.value,
            label: (option.textContent || '').replace(/\s+/g, ' ').trim(),
            selected: option.selected,
            disabled: option.disabled,
          })),
        )
        await locator.evaluate((el) => el.removeAttribute('data-mfa-inspect-options-target')).catch(() => {})
        return toolSuccess(`Inspected ${native.length} native select options for "${input.label}".`, {
          label: input.label,
          matchedLabel,
          options: native.slice(0, maxOptions),
          multiLevel: false,
          url: session.page.url(),
        })
      }
      if (input.open !== false) await locator.click({ timeout: 5000 }).catch(() => {})
      await locator.evaluate((el) => el.removeAttribute('data-mfa-inspect-options-target')).catch(() => {})
    }

    await session.page.waitForTimeout(180)
    const inspected = await session.page.evaluate((limit) => {
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const optionSelectors = [
        '[role="listbox"] [role="option"]',
        '[role="tree"] [role="treeitem"]',
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
        '.ant-cascader-dropdown:not(.ant-cascader-dropdown-hidden) .ant-cascader-menu-item',
        '.ant-cascader-menu-item',
        '.rc-select-dropdown .rc-select-item-option',
        '.el-select-dropdown__item',
        '[class*="menu"] [class*="option"]',
      ]
      const nodes = optionSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      const seen = new Set<Element>()
      const options = []
      for (const node of nodes) {
        if (seen.has(node) || !isVisible(node)) continue
        seen.add(node)
        const label = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'))
        if (!label) continue
        const parentMenus = Array.from(document.querySelectorAll('.ant-cascader-menu,[role="tree"],[role="listbox"]')).filter(isVisible)
        const levelIndex = parentMenus.findIndex((menu) => menu.contains(node))
        options.push({
          value: node.getAttribute('data-value') || node.getAttribute('title') || node.getAttribute('value') || undefined,
          label,
          selected: node.getAttribute('aria-selected') === 'true' || /selected/i.test(node.getAttribute('class') || ''),
          disabled: node.getAttribute('aria-disabled') === 'true' || /disabled/i.test(node.getAttribute('class') || ''),
          level: levelIndex >= 0 ? levelIndex : undefined,
        })
        if (options.length >= limit) break
      }
      const visibleCascader = Array.from(document.querySelectorAll('.ant-cascader-dropdown,.ant-cascader-menu,[role="tree"]')).some(isVisible)
      const menuCount = Array.from(document.querySelectorAll('.ant-cascader-menu,[role="tree"]')).filter(isVisible).length
      return {
        options,
        multiLevel: menuCount > 1 || visibleCascader,
      }
    }, maxOptions)

    await session.page.keyboard.press('Escape').catch(() => {})

    return toolSuccess(`Inspected ${inspected.options.length} visible options.`, {
      ref: input.ref,
      label: input.label,
      matchedLabel,
      options: inspected.options,
      multiLevel: inspected.multiLevel,
      url: session.page.url(),
    })
  } catch (error) {
    await session.page.keyboard.press('Escape').catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('PAGE_CRASHED', `Failed to inspect options: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_inspect_options'],
    })
  }
}
