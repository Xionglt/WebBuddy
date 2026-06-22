import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { browserOpen } from '../browser/open.js'
import { sessionManager } from '../session/manager.js'
import { ToolRegistry } from '../core/tool-registry.js'
import { runAgentLoop } from '../core/agent-loop.js'
import { defaultAuthPath, ensureLogin } from '../core/login.js'
import { loadConfig, hasModelKey, type AgentConfig } from './config.js'
import { fillResumeDraft } from './form-fill.js'
import { AutoHumanGate, CliHumanGate, type HumanGate } from './human.js'
import { LlmGateway } from './llm.js'
import { refineMatchesWithLlm, matchJobs, tokenize, type JobPosting, type MatchScore } from './matcher.js'
import { readResume, writeSampleResumePdf, type ResumeProfile } from './resume.js'
import { attemptApply, scrapeJobDetail, scrapeJobList, waitForAlibabaLoginClear, type ScrapedJob } from './alibaba.js'
import { TraceRecorder, type TraceSummary } from './trace.js'

/**
 * Unified job-application agent. One pipeline, five presets:
 *
 *   fill       — GENERIC: open any site (cookie login) and let the LLM-driven
 *                agent loop fill the application form from the resume. The
 *                headline "give a website + a resume" mode.
 *   match      — Alibaba preset: scrape list + details, match, then hand off
 *                at the application gate (read-only).
 *   raw       — open a target URL and let the LLM drive the browser directly.
 *   alibaba-apply — legacy Alibaba structured flow: scrape + match, enter the
 *                gated application flow, then let the LLM fill the draft.
 *   auto-apply — generic structured job board: open a list URL, pick the best
 *                matching job, open its application form, fill it, and submit
 *                only when the target is localhost/sandbox.
 *   demo-form  — offline mock form; fills via the agent loop (or heuristic
 *                fallback when no model key), gated at submit. Never submits.
 *
 * The LLM agent loop (`core/agent-loop.ts`) is the single filling mechanism —
 * there is no hardcoded field mapping for the generic path.
 */

export type AgentMode = 'raw' | 'fill' | 'match' | 'alibaba-apply' | 'demo-form' | 'auto-apply'

export const DEFAULT_ALIBABA_APPLY_PROMPT =
  '这是我的个人简历文件，然后现在我想去阿里官方招聘网站进行投递，然后请帮我找到适合我的岗位，然后帮我进行投递，填写表单，充分利用网站信息'

export type FinalState =
  | 'resume_parsed'
  | 'no_jobs'
  | 'no_match'
  | 'login_required'
  | 'login_ok'
  | 'filled'
  | 'submitted'
  | 'stopped_at_submit'
  | 'blocked'
  | 'error'

export interface AgentEvent {
  phase: string
  message: string
  level: 'info' | 'warn' | 'gate' | 'think' | 'act' | 'observe' | 'error' | 'done'
}

export interface AgentRunResult {
  mode: AgentMode
  profile: ResumeProfile
  matches: MatchScore[]
  chosenJob?: JobPosting
  finalState: FinalState
  message: string
  summary: TraceSummary
}

export interface RunOptions {
  config?: AgentConfig
  mode?: AgentMode
  /** Target URL for `fill` / `match` (defaults to the Alibaba list for match). */
  startUrl?: string
  gate?: HumanGate
  llm?: LlmGateway
  onEvent?: (event: AgentEvent) => void
  /** Natural-language task prompt for LLM-driven fill modes. */
  taskPrompt?: string
  /** Fixed run id (names the trace dir output/<runId>). Generated if absent. */
  runId?: string
}

