import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Locator, Page } from 'playwright'
import { toolFailure, toolSuccess } from '../errors.js'
import { resolveRefWithSnapshotRetry } from '../snapshot/ref-resolver.js'
import { sessionManager } from '../session/manager.js'
import { clearHighlight, visualizeBeforeAction } from '../sdk/highlight.js'

const UPLOAD_TARGET_SUGGESTIONS = [
  'browser_snapshot',
  'browser_form_snapshot',
  '寻找真实上传入口: input[type=file], 上传简历, 附件简历, 重新上传, 选择文件, 上传附件, or resume upload.',
]

const FORBIDDEN_UPLOAD_ACTION_TEXT =
  /确认投递|提交申请|投递简历|立即投递|提交投递|投递|提交|申请|\b(?:apply(?:\s+now)?|submit(?:\s+application)?|confirm(?:\s+(?:application|submit))?|send\s+application|start\s+application)\b/i

const EXPLICIT_UPLOAD_TARGET_TEXT =
  /上传|重新上传|选择.{0,8}(?:文件|简历)|选取.{0,8}(?:文件|简历)|附件简历|上传附件|附件上传|resume[-_\s]*upload|upload[-_\s]*resume|file[-_\s]*upload|upload[-_\s]*file|choose[-_\s]*file|select[-_\s]*file|\bupload\b|browse/i

interface UploadTargetDescriptor {
  tag: string
  type?: string
  role?: string
  text?: string
  ariaLabel?: string
  title?: string
  value?: string
  placeholder?: string
  name?: string
  id?: string
  className?: string
  accept?: string
}

function isHeadful(): boolean {
  return process.env.PLAYWRIGHT_HEADLESS === 'false'
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function isFileInput(tagName: string | undefined, typeAttr: string | undefined): boolean {
  return normalizeText(tagName).toLowerCase() === 'input' && normalizeText(typeAttr).toLowerCase() === 'file'
}

function combineText(...values: Array<string | null | undefined>): string {
  return normalizeText(values.filter(Boolean).join(' '))
}

function hasForbiddenUploadActionText(value: string): boolean {
  return FORBIDDEN_UPLOAD_ACTION_TEXT.test(normalizeText(value))
}

function hasExplicitUploadIntent(value: string): boolean {
  return EXPLICIT_UPLOAD_TARGET_TEXT.test(normalizeText(value))
}

function rejectedUploadTarget(label: string, details?: string) {
  const suffix = details ? ` Matched target: ${details}` : ''
  return toolFailure('INVALID_ARGUMENT', `${label} is not a valid upload target.${suffix}`, {
    recoverable: true,
    suggestedNextActions: UPLOAD_TARGET_SUGGESTIONS,
  })
}

function describeUploadTarget(descriptor: UploadTargetDescriptor): string {
  return combineText(
    descriptor.text,
    descriptor.ariaLabel,
    descriptor.title,
    descriptor.value,
    descriptor.placeholder,
    descriptor.name,
    descriptor.id,
  ).slice(0, 220)
}

function uploadTargetDecision(descriptor: UploadTargetDescriptor): { ok: true } | { ok: false; reason: string } {
  if (isFileInput(descriptor.tag, descriptor.type)) return { ok: true }

  const humanText = combineText(
    descriptor.text,
    descriptor.ariaLabel,
    descriptor.title,
    descriptor.value,
    descriptor.placeholder,
  )
  if (hasForbiddenUploadActionText(humanText)) {
    return { ok: false, reason: 'Apply, submit, or final-delivery controls cannot be used as upload targets.' }
  }

  const searchableText = combineText(
    humanText,
    descriptor.name,
    descriptor.id,
    descriptor.className,
    descriptor.accept,
  )
  if (hasExplicitUploadIntent(searchableText)) return { ok: true }

  return { ok: false, reason: 'The target does not look like a real file upload entry.' }
}

async function getUploadTargetDescriptor(locator: Locator): Promise<UploadTargetDescriptor> {
  return locator.evaluate((el) => {
    const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
    const input = el as HTMLInputElement
    const className =
      typeof (el as HTMLElement).className === 'string'
        ? (el as HTMLElement).className
        : el.getAttribute('class') || undefined
    return {
      tag: el.tagName.toLowerCase(),
      type: input.type || el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      text: normalize(el.textContent || input.value || el.getAttribute('aria-label')).slice(0, 180),
      ariaLabel: normalize(el.getAttribute('aria-label')) || undefined,
      title: normalize(el.getAttribute('title')) || undefined,
      value: normalize(input.value) || undefined,
      placeholder: normalize(input.placeholder) || undefined,
      name: normalize(el.getAttribute('name')) || undefined,
      id: normalize(el.getAttribute('id')) || undefined,
      className: normalize(className) || undefined,
      accept: normalize(el.getAttribute('accept')) || undefined,
    }
  })
}

async function assertUploadTarget(locator: Locator, label: string) {
  const descriptor = await getUploadTargetDescriptor(locator)
  const decision = uploadTargetDecision(descriptor)
  if (!decision.ok) {
    return {
      ok: false as const,
      failure: rejectedUploadTarget(`${label} ${decision.reason}`, describeUploadTarget(descriptor)),
    }
  }
  return {
    ok: true as const,
    descriptor,
  }
}

async function markVisibleText(page: import('playwright').Page, text: string, exact: boolean, nth: number, marker: string) {
  return page.evaluate(
    ({ text: targetText, exact: exactMatch, nth: targetIndex, marker: markerValue }) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
      const target = normalize(targetText)
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const matches = (el: Element) => {
        const textContent = normalize(el.textContent || '')
        if (!textContent || textContent.length > 800) return false
        return exactMatch ? textContent === target : textContent.includes(target)
      }
      const isClickable = (el: Element) => {
        const tag = el.tagName.toLowerCase()
        const role = el.getAttribute('role') || ''
        const style = window.getComputedStyle(el)
        return tag === 'a' || tag === 'button' || role === 'button' || (el as HTMLElement).onclick !== null || style.cursor === 'pointer'
      }
      const nearestClickable = (el: Element) => {
        let current: Element | null = el
        while (current && current !== document.body && current !== document.documentElement) {
          if (isVisible(current) && isClickable(current)) return current
          current = current.parentElement
        }
        return el
      }

      const matchesList = Array.from(document.querySelectorAll('body *'))
        .filter((el) => isVisible(el) && matches(el))
        .sort((a, b) => normalize(a.textContent || '').length - normalize(b.textContent || '').length)

      const targets: Element[] = []
      for (const el of matchesList) {
        const targetEl = nearestClickable(el)
        if (!targets.includes(targetEl)) targets.push(targetEl)
      }

      const selected = targets[targetIndex]
      if (!selected) return null
      selected.setAttribute('data-mfa-upload-target', markerValue)
      return {
        tag: selected.tagName.toLowerCase(),
        role: selected.getAttribute('role') || undefined,
        text: normalize(selected.textContent || '').slice(0, 180),
        totalMatches: targets.length,
      }
    },
    { text, exact, nth, marker },
  )
}

