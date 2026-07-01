import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { browserFormSnapshot } from '../browser/form-snapshot.js'
import { browserOpen } from '../browser/open.js'
import { browserSnapshot } from '../browser/snapshot.js'
import { sessionManager } from '../session/manager.js'
import { ToolRegistry } from '../runtime/local/tool-registry.js'
import { runAgentLoop } from '../runtime/local/agent-loop.js'
import { defaultAuthPath, ensureLogin } from '../runtime/local/login.js'
import { loadConfig, hasModelKey, type AgentConfig } from './config.js'
import { fillResumeDraft } from './form-fill.js'
import { AutoHumanGate, CliHumanGate, type HumanGate } from './human.js'
import { LlmGateway } from './llm.js'
import {
  DEFAULT_MATCH_THRESHOLD,
  decideMatchThreshold,
  matchJobsCoarse,
  refineMatchesWithLlm,
  matchJobs,
  tokenize,
  type JobPosting,
  type MatchScore,
  type MatchThresholdDecision,
} from './matcher.js'
import {
  ingestResume,
  readResume,
  resumeV2ToLegacyProfile,
  writeSampleResumePdf,
  type ResumeProfile,
  type ResumeProfileV2,
} from './resume.js'
import { attemptApply, scrapeJobDetail, scrapeJobList, waitForAlibabaLoginClear, type ScrapedJob } from './alibaba.js'
import { TraceRecorder, type TraceSummary } from './trace.js'
import type { RunSource } from '../metrics/trace-inputs.js'
import { detectDirectSubmitReview, type DirectSubmitReview } from '../workflow/direct-submit.js'
import {
  FileSessionRecorder,
  FileSessionStore,
  type AgentSession,
  type AgentSessionSource,
  type AgentSessionStatus,
  type SessionRecorder,
} from '../session/index.js'

/**
 * Unified local Web Agent orchestrator. One pipeline, plus safe demos:
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
 *   demo-research — offline read-only research page; observes, summarizes, and
 *                writes trace/metrics without login, form fill, or submit.
 *
 * The local LLM agent loop (`runtime/local/agent-loop.ts`) is the single filling mechanism —
 * there is no hardcoded field mapping for the generic path.
 */

export type AgentMode = 'raw' | 'fill' | 'match' | 'alibaba-apply' | 'demo-form' | 'demo-research' | 'auto-apply'

export const DEFAULT_ALIBABA_APPLY_PROMPT =
  '这是我的个人简历文件，然后现在我想去阿里官方招聘网站进行投递，然后请帮我找到适合我的岗位，然后帮我进行投递，填写表单，充分利用网站信息'

export type FinalState =
  | 'completed'
  | 'resume_parsed'
  | 'no_jobs'
  | 'no_match'
  | 'login_required'
  | 'login_ok'
  | 'filled'
  | 'submitted'
  | 'stopped_at_submit'
  | 'direct_submit_review'
  | 'blocked'
  | 'error'

export interface AgentEvent {
  phase: string
  message: string
  level: 'info' | 'warn' | 'gate' | 'think' | 'risk' | 'decision' | 'act' | 'observe' | 'error' | 'done'
}

