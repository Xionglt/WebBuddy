import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRef } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'
import type { FieldControlKind, PlannedField } from '../fill/field-plan.js'

type IntendedValue = string | string[] | boolean | null
type SetFieldKind = Exclude<FieldControlKind, 'file' | 'unknown'> | 'unknown'

interface FieldMatch {
  tag: string
  type?: string
  role?: string
  label?: string
  fieldKey?: string
  fieldIndex?: number
  totalMatches?: number
}

interface Readback {
  value: string | string[] | boolean
  text?: string
  checked?: boolean
}

interface AttemptResult {
  strategy: string
  ok: boolean
  readback?: Readback
  reason?: string
}

const CONTROL_SELECTOR = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="tree"]',
  '.ant-select',
  '.ant-cascader',
  '.ant-picker',
  '[class*="select__control"]',
  '[class*="Select-control"]',
].join(',')

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function flattenIntended(value: IntendedValue): string[] {
  if (value === null) return []
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean)
  if (typeof value === 'boolean') return [String(value)]
  return [normalizeText(value)].filter(Boolean)
}

function valuesMatch(readback: Readback | undefined, intended: IntendedValue, kind: SetFieldKind): boolean {
  if (!readback) return false
  if (kind === 'checkbox') {
    if (typeof intended === 'boolean') return readback.value === intended || readback.checked === intended
    const expected = flattenIntended(intended).map((item) => item.toLowerCase())
    if (expected.length === 0) return readback.value === false || readback.checked === false
    if (readback.value === true || readback.checked === true) {
      const text = normalizeText(readback.text || '').toLowerCase()
      return expected.some((item) => item === 'true' || text.includes(item))
    }
    return false
  }
  const expectedParts = flattenIntended(intended).map((item) => item.toLowerCase())
  if (expectedParts.length === 0) return normalizeText(readback.value).length === 0
  const actualParts = Array.isArray(readback.value)
    ? readback.value.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
    : [normalizeText(readback.value).toLowerCase()].filter(Boolean)
  const actualJoined = actualParts.join(' / ')
  if (kind === 'cascader') return expectedParts.every((part) => actualJoined.includes(part))
  return expectedParts.some((part) => actualParts.some((actual) => actual === part || actual.includes(part)))
}

function inferKind(match: FieldMatch, requested?: string): SetFieldKind {
  if (requested && requested !== 'unknown') return requested as SetFieldKind
  const tag = match.tag.toLowerCase()
  const type = normalizeText(match.type).toLowerCase()
  const role = normalizeText(match.role).toLowerCase()
  const label = normalizeText(match.label).toLowerCase()
  if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'checkbox'
  if (type === 'radio' || role === 'radio') return 'radio'
  if (tag === 'textarea') return 'textarea'
  if (tag === 'select') return 'select_native'
  if (/date|time|month|week/.test(type) || /picker/.test(label)) return 'date'
  if (/cascader/.test(label) || role === 'tree') return 'cascader'
  if (role === 'combobox') return 'select_custom'
  return 'text'
}