export async function browserUploadFile(input: {
  filePath: string
  sessionId?: string
  ref?: string
  text?: string
  selector?: string
  exact?: boolean
  nth?: number
  timeoutMs?: number
  confirmed?: boolean
  highlight?: boolean
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  if (input.confirmed !== true) {
    return toolFailure('CONFIRMATION_REQUIRED', 'Uploading a resume or local file requires confirmed=true.', {
      recoverable: true,
      suggestedNextActions: ['Confirm the file upload is intended, then retry browser_upload_file with confirmed=true.'],
    })
  }

  const filePath = resolve(input.filePath)
  if (!existsSync(filePath)) {
    return toolFailure('INVALID_ARGUMENT', `File does not exist: ${filePath}`, {
      recoverable: true,
      suggestedNextActions: ['Check filePath and retry browser_upload_file.'],
    })
  }

  const timeout = input.timeoutMs ?? Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || 10000)

  try {
    if (input.ref) {
      const resolved = await resolveRefWithSnapshotRetry(session.page, session.latestSnapshot, input.ref, session.id)
      if (!resolved.ok) return resolved.failure
      const { locator } = resolved
      const tagName = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
      const typeAttr = await locator.getAttribute('type').catch(() => '')
      let verifyLocator: Locator | undefined
      if (tagName === 'input' && typeAttr === 'file') {
        await locator.setInputFiles(filePath, { timeout })
        verifyLocator = locator
      } else {
        const target = await assertUploadTarget(locator, `ref ${input.ref}`)
        if (!target.ok) return target.failure
        if (input.highlight && isHeadful()) await visualizeBeforeAction(session.page, locator, 'click_risky')
        await uploadViaFileChooser(session.page, locator, filePath, timeout)
      }
      if (input.highlight && isHeadful()) await clearHighlight(session.page)
      const verification = await verifyUploadAcknowledged(session.page, filePath, verifyLocator)
      sessionManager.invalidateSnapshot(session.id)
      return uploadResult(`Uploaded file to ref ${input.ref}.`, { filePath, ref: input.ref, url: session.page.url() }, verification)
    }

    if (input.selector) {
      const locator = session.page.locator(input.selector).first()
      const count = await locator.count()
      if (count === 0) {
        return toolFailure('ELEMENT_NOT_FOUND', `No element matched selector: ${input.selector}`, {
          recoverable: true,
          suggestedNextActions: UPLOAD_TARGET_SUGGESTIONS,
        })
      }
      const tagName = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
      const typeAttr = await locator.getAttribute('type').catch(() => '')
      let verifyLocator: Locator | undefined
      if (tagName === 'input' && typeAttr === 'file') {
        await locator.setInputFiles(filePath, { timeout })
        verifyLocator = locator
      } else {
        const target = await assertUploadTarget(locator, `selector ${input.selector}`)
        if (!target.ok) return target.failure
        await uploadViaFileChooser(session.page, locator, filePath, timeout)
      }
      const verification = await verifyUploadAcknowledged(session.page, filePath, verifyLocator)
      sessionManager.invalidateSnapshot(session.id)
      return uploadResult(`Uploaded file via selector ${input.selector}.`, { filePath, selector: input.selector, url: session.page.url() }, verification)
    }

    if (input.text) {
      if (hasForbiddenUploadActionText(input.text)) {
        return rejectedUploadTarget('Visible text target is an apply/submit control, not an upload entry', input.text)
      }
      const marker = `mfa-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const match = await markVisibleText(session.page, input.text, input.exact ?? false, input.nth ?? 0, marker)
      if (!match) {
        return toolFailure('ELEMENT_NOT_FOUND', `No visible upload trigger matched text "${input.text}".`, {
          recoverable: true,
          suggestedNextActions: UPLOAD_TARGET_SUGGESTIONS,
        })
      }
      const locator = session.page.locator(`[data-mfa-upload-target="${marker}"]`).first()
      try {
        const target = await assertUploadTarget(locator, `visible text "${input.text}"`)
        if (!target.ok) return target.failure
        if (input.highlight && isHeadful()) await visualizeBeforeAction(session.page, locator, 'click_risky')
        await uploadViaFileChooser(session.page, locator, filePath, timeout)
        if (input.highlight && isHeadful()) await clearHighlight(session.page)
      } finally {
        await locator.evaluate((el) => el.removeAttribute('data-mfa-upload-target')).catch(() => {})
      }
      const verification = await verifyUploadAcknowledged(session.page, filePath)
      sessionManager.invalidateSnapshot(session.id)
      return uploadResult(`Uploaded file via visible text "${input.text}".`, {
        filePath,
        text: input.text,
        matchedText: match.text,
        totalMatches: match.totalMatches,
        url: session.page.url(),
      }, verification)
    }

    const fileInput = session.page.locator('input[type="file"]').first()
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(filePath, { timeout })
      const verification = await verifyUploadAcknowledged(session.page, filePath, fileInput)
      sessionManager.invalidateSnapshot(session.id)
      return uploadResult('Uploaded file via first input[type=file].', {
        filePath,
        url: session.page.url(),
      }, verification)
    }

    return toolFailure('ELEMENT_NOT_FOUND', 'No upload target was found. Provide ref, text, or selector after browser_form_snapshot.', {
      recoverable: true,
      suggestedNextActions: UPLOAD_TARGET_SUGGESTIONS,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (input.highlight && isHeadful()) await clearHighlight(session.page)
    return toolFailure('ELEMENT_NOT_FOUND', `Failed to upload file: ${message}`, {
      recoverable: true,
      suggestedNextActions: UPLOAD_TARGET_SUGGESTIONS,
    })
  }
}

async function uploadViaFileChooser(page: Page, locator: Locator, filePath: string, timeout: number): Promise<void> {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout }),
    locator.click({ timeout }),
  ])
  await fileChooser.setFiles(filePath)
}

async function verifyUploadAcknowledged(page: Page, filePath: string, locator?: Locator): Promise<{ verified: boolean; signals: string[] }> {
  const signals: string[] = []
  const fileName = basename(filePath)
  if (locator) {
    const fileCount = await locator.evaluate((el) => {
      const input = el as HTMLInputElement
      return input.files?.length ?? 0
    }).catch(() => 0)
    if (fileCount > 0) signals.push('input.files')
  }

  const pageSignals = await page.evaluate((name) => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ')
    const fileInputsWithFiles = Array.from(document.querySelectorAll('input[type="file"]')).some((el) => {
      const input = el as HTMLInputElement
      return (input.files?.length ?? 0) > 0
    })
    return {
      fileNameVisible: Boolean(name) && text.includes(name),
      uploadStatusVisible: /uploaded|uploading|attached|processing|upload complete|upload successful|解析中|解析完成|上传成功|上传完成|已上传|附件已上传|简历已上传/i.test(text),
      fileInputsWithFiles,
    }
  }, fileName).catch(() => ({
    fileNameVisible: false,
    uploadStatusVisible: false,
    fileInputsWithFiles: false,
  }))
  if (pageSignals.fileNameVisible) signals.push('filename_visible')
  if (pageSignals.uploadStatusVisible) signals.push('upload_status_visible')
  if (pageSignals.fileInputsWithFiles) signals.push('page_file_input_files')

  return { verified: signals.length > 0, signals }
}

function uploadResult<T extends Record<string, unknown>>(
  observation: string,
  data: T,
  verification: { verified: boolean; signals: string[] },
) {
  if (!verification.verified) {
    return toolSuccess(
      `UPLOAD_UNVERIFIED: file chooser accepted the file but the page did not acknowledge it. Re-snapshot before assuming success.`,
      { ...data, uploadVerified: false, uploadSignals: verification.signals },
      false,
    )
  }
  return toolSuccess(observation, { ...data, uploadVerified: true, uploadSignals: verification.signals }, true)
}
