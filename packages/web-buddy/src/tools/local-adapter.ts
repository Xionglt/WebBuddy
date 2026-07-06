import { browserClick } from '../browser/click.js'
import { browserClickText } from '../browser/click-text.js'
import { browserFillByLabel } from '../browser/fill-by-label.js'
import { browserFormAudit } from '../browser/form-audit.js'
import { browserFormSnapshot } from '../browser/form-snapshot.js'
import { browserInspectOptions } from '../browser/inspect-options.js'
import { browserOpen } from '../browser/open.js'
import { browserScreenshot } from '../browser/screenshot.js'
import { browserSelect } from '../browser/select.js'
import { browserSelectByText } from '../browser/select-by-text.js'
import { browserSetField } from '../browser/set-field.js'
import { browserSnapshot } from '../browser/snapshot.js'
import { browserType } from '../browser/type.js'
import { browserUploadFile } from '../browser/upload-file.js'
import { browserWait } from '../browser/wait.js'
import type { AnswerStore, UserAnswer } from '../context/answer-store.js'
import { isProfileSection, type ProfileStore } from '../context/profile-store.js'
import { createFieldPlanner } from '../fill/field-planner.js'
import type { FieldPlan } from '../fill/field-plan.js'
import type { FillLedgerSummary } from '../fill/fill-ledger.js'
import { observationManager } from '../observation/observation-manager.js'
import { sessionManager } from '../session/manager.js'
import type { HumanInput } from '../sdk/human.js'
import type { LlmGateway } from '../sdk/llm.js'
import type { ToolSchema } from '../sdk/llm.js'
import { scrapeJobList } from '../sdk/alibaba.js'
import { matchJobsCoarse, type JobPosting, type MatchScore } from '../sdk/matcher.js'
import type { ResumeProfile } from '../sdk/resume.js'
import type { RiskLevel, TraceRecorder } from '../sdk/trace.js'
import { pageView } from '../runtime/local/page-view.js'
import { listLocalToolDefs } from './catalog.js'
import type { ToolCategory, ToolDef as CatalogToolDef } from './types.js'

export interface LocalToolContext {
  sessionId: string
  highlight: boolean
  trace: TraceRecorder
  profileStore?: ProfileStore
  answerStore?: AnswerStore
  fieldPlan?: FieldPlan
  fillLedgerSummary?: FillLedgerSummary
  humanInput?: Partial<HumanInput>
  llm?: Pick<LlmGateway, 'hasKey' | 'generateJson'>
  abortSignal?: AbortSignal
}

export interface LocalToolRunResult {
  observation: string
  data?: unknown
  risk?: RiskLevel
  pageChanged?: boolean
  done?: boolean
}

export interface LocalToolDef {
  name: string
  description: string
  category: ToolCategory
  parameters: Record<string, unknown>
  inherentRisk?: RiskLevel
  metadata?: Record<string, unknown>
  resolveRisk?: (args: Record<string, unknown>, ctx: LocalToolContext) => RiskLevel | undefined
  run: (args: Record<string, unknown>, ctx: LocalToolContext) => Promise<LocalToolRunResult>
}

type BrowserToolResult = {
  ok: boolean
  observation: string
  data?: unknown
  error?: { code: string; message: string }
  pageChanged?: boolean
}

type LocalHandler = (args: Record<string, unknown>, ctx: LocalToolContext) => Promise<LocalToolRunResult>

const HIGH_RISK_TEXT = [
  /submit/i,
  /apply/i,
  /application/i,
  /提交/,
  /投递/,
  /申请/,
  /递交/,
  /报名/,
  /send/i,
  /发送/,
  /confirm/i,
  /确认/,
  /pay/i,
  /支付/,
]

