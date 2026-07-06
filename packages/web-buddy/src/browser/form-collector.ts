import type { Page } from 'playwright'
import type { FormCoverage } from '../observation/form-state.js'
import type { RawFormField, RawFormSnapshot, RawSubmitCandidate, RawUploadHint } from '../observation/form-state-builder.js'

const CONTROL_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
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

export interface CollectedFormSnapshot extends RawFormSnapshot {
  title?: string
  uploadHints: RawUploadHint[]
  submitCandidates: RawSubmitCandidate[]
  visibleErrors: string[]
  totalControls: number
}

export interface FormAuditSnapshot extends CollectedFormSnapshot {
  formCoverage: FormCoverage
}

export async function collectFormSnapshotFromPage(page: Page, input: { maxFields?: number } = {}): Promise<CollectedFormSnapshot> {
  const maxFields = input.maxFields ?? 120
  const result = await page.evaluate(
    ({ selector, limit }) => {
      type Field = RawFormField & { nearbyText?: string }
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
      const classText = (el: Element | null | undefined) =>
        !el ? '' : typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : el.getAttribute('class') || ''
      const isVisible = (el: Element) => {
        const input = el as HTMLInputElement
        if (input.type === 'file') return true
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        const inViewport =
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.left <= (window.innerWidth || document.documentElement.clientWidth)
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && inViewport
      }
      const canonicalControl = (el: Element) => {
        const antSelect = el.closest('.ant-select')
        if (antSelect) return antSelect
        const antCascader = el.closest('.ant-cascader')
        if (antCascader) return antCascader
        const antPicker = el.closest('.ant-picker')
        if (antPicker) return antPicker
        return el
      }
      const cssPath = (el: Element) => {
        const parts: string[] = []
        let node: Element | null = el
        while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
          const tag = node.tagName.toLowerCase()
          const id = node.getAttribute('id')
          if (id) {
            parts.unshift(`${tag}#${CSS.escape(id)}`)
            break
          }
          let nth = 1
          let sibling = node.previousElementSibling
          while (sibling) {
            if (sibling.tagName === node.tagName) nth += 1
            sibling = sibling.previousElementSibling
          }
          const cls = classText(node)
            .split(/\s+/)
            .find((name) => /^(ant-|el-|select|field|form|input)/i.test(name))
          parts.unshift(`${tag}${cls ? `.${CSS.escape(cls)}` : ''}:nth-of-type(${nth})`)
          node = node.parentElement
        }
        return parts.join(' > ')
      }
      const xpath = (el: Element) => {
        const parts: string[] = []
        let node: Element | null = el
        while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
          let index = 1
          let sibling = node.previousElementSibling
          while (sibling) {
            if (sibling.tagName === node.tagName) index += 1
            sibling = sibling.previousElementSibling
          }
          parts.unshift(`${node.tagName.toLowerCase()}[${index}]`)
          node = node.parentElement
        }
        return `/${parts.join('/')}`
      }
      const hashText = (value: string) => {
        let hash = 5381
        for (let i = 0; i < value.length; i += 1) hash = (hash * 33) ^ value.charCodeAt(i)
        return (hash >>> 0).toString(36)
      }
      const rootFor = (el: Element) =>
        el.closest(
          '.ant-form-item,[class*="form-item"],[class*="FormItem"],label,[class*="field"],[class*="Field"],[class*="item"],[class*="row"],[class*="upload"]',
        ) || el.parentElement
      const nearbyText = (el: Element) => normalize(rootFor(el)?.textContent).slice(0, 360)
      const labelFor = (el: Element) => {
        const ownId = el.getAttribute('id') || el.querySelector('input,textarea,select')?.getAttribute('id')
        if (!ownId) return ''
        return normalize(document.querySelector(`label[for="${CSS.escape(ownId)}"]`)?.textContent)
      }
      const labelledBy = (el: Element) =>
        normalize(
          (el.getAttribute('aria-labelledby') || el.querySelector('[aria-labelledby]')?.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' '),
        )
      const closestLabel = (el: Element) => normalize(el.closest('label')?.textContent)
      const fieldLabel = (el: Element) => {
        const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | null
        const aria = normalize(el.getAttribute('aria-label') || input?.getAttribute('aria-label'))
        const placeholder = normalize(input?.placeholder || el.getAttribute('placeholder'))
        const label = labelFor(el) || closestLabel(el)
        const antLabel = normalize(el.closest('.ant-form-item')?.querySelector('.ant-form-item-label')?.textContent)
        const name = normalize(el.getAttribute('name') || input?.getAttribute('name'))
        const id = normalize(el.getAttribute('id') || input?.getAttribute('id'))
        return aria || labelledBy(el) || label || antLabel || placeholder || name || id || nearbyText(el)
      }
      const controlKind = (el: Element) => {
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
        if (role === 'combobox' || /ant-select|select__control|Select-control/.test(classes) || el.getAttribute('aria-haspopup') === 'listbox') {
          return 'select_custom'
        }
        if (tag === 'textarea' || input?.tagName.toLowerCase() === 'textarea') return 'textarea'
        if (tag === 'input' || input || /textbox|searchbox/.test(role) || el.getAttribute('contenteditable') === 'true') return 'text'
        return 'unknown'
      }
      const fieldOptions = (el: Element) => {
        const select = (el.matches('select') ? el : el.querySelector('select')) as HTMLSelectElement | null
        if (!select) return undefined
        return Array.from(select.options)
          .map((option) => ({
            value: option.value,
            label: normalize(option.textContent),
            selected: option.selected,
          }))
          .slice(0, 80)
      }
      const fieldValue = (el: Element, kind: string) => {
        const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | HTMLSelectElement | null
        if (kind === 'checkbox' || kind === 'radio') return input && (input as HTMLInputElement).checked ? normalize(nearbyText(el) || input.value) : ''
        if (kind === 'file') return ''
        if (kind === 'select_native' && input && 'selectedOptions' in input) {
          return normalize(Array.from((input as HTMLSelectElement).selectedOptions).map((option) => option.textContent || option.value).join(' '))
        }
        if (kind === 'select_custom' || kind === 'cascader' || kind === 'date') {
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
          if (selectedText) return selectedText
        }
        if (input && 'value' in input) return normalize(String(input.value ?? ''))
        return normalize(el.getAttribute('aria-valuetext') || el.textContent)
      }
      const fieldChecked = (el: Element, kind: string) => {
        const input = (el.matches('input') ? el : el.querySelector('input')) as HTMLInputElement | null
        if (kind !== 'checkbox' && kind !== 'radio') return undefined
        return input ? input.checked : el.getAttribute('aria-checked') === 'true'
      }
      const fieldFilled = (kind: string, value: string, checked: boolean | undefined, options: ReturnType<typeof fieldOptions>) => {
        if (kind === 'checkbox' || kind === 'radio') return Boolean(checked)
        if (kind === 'select_native' || kind === 'select_custom' || kind === 'cascader') {
          if (options?.some((option) => option.selected && (normalize(option.value) || normalize(option.label)))) return true
          return value.length > 0 && !/^(请选择|please select|select|choose)$/i.test(value)
        }
        return value.length > 0
      }
      const fieldError = (el: Element) => {
        const root = rootFor(el)
        if (!root) return ''
        const selectors = [
          '[role="alert"]',
          '[aria-live]',
          '.ant-form-item-explain-error',
          '[class*="error"]',
          '[class*="Error"]',
          '[class*="invalid"]',
          '[class*="help"]',
          '[class*="tips"]',
          '[class*="message"]',
        ]
        for (const errorSelector of selectors) {
          const text = normalize(root.querySelector(errorSelector)?.textContent)
          if (text) return text.slice(0, 180)
        }
        const rootText = normalize(root.textContent)
        const match = rootText.match(/(?:必填|不能为空|请选择|请输入|is required|required|must be filled)[^。.!?；;\n]*/i)
        return match ? match[0].slice(0, 180) : ''
      }
      const requiredSignals = (el: Element, errorText: string) => {
        const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | null
        const root = rootFor(el)
        const rootText = nearbyText(el)
        const classes = [classText(el), classText(input), classText(root)].join(' ')
        const labelNode = root?.querySelector('label,.ant-form-item-label,*[class*="label"],*[class*="Label"]')
        let confidence = 0
        if (input?.required || el.getAttribute('required') !== null || el.getAttribute('aria-required') === 'true' || input?.getAttribute('aria-required') === 'true') {
          confidence = Math.max(confidence, 1)
        }
        if (/ant-form-item-required|\brequired\b|is-required/.test(classes) || root?.querySelector('.ant-form-item-required,[class*="required"],[class*="Required"]')) {
          confidence = Math.max(confidence, 0.9)
        }
        if (/[*＊]/.test(normalize(labelNode?.textContent)) || /[*＊]\s*$/.test(rootText)) confidence = Math.max(confidence, 0.75)
        if (/必填|不能为空|请选择|请输入|is required|required|must be filled/i.test(errorText || rootText)) confidence = Math.max(confidence, errorText ? 0.95 : 0.7)
        return { required: confidence >= 0.6, requiredConfidence: confidence || undefined }
      }
      const fieldKey = (el: Element, kind: string, label: string, hints: { id?: string; name?: string; css?: string }) => {
        const primary = hints.id ? `id:${hints.id}` : hints.name ? `name:${hints.name}` : `label:${label.toLowerCase()}`
        return `${kind}:${primary}:${hashText(hints.css || label || kind)}`
      }

      const controls: Element[] = []
      const seen = new Set<Element>()
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const control = canonicalControl(node)
        if (seen.has(control)) continue
        seen.add(control)
        controls.push(control)
      }

      const fields: Field[] = []
      for (const el of controls) {
        if (!isVisible(el)) continue
        const input = (el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select')) as HTMLInputElement | null
        const type = normalize(input?.type || el.getAttribute('type')).toLowerCase()
        if (type === 'hidden') continue
        const kind = controlKind(el)
        const tag = el.tagName.toLowerCase()
        const error = fieldError(el)
        const label = fieldLabel(el)
        const value = fieldValue(el, kind)
        const checked = fieldChecked(el, kind)
        const options = fieldOptions(el)
        const id = normalize(el.getAttribute('id') || input?.getAttribute('id'))
        const name = normalize(el.getAttribute('name') || input?.getAttribute('name'))
        const placeholder = normalize(input?.placeholder || el.getAttribute('placeholder'))
        const css = cssPath(el)
        const locatorHints = {
          aria: normalize(el.getAttribute('aria-label') || input?.getAttribute('aria-label')) || undefined,
          text: label || nearbyText(el) || undefined,
          css,
          xpath: xpath(el),
          name: name || undefined,
          id: id || undefined,
          placeholder: placeholder || undefined,
          label: label || undefined,
        }
        fields.push({
          index: fields.length,
          fieldKey: fieldKey(el, kind, label, { id, name, css }),
          controlKind: kind as Field['controlKind'],
          tag,
          type: type || undefined,
          role: el.getAttribute('role') || input?.getAttribute('role') || undefined,
          label,
          placeholder: placeholder || undefined,
          name: name || undefined,
          id: id || undefined,
          value,
          filled: fieldFilled(kind, value, checked, options),
          checked,
          ...requiredSignals(el, error),
          disabled: Boolean(input?.disabled) || el.getAttribute('aria-disabled') === 'true',
          readonly: Boolean(input?.readOnly) || el.getAttribute('aria-readonly') === 'true',
          invalid: el.getAttribute('aria-invalid') === 'true' || input?.getAttribute('aria-invalid') === 'true' || Boolean(error),
          error: error || undefined,
          nearbyText: nearbyText(el),
          locatorHints,
          options,
        })
        if (fields.length >= limit) break
      }

      const forbiddenUploadActionText =
        /确认投递|提交申请|投递简历|立即投递|提交投递|投递|提交|申请|\b(?:apply(?:\s+now)?|submit(?:\s+application)?|confirm(?:\s+(?:application|submit))?|send\s+application|start\s+application)\b/i
      const explicitUploadTargetText =
        /上传|重新上传|选择.{0,8}(?:文件|简历)|选取.{0,8}(?:文件|简历)|附件简历|上传附件|附件上传|resume[-_\s]*upload|upload[-_\s]*resume|file[-_\s]*upload|upload[-_\s]*file|choose[-_\s]*file|select[-_\s]*file|\bupload\b|browse/i
      const uploadHints = Array.from(
        document.querySelectorAll('input[type="file"],button,[role="button"],a,[class*="upload"],[class*="Upload"],[id*="upload"],[id*="Upload"]'),
      )
        .map((el) => {
          const input = el as HTMLInputElement
          const cls = classText(el) || undefined
          const text = normalize(
            el.textContent ||
              input.value ||
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              el.getAttribute('name') ||
              el.getAttribute('id'),
          ).slice(0, 180)
          const humanText = normalize([el.textContent, input.value, el.getAttribute('aria-label'), el.getAttribute('title'), input.placeholder].filter(Boolean).join(' '))
          const searchableText = normalize([humanText, el.getAttribute('name'), el.getAttribute('id'), cls, el.getAttribute('accept')].filter(Boolean).join(' '))
          return {
            tag: el.tagName.toLowerCase(),
            type: input.type || el.getAttribute('type') || undefined,
            text,
            visible: isVisible(el),
            accept: el.getAttribute('accept') || undefined,
            humanText,
            searchableText,
          }
        })
        .filter((item) => {
          if (item.type === 'file') return true
          if (!item.visible) return false
          if (forbiddenUploadActionText.test(item.humanText)) return false
          return explicitUploadTargetText.test(item.searchableText)
        })
        .map((item) => ({
          tag: item.tag,
          type: item.type,
          text: item.text,
          visible: item.visible,
          accept: item.accept,
        }))
        .slice(0, 40)

      const submitCandidates = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"]'))
        .map((el) => {
          const input = el as HTMLInputElement
          const text = normalize(el.textContent || input.value || el.getAttribute('aria-label')).slice(0, 180)
          return {
            tag: el.tagName.toLowerCase(),
            type: input.type || el.getAttribute('type') || undefined,
            role: el.getAttribute('role') || undefined,
            text,
            visible: isVisible(el),
            risk: /submit|apply|application|提交|投递|申请|递交|报名|send|发送|confirm|确认|pay|支付/i.test(text) ? 'L3' : 'L1',
          }
        })
        .filter((item) => item.visible && item.text)
        .slice(0, 40)

      const visibleErrors = Array.from(
        document.querySelectorAll('[role="alert"],.ant-form-item-explain-error,[class*="error"],[class*="Error"],[class*="invalid"],[class*="message"]'),
      )
        .map((el) => normalize(el.textContent).slice(0, 180))
        .filter(Boolean)
        .slice(0, 40)

      return {
        fields,
        uploadHints,
        submitCandidates,
        visibleErrors,
        totalControls: controls.length,
      }
    },
    { selector: CONTROL_SELECTOR, limit: maxFields },
  )

  return result
}

