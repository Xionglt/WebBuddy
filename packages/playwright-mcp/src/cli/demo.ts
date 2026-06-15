/**
 * job-agent CLI — drive the visual browser job-application agent.
 *
 *   job-agent fill <url>          GENERIC: cookie-login + LLM-driven form fill
 *   job-agent match [--list-url]  Alibaba: scrape list+details, match, hand off
 *   job-agent demo-form           offline mock form, visible fill (always works)
 *   job-agent login <url>         interactive: log in once, save cookies
 *   job-agent --help
 *
 * Visible by default when run from a terminal (headful + highlights). Add
 * --headless / --auto-gate for CI. See README for the safety contract.
 */
import { loadConfig, type AgentConfig } from '../sdk/config.js'
import { runJobApplicationAgent, type AgentMode } from '../sdk/orchestrator.js'
import { sessionManager } from '../session/manager.js'
import { defaultAuthPath, ensureLogin } from '../core/login.js'
import { AutoHumanGate, CliHumanGate } from '../sdk/human.js'
import { LlmGateway } from '../sdk/llm.js'
import { TraceRecorder } from '../sdk/trace.js'

interface Flags {
  resume?: string
  headful?: boolean
  headless?: boolean
  autoGate?: boolean
  modelKey?: string
  baseUrl?: string
  modelName?: string
  listUrl?: string
  maxJobs: number
  storageState?: string
}

interface ParsedArgs {
  flags: Flags
  positionals: string[]
}

const VALUE_FLAGS = new Set([
  '--resume', '--model-key', '--base-url', '--model-name',
  '--list-url', '--max-jobs', '--storage-state',
])

/** Single-pass parser: value-flags consume their next token; others are positional. */
function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = { maxJobs: 3 }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--headful') flags.headful = true
    else if (a === '--headless') flags.headless = true
    else if (a === '--auto-gate') flags.autoGate = true
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i]
      if (v === undefined) { console.error(`Option ${a} requires a value`); process.exit(2) }
      switch (a) {
        case '--resume': flags.resume = v; break
        case '--model-key': flags.modelKey = v; break
        case '--base-url': flags.baseUrl = v; break
        case '--model-name': flags.modelName = v; break
        case '--list-url': flags.listUrl = v; break
        case '--max-jobs': flags.maxJobs = Number(v); break
        case '--storage-state': flags.storageState = v; break
      }
    } else if (a?.startsWith('--')) {
      console.error(`Unknown option: ${a}`); process.exit(2)
    } else {
      positionals.push(a)
    }
  }
  return { flags, positionals }
}

function applyFlags(config: AgentConfig, f: Flags): AgentConfig {
  if (f.headful) { config.browser.headless = false; config.browser.visualHighlight = true }
  if (f.headless) { config.browser.headless = true; config.browser.visualHighlight = false }
  if (f.autoGate) config.human.mode = 'auto'
  if (f.storageState) config.auth.storageStatePath = f.storageState
  return config
}

function printHeader(title: string, config: AgentConfig, mode: AgentMode, extra?: Record<string, string>) {
  console.log('━'.repeat(64))
  console.log(` job-agent · ${title}`)
  console.log('━'.repeat(64))
  const rows: Record<string, string> = {
    mode: mode,
    browser: `${config.browser.headless ? 'headless' : 'headful (visible)'}${config.browser.visualHighlight ? ' + highlights' : ''}`,
    resume: config.resumePath,
    model: config.model.apiKey ? `${config.model.name} @ ${config.model.baseUrl}` : '(none — heuristic fallback only)',
    'human gate': config.human.mode,
  }
  if (extra) Object.assign(rows, extra)
  for (const [k, v] of Object.entries(rows)) console.log(` ${k.padEnd(12)} : ${v}`)
  console.log('━'.repeat(64))
  console.log('')
}

const ICON: Record<string, string> = {
  info: '• ', warn: '⚠️ ', gate: '⛔', think: '💭', act: '🎯', observe: '👀', error: '✖ ', done: '✅',
}

async function run(mode: AgentMode, f: Flags, startUrl?: string) {
  const config = applyFlags(loadConfig({
    resumePath: f.resume,
    alibabaCareersUrl: f.listUrl,
    maxJobsToDetail: f.maxJobs,
    model: { apiKey: f.modelKey, baseUrl: f.baseUrl!, name: f.modelName! },
  }), f)

  printHeader(
    mode === 'fill' ? 'generic form fill' : mode === 'match' ? 'alibaba match' : 'offline demo form',
    config, mode,
    startUrl ? { target: startUrl } : undefined,
  )

  const result = await runJobApplicationAgent({
    config, mode, startUrl,
    onEvent: (e) => console.log(`${ICON[e.level] || '• '}${e.phase.padEnd(12)} ${e.message}`),
  })

  console.log('')
  console.log('━'.repeat(64))
  console.log(` final state : ${result.finalState}`)
  console.log(` message     : ${result.message}`)
  if (result.chosenJob) console.log(` chosen job  : ${result.chosenJob.title}`)
  console.log(` trace       : ${result.summary.tracePath}`)
  console.log(`             : ${result.summary.steps} steps, ${result.summary.screenshots} screenshots, max risk ${result.summary.maxRiskReached ?? '—'}`)
  console.log('━'.repeat(64))
  await sessionManager.closeAll()
}

