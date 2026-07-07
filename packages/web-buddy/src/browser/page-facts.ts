import type { Page } from 'playwright'
import { emptyPageFacts, normalizePageFacts, type PageFacts } from '../observation/page-facts.js'

export async function collectPageFacts(page: Page): Promise<PageFacts> {
  const raw = await page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
    const redactText = (value: string | null | undefined, max: number) => {
      const normalized = normalize(value)
      if (!normalized) return ''
      const redacted = normalized
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\b(?:\+?\d[\d\s().-]{6,}\d)\b/g, '[number]')
        .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[url]')
      return redacted.length <= max ? redacted : `${redacted.slice(0, max)}...`
    }
    const isVisible = (el: Element) => {
      const input = el as HTMLInputElement
      if (input.type === 'file') return true
      const style = window.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const isEnabled = (el: Element) => {
      const input = el as HTMLInputElement
      return !input.disabled && el.getAttribute('aria-disabled') !== 'true'
    }
    const labelFor = (el: Element) => {
      const id = el.getAttribute('id')
      if (!id) return ''
      return normalize(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent)
    }
    const closestLabel = (el: Element) => normalize(el.closest('label')?.textContent)
    const nearbyText = (el: Element) => {
      const parent =
        el.closest('label,[class*="form"],[class*="field"],[class*="item"],[class*="row"],[class*="notice"],[class*="agree"],[class*="upload"]') ||
        el.parentElement
      return normalize(parent?.textContent).slice(0, 260)
    }
    const controlText = (el: Element) => {
      const input = el as HTMLInputElement
      return redactText(
        [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          labelFor(el),
          closestLabel(el),
          input.placeholder,
          el.textContent,
          input.value,
          el.getAttribute('name'),
          el.getAttribute('id'),
          nearbyText(el),
        ]
          .filter(Boolean)
          .join(' '),
        180,
      )
    }
    const searchableAttrs = (el: Element) => {
      const input = el as HTMLInputElement
      const className =
        typeof (el as HTMLElement).className === 'string'
          ? (el as HTMLElement).className
          : el.getAttribute('class') || ''
      return normalize([
        controlText(el),
        el.getAttribute('name'),
        el.getAttribute('id'),
        className,
        el.getAttribute('accept'),
        input.placeholder,
      ].filter(Boolean).join(' '))
    }
    const buttonText = (el: Element) => redactText(
      [
        el.textContent,
        (el as HTMLInputElement).value,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
      ].filter(Boolean).join(' '),
      140,
    )
    const buttonFact = (el: Element) => {
      const input = el as HTMLInputElement
      return {
        tag: el.tagName.toLowerCase(),
        type: (input.type || el.getAttribute('type') || '').toLowerCase() || undefined,
        role: el.getAttribute('role') || undefined,
        text: buttonText(el),
        visible: isVisible(el),
        disabled: !isEnabled(el),
      }
    }
    const excerptAround = (text: string, pattern: RegExp, max = 260) => {
      const index = text.search(pattern)
      if (index < 0) return redactText(text, max)
      const start = Math.max(0, index - Math.floor(max / 3))
      return redactText(text.slice(start, start + max), max)
    }

    const agreementText =
      /同意|已阅读|阅读并同意|协议|条款|须知|需知|隐私|声明|承诺|授权|agreement|agree|terms|notice|privacy|consent/i
    const quotaText =
      /申请名额|投递名额|申请次数|投递次数|你已申请.{0,12}职位|已申请.{0,12}职位|本月.{0,18}(?:还能|可|可以).{0,18}(?:申请|投递)|本月.{0,12}申请.{0,12}职位|每月.{0,12}申请|可申请.{0,12}职位|请慎重选择|application quota|application limit|apply quota|apply limit|submission quota|submission limit/i
    const uploadActionText =
      /确认投递|提交申请|投递简历|立即投递|提交投递|投递|提交|申请|\b(?:apply(?:\s+now)?|submit(?:\s+application)?|confirm(?:\s+(?:application|submit))?|send\s+application|start\s+application)\b/i
    const uploadTargetText =
      /上传|重新上传|选择.{0,8}(?:文件|简历)|选取.{0,8}(?:文件|简历)|附件简历|上传附件|附件上传|resume[-_\s]*upload|upload[-_\s]*resume|file[-_\s]*upload|upload[-_\s]*file|choose[-_\s]*file|select[-_\s]*file|\bupload\b|browse/i
    const submitLikeText =
      /确认投递|确认提交|提交申请|提交投递|递交申请|投递|提交|申请|确认|发送|报名|下一步|继续|完成|submit|apply|application|confirm|send|continue|next|finish|complete|done/i
    const applyEntryText =
      /^(投递简历|立即投递|申请职位|开始申请|进入申请|start application|apply now|apply)$/i
    const finalSubmitText =
      /确认投递|确认提交|提交申请|提交投递|递交申请|最终提交|submit application|submit final|final submit|\bsubmit$/i
    const loginText = /login|log in|sign in|signin|sso|auth|password|密码登录|短信登录|账号登录|统一认证|单点登录|请登录|登录后|登陆后|登入后/i
    const captchaText = /captcha|verify you are human|human verification|security check|滑块|验证码|安全验证|人机验证|请验证/i
    const validationText = /必填|required|invalid|error|错误|不能为空|请填写|校验失败|验证失败/i
    const confirmationText = /确认|取消|继续|确定|confirm|cancel|continue|ok/i

    const agreementCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"],[role="checkbox"]'))
      .filter((el) => isVisible(el) && isEnabled(el) && agreementText.test(controlText(el)))
      .map((el) => {
        const input = el as HTMLInputElement
        return input.checked === true || el.getAttribute('aria-checked') === 'true'
      })

    const realUploadInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(isEnabled)
    const uploadCandidateElements = new Set<Element>()
    for (const input of realUploadInputs) uploadCandidateElements.add(input)
    for (const el of Array.from(document.querySelectorAll('button,[role="button"],a,[class*="upload"],[class*="Upload"],[id*="upload"],[id*="Upload"]'))) {
      if (!isVisible(el) || !isEnabled(el)) continue
      const humanText = buttonText(el)
      if (uploadActionText.test(humanText)) continue
      if (uploadTargetText.test(searchableAttrs(el))) uploadCandidateElements.add(el)
    }

    const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"]'))
      .filter((el) => isVisible(el))
      .map(buttonFact)
      .filter((button) => button.text)
    const submitLikeButtons = buttons.filter((button) => !button.disabled && submitLikeText.test(button.text)).slice(0, 24)
    const likelyApplyEntryButtons = submitLikeButtons.filter((button) => applyEntryText.test(button.text)).slice(0, 16)
    const likelyFinalSubmitButtons = submitLikeButtons.filter((button) => finalSubmitText.test(button.text)).slice(0, 16)

    const dialogSelector = [
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
      '[class*="modal"]',
      '[class*="Modal"]',
      '[class*="dialog"]',
      '[class*="Dialog"]',
      '[class*="popup"]',
      '[class*="Popup"]',
      '[class*="drawer"]',
      '[class*="Drawer"]',
    ].join(',')
    const dialogs = Array.from(document.querySelectorAll(dialogSelector))
      .filter((el) => isVisible(el))
      .map((el) => {
        const text = redactText((el as HTMLElement).innerText || el.textContent, 260)
        const role = el.getAttribute('role') || (el.getAttribute('aria-modal') === 'true' ? 'modal' : undefined)
        const hasControls = Array.from(el.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]'))
          .some((control) => isVisible(control) && isEnabled(control))
        return { text, role, hasControls }
      })
      .filter((dialog) => dialog.text)

    const bodyText = normalize(document.body?.innerText || '')
    const bodyControlTexts = buttons.map((button) => button.text)
    const hasQuotaBodyFallback =
      quotaText.test(bodyText) &&
      bodyControlTexts.some((text) => /取消|cancel/i.test(text)) &&
      bodyControlTexts.some((text) => /投递|申请|提交|apply|submit|confirm/i.test(text))
    if (hasQuotaBodyFallback && !dialogs.some((dialog) => quotaText.test(dialog.text))) {
      dialogs.unshift({
        text: excerptAround(bodyText, quotaText, 260),
        role: 'body-quota-heuristic',
        hasControls: true,
      })
    }

    const quotaDialog = dialogs.find((dialog) => quotaText.test(dialog.text))
    const blockingDialog =
      quotaDialog ||
      dialogs.find((dialog) => captchaText.test(dialog.text)) ||
      dialogs.find((dialog) => loginText.test(dialog.text)) ||
      dialogs.find((dialog) => validationText.test(dialog.text) && dialog.hasControls) ||
      dialogs.find((dialog) => confirmationText.test(dialog.text) && dialog.hasControls) ||
      dialogs.find((dialog) => dialog.hasControls)

    const dialogKind = (text: string | undefined): 'quota' | 'login' | 'captcha' | 'validation' | 'confirmation' | 'modal' | undefined => {
      if (!text) return undefined
      if (quotaText.test(text)) return 'quota'
      if (captchaText.test(text)) return 'captcha'
      if (loginText.test(text)) return 'login'
      if (validationText.test(text)) return 'validation'
      if (confirmationText.test(text)) return 'confirmation'
      return 'modal'
    }

    return {
      hasAgreementCheckbox: agreementCheckboxes.length > 0,
      agreementChecked: agreementCheckboxes.length > 0 && agreementCheckboxes.every(Boolean),
      hasApplicationQuotaDialog: Boolean(quotaDialog),
      quotaDialogText: quotaDialog?.text || undefined,
      hasRealUploadInput: realUploadInputs.length > 0,
      uploadCandidateCount: uploadCandidateElements.size,
      submitLikeButtons,
      likelyApplyEntryButtons,
      likelyFinalSubmitButtons,
      visibleBlockingDialog: blockingDialog
        ? {
            present: true,
            kind: dialogKind(blockingDialog.text),
            text: blockingDialog.text,
            role: blockingDialog.role,
          }
        : { present: false },
    }
  })

  return normalizePageFacts(raw) ?? emptyPageFacts()
}
