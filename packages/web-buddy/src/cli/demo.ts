/**
 * web-agent / job-agent CLI — drive the local auditable Web Agent runtime.
 *
 *   job-agent raw <url>           RAW: LLM drives browser directly
 *   job-agent fill <url>          GENERIC: cookie-login + LLM-driven form fill
 *   job-agent auto-apply <url>    Structured job board: match + fill + local submit
 *   job-agent alibaba-apply       Alibaba official site: match + enter flow + fill
 *   job-agent match [--list-url]  Alibaba: scrape list+details, match, hand off
 *   job-agent demo-form           offline mock form, visible fill (always works)
 *   job-agent demo-research       offline read-only research page (always works)
 *   job-agent login <url>         interactive: log in once, save cookies
 *   job-agent --help
 *
 * Visible by default when run from a terminal (headful + highlights). Add
 * --headless / --auto-gate for CI. See README for the safety contract.
 */
import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { relative } from 'node:path'
import { loadConfig, type AgentConfig } from '../sdk/config.js'
import { DEFAULT_ALIBABA_APPLY_PROMPT, runJobApplicationAgent, type AgentMode } from '../sdk/orchestrator.js'
import { sessionManager } from '../session/manager.js'
import { defaultAuthPath, ensureLogin } from '../runtime/local/login.js'
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
  prompt?: string
  maxJobs: number
  storageState?: string
  keepBrowserOpen?: boolean
  profile?: string
}

interface ParsedArgs {
  flags: Flags
  positionals: string[]
}