const localHandlers: Record<string, LocalHandler> = {
  async browser_open(args, ctx) {
    const r = await browserOpen({ url: String(args.url), waitUntil: args.waitUntil as never, sessionId: ctx.sessionId })
    if (!r.ok) return toResult(r, undefined, false)
    const snap = await browserSnapshot({ sessionId: ctx.sessionId })
    return {
      observation: `${r.observation}\n\n${pageView(snap.ok ? snap.data : undefined)}`,
      data: snap.ok ? snap.data : r.data,
      pageChanged: true,
    }
  },

  async browser_snapshot(args, ctx) {
    const r = await browserSnapshot({ sessionId: ctx.sessionId, maxElements: args.maxElements as number | undefined })
    if (!r.ok) return toResult(r, undefined, false)
    return { observation: pageView(r.data), data: r.data, pageChanged: false }
  },

  async browser_form_snapshot(args, ctx) {
    const r = await browserFormSnapshot({
      sessionId: ctx.sessionId,
      maxFields: args.maxFields as number | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, false)
  },

  async browser_form_audit(args, ctx) {
    const r = await browserFormAudit({
      sessionId: ctx.sessionId,
      maxFields: args.maxFields as number | undefined,
      waitMs: args.waitMs as number | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, false)
  },

  async browser_inspect_options(args, ctx) {
    const r = await browserInspectOptions({
      sessionId: ctx.sessionId,
      ref: args.ref as string | undefined,
      label: args.label as string | undefined,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      maxOptions: args.maxOptions as number | undefined,
      open: args.open as boolean | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, false)
  },

  async resume_query(args, ctx) {
    if (!ctx.profileStore) {
      return {
        observation: 'FAILED (NO_PROFILE_STORE): resume_query is unavailable because no ProfileStore is attached.',
        pageChanged: false,
      }
    }
    const section = args.section
    if (!isProfileSection(section)) {
      return {
        observation: `FAILED (INVALID_SECTION): section must be one of contact, summary, skills, experience, projects, education, targetRoles, all.`,
        pageChanged: false,
      }
    }
    const result = ctx.profileStore.query(section, typeof args.query === 'string' ? args.query : undefined)
    return {
      observation: `resume_query(${section}) returned:\n${JSON.stringify(result.data, null, 2)}`,
      data: result,
      pageChanged: false,
    }
  },

  async job_match_candidates(args, ctx) {
    if (!ctx.profileStore) {
      return {
        observation: 'FAILED (NO_PROFILE_STORE): job_match_candidates requires parsed resume context.',
        pageChanged: false,
      }
    }
    const page = sessionManager.get(ctx.sessionId)?.page
    if (!page) {
      return {
        observation: 'FAILED (NO_PAGE): job_match_candidates requires an active browser page.',
        pageChanged: false,
      }
    }

    const profile = profileFromStore(ctx.profileStore)
    const currentUrl = page.url()
    const maxPages = positiveInt(args.maxPages, 1)
    const maxJobs = positiveInt(args.maxJobs, 50)
    const limit = positiveInt(args.limit, 10)
    const isAlibabaList = /talent-holding\.alibaba\.com\/off-campus\/position-list/i.test(currentUrl)
    const jobs = isAlibabaList
      ? (await scrapeJobList(ctx.sessionId, currentUrl, ctx.trace, { maxPages, maxJobs })).jobs
      : await extractVisibleJobCandidates(ctx.sessionId, maxJobs)

    const matches = matchJobsCoarse(profile, jobs).slice(0, limit)
    const result = {
      schemaVersion: 'job-match-candidates/v1',
      sourceUrl: page.url(),
      scanned: jobs.length,
      returned: matches.length,
      note: 'Candidate discovery only. The autonomous agent must choose any next action; this result does not satisfy completion and does not authorize applying.',
      candidates: matches.map(serializeCandidateMatch),
    }
    ctx.trace.record({
      phase: 'tool:job_match_candidates',
      action: `Ranked ${matches.length}/${jobs.length} job candidates from ${isAlibabaList ? 'Alibaba list' : 'visible page'} without entering application flow.`,
      url: result.sourceUrl,
      status: jobs.length ? 'ok' : 'warn',
      observation: matches.map((match, index) => `${index + 1}. ${match.job.title} — ${match.score.toFixed(2)} — ${match.reason}`).join('\n') || 'No candidates found.',
    })
    return {
      observation: `job_match_candidates returned ${matches.length}/${jobs.length} ranked candidates:\n${JSON.stringify(result, null, 2)}`,
      data: result,
      pageChanged: false,
    }
  },

  async plan_form_fill(args, ctx) {
    if (!ctx.profileStore) {
      return {
        observation: 'FAILED (NO_PROFILE_STORE): plan_form_fill requires a ProfileStore.',
        pageChanged: false,
      }
    }
    let formState = observationManager.getFormState(ctx.sessionId)
    if (!formState) {
      const snapshot = await browserFormSnapshot({ sessionId: ctx.sessionId })
      if (!snapshot.ok) return toResult(snapshot, undefined, false)
      formState = observationManager.getFormState(ctx.sessionId)
    }
    if (!formState) {
      return {
        observation: 'FAILED (NO_FORM_STATE): plan_form_fill could not find or create a FormState.',
        pageChanged: false,
      }
    }
    const refresh = args.refresh !== false
    if (!refresh && ctx.fieldPlan) {
      return {
        observation: `plan_form_fill reused existing FieldPlan with ${ctx.fieldPlan.planned.length} planned fields.`,
        data: ctx.fieldPlan,
        pageChanged: false,
      }
    }
    const planner = createFieldPlanner({ llm: ctx.llm })
    const plan = await planner.plan({
      fields: formState.fields,
      profileStoreAvailable: true,
      answerStoreAvailable: Boolean(ctx.answerStore),
      profileStore: ctx.profileStore,
      answerStore: ctx.answerStore,
      llm: ctx.llm,
      existingPlan: ctx.fieldPlan,
      sourceFormUrl: formState.url,
    })
    ctx.fieldPlan = plan
    return {
      observation: `plan_form_fill created FieldPlan for ${plan.planned.length} fields:\n${JSON.stringify(plan, null, 2)}`,
      data: plan,
      pageChanged: false,
    }
  },

  async ask_user(args, ctx) {
    const field = String(args.field ?? '').trim()
    const question = String(args.question ?? '').trim()
    const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : undefined
    if (!field || !question) {
      return {
        observation: 'FAILED (INVALID_INFO_REQUEST): ask_user requires non-empty field and question.',
        pageChanged: false,
      }
    }

    const existing = ctx.answerStore?.get(field)
    if (existing) {
      return {
        observation: `ask_user reused saved answer for "${field}": ${existing.answer}`,
        data: { userAnswer: existing, reused: true },
        pageChanged: false,
      }
    }

    if (!ctx.humanInput?.requestInfo) {
      return {
        observation: 'FAILED (NO_HUMAN_INPUT): ask_user requires a HumanInput.requestInfo implementation.',
        pageChanged: false,
      }
    }

    const response = await ctx.humanInput.requestInfo({
      field,
      question,
      ...(options?.length ? { options } : {}),
      ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    })
    const answer = response.answer.trim()
    if (!answer) {
      return {
        observation: `FAILED (EMPTY_USER_ANSWER): user did not provide an answer for "${field}".`,
        pageChanged: false,
      }
    }
    const userAnswer: UserAnswer = {
      field,
      question,
      answer,
      at: new Date().toISOString(),
      source: 'ask_user',
      ...(options?.length ? { options } : {}),
    }
    ctx.answerStore?.put(userAnswer)
    return {
      observation: `ask_user received answer for "${field}": ${answer}`,
      data: { userAnswer, reused: false },
      pageChanged: false,
    }
  },

  async browser_click(args, ctx) {
    const r = await browserClick({
      ref: String(args.ref),
      sessionId: ctx.sessionId,
      timeoutMs: args.timeoutMs as number | undefined,
      confirmed: Boolean(args.confirmed),
      highlight: ctx.highlight,
    })
    return toResult(r, undefined, r.ok ? Boolean(r.pageChanged) : false)
  },

  async browser_click_text(args, ctx) {
    const r = await browserClickText({
      text: String(args.text ?? ''),
      sessionId: ctx.sessionId,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
      confirmed: Boolean(args.confirmed),
      highlight: ctx.highlight,
    })
    return toResult(r, r.ok ? r.data : undefined, r.ok ? Boolean(r.pageChanged) : false)
  },

  async browser_type(args, ctx) {
    const r = await browserType({
      ref: String(args.ref),
      text: String(args.text ?? ''),
      sessionId: ctx.sessionId,
      clear: args.clear !== false,
      timeoutMs: args.timeoutMs as number | undefined,
      highlight: ctx.highlight,
      typeDelayMs: args.typeDelayMs as number | undefined,
    })
    return toResult(r, undefined, r.ok)
  },

  async browser_fill_by_label(args, ctx) {
    const r = await browserFillByLabel({
      label: String(args.label ?? ''),
      text: String(args.text ?? ''),
      sessionId: ctx.sessionId,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      clear: args.clear !== false,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, r.ok)
  },

  async browser_select(args, ctx) {
    const r = await browserSelect({
      ref: String(args.ref),
      value: String(args.value),
      sessionId: ctx.sessionId,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, undefined, r.ok)
  },

  async browser_select_by_text(args, ctx) {
    const r = await browserSelectByText({
      option: String(args.option ?? ''),
      label: args.label as string | undefined,
      ref: args.ref as string | undefined,
      sessionId: ctx.sessionId,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      optionNth: args.optionNth as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, r.ok)
  },

  async browser_set_field(args, ctx) {
    const r = await browserSetField({
      field: args.field as never,
      ref: args.ref as string | undefined,
      selector: args.selector as string | undefined,
      label: args.label as string | undefined,
      fieldKey: args.fieldKey as string | undefined,
      fieldIndex: args.fieldIndex as number | undefined,
      controlKind: args.controlKind as never,
      intendedValue: args.intendedValue as never,
      sessionId: ctx.sessionId,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      optionNth: args.optionNth as number | undefined,
      clear: args.clear !== false,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, r.ok)
  },

  async browser_wait(args, ctx) {
    const r = await browserWait({
      sessionId: ctx.sessionId,
      for: args.for as never,
      value: args.value as string | undefined,
      ms: args.ms as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
    })
    return toResult(r, undefined, false)
  },

  async browser_screenshot(args, ctx) {
    const r = await browserScreenshot({
      sessionId: ctx.sessionId,
      label: args.label as string | undefined,
      outDir: args.outDir as string | undefined,
      fullPage: args.fullPage as boolean | undefined,
    })
    return toResult(r, r.ok ? r.data : undefined, false)
  },

  async browser_upload_file(args, ctx) {
    const r = await browserUploadFile({
      filePath: String(args.filePath ?? ''),
      ref: args.ref as string | undefined,
      text: args.text as string | undefined,
      selector: args.selector as string | undefined,
      exact: args.exact as boolean | undefined,
      nth: args.nth as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
      confirmed: Boolean(args.confirmed),
      highlight: ctx.highlight,
      sessionId: ctx.sessionId,
    })
    return toResult(r, r.ok ? r.data : undefined, r.ok ? Boolean(r.pageChanged) : false)
  },

  async agent_done(args) {
    return { observation: `agent_done: ${args.summary}`, done: true, data: { blocked: Boolean(args.blocked) } }
  },
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function profileFromStore(profileStore: ProfileStore): ResumeProfile {
  const all = profileStore.query('all').data as Record<string, unknown>
  const skills = fieldValues(all.skills)
  const keywords = fieldValues(all.keywords)
  const targetRoles = fieldValues(all.targetRoles)
  const contact = all.contact as Record<string, unknown> | undefined
  const summary = all.summary as Record<string, unknown> | undefined
  return {
    name: fieldValue(contact?.name),
    email: fieldValue(contact?.email),
    phone: fieldValue(contact?.phone),
    location: fieldValue(contact?.location),
    summary: fieldValue(summary?.summary),
    skills,
    keywords: [...new Set([...keywords, ...targetRoles])],
    experience: Array.isArray(all.experience) ? all.experience as ResumeProfile['experience'] : fieldArray(all.experience),
    education: Array.isArray(all.education) ? all.education as ResumeProfile['education'] : fieldArray(all.education),
    source: 'json',
  }
}

function fieldArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  const nested = (value as { value?: unknown } | undefined)?.value
  return Array.isArray(nested) ? nested as T[] : []
}

function fieldValues(value: unknown): string[] {
  return fieldArray<unknown>(value)
    .map((item) => typeof item === 'string' ? item : String(item ?? ''))
    .map((item) => item.trim())
    .filter(Boolean)
}

function fieldValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  const nested = (value as { value?: unknown } | undefined)?.value
  return typeof nested === 'string' && nested ? nested : undefined
}

async function extractVisibleJobCandidates(sessionId: string, maxJobs: number): Promise<JobPosting[]> {
  const page = sessionManager.get(sessionId)?.page
  if (!page) return []
  const raw = await page.evaluate((maxJobs) => {
    const clean = (value: string | null | undefined): string => (value || '').replace(/\s+/g, ' ').trim()
    const absolute = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined
      try { return new URL(value, location.href).toString() } catch { return undefined }
    }
    const textOf = (root: Element, selector: string): string => clean(root.querySelector(selector)?.textContent)
    const roots = new Set<Element>()
    for (const selector of [
      '[data-job-card]',
      '[data-position-id]',
      '[data-job-id]',
      'article.job-card',
      '.job-card',
      '.position-card',
      '.position-item',
      '.job-list-item',
      '.job-item',
      'article',
      'a[href*="position-detail"]',
      'a[href*="positionId"]',
    ]) {
      for (const el of Array.from(document.querySelectorAll(selector)).slice(0, maxJobs * 2)) {
        roots.add(el.closest('[data-job-card],[data-position-id],[data-job-id],article.job-card,.job-card,.position-card,.position-item,.job-list-item,.job-item,article') || el)
      }
    }
    return Array.from(roots).slice(0, maxJobs).map((card, index) => {
      const link = card.querySelector<HTMLAnchorElement>('a[href*="position-detail"],a[href*="positionId"],a[href]')
      const title =
        clean(card.getAttribute('data-title')) ||
        textOf(card, '[data-job-title],.job-title,.position-title,h1,h2,h3,h4') ||
        clean(link?.textContent) ||
        clean(card.textContent).split(/\s+更新于|Updated/i)[0] ||
        `job-${index + 1}`
      const category = clean(card.getAttribute('data-category')) || textOf(card, '[data-category],.category')
      const locationText = clean(card.getAttribute('data-location')) || textOf(card, '[data-location],.location')
      const tags = [
        clean(card.getAttribute('data-tags')),
        clean(card.getAttribute('data-job-tags')),
        textOf(card, '[data-job-tags],[data-tags]'),
      ].filter(Boolean).join(' ')
      const detailUrl =
        absolute(card.getAttribute('data-detail-url')) ||
        absolute(link?.getAttribute('href')) ||
        undefined
      return {
        id: clean(card.getAttribute('data-job-id')) || clean(card.getAttribute('data-position-id')) || `visible-${index + 1}`,
        title,
        category: category || undefined,
        location: locationText || undefined,
        detailUrl,
        searchText: [title, category, locationText, tags, clean(card.textContent)].filter(Boolean).join(' '),
        tags: tags.split(/[,\s，、/]+/).map((tag) => tag.trim()).filter(Boolean),
      }
    }).filter((job) => job.title && !/筛选|清除|职位类别/.test(job.title))
  }, maxJobs).catch(() => [])
  return raw.map((job) => ({
    ...job,
    tags: [...new Set([...job.tags, ...tokenizeLocal(job.searchText)])],
  }))
}

function tokenizeLocal(text: string): string[] {
  const lower = text.toLowerCase()
  return [
    ...(lower.match(/[a-z][a-z0-9.+#-]{1,}/g) || []),
    ...(lower.match(/[一-鿿]{2,}/g) || []),
  ].map((token) => token.replace(/[.-]+$/, '')).filter(Boolean)
}

function serializeCandidateMatch(match: MatchScore) {
  return {
    id: match.job.id,
    title: match.job.title,
    score: Number(match.score.toFixed(4)),
    confidence: Number(match.score.toFixed(4)),
    reason: match.reason,
    detailUrl: match.job.detailUrl,
    applicationUrl: match.job.applicationUrl,
    category: match.job.category,
    location: match.job.location,
    updated: match.job.updated,
    matchedSkills: match.matchedSkills,
    missingSkills: match.missingSkills,
    context: match.context,
    tagTaxonomy: match.tagTaxonomy,
  }
}

export function createLocalTools(defs: CatalogToolDef[] = listLocalToolDefs()): LocalToolDef[] {
  return defs.map((def) => {
    const handler = localHandlers[def.name]
    if (!handler) {
      throw new Error(`No local handler registered for ${def.name}`)
    }
    return {
      name: def.name,
      description: def.description,
      category: def.category,
      parameters: stripSessionParameter(def.parameters),
      inherentRisk: def.risk,
      metadata: def.metadata,
      resolveRisk: localRiskResolver(def),
      run: handler,
    }
  })
}

export function toOpenAITools(tools: LocalToolDef[]): ToolSchema[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

function localRiskResolver(def: CatalogToolDef): LocalToolDef['resolveRisk'] | undefined {
  const resolver = def.metadata?.riskResolver
  if (resolver === 'ref') return refRisk
  if (resolver === 'refOrDefault') return (args, ctx) => refRisk(args, ctx) ?? def.risk
  if (resolver === 'text') return textRisk
  return undefined
}

function refRisk(args: Record<string, unknown>, ctx: LocalToolContext): RiskLevel | undefined {
  const ref = String(args.ref ?? '')
  if (!ref) return undefined
  const session = sessionManager.get(ctx.sessionId)
  return session?.latestSnapshot?.refMap.get(ref)?.risk
}

function textRisk(args: Record<string, unknown>): RiskLevel {
  const text = String(args.text ?? '')
  return HIGH_RISK_TEXT.some((pattern) => pattern.test(text)) ? 'L3' : 'L1'
}

function stripSessionParameter(parameters: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>
  const properties = clone.properties as Record<string, unknown> | undefined
  if (properties) delete properties.sessionId
  return clone
}

function toResult(r: BrowserToolResult, data: unknown, pageChanged: boolean): LocalToolRunResult {
  if (r.ok) {
    return { observation: r.observation, data: data ?? r.data, pageChanged }
  }
  return { observation: `FAILED (${r.error?.code}): ${r.error?.message ?? r.observation}`, pageChanged: false }
}