async function markField(
  page: import('playwright').Page,
  input: {
    selector?: string
    label?: string
    fieldKey?: string
    fieldIndex?: number
    exact?: boolean
    nth?: number
  },
  marker: string,
): Promise<FieldMatch | null> {
  if (input.selector) {
    return page.evaluate(
      ({ selector, marker: markerValue }) => {
        const el = document.querySelector(selector)
        if (!el) return null
        el.setAttribute('data-mfa-set-field-target', markerValue)
        const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | null
        return {
          tag: el.tagName.toLowerCase(),
          type: input?.type || el.getAttribute('type') || undefined,
          role: el.getAttribute('role') || input?.getAttribute('role') || undefined,
          label: el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 220) || undefined,
          totalMatches: 1,
        }
      },
      { selector: input.selector, marker },
    )
  }

  return page.evaluate(
    ({ controlSelector, targetLabel, targetFieldKey, targetFieldIndex, exact, nth, marker: markerValue }) => {
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const classText = (el: Element | null | undefined) =>
        !el ? '' : typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : el.getAttribute('class') || ''
      const isVisible = (el: Element) => {
        const input = el as HTMLInputElement
        if (input.type === 'file') return true
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const canonicalControl = (el: Element) => el.closest('.ant-select,.ant-cascader,.ant-picker') || el
      const rootFor = (el: Element) =>
        el.closest('fieldset,.ant-form-item,[class*="form-item"],[class*="FormItem"],label,[class*="field"],[class*="Field"],[class*="item"],[class*="row"]') ||
        el.parentElement
      const labelFor = (el: Element) => {
        const ownId = el.getAttribute('id') || el.querySelector('input,textarea,select')?.getAttribute('id')
        if (!ownId) return ''
        return normalize(document.querySelector(`label[for="${CSS.escape(ownId)}"]`)?.textContent)
      }
      const labelText = (el: Element) => {
        const child = el.querySelector('input,textarea,select') as HTMLInputElement | null
        return [
          el.getAttribute('aria-label'),
          child?.getAttribute('aria-label'),
          labelFor(el),
          el.closest('fieldset')?.textContent,
          normalize(el.closest('.ant-form-item')?.querySelector('.ant-form-item-label')?.textContent),
          el.closest('label')?.textContent,
          child?.placeholder,
          el.getAttribute('name'),
          child?.getAttribute('name'),
          el.getAttribute('id'),
          child?.getAttribute('id'),
          rootFor(el)?.textContent,
        ]
          .map(normalize)
          .filter(Boolean)
          .join(' ')
      }
      const cssPath = (el: Element) => {
        const parts: string[] = []
        let node: Element | null = el
        while (node && parts.length < 7) {
          const tag = node.tagName.toLowerCase()
          const id = node.getAttribute('id')
          if (id) {
            parts.unshift(`${tag}#${CSS.escape(id)}`)
            break
          }
          let index = 1
          let sibling = node.previousElementSibling
          while (sibling) {
            if (sibling.tagName === node.tagName) index += 1
            sibling = sibling.previousElementSibling
          }
          const cls = classText(node).split(/\s+/).find((name) => /^(ant-|el-|select|field|form|input)/i.test(name))
          parts.unshift(`${tag}${cls ? `.${CSS.escape(cls)}` : ''}:nth-of-type(${index})`)
          node = node.parentElement
        }
        return parts.join(' > ')
      }
      const hashText = (value: string) => {
        let hash = 5381
        for (let i = 0; i < value.length; i += 1) hash = (hash * 33) ^ value.charCodeAt(i)
        return (hash >>> 0).toString(36)
      }
      const kindFor = (el: Element) => {
        const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | null
        const tag = el.tagName.toLowerCase()
        const type = normalize(input?.type || el.getAttribute('type')).toLowerCase()
        const role = normalize(el.getAttribute('role') || input?.getAttribute('role')).toLowerCase()
        const classes = classText(el)
        if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'checkbox'
        if (type === 'radio' || role === 'radio') return 'radio'
        if (type === 'file') return 'file'
        if (tag === 'select' || input?.tagName.toLowerCase() === 'select') return 'select_native'
        if (/cascader/i.test(classes)) return 'cascader'
        if (/date|time|month|week/.test(type) || /picker/i.test(classes)) return 'date'
        if (role === 'combobox' || /ant-select|select__control|Select-control/.test(classes) || el.getAttribute('aria-haspopup') === 'listbox') return 'select_custom'
        if (tag === 'textarea' || input?.tagName.toLowerCase() === 'textarea') return 'textarea'
        return 'text'
      }
      const fieldKey = (el: Element, kind: string, label: string) => {
        const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | null
        const id = normalize(el.getAttribute('id') || input?.getAttribute('id'))
        const name = normalize(el.getAttribute('name') || input?.getAttribute('name'))
        const primary = id ? `id:${id}` : name ? `name:${name}` : `label:${label.toLowerCase()}`
        return `${kind}:${primary}:${hashText(cssPath(el) || label || kind)}`
      }
      const matchesLabel = (value: string) => {
        if (!targetLabel) return false
        const normalized = normalize(value).toLowerCase()
        const target = normalize(targetLabel).toLowerCase()
        return exact ? normalized === target : normalized.includes(target)
      }

      const controls: Element[] = []
      const seen = new Set<Element>()
      for (const node of Array.from(document.querySelectorAll(controlSelector))) {
        const control = canonicalControl(node)
        if (seen.has(control) || !isVisible(control)) continue
        seen.add(control)
        controls.push(control)
      }

      const scored = controls
        .map((el, index) => {
          const label = labelText(el)
          const kind = kindFor(el)
          const key = fieldKey(el, kind, label)
          const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | null
          const byIndex = typeof targetFieldIndex === 'number' && index === targetFieldIndex
          const byKey = Boolean(targetFieldKey && key === targetFieldKey)
          const byLabel = matchesLabel(label)
          return {
            el,
            index,
            label,
            key,
            matched: byIndex || byKey || byLabel || (!targetLabel && !targetFieldKey && typeof targetFieldIndex !== 'number'),
            score: byKey ? 0 : byIndex ? 1 : byLabel ? 2 : 9,
            tag: el.tagName.toLowerCase(),
            type: input?.type || el.getAttribute('type') || undefined,
            role: el.getAttribute('role') || input?.getAttribute('role') || undefined,
          }
        })
        .filter((item) => item.matched)
        .sort((a, b) => a.score - b.score || a.label.length - b.label.length)

      const selected = scored[nth || 0]
      if (!selected) return null
      selected.el.setAttribute('data-mfa-set-field-target', markerValue)
      return {
        tag: selected.tag,
        type: selected.type,
        role: selected.role,
        label: selected.label.slice(0, 220),
        fieldKey: selected.key,
        fieldIndex: selected.index,
        totalMatches: scored.length,
      }
    },
    {
      controlSelector: CONTROL_SELECTOR,
      targetLabel: input.label,
      targetFieldKey: input.fieldKey,
      targetFieldIndex: input.fieldIndex,
      exact: input.exact ?? false,
      nth: input.nth ?? 0,
      marker,
    },
  )
}