function mockApplicationFormUrl(profile: ResumeProfile): string {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>站内简历草稿 (DEMO FORM)</title>
<style>
  body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f7fa;margin:0;padding:32px;color:#1f2329}
  .wrap{max-width:680px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#8a9099;font-size:13px;margin-bottom:24px}
  label{display:block;font-size:13px;color:#4e5969;margin:14px 0 6px}
  input,select{width:100%;padding:9px 12px;border:1px solid #e5e6eb;border-radius:4px;font-size:14px;box-sizing:border-box}
  .row{display:flex;gap:16px} .row>div{flex:1}
  .btns{margin-top:28px;display:flex;gap:12px}
  button{padding:9px 20px;border-radius:4px;border:none;font-size:14px;cursor:pointer}
  .save{background:#fff;border:1px solid #1677ff;color:#1677ff}
  .submit{background:#1677ff;color:#fff}
</style></head><body><div class="wrap">
<h1>站内简历草稿</h1>
<div class="sub">DEMO FORM — local mock. Filling this never contacts a real site.</div>
<div class="row">
  <div><label for="name">姓名 Name</label><input id="name" name="name" type="text" placeholder="请输入姓名" /></div>
  <div><label for="phone">手机 Phone</label><input id="phone" name="phone" type="tel" placeholder="请输入手机号" /></div>
</div>
<div class="row">
  <div><label for="email">邮箱 Email</label><input id="email" name="email" type="email" placeholder="请输入邮箱" /></div>
  <div><label for="city">期望城市 City</label><input id="city" name="city" type="text" placeholder="请输入城市" /></div>
</div>
<label for="summary">个人简介 Summary</label><textarea id="summary" name="summary" rows="3" placeholder="一句话介绍"></textarea>
<div class="btns">
  <button class="save" type="button">保存草稿 Save draft</button>
  <button class="submit" type="submit">投递申请 Submit application</button>
</div>
<div class="note" style="margin-top:16px;font-size:12px;color:#86909c">本页是本地 mock，${profile.name || '候选人'} 信息仅用于演示可视化填写。</div>
</div></body></html>`
  return `data:text/html,${encodeURIComponent(html)}`
}

function applyBrowserEnv(config: AgentConfig): void {
  const env = process.env
  if (env.PLAYWRIGHT_HEADLESS === undefined) {
    env.PLAYWRIGHT_HEADLESS = config.browser.headless ? 'true' : 'false'
  }
  if (config.browser.slowMoMs > 0 && !env.PLAYWRIGHT_SLOWMO_MS) env.PLAYWRIGHT_SLOWMO_MS = String(config.browser.slowMoMs)
  if (config.browser.typeDelayMs > 0 && !env.PLAYWRIGHT_TYPE_DELAY_MS) env.PLAYWRIGHT_TYPE_DELAY_MS = String(config.browser.typeDelayMs)
  if (!env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS) env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS = String(config.browser.navigationTimeoutMs)
  if (!env.PLAYWRIGHT_ACTION_TIMEOUT_MS) env.PLAYWRIGHT_ACTION_TIMEOUT_MS = String(config.browser.actionTimeoutMs)
  if (!env.PLAYWRIGHT_VIEWPORT_WIDTH) env.PLAYWRIGHT_VIEWPORT_WIDTH = String(config.browser.viewport.width)
  if (!env.PLAYWRIGHT_VIEWPORT_HEIGHT) env.PLAYWRIGHT_VIEWPORT_HEIGHT = String(config.browser.viewport.height)
  if (!env.PLAYWRIGHT_USER_AGENT) env.PLAYWRIGHT_USER_AGENT = config.browser.userAgent
  if (config.browser.blockLocalhost === false) env.PLAYWRIGHT_BLOCK_LOCALHOST = 'false'
  if (config.browser.allowedDomains.length > 0) env.PLAYWRIGHT_ALLOWED_DOMAINS = config.browser.allowedDomains.join(',')
  if (config.auth.storageStatePath) env.PLAYWRIGHT_STORAGE_STATE = config.auth.storageStatePath
}

async function ensureResume(config: AgentConfig, trace: TraceRecorder, emit: (e: AgentEvent) => void): Promise<ResumeProfile> {
  const path = config.resumePath
  if (!existsSync(path)) {
    emit({ phase: 'parse_resume', message: `Resume not found at ${path}; generating sample resume PDF.`, level: 'warn' })
    writeSampleResumePdf(path)
    trace.record({ phase: 'parse_resume', action: 'Generated sample resume PDF (none provided).', status: 'warn' })
  }
  const profile = await readResume(path)
  if (!profile) throw new Error(`Could not read resume from ${path}`)
  trace.record({
    phase: 'parse_resume',
    action: `Parsed resume: ${profile.name || 'unknown'} — ${profile.skills.length} skills.`,
    status: 'ok',
    observation: `skills: ${profile.skills.slice(0, 10).join(', ')}`,
  })
  emit({ phase: 'parse_resume', message: `Resume → ${profile.name || 'unknown'} | ${profile.email || 'no email'} | ${profile.skills.length} skills`, level: 'info' })
  return profile
}

export async function runJobApplicationAgent(options: RunOptions = {}): Promise<AgentRunResult> {
  const config = options.config ?? loadConfig()
  const mode: AgentMode = options.mode ?? 'fill'
  const emit = options.onEvent ?? ((_e: AgentEvent) => {})
  const gate: HumanGate = options.gate ?? (config.human.mode === 'auto' ? new AutoHumanGate(undefined, { allowLocalFinalSubmit: mode === 'auto-apply' }) : new CliHumanGate())
  const llm = options.llm ?? new LlmGateway(config.model)
  const highlight = config.browser.visualHighlight

  applyBrowserEnv(config)
  if (mode === 'demo-form') process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'

  const trace = new TraceRecorder(config.trace.outDir, options.runId)
  const sessionId = 'default'
  trace.record({ phase: 'boot', action: `Agent start (mode=${mode}, headless=${config.browser.headless}, llm=${hasModelKey(config)})`, status: 'ok' })

  try {
    const profile = await ensureResume(config, trace, emit)
    if ((mode === 'alibaba-apply' || mode === 'raw') && !llm.hasKey) {
      return finalize({
        mode,
        profile,
        matches: [],
        finalState: 'blocked',
        message: `${mode} requires a model key because it relies on LLM tool-calling to use page/job information.`,
        trace,
        emit,
      })
    }

    // --- mode-specific "open the target" pre-step -------------------------
    let chosenJob: JobPosting | undefined
    let matches: MatchScore[] = []
    let extraContext: string | undefined
    let startUrl = options.startUrl

    if (mode === 'raw') {
      startUrl = startUrl ?? config.alibabaCareersUrl
      const open = await browserOpen({ url: startUrl, sessionId, waitUntil: 'domcontentloaded' })
      if (!open.ok) throw new Error(open.error.message)
      trace.record({
        phase: 'open_target',
        action: `Opened raw-agent target: ${startUrl}`,
        url: sessionManager.get(sessionId)?.page.url(),
        status: 'ok',
        screenshotPath: await trace.screenshot(sessionManager.get(sessionId)?.page, 'raw-target'),
      })
      emit({ phase: 'open_target', message: `Opened raw-agent target: ${startUrl}`, level: 'info' })
    } else if (mode === 'demo-form') {
      const url = mockApplicationFormUrl(profile)
      const open = await browserOpen({ url, sessionId, waitUntil: 'domcontentloaded' })
      if (!open.ok) throw new Error(open.error.message)
      trace.record({ phase: 'open_form', action: 'Opened local DEMO application form.', url, status: 'ok', screenshotPath: await trace.screenshot(sessionManager.get(sessionId)?.page, 'demo-form-open') })
      emit({ phase: 'open_form', message: 'Opened local DEMO application form (offline, safe).', level: 'info' })
    } else if (mode === 'auto-apply') {
      if (!startUrl) throw new Error('auto-apply requires a target job-list URL.')
      const open = await browserOpen({ url: startUrl, sessionId, waitUntil: 'domcontentloaded' })
      if (!open.ok) throw new Error(open.error.message)
      trace.record({ phase: 'open_jobs', action: `Opened job list: ${startUrl}`, url: sessionManager.get(sessionId)?.page.url(), status: 'ok', screenshotPath: await trace.screenshot(sessionManager.get(sessionId)?.page, 'job-list') })
      emit({ phase: 'open_jobs', message: `Opened job list: ${startUrl}`, level: 'info' })

      const jobs = await scrapeStructuredJobList(sessionId)
      if (jobs.length === 0) {
        return finalize({ mode, profile, matches: [], finalState: 'no_jobs', message: 'No structured job cards found on the target page.', trace, emit })
      }
      matches = matchJobs(profile, jobs)
      const best = matches[0]
      if (!best || best.score <= 0) {
        return finalize({ mode, profile, matches, finalState: 'no_match', message: 'No suitable match found on the target page.', trace, emit })
      }
      chosenJob = best.job
      extraContext = `Matched job: ${best.job.title}. Match score: ${best.score.toFixed(2)}. ${best.reason}`
      trace.record({ phase: 'match', action: `Best match: ${best.job.title} (score ${best.score.toFixed(2)}).`, status: 'ok', observation: best.reason })
      emit({ phase: 'match', message: `Best match → ${best.job.title} (score ${best.score.toFixed(2)})`, level: 'info' })
      matches.slice(0, 5).forEach((m, i) => emit({ phase: 'match', message: `  ${i + 1}. ${m.job.title} — ${m.score.toFixed(2)} — ${m.matchedSkills.slice(0, 5).join(', ')}`, level: 'info' }))

      const applyUrl = best.job.applicationUrl || best.job.detailUrl
      if (!applyUrl) throw new Error(`Matched job "${best.job.title}" has no application URL.`)
      const openApply = await browserOpen({ url: applyUrl, sessionId, waitUntil: 'domcontentloaded' })
      if (!openApply.ok) throw new Error(openApply.error.message)
      trace.record({ phase: 'open_form', action: `Opened application form for ${best.job.title}.`, url: sessionManager.get(sessionId)?.page.url(), risk: isLocalUrl(applyUrl) ? 'L1' : 'L3', status: 'ok', screenshotPath: await trace.screenshot(sessionManager.get(sessionId)?.page, 'application-form') })
      emit({ phase: 'open_form', message: `Opened application form for ${best.job.title}.`, level: 'info' })
    } else if (mode === 'alibaba-apply') {
      const listUrl = startUrl ?? config.alibabaCareersUrl
      const { jobs } = await scrapeJobList(sessionId, listUrl, trace)
      if (jobs.length === 0) {
        return finalize({ mode, profile, matches: [], finalState: 'no_jobs', message: 'No jobs found on the Alibaba list page.', trace, emit })
      }

      emit({ phase: 'scrape_list', message: `Scraped ${jobs.length} Alibaba jobs. Opening top ${Math.min(config.maxJobsToDetail, jobs.length)} for detail…`, level: 'info' })
      const preRanked = matchJobs(profile, jobs).slice(0, config.maxJobsToDetail)
      const detailed: ScrapedJob[] = []
      for (const m of preRanked) {
        try { detailed.push((await scrapeJobDetail(sessionId, m.job as ScrapedJob, trace)).job) }
        catch (error) { trace.record({ phase: 'scrape_detail', action: `Detail failed: ${(error as Error).message}`, status: 'warn' }) }
      }

      const pool = detailed.length > 0 ? detailed : jobs
      matches = matchJobs(profile, pool)
      matches = await refineMatchesWithLlm(matches, profile, llm)
      const best = matches[0]
      if (!best || best.score <= 0) {
        return finalize({ mode, profile, matches, finalState: 'no_match', message: 'No suitable Alibaba job match found.', trace, emit })
      }

      chosenJob = best.job
      extraContext = [
        `Matched Alibaba job: ${best.job.title} (${best.job.category || 'unknown category'}).`,
        best.job.location ? `Location: ${best.job.location}.` : '',
        best.job.detailUrl ? `Detail URL: ${best.job.detailUrl}.` : '',
        `Match score: ${best.score.toFixed(2)}. ${best.reason}`,
        'Use the current Alibaba page and any visible job/application information to fill only fields that can be mapped confidently from the resume.',
      ].filter(Boolean).join('\n')
      trace.record({ phase: 'match', action: `Best Alibaba match: ${best.job.title} (score ${best.score.toFixed(2)}).`, status: best.score <= 0 ? 'warn' : 'ok', observation: best.reason })
      emit({ phase: 'match', message: `Best match → ${best.job.title} (score ${best.score.toFixed(2)})`, level: best.score <= 0 ? 'warn' : 'info' })
      matches.slice(0, 5).forEach((m, i) => emit({ phase: 'match', message: `  ${i + 1}. ${m.job.title} — ${m.score.toFixed(2)} — ${m.matchedSkills.slice(0, 5).join(', ')}`, level: 'info' }))

      const apply = await attemptApply(sessionId, best.job as ScrapedJob, gate, trace)
      if (apply.gateDecision !== 'approve') {
        return finalize({
          mode,
          profile,
          matches,
          chosenJob,
          finalState: 'blocked',
          message: `Matched "${best.job.title}", but entering the Alibaba application flow was handed off (${apply.gateDecision}).`,
          trace,
          emit,
        })
      }

      if (apply.reachedLogin) {
        emit({ phase: 'login', message: 'Alibaba login/captcha wall reached. Waiting for human login hand-off.', level: 'gate' })
        let loginCleared = false
        for (let attempt = 1; attempt <= 3 && !loginCleared; attempt += 1) {
          const decision = await gate.confirm(
            'login',
            attempt === 1
              ? 'Please log in to Alibaba in the visible browser window (and solve any captcha), then approve to continue filling.'
              : 'Alibaba is still showing the login page. Please finish the SMS/captcha login in the browser, wait for the job/application page to load, then approve again.',
            { url: apply.page.url(), risk: 'L4' },
          )
          trace.record({
            phase: 'login',
            action: `Alibaba login hand-off attempt ${attempt} → ${decision}.`,
            url: apply.page.url(),
            risk: 'L4',
            status: decision === 'approve' ? 'ok' : 'blocked',
          })
          if (decision !== 'approve') {
            return finalize({ mode, profile, matches, chosenJob, finalState: 'login_required', message: `Matched "${best.job.title}" but stopped at Alibaba login/captcha hand-off.`, trace, emit })
          }

          await apply.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
          loginCleared = await waitForAlibabaLoginClear(apply.page, 30000)
          trace.record({
            phase: 'login',
            action: loginCleared ? 'Alibaba login page cleared.' : `Still on Alibaba login page after attempt ${attempt}.`,
            url: apply.page.url(),
            risk: 'L4',
            status: loginCleared ? 'ok' : 'blocked',
          })
        }
        if (!loginCleared) {
          return finalize({ mode, profile, matches, chosenJob, finalState: 'login_required', message: `Matched "${best.job.title}" but Alibaba login did not complete after repeated hand-offs.`, trace, emit })
        }

        sessionManager.adoptPage(sessionId, apply.page)
        const authPath = config.auth.storageStatePath || defaultAuthPath(listUrl, config.trace.outDir)
        try {
          mkdirSync(dirname(authPath), { recursive: true })
          await sessionManager.saveAuth(sessionId, authPath)
          trace.record({ phase: 'login', action: `Saved Alibaba cookies to ${authPath}.`, status: 'ok' })
        } catch (error) {
          trace.record({ phase: 'login', action: `Failed to save Alibaba cookies: ${(error as Error).message}`, status: 'warn' })
        }
      } else if (apply.reachedForm) {
        emit({ phase: 'open_form', message: 'Alibaba application form reached; starting LLM fill.', level: 'info' })
      } else {
        emit({ phase: 'open_form', message: 'Alibaba application-flow state is unclear; the LLM will inspect the current page.', level: 'warn' })
      }
    } else if (mode === 'match') {
      const listUrl = startUrl ?? config.alibabaCareersUrl
      const { jobs } = await scrapeJobList(sessionId, listUrl, trace)
      if (jobs.length === 0) {
        return finalize({ mode, profile, matches: [], finalState: 'no_jobs', message: 'No jobs found on the list page.', trace, emit })
      }
      emit({ phase: 'scrape_list', message: `Scraped ${jobs.length} jobs. Opening top ${Math.min(config.maxJobsToDetail, jobs.length)} for detail…`, level: 'info' })
      const preRanked = matchJobs(profile, jobs).slice(0, config.maxJobsToDetail)
      const detailed: ScrapedJob[] = []
      for (const m of preRanked) {
        try { detailed.push((await scrapeJobDetail(sessionId, m.job as ScrapedJob, trace)).job) }
        catch (error) { trace.record({ phase: 'scrape_detail', action: `Detail failed: ${(error as Error).message}`, status: 'warn' }) }
      }
      const pool = detailed.length > 0 ? detailed : jobs
      matches = matchJobs(profile, pool)
      if (llm.hasKey) matches = await refineMatchesWithLlm(matches, profile, llm)
      const best = matches[0]
      if (!best) return finalize({ mode, profile, matches, finalState: 'no_match', message: 'No suitable match found.', trace, emit })
      chosenJob = best.job
      extraContext = `Matched job: ${best.job.title} (${best.job.category || ''}). Match score: ${best.score.toFixed(2)}. ${best.reason}`
      trace.record({ phase: 'match', action: `Best match: ${best.job.title} (score ${best.score.toFixed(2)}).`, status: best.score <= 0 ? 'warn' : 'ok', observation: best.reason })
      emit({ phase: 'match', message: `Best match → ${best.job.title} (score ${best.score.toFixed(2)})`, level: best.score <= 0 ? 'warn' : 'info' })
      matches.slice(0, 5).forEach((m, i) => emit({ phase: 'match', message: `  ${i + 1}. ${m.job.title} — ${m.score.toFixed(2)} — ${m.matchedSkills.slice(0, 5).join(', ')}`, level: 'info' }))
      // match mode is read-only: hand off at the gate (no navigation into apply).
      const decision = await gate.confirm('final_submit', `Enter Alibaba's application flow for "${best.job.title}"?`, { url: best.job.detailUrl })
      trace.record({ phase: 'apply', action: `Apply hand-off (match mode): ${decision}`, url: best.job.detailUrl, risk: 'L3', status: 'blocked' })
      return finalize({ mode, profile, matches, chosenJob, finalState: 'login_required', message: `Matched "${best.job.title}". Application flow handed to human (gate: ${decision}).`, trace, emit })
    } else {
      // mode === 'fill' : generic. Requires a target URL.
      startUrl = startUrl ?? config.alibabaCareersUrl
      emit({ phase: 'login', message: `Establishing session for ${startUrl} (cookie login ${hasModelKey(config) ? '' : ''})…`, level: 'info' })
      const authPath = config.auth.storageStatePath || defaultAuthPath(startUrl, config.trace.outDir)
      const login = await ensureLogin({
        sessionId, url: startUrl, storageStatePath: authPath, gate, trace,
        interactive: config.human.mode === 'cli',
      })
      if (!login.loggedIn) {
        emit({ phase: 'login', message: 'Not logged in — agent will attempt the form but may hit a login wall.', level: 'warn' })
      } else {
        emit({ phase: 'login', message: login.usedSavedCookies ? 'Logged in via saved cookies.' : 'Logged in.', level: 'info' })
      }
    }

    // --- fill the form -----------------------------------------------------
    if (mode === 'auto-apply') {
      const currentUrl = sessionManager.get(sessionId)?.page.url()
      const allowFinalSubmit = isLocalUrl(currentUrl)
      emit({
        phase: 'agent',
        message: allowFinalSubmit
          ? 'Using deterministic local/sandbox fill and final submit.'
          : 'Using deterministic fill; external final submit will stop at the human gate.',
        level: allowFinalSubmit ? 'info' : 'warn',
      })
      const fill = await fillResumeDraft(sessionId, profile, gate, trace, highlight, { allowFinalSubmit })
      await captureFinalScreenshot(sessionId, trace)
      const finalState: FinalState =
        fill.stoppedAt === 'submitted' ? 'submitted'
          : fill.stoppedAt === 'submit' || fill.stoppedAt === 'save' ? 'stopped_at_submit'
            : fill.stoppedAt === 'no_fields' ? 'blocked'
              : 'filled'
      const message =
        fill.stoppedAt === 'submitted'
          ? `Applied to "${chosenJob?.title || 'matched job'}" on the local/sandbox site.`
          : `Filled "${chosenJob?.title || 'matched job'}" but stopped at "${fill.stoppedAt}".`
      return finalize({ mode, profile, matches, chosenJob, finalState, message, trace, emit })
    }

    const useLlm = llm.hasKey
    if (useLlm) {
      const goal =
        mode === 'raw'
          ? options.taskPrompt || DEFAULT_ALIBABA_APPLY_PROMPT
          : mode === 'demo-form'
          ? 'Fill this application form using my resume. Fill name/phone/email/city/summary. Do NOT click submit. Call agent_done when the draft is filled.'
          : mode === 'alibaba-apply'
            ? options.taskPrompt || DEFAULT_ALIBABA_APPLY_PROMPT
          : 'Fill the application form on the current page using my resume. Map resume fields to the matching form inputs. Do NOT click any submit/投递 button. If you hit a login wall or captcha, call agent_done with blocked=true.'
      const loopResult = await runAgentLoop({
        goal, resume: profile, llm,
        registry: new ToolRegistry(),
        ctx: { sessionId, highlight, trace },
        gate, extraContext,
        safetyMode: mode === 'raw' ? 'raw' : 'guarded',
        maxSteps: config.agent.maxSteps,
        onEvent: (e) => emit({ phase: 'agent', level: e.level, message: e.message }),
      })
      await captureFinalScreenshot(sessionId, trace)
      const finalState: FinalState = loopResult.blocked
        ? (loopResult.summary.toLowerCase().includes('submit') ? 'stopped_at_submit' : 'blocked')
        : 'filled'
      return finalize({
        mode, profile, matches, chosenJob, finalState,
        message: loopResult.summary + (loopResult.blocked ? ' (stopped)' : ' (draft filled — not submitted)'),
        trace, emit,
      })
    }

    // Heuristic fallback (no model key): only works on simple known-label forms.
    emit({ phase: 'agent', message: 'No model key — using heuristic field matcher (name/email/phone only).', level: 'warn' })
    const fill = await fillResumeDraft(sessionId, profile, gate, trace, highlight)
    await captureFinalScreenshot(sessionId, trace)
    const finalState: FinalState =
      fill.stoppedAt === 'submit' ? 'stopped_at_submit'
        : fill.stoppedAt === 'save' ? 'stopped_at_submit'
          : 'filled'
    return finalize({ mode, profile, matches, chosenJob, finalState, message: `Heuristic fill stopped at "${fill.stoppedAt}" — not submitted.`, trace, emit })
  } catch (error) {
    trace.record({ phase: 'fatal', action: `Agent error: ${(error as Error).message}`, status: 'error' })
    emit({ phase: 'fatal', message: (error as Error).message, level: 'error' })
    return finalize({ mode, profile: { skills: [], experience: [], education: [], keywords: [], source: 'json' }, matches: [], finalState: 'error', message: (error as Error).message, trace, emit })
  } finally {
    if (gate instanceof CliHumanGate) gate.close()
  }
}

async function scrapeStructuredJobList(sessionId: string): Promise<JobPosting[]> {
  const page = sessionManager.get(sessionId)?.page
  if (!page) return []
  const raw = await page.evaluate(() => {
    const absolute = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined
      try { return new URL(value, location.href).toString() } catch { return undefined }
    }
    const textOf = (root: Element, selector: string): string =>
      root.querySelector(selector)?.textContent?.trim() || ''
    const cards = Array.from(document.querySelectorAll('[data-job-card], article.job-card, .job-card'))
    return cards.map((card, index) => {
      const link = card.querySelector<HTMLAnchorElement>('a[href]')
      const tags =
        card.getAttribute('data-tags') ||
        card.getAttribute('data-job-tags') ||
        textOf(card, '[data-job-tags]') ||
        ''
      const title =
        card.getAttribute('data-title') ||
        textOf(card, '[data-job-title]') ||
        textOf(card, 'h1,h2,h3') ||
        link?.textContent?.trim() ||
        `job-${index + 1}`
      const detailUrl =
        absolute(card.getAttribute('data-detail-url')) ||
        absolute(link?.getAttribute('href')) ||
        absolute(card.getAttribute('data-apply-url'))
      const applicationUrl =
        absolute(card.getAttribute('data-apply-url')) ||
        absolute(card.querySelector<HTMLAnchorElement>('[data-apply-link]')?.getAttribute('href'))
      return {
        id: card.getAttribute('data-job-id') || `job-${index + 1}`,
        title,
        category: card.getAttribute('data-category') || textOf(card, '[data-category]') || undefined,
        location: card.getAttribute('data-location') || textOf(card, '[data-location]') || undefined,
        detailUrl,
        applicationUrl,
        searchText: [title, tags, card.textContent || ''].join(' '),
        tags,
      }
    })
  })
  return raw
    .filter((job) => job.title && (job.detailUrl || job.applicationUrl))
    .map((job) => ({
      ...job,
      tags: [...new Set([...String(job.tags || '').split(/[,\s，、]+/).filter(Boolean), ...tokenize(job.searchText)])],
    }))
}

function isLocalUrl(url?: string): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/** Capture a screenshot of the final page state so the UI shows the filled form. */
async function captureFinalScreenshot(sessionId: string, trace: TraceRecorder): Promise<void> {
  const page = sessionManager.get(sessionId)?.page
  if (!page) return
  const path = await trace.screenshot(page, 'final')
  trace.record({ phase: 'fill_draft', action: 'Captured final page state.', status: 'ok', screenshotPath: path })
}

function finalize(args: {
  mode: AgentMode
  profile: ResumeProfile
  matches: MatchScore[]
  chosenJob?: JobPosting
  finalState: FinalState
  message: string
  trace: TraceRecorder
  emit: (e: AgentEvent) => void
}): AgentRunResult {
  const summary = args.trace.finish()
  args.emit({ phase: 'done', message: `${args.message} (trace: ${summary.tracePath})`, level: 'done' })
  return { mode: args.mode, profile: args.profile, matches: args.matches, chosenJob: args.chosenJob, finalState: args.finalState, message: args.message, summary }
}

// Re-exports for SDK consumers.
export { matchJobs, type JobPosting, type MatchScore } from './matcher.js'
export { readResume, writeSampleResumePdf, type ResumeProfile } from './resume.js'
export { LlmGateway } from './llm.js'
export { CliHumanGate, AutoHumanGate, ScriptedHumanGate, type HumanGate } from './human.js'
export { TraceRecorder } from './trace.js'
export { loadConfig, type AgentConfig } from './config.js'
export { ToolRegistry } from '../core/tool-registry.js'
export { runAgentLoop } from '../core/agent-loop.js'
