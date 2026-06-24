import { toolFailure, toolSuccess } from '../errors.js'
import { sessionManager } from '../session/manager.js'

const CONTROL_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
].join(',')

export async function browserFormSnapshot(input: {
  sessionId?: string
  maxFields?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  try {
    const maxFields = input.maxFields ?? 120
    const result = await session.page.$$eval(
      CONTROL_SELECTOR,
      (nodes, limit) => {
        const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
        const isVisible = (el: Element) => {
          const input = el as HTMLInputElement
          if (input.type === 'file') return true
          const style = window.getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
        }
        const nearbyText = (el: Element) => {
          const parent = el.closest('label,[class*="form"],[class*="field"],[class*="item"],[class*="row"],[class*="upload"]') || el.parentElement
          return normalize(parent?.textContent).slice(0, 260)
        }
        const labelFor = (el: Element) => {
          const id = el.getAttribute('id')
          if (!id) return ''
          return normalize(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent)
        }
        const closestLabel = (el: Element) => normalize(el.closest('label')?.textContent)
        const fieldLabel = (el: Element) => {
          const aria = normalize(el.getAttribute('aria-label'))
          const labelledBy = normalize(
            (el.getAttribute('aria-labelledby') || '')
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent || '')
              .join(' '),
          )
          const placeholder = normalize((el as HTMLInputElement).placeholder)
          const label = labelFor(el) || closestLabel(el)
          const name = normalize(el.getAttribute('name'))
          const id = normalize(el.getAttribute('id'))
          return aria || labelledBy || label || placeholder || name || id || nearbyText(el)
        }
        const fieldValue = (el: Element) => {
          const input = el as HTMLInputElement
          if (input.type === 'file') return ''
          if ('value' in input) return normalize(String(input.value ?? ''))
          return normalize(el.textContent)
        }
        const fieldOptions = (el: Element) => {
          if (el.tagName.toLowerCase() !== 'select') return undefined
          return Array.from((el as HTMLSelectElement).options)
            .map((option) => ({
              value: option.value,
              label: normalize(option.textContent),
              selected: option.selected,
            }))
            .slice(0, 80)
        }
        const fieldError = (el: Element) => {
          const root = el.closest('[class*="form"],[class*="field"],[class*="item"],[class*="row"]') || el.parentElement
          if (!root) return ''
          const selectors = [
            '[role="alert"]',
            '[aria-live]',
            '[class*="error"]',
            '[class*="Error"]',
            '[class*="invalid"]',
            '[class*="help"]',
            '[class*="tips"]',
            '[class*="message"]',
          ]
          for (const selector of selectors) {
            const text = normalize(root.querySelector(selector)?.textContent)
            if (text) return text.slice(0, 180)
          }
          return ''
        }
        const required = (el: Element) => {
          const input = el as HTMLInputElement
          const rootText = nearbyText(el)
          return input.required || el.getAttribute('aria-required') === 'true' || /[*＊]\s*$|必填|required/i.test(rootText)
        }

        const fields = []
        for (const el of nodes) {
          if (!isVisible(el)) continue
          const input = el as HTMLInputElement
          const tag = el.tagName.toLowerCase()
          const type = input.type || el.getAttribute('type') || undefined
          if (type === 'hidden') continue
          fields.push({
            index: fields.length,
            tag,
            type,
            role: el.getAttribute('role') || undefined,
            label: fieldLabel(el),
            placeholder: normalize(input.placeholder) || undefined,
            name: normalize(el.getAttribute('name')) || undefined,
            id: normalize(el.getAttribute('id')) || undefined,
            value: fieldValue(el),
            required: required(el),
            disabled: input.disabled || el.getAttribute('aria-disabled') === 'true',
            readonly: input.readOnly || el.getAttribute('aria-readonly') === 'true',
            invalid: el.getAttribute('aria-invalid') === 'true' || Boolean(fieldError(el)),
            error: fieldError(el) || undefined,
            nearbyText: nearbyText(el),
            options: fieldOptions(el),
          })
          if (fields.length >= limit) break
        }

        const uploadHints = Array.from(document.querySelectorAll('input[type="file"],button,[role="button"],a,[class*="upload"],[class*="Upload"]'))
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: (el as HTMLInputElement).type || el.getAttribute('type') || undefined,
            text: normalize(el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label')).slice(0, 180),
            visible: isVisible(el),
            accept: el.getAttribute('accept') || undefined,
          }))
          .filter((item) => item.type === 'file' || /上传|简历|resume|upload|pdf/i.test(item.text))
          .slice(0, 40)

        const visibleErrors = Array.from(document.querySelectorAll('[role="alert"],[class*="error"],[class*="Error"],[class*="invalid"],[class*="message"]'))
          .map((el) => normalize(el.textContent).slice(0, 180))
          .filter(Boolean)
          .slice(0, 40)

        return {
          fields,
          uploadHints,
          visibleErrors,
          totalControls: nodes.length,
        }
      },
      maxFields,
    )

    return toolSuccess(`Form snapshot captured ${result.fields.length} fields and ${result.uploadHints.length} upload hints.`, {
      url: session.page.url(),
      title: await session.page.title(),
      ...result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('PAGE_CRASHED', `Failed to capture form snapshot: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot', 'browser_form_snapshot'],
    })
  }
}