async function readField(page: import('playwright').Page, marker: string, kind: SetFieldKind): Promise<Readback> {
  return page.evaluate(
    ({ marker: markerValue, kind: fieldKind }) => {
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const el = document.querySelector(`[data-mfa-set-field-target="${markerValue}"]`)
      if (!el) return { value: '' }
      const root =
        el.closest(fieldKind === 'radio' ? 'fieldset,.radio-group,[role="radiogroup"],.ant-form-item,[class*="form-item"],[class*="FormItem"],[class*="field"],[class*="Field"],[class*="item"],[class*="row"]' : '.ant-form-item,[class*="form-item"],[class*="FormItem"],label,[class*="field"],[class*="Field"],[class*="item"],[class*="row"]') ||
        el.parentElement ||
        el
      const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | HTMLSelectElement | null
      if (fieldKind === 'checkbox' || fieldKind === 'radio') {
        const checked = input && 'checked' in input ? Boolean((input as HTMLInputElement).checked) : el.getAttribute('aria-checked') === 'true'
        if (fieldKind === 'radio') {
          const selected = root.querySelector('input[type="radio"]:checked') as HTMLInputElement | null
          const selectedLabel = selected?.closest('label')?.textContent || selected?.getAttribute('aria-label') || selected?.value || ''
          return { value: normalize(selectedLabel || selected?.value), checked: Boolean(selected), text: normalize(root.textContent) }
        }
        return { value: checked, checked, text: normalize(root.textContent) }
      }
      if (input?.tagName.toLowerCase() === 'select') {
        const selected = Array.from((input as HTMLSelectElement).selectedOptions).map((option) => normalize(option.textContent || option.value)).filter(Boolean)
        return { value: selected.join(' '), text: selected.join(' ') }
      }
      if (fieldKind === 'select_custom' || fieldKind === 'cascader' || fieldKind === 'date') {
        const selectedText = normalize(
          Array.from(
            el.querySelectorAll(
              '.ant-select-selection-item,.ant-select-selection-overflow-item,.ant-cascader-picker-label,.ant-picker-input input,[class*="singleValue"],[class*="selected"]',
            ),
          )
            .map((node) => ((node as HTMLInputElement).value || node.textContent || '').trim())
            .filter(Boolean)
            .join(' '),
        )
        if (selectedText) return { value: selectedText, text: selectedText }
      }
      if (input && 'value' in input) return { value: normalize(String(input.value ?? '')), text: normalize(String(input.value ?? '')) }
      return { value: normalize(el.textContent), text: normalize(el.textContent) }
    },
    { marker, kind },
  )
}