export async function auditFormSnapshotFromPage(page: Page, input: { maxFields?: number; waitMs?: number } = {}): Promise<FormAuditSnapshot> {
  const maxFields = input.maxFields ?? 240
  const waitMs = input.waitMs ?? 120
  const originalScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 }))
  const metrics = await page.evaluate(() => ({
    height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    viewport: window.innerHeight || document.documentElement.clientHeight || 800,
  }))
  const maxY = Math.max(0, metrics.height - metrics.viewport)
  const step = Math.max(240, Math.floor(metrics.viewport * 0.8))
  const positions = Array.from(new Set([0, ...Array.from({ length: Math.ceil(maxY / step) + 1 }, (_, index) => Math.min(maxY, index * step)), maxY])).sort(
    (a, b) => a - b,
  )

  const merged = new Map<string, RawFormField>()
  let uploadHints: RawUploadHint[] = []
  let submitCandidates: RawSubmitCandidate[] = []
  let visibleErrors: string[] = []
  let totalControls = 0

  try {
    for (const y of positions) {
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y)
      await page.waitForTimeout(waitMs)
      const segment = await collectFormSnapshotFromPage(page, { maxFields })
      totalControls += segment.totalControls
      uploadHints = mergeByText(uploadHints, segment.uploadHints)
      submitCandidates = mergeByText(submitCandidates, segment.submitCandidates)
      visibleErrors = Array.from(new Set([...visibleErrors, ...segment.visibleErrors])).slice(0, 80)
      for (const field of segment.fields ?? []) {
        const key = field.fieldKey || `${field.controlKind || field.tag}:${field.name || field.id || field.label || field.index}`
        const existing = merged.get(key)
        if (!existing) {
          merged.set(key, field)
          continue
        }
        merged.set(key, {
          ...existing,
          ...field,
          value: field.value || existing.value,
          checked: field.checked ?? existing.checked,
          required: Boolean(existing.required || field.required),
          requiredConfidence: Math.max(existing.requiredConfidence ?? 0, field.requiredConfidence ?? 0) || undefined,
          error: field.error || existing.error,
          options: field.options?.length ? field.options : existing.options,
        })
      }
      if (merged.size >= maxFields) break
    }
  } finally {
    await page.evaluate(({ x, y }) => window.scrollTo(x, y), originalScroll).catch(() => {})
  }

  const fields = Array.from(merged.values()).slice(0, maxFields).map((field, index) => ({ ...field, index }))
  const updatedAt = new Date().toISOString()
  const formCoverage: FormCoverage = {
    schemaVersion: 'form-coverage/v1',
    scrolledTop: positions.includes(0),
    scrolledBottom: maxY === 0 || positions.some((position) => position >= maxY - 2),
    segments: positions.length,
    totalFieldsSeen: fields.length,
    fieldKeysSeen: fields.map((field) => field.fieldKey).filter((key): key is string => Boolean(key)),
    auditTool: 'browser_form_audit',
    updatedAt,
  }

  return {
    fields,
    uploadHints,
    submitCandidates,
    visibleErrors,
    totalControls,
    formCoverage,
  }
}

function mergeByText<T extends { tag?: string; type?: string; text?: string; role?: string }>(left: T[], right: T[]): T[] {
  const merged = new Map<string, T>()
  for (const item of [...left, ...right]) {
    const key = [item.tag, item.type, item.role, item.text].filter(Boolean).join('|')
    if (!key) continue
    if (!merged.has(key)) merged.set(key, item)
  }
  return Array.from(merged.values()).slice(0, 80)
}