export interface AgentRunResult {
  mode: AgentMode
  profile: ResumeProfile
  matches: MatchScore[]
  chosenJob?: JobPosting
  finalState: FinalState
  message: string
  summary: TraceSummary
  session?: AgentSession
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
  /** Observation source written to run-manifest, metrics, and agent-state. */
  source?: RunSource
  /** Runtime profile label for metrics comparison. */
  profile?: string
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

function researchBriefingUrl(): string {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Atlas Help Center Research Fixture</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f8fb;margin:0;color:#1f2937}
  header{background:#fff;border-bottom:1px solid #e5e7eb;padding:28px 40px}
  main{max-width:960px;margin:0 auto;padding:28px 24px 48px}
  h1{font-size:28px;margin:0 0 8px} h2{font-size:18px;margin:28px 0 12px}
  .sub{color:#6b7280;max-width:720px;line-height:1.5}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb}
  th,td{text-align:left;border-bottom:1px solid #eef0f3;padding:10px 12px;font-size:14px}
  th{background:#f3f4f6;color:#374151}
  details{background:#fff;border:1px solid #e5e7eb;border-radius:8px;margin:8px 0;padding:12px 14px}
  summary{cursor:pointer;font-weight:600}
</style></head><body>
<header>
  <h1>Atlas Help Center</h1>
  <div class="sub">A local read-only fixture for testing web research. It contains product facts, pricing, limits, and FAQ answers without using a live account or external network.</div>
</header>
<main>
  <section aria-labelledby="overview">
    <h2 id="overview">Product Overview</h2>
    <div class="grid">
      <article class="card"><strong>Audience</strong><p>Small operations teams that need auditable browser automation.</p></article>
      <article class="card"><strong>Core promise</strong><p>Read pages, understand forms, and stop before sensitive actions.</p></article>
      <article class="card"><strong>Safety</strong><p>Login, captcha, upload, payment, and final submit require human handoff.</p></article>
    </div>
  </section>
  <section aria-labelledby="plans">
    <h2 id="plans">Plans And Limits</h2>
    <table>
      <thead><tr><th>Plan</th><th>Monthly runs</th><th>Trace retention</th><th>Best for</th></tr></thead>
      <tbody>
        <tr><td>Starter</td><td>100</td><td>7 days</td><td>Local evaluation</td></tr>
        <tr><td>Team</td><td>1,000</td><td>30 days</td><td>Shared review workflows</td></tr>
        <tr><td>Audit</td><td>5,000</td><td>180 days</td><td>Regulated browser tasks</td></tr>
      </tbody>
    </table>
  </section>
  <section aria-labelledby="faq">
    <h2 id="faq">FAQ</h2>
    <details open><summary>Does Atlas auto-submit forms?</summary><p>No. Final submit is a sensitive action and remains behind a human gate.</p></details>
    <details><summary>Can it solve captchas?</summary><p>No. Captchas are treated as human verification and require handoff.</p></details>
    <details><summary>What does a run produce?</summary><p>Each run writes a trace, screenshots, metrics, agent state, and optional safety report.</p></details>
  </section>
</main></body></html>`
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

async function ensureResume(
  config: AgentConfig,
  trace: TraceRecorder,
  emit: (e: AgentEvent) => void,
  llm?: LlmGateway,
): Promise<ResumeProfile> {
  const path = config.resumePath
  if (!existsSync(path)) {
    emit({ phase: 'parse_resume', message: `Resume not found at ${path}; generating sample resume PDF.`, level: 'warn' })
    writeSampleResumePdf(path)
    trace.record({ phase: 'parse_resume', action: 'Generated sample resume PDF (none provided).', status: 'warn' })
  }

  let profileV2: ResumeProfileV2 | null
  let usedLegacyFallback = false
  const legacyWarnings: string[] = []
  try {
    profileV2 = await ingestResume(path, { llm })
  } catch (error) {
    legacyWarnings.push(`Resume V2 ingestion failed: ${error instanceof Error ? error.message : String(error)}`)
    profileV2 = null
  }

  if (!profileV2) {
    usedLegacyFallback = true
    emit({ phase: 'parse_resume', message: `V2 resume parse failed for ${path}; fallback to legacy parser.`, level: 'warn' })
    const legacyProfile = await readResume(path)
    if (!legacyProfile) throw new Error(`Could not read resume from ${path}`)
    const legacySource = legacySourceToV2Type(legacyProfile.source)
    profileV2 = legacyProfileToResumeV2Fallback(legacyProfile, {
      path,
      type: legacySource,
      extractionWarnings: legacyWarnings,
      parser: 'heuristic',
    })
  }

  const legacyProfile = resumeV2ToLegacyProfile(profileV2)
  const parseStatus: 'ok' | 'warn' = usedLegacyFallback || legacyWarnings.length > 0 ? 'warn' : 'ok'
  writeResumeProfileV2Artifact(trace, profileV2)

  trace.record({
    phase: 'parse_resume',
    action:
      `Parsed resume via ${profileV2?.source.parser ?? 'legacy-fallback'}: ${legacyProfile.name || 'unknown'} — ` +
      `${legacyProfile.skills.length} skills.`,
    status: parseStatus,
    observation: `skills=${legacyProfile.skills.slice(0, 10).join(', ')}`,
  })

  emit({
    phase: 'parse_resume',
    message: `Resume → ${legacyProfile.name || 'unknown'} | ${legacyProfile.email || 'no email'} | ${legacyProfile.skills.length} skills`,
    level: parseStatus === 'ok' ? 'info' : 'warn',
  })

  return legacyProfile
}

function legacySourceToV2Type(source: ResumeProfile['source']): ResumeProfileV2['source']['type'] {
  if (source === 'json') return 'json'
  if (source === 'txt') return 'txt'
  return 'pdf-text'
}

function legacyProfileToResumeV2Fallback(
  profile: ResumeProfile,
  metadata: {
    path: string
    type: ResumeProfileV2['source']['type']
    extractionWarnings: string[]
    parser: ResumeProfileV2['source']['parser']
  },
): ResumeProfileV2 {
  const targetRoles = [...new Set(profile.experience.map((experience) => experience.title).filter(Boolean))] as string[]
  const seniority = profile.experience.some((experience) => /senior|lead|principal|architect/i.test(experience.title || ''))
    ? 'senior'
    : profile.experience.length
      ? 'mid'
      : undefined

  return {
    schemaVersion: 'resume-profile/v2',
    name: profile.name ? { value: profile.name, confidence: 0.7, evidence: 'Legacy parser fallback: name field.' } : undefined,
    email: profile.email ? { value: profile.email, confidence: 0.95, evidence: 'Legacy parser fallback: email field.' } : undefined,
    phone: profile.phone ? { value: profile.phone, confidence: 0.95, evidence: 'Legacy parser fallback: phone field.' } : undefined,
    location: profile.location ? { value: profile.location, confidence: 0.6, evidence: 'Legacy parser fallback: location field.' } : undefined,
    summary: profile.summary ? { value: profile.summary, confidence: 0.5, evidence: 'Legacy parser fallback: summary field.' } : undefined,
    targetRoles: {
      value: targetRoles,
      confidence: targetRoles.length ? 0.55 : 0.2,
      evidence: 'Legacy parser fallback: inferred from legacy experience titles.',
    },
    skills: {
      value: [...new Set(profile.skills.map((value) => value.toLowerCase()))],
      confidence: profile.skills.length ? 0.75 : 0.2,
      evidence: 'Legacy parser fallback: imported skill list.',
    },
    projects: { value: [], confidence: 0.15, evidence: 'No legacy project section available in fallback mode.' },
    experience: {
      value: profile.experience,
      confidence: profile.experience.length ? 0.55 : 0.2,
      evidence: 'Legacy parser fallback: imported experience list.',
    },
    education: {
      value: profile.education,
      confidence: profile.education.length ? 0.6 : 0.2,
      evidence: 'Legacy parser fallback: imported education list.',
    },
    keywords: {
      value: profile.keywords,
      confidence: profile.keywords.length ? 0.55 : 0.2,
      evidence: 'Legacy parser fallback: imported keywords.',
    },
    seniority: seniority ? { value: seniority, confidence: 0.4, evidence: 'Legacy parser fallback: inferred from role depth clues.' } : undefined,
    source: {
      path: metadata.path,
      type: metadata.type,
      extractionWarnings: metadata.extractionWarnings,
      parser: metadata.parser,
    },
  }
}

export async function runJobApplicationAgent(options: RunOptions = {}): Promise<AgentRunResult> {
  const config = options.config ?? loadConfig()
  const mode: AgentMode = options.mode ?? 'fill'
  const emit = options.onEvent ?? ((_e: AgentEvent) => {})
  const gate: HumanGate = options.gate ?? (config.human.mode === 'auto' ? new AutoHumanGate(undefined, { allowLocalFinalSubmit: mode === 'auto-apply' }) : new CliHumanGate())
  const llm = options.llm ?? new LlmGateway(config.model)
  const highlight = config.browser.visualHighlight

  applyBrowserEnv(config)
  if (mode === 'demo-form' || mode === 'demo-research') process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'

  const runtimeProfile = options.profile ?? 'debug'
  const trace = new TraceRecorder(config.trace.outDir, {
    runId: options.runId,
    source: options.source ?? 'local-runtime',
    scenario: mode,
    profile: runtimeProfile,
    goal: options.taskPrompt,
  })
  const sessionRecorder = await createRunSession({
    config,
    trace,
    mode,
    source: options.source ?? 'local-runtime',
    goal: options.taskPrompt ?? defaultGoalForMode(mode),
    emit,
  })
  const finalizeRun = (args: Omit<FinalizeArgs, 'session'>) =>
    finalize({ ...args, session: sessionRecorder })
  const sessionId = 'default'
  trace.record({
    phase: 'boot',
    action: `Agent start (mode=${mode}, permission=${config.human.permissionMode}, headless=${config.browser.headless}, llm=${hasModelKey(config)})`,
    status: 'ok',
  })

  try {
    if (mode === 'demo-research') {
      const summary = await runResearchDemo(sessionId, trace, emit)
      return finalizeRun({
        mode,
        profile: emptyProfile('research-demo'),
        matches: [],
        finalState: 'completed',
        message: `Read-only research demo completed: ${summary.headingCount} headings, ${summary.planCount} plan rows, ${summary.faqCount} FAQ items.`,
        trace,
        emit,
      })
    }

    const profile = await ensureResume(config, trace, emit, llm)
    if ((mode === 'alibaba-apply' || mode === 'raw') && !llm.hasKey) {
      return finalizeRun({
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
        return finalizeRun({ mode, profile, matches: [], finalState: 'no_jobs', message: 'No structured job cards found on the target page.', trace, emit })
      }
      const coarseMatches = matchJobsCoarse(profile, jobs)
      writeJobCandidatesArtifact(trace, 'job-candidates-coarse.json', {
        schemaVersion: 'job-candidates/coarse/v1',
        scanned: jobs.length,
        threshold: config.matchThreshold,
        candidates: serializeMatches(coarseMatches),
      })
      trace.record({
        phase: 'match',
        action: `Coarse ranked ${jobs.length} structured job candidates.`,
        status: coarseMatches.length ? 'ok' : 'warn',
        observation: formatTopMatches(coarseMatches, 5),
      })

      matches = matchJobs(profile, jobs)
      const thresholdDecision = decideMatchThreshold(matches, config.matchThreshold)
      writeJobCandidatesArtifact(trace, 'job-candidates-final.json', {
        schemaVersion: 'job-candidates/final/v1',
        scanned: jobs.length,
        threshold: thresholdDecision.threshold,
        decision: serializeDecision(thresholdDecision),
        candidates: serializeMatches(matches),
      })
      const best = thresholdDecision.best
      if (!thresholdDecision.shouldApply || !best) {
        trace.record({
          phase: 'match',
          action: `Stopped before apply decision: ${thresholdDecision.reason}`,
          status: 'blocked',
          observation: formatTopMatches(matches, 5),
        })
        return finalizeRun({ mode, profile, matches, finalState: 'no_match', message: `No suitable match found on the target page. ${thresholdDecision.reason}`, trace, emit })
      }
      chosenJob = best.job
      extraContext = `Matched job: ${best.job.title}. Match score: ${best.score.toFixed(2)}. ${best.reason}`
      trace.record({ phase: 'match', action: `Best match: ${best.job.title} (score ${best.score.toFixed(2)}; threshold ${thresholdDecision.threshold.toFixed(2)}).`, status: 'ok', observation: `${best.reason}\n${thresholdDecision.reason}` })
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
      const pipeline = await runAlibabaMatchPipeline({ sessionId, listUrl, profile, config, trace, emit, llm })
      if (pipeline.jobs.length === 0) {
        return finalizeRun({ mode, profile, matches: [], finalState: 'no_jobs', message: 'No jobs found on the Alibaba list page.', trace, emit })
      }

      matches = pipeline.matches
      const best = pipeline.decision.best
      if (!pipeline.decision.shouldApply || !best) {
        return finalizeRun({
          mode,
          profile,
          matches,
          finalState: 'no_match',
          message: `No suitable Alibaba job match found. ${pipeline.decision.reason}`,
          trace,
          emit,
        })
      }

      chosenJob = best.job
      extraContext = [
        `Matched Alibaba job: ${best.job.title} (${best.job.category || 'unknown category'}).`,
        best.job.location ? `Location: ${best.job.location}.` : '',
        best.job.detailUrl ? `Detail URL: ${best.job.detailUrl}.` : '',
        `Match score: ${best.score.toFixed(2)}. ${best.reason}`,
        'Use the current Alibaba page and any visible job/application information to fill only fields that can be mapped confidently from the resume.',
      ].filter(Boolean).join('\n')
      trace.record({ phase: 'match', action: `Selected Alibaba match: ${best.job.title} (score ${best.score.toFixed(2)}; threshold ${pipeline.decision.threshold.toFixed(2)}).`, status: 'ok', observation: `${best.reason}\n${pipeline.decision.reason}` })
      emit({ phase: 'match', message: `Best match → ${best.job.title} (score ${best.score.toFixed(2)})`, level: 'info' })
      matches.slice(0, 5).forEach((m, i) => emit({ phase: 'match', message: `  ${i + 1}. ${m.job.title} — ${m.score.toFixed(2)} — ${m.matchedSkills.slice(0, 5).join(', ')}`, level: 'info' }))

      const apply = await attemptApply(sessionId, best.job as ScrapedJob, gate, trace)
      if (apply.directSubmitReview) {
        return finalizeRun({
          mode,
          profile,
          matches,
          chosenJob,
          finalState: 'direct_submit_review',
          message: directSubmitReviewMessage(best.job.title, apply.directSubmitReview),
          trace,
          emit,
        })
      }
      if (apply.gateDecision !== 'approve') {
        return finalizeRun({
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
            return finalizeRun({ mode, profile, matches, chosenJob, finalState: 'login_required', message: `Matched "${best.job.title}" but stopped at Alibaba login/captcha hand-off.`, trace, emit })
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
          return finalizeRun({ mode, profile, matches, chosenJob, finalState: 'login_required', message: `Matched "${best.job.title}" but Alibaba login did not complete after repeated hand-offs.`, trace, emit })
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

        const postLoginDirectSubmit = await detectAndRecordDirectSubmitReview(trace, apply.page, 'after login')
        if (postLoginDirectSubmit) {
          emit({ phase: 'apply', message: postLoginDirectSubmit.userMessage, level: 'gate' })
          return finalizeRun({
            mode,
            profile,
            matches,
            chosenJob,
            finalState: 'direct_submit_review',
            message: directSubmitReviewMessage(best.job.title, postLoginDirectSubmit),
            trace,
            emit,
          })
        }
      } else if (apply.reachedForm) {
        emit({ phase: 'open_form', message: 'Alibaba application form reached; starting LLM fill.', level: 'info' })
      } else {
        emit({ phase: 'open_form', message: 'Alibaba application-flow state is unclear; the LLM will inspect the current page.', level: 'warn' })
      }
    } else if (mode === 'match') {
      const listUrl = startUrl ?? config.alibabaCareersUrl
      const pipeline = await runAlibabaMatchPipeline({ sessionId, listUrl, profile, config, trace, emit, llm })
      if (pipeline.jobs.length === 0) {
        return finalizeRun({ mode, profile, matches: [], finalState: 'no_jobs', message: 'No jobs found on the list page.', trace, emit })
      }
      matches = pipeline.matches
      const best = pipeline.decision.best
      if (!pipeline.decision.shouldApply || !best) {
        return finalizeRun({
          mode,
          profile,
          matches,
          finalState: 'no_match',
          message: `No suitable match found. ${pipeline.decision.reason}`,
          trace,
          emit,
        })
      }
      chosenJob = best.job
      extraContext = `Matched job: ${best.job.title} (${best.job.category || ''}). Match score: ${best.score.toFixed(2)}. ${best.reason}`
      trace.record({ phase: 'match', action: `Selected match: ${best.job.title} (score ${best.score.toFixed(2)}; threshold ${pipeline.decision.threshold.toFixed(2)}).`, status: 'ok', observation: `${best.reason}\n${pipeline.decision.reason}` })
      emit({ phase: 'match', message: `Best match → ${best.job.title} (score ${best.score.toFixed(2)})`, level: 'info' })
      matches.slice(0, 5).forEach((m, i) => emit({ phase: 'match', message: `  ${i + 1}. ${m.job.title} — ${m.score.toFixed(2)} — ${m.matchedSkills.slice(0, 5).join(', ')}`, level: 'info' }))
      // match mode is read-only: hand off at the gate (no navigation into apply).
      const decision = await gate.confirm('final_submit', `Enter Alibaba's application flow for "${best.job.title}"?`, { url: best.job.detailUrl })
      trace.record({ phase: 'apply', action: `Apply hand-off (match mode): ${decision}`, url: best.job.detailUrl, risk: 'L3', status: 'blocked' })
      return finalizeRun({ mode, profile, matches, chosenJob, finalState: 'login_required', message: `Matched "${best.job.title}". Application flow handed to human (gate: ${decision}).`, trace, emit })
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
      return finalizeRun({ mode, profile, matches, chosenJob, finalState, message, trace, emit })
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
        permissionMode: config.human.permissionMode,
        allowFinalSubmit: config.human.allowFinalSubmit,
        maxSteps: config.agent.maxSteps,
        onEvent: (e) => emit({ phase: 'agent', level: e.level, message: e.message }),
        session: sessionRecorder,
      })
      await captureFinalScreenshot(sessionId, trace)
      const finalState: FinalState = loopResult.blocked
        ? (loopResult.summary.toLowerCase().includes('submit') ? 'stopped_at_submit' : 'blocked')
        : 'filled'
      return finalizeRun({
        mode, profile, matches, chosenJob, finalState,
        message: loopResult.summary + (loopResult.blocked ? ' (stopped)' : ' (draft filled — not submitted)'),
        trace, emit,
        recordSessionFinal: false,
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
    return finalizeRun({ mode, profile, matches, chosenJob, finalState, message: `Heuristic fill stopped at "${fill.stoppedAt}" — not submitted.`, trace, emit })
  } catch (error) {
    trace.record({ phase: 'fatal', action: `Agent error: ${(error as Error).message}`, status: 'error' })
    emit({ phase: 'fatal', message: (error as Error).message, level: 'error' })
    return finalizeRun({ mode, profile: { skills: [], experience: [], education: [], keywords: [], source: 'json' }, matches: [], finalState: 'error', message: (error as Error).message, trace, emit })
  } finally {
    if (gate instanceof CliHumanGate) gate.close()
  }
}

async function runResearchDemo(
  sessionId: string,
  trace: TraceRecorder,
  emit: (e: AgentEvent) => void,
): Promise<{ headingCount: number; planCount: number; faqCount: number }> {
  const url = researchBriefingUrl()
  const open = await browserOpen({ url, sessionId, waitUntil: 'domcontentloaded' })
  if (!open.ok) throw new Error(open.error.message)

  const page = sessionManager.get(sessionId)?.page
  trace.record({
    phase: 'open_research',
    action: 'Opened local read-only research fixture.',
    url: page?.url(),
    risk: 'L0',
    status: 'ok',
    screenshotPath: await trace.screenshot(page, 'research-open'),
  })
  emit({ phase: 'open_research', message: 'Opened local read-only research fixture.', level: 'info' })

  const snapshot = await browserSnapshot({ sessionId, maxElements: 120 })
  trace.record({
    phase: 'observation',
    action: 'browser_snapshot captured research fixture.',
    url: page?.url(),
    risk: 'L0',
    toolCategory: 'observation',
    status: snapshot.ok ? 'ok' : 'warn',
    observation: snapshot.observation,
  })
  emit({ phase: 'observation', message: snapshot.observation, level: snapshot.ok ? 'observe' : 'warn' })

  const summary = page ? await page.evaluate(() => {
    const text = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
    const headings = Array.from(document.querySelectorAll('h1,h2')).map((node) => text(node.textContent))
    const plans = Array.from(document.querySelectorAll('tbody tr')).map((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => text(cell.textContent))
      return {
        plan: cells[0] || '',
        monthlyRuns: cells[1] || '',
        traceRetention: cells[2] || '',
        bestFor: cells[3] || '',
      }
    })
    const faqs = Array.from(document.querySelectorAll('details')).map((node) => ({
      question: text(node.querySelector('summary')?.textContent),
      answer: text(node.querySelector('p')?.textContent),
    }))
    return {
      title: document.title,
      headings,
      plans,
      faqs,
      safetySignals: faqs
        .map((item) => `${item.question} ${item.answer}`)
        .filter((line) => /submit|captcha|handoff|trace|safety/i.test(line)),
    }
  }) : { title: '', headings: [], plans: [], faqs: [], safetySignals: [] }

  const artifactPath = trace.agentTrace?.writeArtifact('research-summary.json', `${JSON.stringify(summary, null, 2)}\n`)
  trace.agentTrace?.recordEvent('research_summary', { path: artifactPath, summary })
  trace.record({
    phase: 'summarize',
    action: 'Extracted structured research brief from page content.',
    url: page?.url(),
    risk: 'L0',
    status: 'ok',
    observation: [
      `title=${summary.title}`,
      `headings=${summary.headings.join(' | ')}`,
      `plans=${summary.plans.map((plan) => `${plan.plan}:${plan.monthlyRuns}`).join(', ')}`,
      `safety=${summary.safetySignals.length}`,
    ].join('\n'),
  })
  emit({
    phase: 'summarize',
    message: `Structured page summary: ${summary.plans.length} plan rows, ${summary.faqs.length} FAQ items.`,
    level: 'done',
  })

  trace.record({
    phase: 'observation',
    action: 'Captured final read-only research page state.',
    url: page?.url(),
    risk: 'L0',
    status: 'ok',
    screenshotPath: await trace.screenshot(page, 'research-final'),
  })

  return {
    headingCount: summary.headings.length,
    planCount: summary.plans.length,
    faqCount: summary.faqs.length,
  }
}

function emptyProfile(sourceLabel: string): ResumeProfile {
  return {
    name: sourceLabel,
    skills: [],
    experience: [],
    education: [],
    keywords: [],
    source: 'json',
  }
}

interface AlibabaMatchPipelineArgs {
  sessionId: string
  listUrl: string
  profile: ResumeProfile
  config: AgentConfig
  trace: TraceRecorder
  emit: (e: AgentEvent) => void
  llm: LlmGateway
}

interface AlibabaMatchPipelineResult {
  jobs: ScrapedJob[]
  coarseMatches: MatchScore[]
  matches: MatchScore[]
  decision: MatchThresholdDecision
}

async function runAlibabaMatchPipeline(args: AlibabaMatchPipelineArgs): Promise<AlibabaMatchPipelineResult> {
  const threshold = Number.isFinite(args.config.matchThreshold)
    ? args.config.matchThreshold
    : DEFAULT_MATCH_THRESHOLD
  const crawl = await scrapeJobList(args.sessionId, args.listUrl, args.trace, {
    maxPages: args.config.maxJobPagesToCrawl,
    maxJobs: args.config.maxJobsToCrawl,
  })
  const jobs = crawl.jobs
  if (jobs.length === 0) {
    writeJobCandidatesArtifact(args.trace, 'job-candidates-coarse.json', {
      schemaVersion: 'job-candidates/coarse/v1',
      scanned: 0,
      pagesScanned: crawl.pagesScanned ?? 0,
      rawCount: crawl.rawCount ?? 0,
      threshold,
      candidates: [],
    })
    const decision = decideMatchThreshold([], threshold)
    writeJobCandidatesArtifact(args.trace, 'job-candidates-final.json', {
      schemaVersion: 'job-candidates/final/v1',
      scanned: 0,
      threshold: decision.threshold,
      decision: serializeDecision(decision),
      candidates: [],
    })
    return { jobs, coarseMatches: [], matches: [], decision }
  }

  args.emit({
    phase: 'scrape_list',
    message: `Scanned ${jobs.length} unique jobs across ${crawl.pagesScanned ?? 1} page(s); opening top ${Math.min(args.config.maxJobsToDetail, jobs.length)} for detail.`,
    level: 'info',
  })

  const coarseMatches = matchJobsCoarse(args.profile, jobs)
  writeJobCandidatesArtifact(args.trace, 'job-candidates-coarse.json', {
    schemaVersion: 'job-candidates/coarse/v1',
    scanned: jobs.length,
    rawCount: crawl.rawCount ?? jobs.length,
    pagesScanned: crawl.pagesScanned ?? 1,
    siteAdvertisedTotal: crawl.total,
    threshold,
    candidates: serializeMatches(coarseMatches),
  })
  args.trace.record({
    phase: 'match',
    action: `Top coarse candidates from ${jobs.length} scanned jobs.`,
    status: coarseMatches.length ? 'ok' : 'warn',
    observation: formatTopMatches(coarseMatches, 8),
  })
  coarseMatches.slice(0, 5).forEach((m, i) =>
    args.emit({ phase: 'match', message: `coarse ${i + 1}. ${m.job.title} — ${m.score.toFixed(2)}`, level: 'info' }),
  )

  const detailLimit = Math.max(0, Math.min(args.config.maxJobsToDetail, coarseMatches.length))
  const toDetail = coarseMatches.slice(0, detailLimit)
  const detailed: ScrapedJob[] = []
  for (const m of toDetail) {
    try {
      detailed.push((await scrapeJobDetail(args.sessionId, m.job as ScrapedJob, args.trace)).job)
    } catch (error) {
      args.trace.record({ phase: 'scrape_detail', action: `Detail failed for "${m.job.title}": ${(error as Error).message}`, status: 'warn' })
    }
  }

  const localFinal = detailed.length > 0
    ? mergeCoarseAndDetailMatches(coarseMatches, matchJobs(args.profile, detailed))
    : coarseMatches.slice(0, detailLimit || Math.min(10, coarseMatches.length))
  const finalMatches = args.llm.hasKey && localFinal.length > 0
    ? await refineMatchesWithLlm(localFinal, args.profile, args.llm, Math.min(detailLimit || localFinal.length, localFinal.length))
    : localFinal
  const decision = decideMatchThreshold(finalMatches, threshold)

  writeJobCandidatesArtifact(args.trace, 'job-candidates-final.json', {
    schemaVersion: 'job-candidates/final/v1',
    scanned: jobs.length,
    detailsOpened: detailed.length,
    detailsAttempted: toDetail.length,
    llmReranked: args.llm.hasKey && localFinal.length > 0,
    threshold: decision.threshold,
    decision: serializeDecision(decision),
    candidates: serializeMatches(finalMatches),
  })
  args.trace.record({
    phase: 'match',
    action: `Top final candidates after ${detailed.length}/${toDetail.length} detail enrichments. ${decision.reason}`,
    status: decision.shouldApply ? 'ok' : 'blocked',
    observation: formatTopMatches(finalMatches, 8),
  })

  return { jobs, coarseMatches, matches: finalMatches, decision }
}

function mergeCoarseAndDetailMatches(coarseMatches: MatchScore[], detailMatches: MatchScore[]): MatchScore[] {
  const coarseByKey = new Map(coarseMatches.flatMap((match) => jobIdentityKeys(match.job).map((key) => [key, match] as const)))
  const merged = detailMatches.map((detailMatch) => {
    const coarse = jobIdentityKeys(detailMatch.job).map((key) => coarseByKey.get(key)).find(Boolean)
    if (!coarse) return detailMatch
    const score = clampMatchScore(coarse.score * 0.45 + detailMatch.score * 0.55)
    return {
      ...detailMatch,
      score,
      reason: `Final: coarse ${coarse.score.toFixed(2)} + detail ${detailMatch.score.toFixed(2)}. ${detailMatch.reason}`,
      matchedSkills: [...new Set([...coarse.matchedSkills, ...detailMatch.matchedSkills])],
      missingSkills: detailMatch.missingSkills,
    }
  })
  merged.sort((a, b) => b.score - a.score || b.matchedSkills.length - a.matchedSkills.length)
  return merged
}

function clampMatchScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(1, Number(score.toFixed(4))))
}

function jobIdentityKeys(job: JobPosting): string[] {
  const scraped = job as ScrapedJob
  return [
    scraped.positionId ? `position:${scraped.positionId}` : '',
    job.id ? `id:${job.id}` : '',
    job.detailUrl ? `url:${job.detailUrl}` : '',
    job.title ? `title:${job.title.trim().toLowerCase()}` : '',
  ].filter(Boolean)
}

function writeJobCandidatesArtifact(trace: TraceRecorder, name: string, value: unknown): string | undefined {
  const content = `${JSON.stringify(value, null, 2)}\n`
  let path = trace.agentTrace?.writeArtifact(name, content)
  const legacyPath = join(trace.dir, name)
  try {
    writeFileSync(legacyPath, content)
    path = path || legacyPath
  } catch {
    // Artifact writing is diagnostic; the run should still finish.
  }
  trace.agentTrace?.recordEvent('job_candidates_artifact', { name, path, legacyPath })
  return path
}

function writeResumeProfileV2Artifact(trace: TraceRecorder, profile: ResumeProfileV2): string | undefined {
  const artifact = {
    schemaVersion: profile.schemaVersion,
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    summary: profile.summary,
    targetRoles: profile.targetRoles,
    skills: profile.skills,
    projects: profile.projects,
    experience: profile.experience,
    education: profile.education,
    keywords: profile.keywords,
    seniority: profile.seniority,
    source: {
      path: profile.source.path,
      type: profile.source.type,
      extractionWarnings: profile.source.extractionWarnings,
      textLength: profile.source.textLength,
      parser: profile.source.parser,
    },
  }

  const content = `${JSON.stringify(artifact, null, 2)}\n`
  let path = trace.agentTrace?.writeArtifact('resume-profile-v2.json', content)
  const legacyPath = join(trace.dir, 'resume-profile-v2.json')
  try {
    writeFileSync(legacyPath, content)
    path = path || legacyPath
  } catch {
    // Artifact writing is diagnostic; the run should still finish.
  }
  trace.agentTrace?.recordEvent('resume_profile_v2_artifact', {
    path,
    legacyPath,
    sourceType: profile.source.type,
    parser: profile.source.parser,
  })
  return path
}

async function detectAndRecordDirectSubmitReview(
  trace: TraceRecorder,
  page: { url(): string } & Parameters<typeof detectDirectSubmitReview>[0],
  context: string,
): Promise<DirectSubmitReview | undefined> {
  const review = await detectDirectSubmitReview(page).catch(() => undefined)
  if (!review) return undefined
  writeDirectSubmitReviewArtifact(trace, review)
  trace.record({
    phase: 'apply',
    action: `Detected direct-submit review boundary ${context}.`,
    url: page.url(),
    risk: 'L4',
    status: 'ok',
    screenshotPath: await trace.screenshot(page, 'direct-submit-review'),
    observation: review.userMessage,
  })
  return review
}

function writeDirectSubmitReviewArtifact(trace: TraceRecorder, review: DirectSubmitReview): string | undefined {
  const content = `${JSON.stringify(review, null, 2)}\n`
  let path = trace.agentTrace?.writeArtifact('direct-submit-review.json', content)
  const legacyPath = join(trace.dir, 'direct-submit-review.json')
  try {
    writeFileSync(legacyPath, content)
    path = path || legacyPath
  } catch {
    // Artifact writing is diagnostic; the run should still finish.
  }
  trace.agentTrace?.recordEvent('direct_submit_review', { path, legacyPath, review })
  return path
}

function directSubmitReviewMessage(jobTitle: string, review: DirectSubmitReview): string {
  return `Matched "${jobTitle}" and stopped at direct-submit review. ${review.userMessage}`
}

function serializeMatches(matches: MatchScore[]) {
  return matches.map((match, index) => ({
    rank: index + 1,
    id: match.job.id,
    positionId: (match.job as ScrapedJob).positionId,
    title: match.job.title,
    category: match.job.category,
    location: match.job.location,
    updated: match.job.updated,
    detailUrl: match.job.detailUrl,
    score: Number(match.score.toFixed(4)),
    reason: match.reason,
    matchedSkills: match.matchedSkills,
    missingSkills: match.missingSkills,
  }))
}

function serializeDecision(decision: MatchThresholdDecision) {
  return {
    threshold: decision.threshold,
    shouldApply: decision.shouldApply,
    reason: decision.reason,
    best: decision.best ? serializeMatches([decision.best])[0] : undefined,
  }
}

function formatTopMatches(matches: MatchScore[], limit: number): string {
  if (matches.length === 0) return 'No candidates.'
  return matches
    .slice(0, limit)
    .map((m, i) => `${i + 1}. ${m.job.title} — ${m.score.toFixed(2)} — ${m.reason.replace(/\s+/g, ' ')}`)
    .join('\n')
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
  await refreshFinalObservation(sessionId, trace)
  const page = sessionManager.get(sessionId)?.page
  if (!page) return
  const path = await trace.screenshot(page, 'final')
  trace.record({ phase: 'fill_draft', action: 'Captured final page state.', status: 'ok', screenshotPath: path })
}

async function refreshFinalObservation(sessionId: string, trace: TraceRecorder): Promise<void> {
  try {
    const firstForm = await browserFormSnapshot({ sessionId })
    const page = await browserSnapshot({ sessionId })
    const finalForm = page.ok ? await browserFormSnapshot({ sessionId }) : firstForm
    trace.record({
      phase: 'observation',
      action: 'Refreshed final PageState/FormState artifacts.',
      url: sessionManager.get(sessionId)?.page.url(),
      status: firstForm.ok || page.ok || finalForm.ok ? 'ok' : 'warn',
      observation: [
        `browser_form_snapshot=${firstForm.ok ? 'ok' : 'failed'}`,
        `browser_snapshot=${page.ok ? 'ok' : 'failed'}`,
        `final_browser_form_snapshot=${finalForm.ok ? 'ok' : 'failed'}`,
      ].join(', '),
    })
  } catch (error) {
    try {
      trace.record({
        phase: 'observation',
        action: 'Final observation refresh failed.',
        url: sessionManager.get(sessionId)?.page.url(),
        status: 'warn',
        observation: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // Final observation is diagnostic output and must not affect the run.
    }
  }
}

interface FinalizeArgs {
  mode: AgentMode
  profile: ResumeProfile
  matches: MatchScore[]
  chosenJob?: JobPosting
  finalState: FinalState
  message: string
  trace: TraceRecorder
  emit: (e: AgentEvent) => void
  session?: SessionRecorder
  recordSessionFinal?: boolean
}

async function createRunSession(args: {
  config: AgentConfig
  trace: TraceRecorder
  mode: AgentMode
  source: RunSource
  goal: string
  emit: (e: AgentEvent) => void
}): Promise<SessionRecorder> {
  const store = new FileSessionStore({ rootDir: join(args.config.trace.outDir, 'sessions') })
  const session = await store.create({
    runId: args.trace.runId,
    source: sessionSourceFromRunSource(args.source),
    goal: args.goal,
    mode: args.mode,
    traceRunId: args.trace.runId,
  })
  return new FileSessionRecorder(store, session, {
    bestEffort: true,
    warn: (message) => args.emit({ phase: 'session', message, level: 'warn' }),
  })
}

async function finalize(args: FinalizeArgs): Promise<AgentRunResult> {
  const summary = args.trace.finish()
  const status = sessionStatusForFinalState(args.finalState)
  if (args.session) {
    if (args.recordSessionFinal !== false) {
      await args.session.transcript({
        type: 'final_result',
        status,
        result: {
          finalState: args.finalState,
          message: args.message,
          tracePath: summary.tracePath,
        },
        ...(status === 'blocked' || status === 'failed' ? { reason: args.message } : {}),
      })
      await args.session.event({
        type: sessionEventTypeForStatus(status),
        message: args.message,
        data: {
          finalState: args.finalState,
          tracePath: summary.tracePath,
        },
      })
    }
    await args.session.updateStatus(status, {
      ...(status === 'blocked' ? { blockedReason: args.message } : {}),
      ...(status === 'failed' ? { error: args.message } : {}),
    })
  }
  args.emit({ phase: 'done', message: `${args.message} (trace: ${summary.tracePath})`, level: 'done' })
  return {
    mode: args.mode,
    profile: args.profile,
    matches: args.matches,
    chosenJob: args.chosenJob,
    finalState: args.finalState,
    message: args.message,
    summary,
    ...(args.session ? { session: args.session.session } : {}),
  }
}

function defaultGoalForMode(mode: AgentMode): string {
  if (mode === 'demo-research') return 'Run the offline read-only research demo.'
  if (mode === 'demo-form') return 'Fill the offline demo application form safely.'
  if (mode === 'match') return 'Match the resume to visible job postings and stop before application handoff.'
  if (mode === 'auto-apply') return 'Run the structured job board apply workflow.'
  if (mode === 'raw') return DEFAULT_ALIBABA_APPLY_PROMPT
  return 'Fill the application form on the current page using the resume.'
}

function sessionSourceFromRunSource(source: RunSource): AgentSessionSource {
  if (source === 'cli-demo') return 'cli'
  if (source === 'web-ui') return 'web'
  if (source === 'benchmark') return 'benchmark'
  if (source === 'sdk') return 'sdk'
  return 'sdk'
}

function sessionStatusForFinalState(finalState: FinalState): Extract<AgentSessionStatus, 'completed' | 'blocked' | 'failed' | 'aborted'> {
  if (finalState === 'error') return 'failed'
  if (
    finalState === 'blocked' ||
    finalState === 'login_required' ||
    finalState === 'no_jobs' ||
    finalState === 'no_match' ||
    finalState === 'stopped_at_submit' ||
    finalState === 'direct_submit_review'
  ) {
    return 'blocked'
  }
  return 'completed'
}

function sessionEventTypeForStatus(status: Extract<AgentSessionStatus, 'completed' | 'blocked' | 'failed' | 'aborted'>) {
  if (status === 'completed') return 'session_completed'
  if (status === 'failed') return 'session_failed'
  if (status === 'aborted') return 'session_aborted'
  return 'session_blocked'
}

// Re-exports for SDK consumers.
export {
  DEFAULT_MATCH_THRESHOLD,
  decideMatchThreshold,
  matchJobs,
  matchJobsCoarse,
  type JobPosting,
  type MatchScore,
  type MatchThresholdDecision,
} from './matcher.js'
export { readResume, writeSampleResumePdf, type ResumeProfile } from './resume.js'
export { LlmGateway } from './llm.js'
export { CliHumanGate, AutoHumanGate, ScriptedHumanGate, type HumanGate } from './human.js'
export { TraceRecorder } from './trace.js'
export { loadConfig, type AgentConfig } from './config.js'
export { ToolRegistry } from '../runtime/local/tool-registry.js'
export { runAgentLoop } from '../runtime/local/agent-loop.js'