async function clickVisibleOption(page: import('playwright').Page, option: string, exact: boolean, optionNth: number, timeout: number) {
  const marker = `mfa-option-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const matched = await page.evaluate(
    ({ optionText, exactMatch, nth, marker: markerValue }) => {
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const target = normalize(optionText).toLowerCase()
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const selectors = [
        '[role="listbox"] [role="option"]',
        '[role="tree"] [role="treeitem"]',
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
        '.ant-cascader-dropdown:not(.ant-cascader-dropdown-hidden) .ant-cascader-menu-item',
        '.rc-select-dropdown .rc-select-item-option',
        '.el-select-dropdown__item',
        '[class*="menu"] [class*="option"]',
      ]
      const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(isVisible)
      const matches = candidates.filter((el) => {
        const text = normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'))
        const normalized = text.toLowerCase()
        return exactMatch ? normalized === target : normalized.includes(target)
      })
      const selected = matches[nth]
      if (!selected) return null
      selected.setAttribute('data-mfa-set-field-option-target', markerValue)
      return normalize(selected.textContent || selected.getAttribute('aria-label') || selected.getAttribute('title'))
    },
    { optionText: option, exactMatch: exact, nth: optionNth, marker },
  )
  if (!matched) throw new Error(`No visible option matched "${option}"`)
  const locator = page.locator(`[data-mfa-set-field-option-target="${marker}"]`).first()
  await locator.click({ timeout })
  await locator.evaluate((el) => el.removeAttribute('data-mfa-set-field-option-target')).catch(() => {})
}

async function writeField(
  page: import('playwright').Page,
  locator: import('playwright').Locator,
  marker: string,
  kind: SetFieldKind,
  intendedValue: IntendedValue,
  strategy: 'primary' | 'fallback',
  input: { exact?: boolean; optionNth?: number; clear?: boolean; timeoutMs?: number },
) {
  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)
  const values = flattenIntended(intendedValue)
  const firstValue = values[0] ?? ''

  if (kind === 'text' || kind === 'textarea' || kind === 'date') {
    const editable = kind === 'date' ? locator.locator('input').first().or(locator) : locator
    if (strategy === 'primary') {
      await editable.fill(firstValue, { timeout })
    } else {
      await editable.click({ timeout })
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.insertText(firstValue)
      await editable.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    return
  }

  if (kind === 'select_native') {
    if (strategy === 'primary') {
      await locator.selectOption({ label: firstValue }, { timeout }).catch(() => locator.selectOption(firstValue, { timeout }))
    } else {
      await locator.evaluate((el, value) => {
        const select = el as HTMLSelectElement
        const target = String(value).replace(/\s+/g, ' ').trim().toLowerCase()
        const option = Array.from(select.options).find((item) => {
          const text = (item.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
          return item.value.toLowerCase() === target || text === target || text.includes(target)
        })
        if (!option) throw new Error(`No native option matched "${value}"`)
        select.value = option.value
        option.selected = true
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }, firstValue)
    }
    return
  }

  if (kind === 'select_custom' || kind === 'cascader') {
    const sequence = kind === 'cascader' ? values : [firstValue]
    for (let index = 0; index < sequence.length; index += 1) {
      await locator.click({ timeout }).catch(() => {})
      await page.waitForTimeout(strategy === 'primary' ? 150 : 250)
      await clickVisibleOption(page, sequence[index], input.exact ?? false, strategy === 'primary' ? input.optionNth ?? 0 : 0, timeout)
      await page.waitForTimeout(120)
    }
    return
  }

  if (kind === 'radio') {
    if (!firstValue) throw new Error('Radio intendedValue must name the option to select')
    if (strategy === 'primary') {
      await page.evaluate(
        ({ marker: markerValue, value }) => {
          const normalize = (text: string | null | undefined) => (text || '').replace(/\s+/g, ' ').trim()
          const target = normalize(value).toLowerCase()
          const el = document.querySelector(`[data-mfa-set-field-target="${markerValue}"]`)
          if (!el) throw new Error('Radio target disappeared')
          const root =
            el.closest('fieldset,.radio-group,[role="radiogroup"],.ant-form-item,[class*="form-item"],[class*="FormItem"],[class*="field"],[class*="Field"],[class*="item"],[class*="row"]') ||
            el.parentElement ||
            document
          const radio = Array.from(root.querySelectorAll('input[type="radio"],[role="radio"]')).find((node) => {
            const input = node as HTMLInputElement
            const text = normalize(node.closest('label')?.textContent || node.getAttribute('aria-label') || input.value)
            return text.toLowerCase().includes(target) || input.value.toLowerCase() === target
          }) as HTMLElement | undefined
          if (!radio) throw new Error(`No radio option matched "${value}"`)
          radio.click()
        },
        { marker, value: firstValue },
      )
    } else {
      await page.getByLabel(firstValue, { exact: input.exact ?? false }).check({ timeout }).catch(async () => {
        await page.getByText(firstValue, { exact: input.exact ?? false }).click({ timeout })
      })
    }
    return
  }

  if (kind === 'checkbox') {
    const desired = typeof intendedValue === 'boolean' ? intendedValue : !['false', 'no', '0', '否', '不'].includes(firstValue.toLowerCase())
    if (strategy === 'primary') {
      const checkbox = locator.locator('input[type="checkbox"]').first().or(locator)
      if (desired) await checkbox.check({ timeout }).catch(() => checkbox.click({ timeout }))
      else await checkbox.uncheck({ timeout }).catch(() => checkbox.click({ timeout }))
    } else {
      await locator.evaluate((el, checked) => {
        const input = (el.matches('input') ? el : el.querySelector('input[type="checkbox"]')) as HTMLInputElement | null
        if (input) {
          input.checked = Boolean(checked)
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          el.setAttribute('aria-checked', checked ? 'true' : 'false')
          el.dispatchEvent(new Event('click', { bubbles: true }))
        }
      }, desired)
    }
  }
}

export async function browserSetField(input: {
  field?: Partial<PlannedField>
  ref?: string
  selector?: string
  label?: string
  fieldKey?: string
  fieldIndex?: number
  controlKind?: FieldControlKind
  intendedValue?: IntendedValue
  sessionId?: string
  exact?: boolean
  nth?: number
  optionNth?: number
  clear?: boolean
  timeoutMs?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  const intendedValue = input.intendedValue ?? (input.field?.intendedValue as IntendedValue | undefined)
  const label = input.label ?? input.field?.label
  const controlKind = input.controlKind ?? input.field?.controlKind
  const fieldKey = input.fieldKey ?? input.field?.fieldKey
  const fieldIndex = input.fieldIndex ?? input.field?.fieldIndex

  if (intendedValue === undefined) {
    return toolFailure('INVALID_ARGUMENT', 'browser_set_field requires intendedValue or field.intendedValue.', {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_set_field'],
    })
  }
  if (controlKind === 'file') {
    return toolFailure('INVALID_ARGUMENT', 'browser_set_field does not handle file uploads. Use browser_upload_file instead.', {
      recoverable: true,
      suggestedNextActions: ['browser_upload_file'],
    })
  }
  if (!input.ref && !input.selector && !label && !fieldKey && typeof fieldIndex !== 'number') {
    return toolFailure('INVALID_ARGUMENT', 'browser_set_field requires ref, selector, label, fieldKey, fieldIndex, or field.', {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_set_field'],
    })
  }

  const marker = `mfa-set-field-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const attempts: AttemptResult[] = []
  let match: FieldMatch | null = null

  try {
    let locator: import('playwright').Locator
    if (input.ref) {
      const resolved = await resolveRef(session.page, session.latestSnapshot, input.ref)
      if (!resolved.ok) return resolved.failure
      locator = resolved.locator
      await locator.evaluate((el, markerValue) => el.setAttribute('data-mfa-set-field-target', markerValue), marker)
      match = {
        tag: resolved.stored.tag,
        role: resolved.stored.role,
        label: resolved.stored.name || resolved.stored.text,
      }
    } else {
      match = await markField(
        session.page,
        {
          selector: input.selector,
          label,
          fieldKey,
          fieldIndex,
          exact: input.exact,
          nth: input.nth,
        },
        marker,
      )
      if (!match) {
        return toolFailure('ELEMENT_NOT_FOUND', `No form field matched "${label ?? fieldKey ?? fieldIndex ?? input.selector}".`, {
          recoverable: true,
          suggestedNextActions: ['browser_form_snapshot', 'browser_set_field'],
        })
      }
      locator = session.page.locator(`[data-mfa-set-field-target="${marker}"]`).first()
    }

    const actualKind = inferKind(match, controlKind)
    if (actualKind === 'file') {
      return toolFailure('INVALID_ARGUMENT', 'browser_set_field does not handle file uploads. Use browser_upload_file instead.', {
        recoverable: true,
        suggestedNextActions: ['browser_upload_file'],
      })
    }

    for (const strategy of ['primary', 'fallback'] as const) {
      try {
        await writeField(session.page, locator, marker, actualKind, intendedValue, strategy, {
          exact: input.exact,
          optionNth: input.optionNth,
          clear: input.clear,
          timeoutMs: input.timeoutMs,
        })
        await session.page.waitForTimeout(80)
        const readback = await readField(session.page, marker, actualKind)
        const ok = valuesMatch(readback, intendedValue, actualKind)
        attempts.push({ strategy, ok, readback, ...(ok ? {} : { reason: 'READBACK_MISMATCH' }) })
        if (ok) {
          await locator.evaluate((el) => el.removeAttribute('data-mfa-set-field-target')).catch(() => {})
          sessionManager.invalidateSnapshot(session.id)
          return toolSuccess(
            `Set field "${label ?? match.label ?? input.ref ?? input.selector}" to intended value and verified readback.`,
            {
              label,
              matchedLabel: match.label,
              fieldKey: match.fieldKey,
              fieldIndex: match.fieldIndex,
              controlKind: actualKind,
              intendedValue,
              readback,
              attempts,
              risk: 'L2',
            },
            true,
          )
        }
      } catch (error) {
        attempts.push({
          strategy,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const last = attempts[attempts.length - 1]
    await locator.evaluate((el) => el.removeAttribute('data-mfa-set-field-target')).catch(() => {})
    return toolFailure(
      'UNKNOWN',
      `Failed to set field "${label ?? match.label ?? input.ref ?? input.selector}": ${last?.reason ?? 'readback did not match intendedValue'}`,
      {
        recoverable: true,
        observation: JSON.stringify(
          {
            status: 'failed',
            reason: last?.reason ?? 'READBACK_MISMATCH',
            label,
            matchedLabel: match.label,
            fieldKey: match.fieldKey,
            fieldIndex: match.fieldIndex,
            controlKind: actualKind,
            intendedValue,
            attempts,
          },
          null,
          2,
        ),
        suggestedNextActions: ['browser_form_snapshot', 'browser_inspect_options', 'browser_set_field'],
      },
    )
  } catch (error) {
    await session.page.locator(`[data-mfa-set-field-target="${marker}"]`).first().evaluate((el) => el.removeAttribute('data-mfa-set-field-target')).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('PAGE_CRASHED', `Failed to set field: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_form_snapshot', 'browser_set_field'],
    })
  }
}