async function loginCommand(url: string, f: Flags) {
  const config = applyFlags(loadConfig(), f)
  config.browser.headless = false // login must be visible
  process.env.PLAYWRIGHT_HEADLESS = 'false'
  const trace = new TraceRecorder(config.trace.outDir)
  const authPath = config.auth.storageStatePath || defaultAuthPath(url, config.trace.outDir)
  printHeader('interactive cookie login', config, 'fill', { target: url, 'auth file': authPath })
  const gate = config.human.mode === 'auto' ? new AutoHumanGate() : new CliHumanGate()
  const res = await ensureLogin({
    sessionId: 'default', url, storageStatePath: authPath, gate, trace, interactive: true,
  })
  console.log(res.loggedIn ? `✅ Logged in. Cookies saved to ${authPath}` : `⚠️  Login not confirmed (cookies ${res.usedSavedCookies ? 'were' : 'NOT'} saved).`)
  console.log(`trace: ${trace.finish().tracePath}`)
  await sessionManager.closeAll()
}

const HELP = `
job-agent — visual browser job-application agent

USAGE
  job-agent <command> [options]

COMMANDS
  fill <url>            GENERIC. Open any recruitment site, log in via saved
                        cookies (or interactively), then let the LLM-driven
                        agent loop fill the application form from your resume.
                        Requires MODEL_API_KEY. Never submits.
  match [--list-url U]  Alibaba preset. Scrape the position list + details,
                        match to your resume, hand off at the gate (read-only).
  demo-form             Offline mock form, visible fill. Always works, no key.
  login <url>           Open the site, let you log in manually, save cookies
                        so later 'fill' runs skip login.

OPTIONS
  --resume <path>       .pdf / .json / .txt resume (default tmp/pdfs/resume.pdf)
  --headful / --headless   show or hide Chromium (default headful in a TTY)
  --auto-gate           non-interactive: hand off sensitive steps automatically
  --model-key <key>     OpenAI-compatible API key (or MODEL_API_KEY)
  --base-url <url>      endpoint base (default https://api.openai.com/v1)
  --model-name <name>   model id (default gpt-4o-mini)
  --list-url <url>      Alibaba position-list URL (match)
  --storage-state <p>   cookie file path (fill/login)
  --max-jobs <n>        top-N jobs to open for detail (match, default 3)
  -h, --help            show this help

EXAMPLES
  job-agent demo-form                              # 30s offline demo
  job-agent login https://talent-holding.alibaba.com/...
  MODEL_API_KEY=sk-... job-agent fill https://talent-holding.alibaba.com/...
  job-agent match --headful
`

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(HELP)
    if (argv.length === 0) {
      // Default: run the reliable offline demo.
      await run('demo-form', parseArgs([]).flags)
    }
    return
  }

  // Legacy: --mode <m>
  if (argv[0] === '--mode') {
    const mode = argv[1] as AgentMode
    const { flags } = parseArgs(argv.slice(2))
    await run(mode, flags)
    return
  }

  const cmd = argv[0]
  const { flags: f, positionals } = parseArgs(argv.slice(1))

  switch (cmd) {
    case 'fill': {
      const url = positionals[0]
      if (!url) { console.error('fill requires a URL: job-agent fill <url>'); process.exit(2) }
      const llm = new LlmGateway(applyFlags(loadConfig(), f).model)
      if (!llm.hasKey) {
        console.error('⚠️  fill needs a model key. Set MODEL_API_KEY or pass --model-key.')
        console.error('    For an offline demo without a key, run: job-agent demo-form')
        process.exit(2)
      }
      await run('fill', f, url)
      break
    }
    case 'match': await run('match', f); break
    case 'demo-form': await run('demo-form', f); break
    case 'login': {
      const url = positionals[0]
      if (!url) { console.error('login requires a URL: job-agent login <url>'); process.exit(2) }
      await loginCommand(url, f)
      break
    }
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`)
      process.exit(2)
  }
}

main().catch((error) => {
  console.error('failed:', error)
  process.exit(1)
})