const VALUE_FLAGS = new Set([
  '--resume', '--model-key', '--base-url', '--model-name',
  '--list-url', '--max-jobs', '--storage-state', '--prompt', '--profile',
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
    else if (a === '--keep-browser-open' || a === '--keep-open') flags.keepBrowserOpen = true
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i]
      if (v === undefined) { console.error(`Option ${a} requires a value`); process.exit(2) }
      switch (a) {
        case '--resume': flags.resume = v; break
        case '--model-key': flags.modelKey = v; break
        case '--base-url': flags.baseUrl = v; break
        case '--model-name': flags.modelName = v; break
        case '--list-url': flags.listUrl = v; break
        case '--prompt': flags.prompt = v; break
        case '--profile': flags.profile = v; break
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

function loadConfigWithFlags(f: Flags): AgentConfig {
  return applyFlags(loadConfig({
    resumePath: f.resume,
    alibabaCareersUrl: f.listUrl,
    maxJobsToDetail: f.maxJobs,
    model: { apiKey: f.modelKey, baseUrl: f.baseUrl!, name: f.modelName! },
  }), f)
}

function shouldKeepBrowserOpen(f: Flags, config: AgentConfig): boolean {
  return Boolean(
    f.keepBrowserOpen ||
      config.browser.keepBrowserOpen ||
      process.env.PLAYWRIGHT_KEEP_BROWSER_OPEN === 'true' ||
      process.env.KEEP_BROWSER_OPEN === 'true',
  )
}

async function finishBrowser(f: Flags, config: AgentConfig): Promise<void> {
  if (!shouldKeepBrowserOpen(f, config)) {
    await sessionManager.closeAll()
    return
  }

  console.log('')
  console.log('Browser kept open at the final page.')
  if (!stdin.isTTY) {
    console.log('No TTY is attached; this process will stay alive so the browser remains open. Stop the process to close it.')
    await new Promise(() => {})
    return
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    await rl.question('Press Enter here to close the browser and exit...')
  } finally {
    rl.close()
    await sessionManager.closeAll()
  }
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
  const config = loadConfigWithFlags(f)

  printHeader(
    mode === 'raw' ? 'raw browser agent'
      : mode === 'fill' ? 'generic form fill'
      : mode === 'match' ? 'alibaba match'
        : mode === 'alibaba-apply' ? 'alibaba apply'
          : mode === 'auto-apply' ? 'structured auto apply'
            : mode === 'demo-research' ? 'offline research demo'
              : 'offline demo form',
    config, mode,
    startUrl ? { target: startUrl } : undefined,
  )

  const result = await runJobApplicationAgent({
    config, mode, startUrl, taskPrompt: f.prompt,
    source: 'cli-demo',
    profile: f.profile ?? 'debug',
    onEvent: (e) => console.log(`${ICON[e.level] || '• '}${e.phase.padEnd(12)} ${e.message}`),
  })

  console.log('')
  console.log('━'.repeat(64))
  console.log(` final state : ${result.finalState}`)
  console.log(` message     : ${result.message}`)
  if (result.chosenJob) console.log(` chosen job  : ${result.chosenJob.title}`)
  console.log(` trace       : ${result.summary.tracePath}`)
  if (result.session) {
    console.log(` session     : ${relative(process.cwd(), `${result.session.outputDir}/session.json`)}`)
    console.log(` transcript  : ${relative(process.cwd(), result.session.transcriptPath)}`)
  }
  console.log(`             : ${result.summary.steps} steps, ${result.summary.screenshots} screenshots, max risk ${result.summary.maxRiskReached ?? '—'}`)
  console.log('━'.repeat(64))
  await finishBrowser(f, config)
}

async function loginCommand(url: string, f: Flags) {
  const config = loadConfigWithFlags(f)
  config.browser.headless = false // login must be visible
  process.env.PLAYWRIGHT_HEADLESS = 'false'
  const trace = new TraceRecorder(config.trace.outDir, {
    source: 'cli-demo',
    scenario: 'login',
    profile: f.profile ?? 'debug',
    goal: url,
  })
  const authPath = config.auth.storageStatePath || defaultAuthPath(url, config.trace.outDir)
  printHeader('interactive cookie login', config, 'fill', { target: url, 'auth file': authPath })
  const gate = config.human.mode === 'auto' ? new AutoHumanGate() : new CliHumanGate()
  const res = await ensureLogin({
    sessionId: 'default', url, storageStatePath: authPath, gate, trace, interactive: true,
  })
  console.log(res.loggedIn ? `✅ Logged in. Cookies saved to ${authPath}` : `⚠️  Login not confirmed (cookies ${res.usedSavedCookies ? 'were' : 'NOT'} saved).`)
  console.log(`trace: ${trace.finish().tracePath}`)
  await finishBrowser(f, config)
}

const HELP = `
web-agent / job-agent — local auditable Web Agent runtime

USAGE
  job-agent <command> [options]

COMMANDS
  raw <url>             RAW. Open the URL and let the LLM drive the browser
                        directly from your prompt and resume. No scraper,
                        matcher, or fixed job-application workflow.
  fill <url>            GENERIC. Open any recruitment site, log in via saved
                        cookies (or interactively), then let the LLM-driven
                        agent loop fill the application form from your resume.
                        Requires a model key. Never submits.
  auto-apply <url>      Structured job board. Find the best matching
                        [data-job-card], open its application form, fill it,
                        and submit only on localhost/sandbox test sites.
  alibaba-apply [url]   Shortcut for raw Alibaba run. Opens Alibaba careers
                        and lets the LLM drive the browser directly from your
                        prompt and resume.
  match [--list-url U]  Alibaba preset. Scrape the position list + details,
                        match to your resume, hand off at the gate (read-only).
  demo-form             Offline mock form, visible fill. Always works, no key.
  demo-research         Offline read-only web research fixture. Always works,
                        no key, login, captcha, or submit.
  login <url>           Open the site, let you log in manually, save cookies
                        so later 'fill' runs skip login.

OPTIONS
  --resume <path>       .pdf / .json / .txt resume (default tmp/pdfs/resume.pdf)
  --headful / --headless   show or hide Chromium (default headful in a TTY)
  --keep-browser-open  keep Chromium open on the final page until Enter
  --auto-gate           non-interactive: hand off sensitive steps automatically
  --model-key <key>     OpenAI-compatible API key (or MODEL_API_KEY)
  --base-url <url>      endpoint base (default https://api.openai.com/v1)
  --model-name <name>   model id (default gpt-4o-mini)
  --list-url <url>      Alibaba position-list URL (match)
  --storage-state <p>   cookie file path (fill/login)
  --prompt <text>       task prompt for LLM-driven fill modes
  --profile <name>      run profile label for metrics (debug/fast/benchmark)
  --max-jobs <n>        top-N jobs to open for detail (match, default 3)
  -h, --help            show this help

EXAMPLES
  job-agent demo-form                              # 30s offline demo
  job-agent demo-research --headless               # read-only research demo
  job-agent raw https://talent-holding.alibaba.com/off-campus/position-list?lang=zh --resume ./resume.pdf
  job-agent login https://talent-holding.alibaba.com/...
  MODEL_API_KEY=sk-... job-agent fill https://talent-holding.alibaba.com/...
  MODEL_API_KEY=sk-... job-agent alibaba-apply --resume ./resume.pdf --headful
  job-agent alibaba-apply --resume ./resume.pdf --headful --keep-browser-open
  job-agent alibaba-apply --prompt "${DEFAULT_ALIBABA_APPLY_PROMPT}"
  job-agent auto-apply http://localhost:5199/jobs --resume ./resume.json --headless --auto-gate
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
    case 'raw': {
      const url = positionals[0]
      if (!url) { console.error('raw requires a URL: job-agent raw <url>'); process.exit(2) }
      const llm = new LlmGateway(loadConfigWithFlags(f).model)
      if (!llm.hasKey) {
        console.error('⚠️  raw needs a model key. Set MODEL_API_KEY/OPENAI_API_KEY, ANTHROPIC_AUTH_TOKEN, or pass --model-key.')
        process.exit(2)
      }
      await run('raw', f, url)
      break
    }
    case 'fill': {
      const url = positionals[0]
      if (!url) { console.error('fill requires a URL: job-agent fill <url>'); process.exit(2) }
      const llm = new LlmGateway(loadConfigWithFlags(f).model)
      if (!llm.hasKey) {
        console.error('⚠️  fill needs a model key. Set MODEL_API_KEY/OPENAI_API_KEY, ANTHROPIC_AUTH_TOKEN, or pass --model-key.')
        console.error('    For an offline demo without a key, run: job-agent demo-form')
        process.exit(2)
      }
      await run('fill', f, url)
      break
    }
    case 'auto-apply': {
      const url = positionals[0]
      if (!url) { console.error('auto-apply requires a URL: job-agent auto-apply <url>'); process.exit(2) }
      await run('auto-apply', f, url)
      break
    }
    case 'alibaba-apply': {
      const llm = new LlmGateway(loadConfigWithFlags(f).model)
      if (!llm.hasKey) {
        console.error('⚠️  alibaba-apply needs a model key. Set MODEL_API_KEY/OPENAI_API_KEY, ANTHROPIC_AUTH_TOKEN, or pass --model-key.')
        console.error('    For read-only matching without a key, run: job-agent match')
        process.exit(2)
      }
      await run('raw', {
        ...f,
        prompt: f.prompt || DEFAULT_ALIBABA_APPLY_PROMPT,
      }, positionals[0] ?? loadConfigWithFlags(f).alibabaCareersUrl)
      break
    }
    case 'match': await run('match', f); break
    case 'demo-form': await run('demo-form', f); break
    case 'demo-research': await run('demo-research', f); break
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
