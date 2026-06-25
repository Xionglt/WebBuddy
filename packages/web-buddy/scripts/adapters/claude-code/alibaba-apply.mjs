#!/usr/bin/env node
/**
 * Run the Alibaba application task through the Claude Code recovered runtime
 * (`packages/claude-code`) while exposing Web Buddy's Playwright browser tools
 * as an MCP server.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgentTraceSession } from '../../../dist/agent-trace/index.js'
import { recordStreamJsonTrace } from '../../../dist/agent-trace/stream-json.js'
import { buildRunManifest, writeRunManifest } from '../../../dist/metrics/trace-inputs.js'
import { generateAndWriteMetrics } from '../../../dist/metrics/writer.js'
import { createAgentState } from '../../../dist/state/agent-state.js'
import { agentStatePathForTraceDir, writeAgentStateSafe } from '../../../dist/state/store.js'

const DEFAULT_ALIBABA_URL = 'https://talent-holding.alibaba.com/off-campus/position-list?lang=zh'
const DEFAULT_TASK_PROMPT =
  '这是我的个人简历文件，然后现在我想去阿里官方招聘网站进行投递，然后请帮我找到适合我的岗位，然后帮我进行投递，填写表单，充分利用网站信息'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..', '..', '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
const CLAUDE_CODE_ROOT = join(REPO_ROOT, 'packages', 'claude-code')

const MCP_TOOL_NAMES = [
  'mcp__playwright__browser_open',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_click_text',
  'mcp__playwright__browser_form_snapshot',
  'mcp__playwright__browser_upload_file',
  'mcp__playwright__browser_fill_by_label',
  'mcp__playwright__browser_select_by_text',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_select',
  'mcp__playwright__browser_wait',
  'mcp__playwright__browser_screenshot',
]

function parseArgs(argv) {
  const out = {
    resume: undefined,
    noResume: false,
    url: undefined,
    prompt: undefined,
    preset: 'alibaba',
    allowedDomains: undefined,
    model: undefined,
    baseUrl: undefined,
    maxTurns: undefined,
    outputFormat: 'text',
    envFile: undefined,
    headless: false,
    keepBrowserOpen: true,
    dryRun: false,
    mcpDebug: false,
    permissionMode: 'bypassPermissions',
    saveFullPrompt: false,
    autoContinue: true,
    waitOnBlocked: true,
    handoffMode: 'terminal',
    continueFile: undefined,
    maxPasses: undefined,
    maxBlockedHandoffs: '3',
    runId: undefined,
    profile: 'debug',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`Option ${arg} requires a value`)
      return next
    }

    if (arg === '--resume') out.resume = value()
    else if (arg === '--no-resume') out.noResume = true
    else if (arg === '--url' || arg === '--list-url') out.url = value()
    else if (arg === '--prompt') out.prompt = value()
    else if (arg === '--preset') out.preset = value()
    else if (arg === '--allowed-domains') out.allowedDomains = value()
    else if (arg === '--model' || arg === '--model-name') out.model = value()
    else if (arg === '--base-url') out.baseUrl = value()
    else if (arg === '--max-turns') out.maxTurns = value()
    else if (arg === '--output-format') out.outputFormat = value()
    else if (arg === '--env-file') out.envFile = value()
    else if (arg === '--stream-json') out.outputFormat = 'stream-json'
    else if (arg === '--headless') out.headless = true
    else if (arg === '--headful') out.headless = false
    else if (arg === '--keep-browser-open' || arg === '--keep-open') out.keepBrowserOpen = true
    else if (arg === '--close-browser-on-exit' || arg === '--no-keep-browser-open') out.keepBrowserOpen = false
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--mcp-debug') out.mcpDebug = true
    else if (arg === '--permission-mode') out.permissionMode = value()
    else if (arg === '--save-full-prompt') out.saveFullPrompt = true
    else if (arg === '--no-auto-continue') out.autoContinue = false
    else if (arg === '--no-wait-on-blocked') out.waitOnBlocked = false
    else if (arg === '--handoff-mode') out.handoffMode = value()
    else if (arg === '--continue-file') out.continueFile = value()
    else if (arg === '--max-passes') out.maxPasses = value()
    else if (arg === '--max-blocked-handoffs') out.maxBlockedHandoffs = value()
    else if (arg === '--run-id') out.runId = value()
    else if (arg === '--profile') out.profile = value()
    else if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return out
}

function printHelp() {
  console.log(`Usage:
  npm run alibaba:apply -- --resume /path/to/resume.pdf [options]

Options:
  --resume <path>          Resume PDF/JSON/TXT. Defaults to RESUME_PDF_PATH.
  --no-resume              Run without resume context.
  --url <url>              Target careers URL. Defaults to Alibaba off-campus list.
  --prompt <text>          Override the task prompt.
  --preset <name>          Prompt preset: alibaba or generic. Default: alibaba.
  --allowed-domains <list> Comma-separated browser allowlist. Defaults to target host.
  --model <name>           Override ANTHROPIC_MODEL for claude-code.
  --base-url <url>         Override ANTHROPIC_BASE_URL for claude-code.
  --max-turns <n>          Optional Claude Code max agent turns. Omitted by default.
  --env-file <path>        Additional .env file to load before environment.
  --stream-json            Print Claude Code stream-json output.
  --headless / --headful   Hide/show Chromium. Default: headful.
  --keep-browser-open      Keep Chromium open after the MCP process exits. Default: on.
  --close-browser-on-exit  Close Chromium when the MCP process exits.
  --mcp-debug              Enable Claude Code MCP debug output.
  --save-full-prompt       Save full prompt, including resume text, under output/.
  --no-auto-continue       Do not restart Claude when it exits without a terminal status marker.
  --no-wait-on-blocked     Do not pause for manual login/captcha handoff when Claude reports BLOCKED.
  --handoff-mode <mode>    terminal or file. File mode waits for --continue-file.
  --continue-file <path>   In file handoff mode, continue after this file appears.
  --max-passes <n>         Optional wrapper continuation pass cap. Omitted by default.
  --max-blocked-handoffs <n> Maximum manual blocked handoffs. Default: 3. Use 0/none/unlimited for no cap.
  --run-id <id>            Stable Agent run id. Defaults to an ISO timestamp.
  --profile <name>         Run profile label for metrics. Default: debug.
  --dry-run                Print generated files and command without calling the model.
`)
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {}
  const result = {}
  const text = readFileSync(filePath, 'utf8')
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function normalizeAnthropicBaseUrl(value) {
  if (!value) return value
  let base = value.replace(/\/+$/, '')
  if (base.includes('bigmodel.cn') && !base.includes('/api/anthropic')) {
    base += '/api/anthropic'
  }
  return base
}

function buildEnv(flags) {
  const rootEnv = loadDotEnv(join(REPO_ROOT, '.env'))
  const packageEnv = loadDotEnv(join(CLAUDE_CODE_ROOT, '.env'))
  const explicitEnv = flags.envFile ? loadDotEnv(resolve(flags.envFile)) : {}
  const env = {
    ...rootEnv,
    ...packageEnv,
    ...explicitEnv,
    ...process.env,
  }

  if (flags.baseUrl) env.ANTHROPIC_BASE_URL = flags.baseUrl
  env.ANTHROPIC_BASE_URL = normalizeAnthropicBaseUrl(
    env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_BASE || 'https://open.bigmodel.cn/api/anthropic',
  )
  env.ANTHROPIC_MODEL = flags.model || env.ANTHROPIC_MODEL || 'glm-4.7'
  env.API_TIMEOUT_MS = env.API_TIMEOUT_MS || '3000000'
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1'
  env.CLAUDE_CODE_MAX_RETRIES = env.CLAUDE_CODE_MAX_RETRIES || '2'

  return env
}

function resolveResumePath(flags, env) {
  if (flags.noResume) return undefined
  const value = flags.resume || env.RESUME_PDF_PATH || join(REPO_ROOT, 'tmp', 'pdfs', 'resume.pdf')
  return resolve(value)
}

async function readResumeForPrompt(resumePath) {
  if (!resumePath) {
    return { rawText: '', profile: null }
  }
  if (!existsSync(resumePath)) {
    throw new Error(`Resume not found: ${resumePath}`)
  }

  const lower = resumePath.toLowerCase()
  const resumeModuleUrl = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'sdk', 'resume.js')).href
  const resumeModule = await import(resumeModuleUrl)

  let rawText = ''
  if (lower.endsWith('.pdf')) {
    rawText = await resumeModule.extractTextFromPdf(resumePath)
  } else {
    rawText = readFileSync(resumePath, 'utf8')
  }
  const profile = await resumeModule.readResume(resumePath)
  return { rawText, profile }
}

function targetHost(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function resolveAllowedDomains(flags, env, url) {
  if (flags.allowedDomains) return flags.allowedDomains
  if (env.PLAYWRIGHT_ALLOWED_DOMAINS) return env.PLAYWRIGHT_ALLOWED_DOMAINS
  const host = targetHost(url)
  return host || 'talent-holding.alibaba.com'
}

function truncate(value, max) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars]`
}

function buildPrompt({ taskPrompt, url, resumePath, resume, preset }) {
  const profileJson = resume.profile ? JSON.stringify(resume.profile, null, 2) : '(unable to parse structured profile)'
  const resumeText = truncate(resume.rawText || '', 14000)
  const resumeLines = resumePath
    ? [
        `简历文件路径：${resumePath}`,
        '',
        '简历结构化摘要：',
        '```json',
        profileJson,
        '```',
        '',
        '简历原文：',
        '```text',
        resumeText,
        '```',
      ]
    : [
        '本次任务没有提供简历文件。不要假设用户的个人信息；如果网页任务需要简历、联系方式或账号信息但页面无法继续，请输出 AGENT_STATUS=BLOCKED。',
      ]

  const common = [
    '你现在运行在 Claude Code recovered runtime 中，浏览器操作能力来自名为 playwright 的 MCP server。',
    '',
    '可用浏览器 MCP 工具：',
    '- mcp__playwright__browser_open',
    '- mcp__playwright__browser_snapshot',
    '- mcp__playwright__browser_click',
    '- mcp__playwright__browser_click_text',
    '- mcp__playwright__browser_form_snapshot',
    '- mcp__playwright__browser_upload_file',
    '- mcp__playwright__browser_fill_by_label',
    '- mcp__playwright__browser_select_by_text',
    '- mcp__playwright__browser_type',
    '- mcp__playwright__browser_select',
    '- mcp__playwright__browser_wait',
    '- mcp__playwright__browser_screenshot',
    '',
    '请只用这些浏览器工具完成网页操作。不要编写脚本爬取页面，不要使用固定流程；根据网站当前可见信息判断下一步。',
    '页面变化、点击失败、输入失败、ref 失效、弹窗出现、跳转登录页之后，必须重新调用 mcp__playwright__browser_snapshot 获取最新 refs。',
    '如果你决定点击提交、申请、投递、付款、删除等高风险按钮，并且这是完成用户目标所必需的，请在 mcp__playwright__browser_click 里传 confirmed=true。',
    '不要因为阶段性总结就停止；只有用户目标完成，或遇到短信验证码、扫码、真实身份验证、账号登录、人机验证、网站风控或其他必须人工处理的步骤，才输出最终回答。',
    '最终回答或阶段性总结不要复述用户手机号、邮箱、身份证号、住址等隐私字段；需要提及时只说“相关信息已从用户提供内容读取”。',
    '',
    '最终回答必须在最后一行包含且只包含以下状态标记之一：',
    '- AGENT_STATUS=COMPLETED：已经完成用户目标。',
    '- AGENT_STATUS=BLOCKED：遇到必须由用户处理的人机验证、扫码、短信验证码、账号登录、真实身份验证、网站风控或其他人工步骤。',
    '- AGENT_STATUS=INCOMPLETE：进程必须停止但目标尚未完成。除非发生无法继续的技术故障，否则不要主动选择这个状态；应继续使用浏览器工具推进。',
    '',
    `目标网站：${url}`,
    ...resumeLines,
    '',
    '用户目标：',
    taskPrompt,
  ]

  if (preset !== 'alibaba') return common.join('\n')

  return [
    ...common.slice(0, 17),
    '请根据网站当前可见信息自主搜索、筛选、比较、打开岗位、填写表单并推进投递目标。',
    '如果岗位标题、列表卡片或链接文字出现在页面正文中，但没有出现在 browser_snapshot refs 里，请使用 mcp__playwright__browser_click_text 按可见文本点击，不要因此停止。',
    '进入投递表单后，应优先寻找“上传简历 / 简历解析 / 附件简历 / PDF上传”等入口；如果存在，请使用 mcp__playwright__browser_upload_file 上传简历文件，并传 confirmed=true。',
    '上传简历并等待解析后，调用 mcp__playwright__browser_form_snapshot 检查字段、必填项、错误提示和上传状态，再用 mcp__playwright__browser_fill_by_label 与 mcp__playwright__browser_select_by_text 修正缺失或错误字段。',
    '如果普通 ref 输入失败、字段 ref 频繁变化、下拉框不是原生 select，请优先改用 form_snapshot + fill_by_label / select_by_text，而不是直接放弃。',
    ...common.slice(17, -2),
    '',
    '用户目标：',
    taskPrompt,
  ].join('\n')
}

function buildContinuationPrompt({ basePrompt, previousOutput, passIndex }) {
  return [
    `这是同一个网页投递任务的自动续跑第 ${passIndex} 轮。`,
    '上一轮 Claude CLI 已经退出，但外层没有看到 AGENT_STATUS=COMPLETED 或 AGENT_STATUS=BLOCKED，因此认为任务尚未完成。',
    '请继续推进同一用户目标，不要只总结上一轮。必要时重新打开目标网站、重新获取页面快照，并继续搜索、比较、填写或处理当前可见页面。',
    '如果上一轮其实已经完成或被人工步骤阻塞，请明确说明，并在最后一行输出对应的 AGENT_STATUS 标记。',
    '',
    '上一轮输出摘要：',
    '```text',
    truncate(previousOutput || '(no stdout captured)', 6000),
    '```',
    '',
    '原始任务上下文如下：',
    '',
    basePrompt,
  ].join('\n')
}

function buildManualHandoffContinuationPrompt({ basePrompt, previousOutput, passIndex }) {
  return [
    `这是同一个网页投递任务的人工步骤交接后续跑第 ${passIndex} 轮。`,
    '上一轮报告遇到登录、验证码、扫码或其他人工步骤，外层 wrapper 已经让用户在浏览器中处理，并保存了新的浏览器登录状态。',
    '请继续推进同一用户目标。不要只总结上一轮。先打开目标网站并获取最新页面快照，判断是否已经登录或是否仍被阻塞，然后继续搜索、比较、填写或投递。',
    '如果仍然被人工步骤阻塞，请说明当前阻塞点，并在最后一行输出 AGENT_STATUS=BLOCKED。',
    '',
    '上一轮输出摘要：',
    '```text',
    truncate(previousOutput || '(no stdout captured)', 6000),
    '```',
    '',
    '原始任务上下文如下：',
    '',
    basePrompt,
  ].join('\n')
}

function buildRedactedPromptRecord({ taskPrompt, url, resumePath, preset }) {
  return [
    `Claude Code recovered runtime + Playwright MCP run (preset=${preset}).`,
    '',
    `目标网站：${url}`,
    `简历文件路径：${resumePath || '(none)'}`,
    '',
    resumePath
      ? '简历内容：已脱敏省略。真实运行时会在内存中传给模型，不默认写入 output。'
      : '本次任务没有提供简历文件。',
    '',
    '用户目标：',
    taskPrompt,
  ].join('\n')
}

function writeMcpConfig({ runDir, env, flags }) {
  const configPath = join(runDir, 'mcp.playwright.json')
  const mcpEnv = {
    PLAYWRIGHT_HEADLESS: flags.headless ? 'true' : 'false',
    PLAYWRIGHT_VISUAL_HIGHLIGHT: flags.headless ? 'false' : 'true',
    PLAYWRIGHT_KEEP_BROWSER_OPEN: flags.keepBrowserOpen ? 'true' : env.PLAYWRIGHT_KEEP_BROWSER_OPEN || 'false',
    PLAYWRIGHT_BLOCK_LOCALHOST: env.PLAYWRIGHT_BLOCK_LOCALHOST || 'true',
    PLAYWRIGHT_ALLOWED_DOMAINS: flags.allowedDomains || env.PLAYWRIGHT_ALLOWED_DOMAINS || 'talent-holding.alibaba.com',
    PLAYWRIGHT_STORAGE_STATE: env.PLAYWRIGHT_STORAGE_STATE || '',
    PLAYWRIGHT_NAVIGATION_TIMEOUT_MS: env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || '90000',
    PLAYWRIGHT_ACTION_TIMEOUT_MS: env.PLAYWRIGHT_ACTION_TIMEOUT_MS || '20000',
    PLAYWRIGHT_SLOWMO_MS: env.PLAYWRIGHT_SLOWMO_MS || (flags.headless ? '0' : '80'),
    PLAYWRIGHT_TYPE_DELAY_MS: env.PLAYWRIGHT_TYPE_DELAY_MS || (flags.headless ? '0' : '12'),
    PLAYWRIGHT_VIEWPORT_WIDTH: env.PLAYWRIGHT_VIEWPORT_WIDTH || '1280',
    PLAYWRIGHT_VIEWPORT_HEIGHT: env.PLAYWRIGHT_VIEWPORT_HEIGHT || '840',
    AGENT_TRACE_ENABLED: env.AGENT_TRACE_ENABLED || '',
    AGENT_TRACE_SESSION_ID: env.AGENT_TRACE_SESSION_ID || '',
    AGENT_TRACE_RUN_ID: env.AGENT_TRACE_RUN_ID || '',
    AGENT_TRACE_OUT_DIR: env.AGENT_TRACE_OUT_DIR || '',
    AGENT_TRACE_MODE: env.AGENT_TRACE_MODE || 'redacted',
    AGENT_TRACE_SCENARIO: env.AGENT_TRACE_SCENARIO || '',
    AGENT_TRACE_PROFILE: env.AGENT_TRACE_PROFILE || '',
    AGENT_TRACE_MODEL: env.AGENT_TRACE_MODEL || '',
    AGENT_TRACE_PROVIDER: env.AGENT_TRACE_PROVIDER || '',
  }

  const config = {
    mcpServers: {
      playwright: {
        command: process.execPath,
        args: [join(PACKAGE_ROOT, 'dist', 'server.js')],
        env: mcpEnv,
      },
    },
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2))
  return configPath
}

function redactCommand(args) {
  return args.map((arg) => (arg.includes('AUTH_TOKEN') || arg.includes('API_KEY') ? '[redacted]' : arg)).join(' ')
}

function normalizeMaxTurns(value) {
  if (value === undefined) return undefined
  const trimmed = String(value).trim().toLowerCase()
  if (!trimmed || trimmed === '0' || trimmed === 'none' || trimmed === 'unlimited') return undefined
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --max-turns value: ${value}`)
  }
  return String(parsed)
}

function normalizeMaxPasses(value) {
  if (value === undefined) return undefined
  const trimmed = String(value).trim().toLowerCase()
  if (!trimmed || trimmed === '0' || trimmed === 'none' || trimmed === 'unlimited') return undefined
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --max-passes value: ${value}`)
  }
  return parsed
}

function normalizeOptionalPositiveInt(value, optionName) {
  if (value === undefined) return undefined
  const trimmed = String(value).trim().toLowerCase()
  if (!trimmed || trimmed === '0' || trimmed === 'none' || trimmed === 'unlimited') return undefined
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${optionName} value: ${value}`)
  }
  return parsed
}

function normalizeRunId(value) {
  const raw = value || new Date().toISOString().replace(/[:.]/g, '-')
  const safe = String(raw).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
  return safe || new Date().toISOString().replace(/[:.]/g, '-')
}

function writeRuntimeMetrics({ runId, trace, runDir, scenario, profile }) {
  if (!trace) return
  try {
    generateAndWriteMetrics({
      runId,
      sessionId: trace.sessionId,
      source: 'claude-runtime',
      scenario,
      profile,
      traceDir: trace.dir,
      runDir,
      outputDir: join(REPO_ROOT, 'output'),
    })
  } catch (error) {
    trace.recordEvent('metrics_error', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function writeRuntimeAgentState({ runId, trace, scenario, profile, goal, stage, currentUrl, lastAction, lastFailure, finalStatus }) {
  if (!trace) return
  writeAgentStateSafe(createAgentState({
    runId,
    sessionId: trace.sessionId,
    source: 'claude-runtime',
    scenario,
    profile,
    goal,
    stage,
    currentUrl,
    lastAction,
    lastFailure,
    finalStatus,
  }), agentStatePathForTraceDir(trace.dir))
}

function appendRunEvent(logPath, event, data = {}) {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    })}\n`,
  )
}

function classifyAgentStatus(stdout) {
  const text = stdout || ''
  if (/AGENT_STATUS\s*=\s*COMPLETED/i.test(text)) return 'completed'
  if (/AGENT_STATUS\s*=\s*BLOCKED/i.test(text)) return 'blocked'
  if (/AGENT_STATUS\s*=\s*INCOMPLETE/i.test(text)) return 'incomplete'
  return 'missing-marker'
}

function isManualBlockedOutput(stdout) {
  return /登录|登陆|验证码|扫码|身份验证|人机验证|风控|人工|sign\s*in|log\s*in|captcha|verification/i.test(stdout || '')
}

async function waitForUserContinue({ message, flags, runLogPath, handoffIndex }) {
  if (flags.handoffMode === 'file') {
    if (!flags.continueFile) throw new Error('--continue-file is required when --handoff-mode=file')
    rmSync(flags.continueFile, { force: true })
    appendRunEvent(runLogPath, 'manual_handoff_waiting_for_continue_file', {
      handoffIndex,
      continueFile: flags.continueFile,
    })
    console.log(`WEB_HANDOFF_WAITING ${JSON.stringify({ handoffIndex, continueFile: flags.continueFile })}`)
    while (!existsSync(flags.continueFile)) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    appendRunEvent(runLogPath, 'manual_handoff_continue_file_seen', {
      handoffIndex,
      continueFile: flags.continueFile,
    })
    rmSync(flags.continueFile, { force: true })
    return
  }

  if (!process.stdin.isTTY) {
    console.log(`${message}\n当前 stdin 不是交互终端，等待 120 秒后继续。`)
    await new Promise((resolve) => setTimeout(resolve, 120000))
    return
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    await rl.question(`${message}\n完成后按 Enter 继续：`)
  } finally {
    rl.close()
  }
}

async function performManualBrowserHandoff({ env, flags, url, runDir, runLogPath, handoffIndex }) {
  const storageStatePath = join(runDir, `manual-handoff-storage-${handoffIndex}.json`)
  const { chromium } = await import('playwright')

  appendRunEvent(runLogPath, 'manual_handoff_start', {
    handoffIndex,
    storageStatePath,
  })

  const browser = await chromium.launch({
    headless: false,
    slowMo: Number(env.PLAYWRIGHT_SLOWMO_MS || (flags.headless ? '0' : '80')),
  })
  const contextOptions = {
    viewport: {
      width: Number(env.PLAYWRIGHT_VIEWPORT_WIDTH || '1280'),
      height: Number(env.PLAYWRIGHT_VIEWPORT_HEIGHT || '840'),
    },
    userAgent:
      env.PLAYWRIGHT_USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  }
  const existingStorageState = env.PLAYWRIGHT_STORAGE_STATE || ''
  if (existingStorageState && existsSync(existingStorageState)) {
    contextOptions.storageState = existingStorageState
  }

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Number(env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS || '90000'),
    })
  } catch (error) {
    appendRunEvent(runLogPath, 'manual_handoff_open_failed', {
      handoffIndex,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  console.log('')
  console.log('Claude 报告遇到需要人工处理的步骤。')
  console.log('我已经打开一个浏览器窗口，请你在里面完成登录、验证码、扫码或其他人工步骤。')
  console.log(flags.handoffMode === 'file'
    ? '完成后回到 Web 控制台点击继续，我会保存登录状态并继续同一个任务。'
    : '完成后回到这个终端按 Enter，我会保存登录状态并继续同一个任务。')
  await waitForUserContinue({ message: '人工步骤交接', flags, runLogPath, handoffIndex })

  await context.storageState({ path: storageStatePath })
  env.PLAYWRIGHT_STORAGE_STATE = storageStatePath
  await browser.close()

  appendRunEvent(runLogPath, 'manual_handoff_saved_storage', {
    handoffIndex,
    storageStatePath,
  })

  return storageStatePath
}

async function runClaudePass({ cliArgs, env, prompt, runLogPath, stdoutLogPath, stderrLogPath, streamJsonLogPath, passIndex, flags }) {
  appendFileSync(stdoutLogPath, `\n\n===== PASS ${passIndex} STDOUT ${new Date().toISOString()} =====\n`)
  appendFileSync(stderrLogPath, `\n\n===== PASS ${passIndex} STDERR ${new Date().toISOString()} =====\n`)
  if (streamJsonLogPath) {
    appendFileSync(streamJsonLogPath, `\n`)
  }

  const child = spawn(process.execPath, cliArgs, {
    cwd: REPO_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  appendRunEvent(runLogPath, 'spawn', {
    passIndex,
    command: `${process.execPath} ${redactCommand(cliArgs)} < [prompt omitted]`,
    maxTurns: flags.maxTurns || null,
    keepBrowserOpen: flags.keepBrowserOpen,
    headless: flags.headless,
  })

  let stdout = ''
  let stderr = ''

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    const text = chunk.toString('utf8')
    stdout += text
    appendFileSync(stdoutLogPath, text)
    if (streamJsonLogPath) appendFileSync(streamJsonLogPath, text)
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    const text = chunk.toString('utf8')
    stderr += text
    appendFileSync(stderrLogPath, text)
  })

  child.stdin.on('error', (error) => {
    appendRunEvent(runLogPath, 'stdin_error', {
      passIndex,
      message: error instanceof Error ? error.message : String(error),
    })
  })
  child.stdin.end(prompt)

  const { exitCode, signal } = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, sig) => {
      resolve({ exitCode: code ?? 0, signal: sig })
    })
  })

  appendRunEvent(runLogPath, 'exit', {
    passIndex,
    exitCode,
    signal,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  })

  return {
    exitCode: signal ? 128 : exitCode,
    signal,
    stdout,
    stderr,
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const env = buildEnv(flags)
  if (!['alibaba', 'generic'].includes(flags.preset)) {
    throw new Error(`Invalid --preset value: ${flags.preset}`)
  }
  if (!['terminal', 'file'].includes(flags.handoffMode)) {
    throw new Error(`Invalid --handoff-mode value: ${flags.handoffMode}`)
  }
  if (flags.handoffMode === 'file' && !flags.continueFile) {
    throw new Error('--continue-file is required when --handoff-mode=file')
  }
  flags.maxTurns = normalizeMaxTurns(flags.maxTurns)
  flags.maxPasses = normalizeMaxPasses(flags.maxPasses)
  flags.maxBlockedHandoffs = normalizeOptionalPositiveInt(flags.maxBlockedHandoffs, '--max-blocked-handoffs')
  flags.profile = String(flags.profile || 'debug').trim() || 'debug'
  const resumePath = resolveResumePath(flags, env)
  const url = flags.url || (flags.preset === 'alibaba' ? env.ALIBABA_CAREERS_URL || DEFAULT_ALIBABA_URL : '')
  if (!url) throw new Error('Missing target URL. Pass --url for generic web tasks.')
  flags.allowedDomains = resolveAllowedDomains(flags, env, url)
  const taskPrompt = flags.prompt || (flags.preset === 'alibaba' ? DEFAULT_TASK_PROMPT : '请根据用户目标操作这个网页，并在完成或被人工步骤阻塞时按要求输出状态标记。')

  const hasCredential = Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN)
  if (!flags.dryRun && !hasCredential) {
    throw new Error('Missing model credential. Set ANTHROPIC_AUTH_TOKEN in repo .env or environment.')
  }

  const resume = await readResumeForPrompt(resumePath)
  const runId = normalizeRunId(flags.runId)
  const runDir = join(REPO_ROOT, 'output', 'claude-runtime', runId)
  mkdirSync(runDir, { recursive: true })
  const runLogPath = join(runDir, 'run-events.log')
  const stdoutLogPath = join(runDir, 'stdout.log')
  const stderrLogPath = join(runDir, 'stderr.log')
  const streamJsonLogPath = flags.outputFormat === 'stream-json' ? join(runDir, 'stream.jsonl') : undefined
  const scenario = flags.preset === 'alibaba' ? 'alibaba-apply' : 'generic-web'

  const prompt = buildPrompt({ taskPrompt, url, resumePath, resume, preset: flags.preset })
  const promptPath = join(runDir, flags.saveFullPrompt ? 'prompt.full.txt' : 'prompt.redacted.txt')
  const promptRecord = flags.saveFullPrompt ? prompt : buildRedactedPromptRecord({ taskPrompt, url, resumePath, preset: flags.preset })
  writeFileSync(promptPath, promptRecord)

  const traceOutDir = join(REPO_ROOT, 'output', 'traces')
  const trace = createAgentTraceSession({
    sessionId: `claude_${runId}`,
    runId,
    outDir: traceOutDir,
    source: 'claude-runtime',
    scenario,
    profile: flags.profile,
    model: env.ANTHROPIC_MODEL,
    provider: 'anthropic',
    userPrompt: promptRecord,
    metadata: {
      runDir,
      runLogPath,
      stdoutLogPath,
      stderrLogPath,
      streamJsonLogPath,
      promptPath,
      outputFormat: flags.outputFormat,
      preset: flags.preset,
      profile: flags.profile,
      allowedDomains: flags.allowedDomains,
      url,
      resumePath,
    },
  })
  if (trace) {
    env.AGENT_TRACE_ENABLED = '1'
    env.AGENT_TRACE_SESSION_ID = trace.sessionId
    env.AGENT_TRACE_RUN_ID = runId
    env.AGENT_TRACE_OUT_DIR = traceOutDir
    env.AGENT_TRACE_MODE = trace.redactionMode
    env.AGENT_TRACE_SCENARIO = scenario
    env.AGENT_TRACE_PROFILE = flags.profile
    env.AGENT_TRACE_MODEL = env.ANTHROPIC_MODEL
    env.AGENT_TRACE_PROVIDER = 'anthropic'
    trace.recordEvent('runtime_files', {
      runDir,
      runLogPath,
      stdoutLogPath,
      stderrLogPath,
      streamJsonLogPath,
      promptPath,
      preset: flags.preset,
      allowedDomains: flags.allowedDomains,
      profile: flags.profile,
    })
    writeRuntimeAgentState({
      runId,
      trace,
      scenario,
      profile: flags.profile,
      goal: taskPrompt,
      stage: 'init',
      currentUrl: url,
      finalStatus: 'incomplete',
    })
  }

  const mcpConfigPath = writeMcpConfig({ runDir, env, flags })
  if (trace) {
    try {
      const manifestPath = writeRunManifest(buildRunManifest({
        runId,
        sessionId: trace.sessionId,
        source: 'claude-runtime',
        scenario,
        profile: flags.profile,
        runDir,
        traceDir: trace.dir,
        files: {
          sessionJson: join(trace.dir, 'session.json'),
          spansJsonl: join(trace.dir, 'spans.jsonl'),
          eventsJsonl: join(trace.dir, 'events.jsonl'),
          stdoutLog: stdoutLogPath,
          stderrLog: stderrLogPath,
          streamJsonl: streamJsonLogPath,
          runLog: runLogPath,
          prompt: promptPath,
        },
        metadata: {
          mcpConfigPath,
          outputFormat: flags.outputFormat,
          preset: flags.preset,
          profile: flags.profile,
        },
      }))
      trace.recordEvent('run_manifest', {
        path: manifestPath,
        runId,
        sessionId: trace.sessionId,
      })
    } catch (error) {
      trace.recordEvent('run_manifest_error', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const cliArgs = [
    join(CLAUDE_CODE_ROOT, 'dist', 'cli.js'),
    '--print',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    '--tools',
    '',
    '--allowedTools',
    MCP_TOOL_NAMES.join(','),
    '--dangerously-skip-permissions',
    '--permission-mode',
    flags.permissionMode,
    '--model',
    env.ANTHROPIC_MODEL,
  ]

  if (flags.maxTurns) {
    cliArgs.push('--max-turns', flags.maxTurns)
  }

  if (flags.outputFormat === 'stream-json') {
    cliArgs.push('--output-format', 'stream-json', '--verbose')
  } else {
    cliArgs.push('--output-format', 'text')
  }
  if (flags.mcpDebug) cliArgs.push('--mcp-debug')

  console.log('Claude runtime run directory:', runDir)
  console.log('MCP config:', mcpConfigPath)
  console.log('Prompt:', promptPath)
  console.log('Run events:', runLogPath)
  console.log('Stdout log:', stdoutLogPath)
  console.log('Stderr log:', stderrLogPath)
  if (streamJsonLogPath) console.log('Stream JSON:', streamJsonLogPath)
  if (trace) console.log('Agent trace:', trace.dir)
  console.log('Runtime: packages/claude-code (Claude Code recovered source)')
  console.log('Browser MCP: packages/web-buddy/dist/server.js')
  console.log('Preset:', flags.preset)
  console.log('Profile:', flags.profile)
  console.log('Allowed domains:', flags.allowedDomains)
  console.log('Handoff mode:', flags.handoffMode)
  console.log('Claude max turns:', flags.maxTurns || 'unlimited')
  console.log('Keep browser open:', flags.keepBrowserOpen ? 'true' : 'false')
  console.log('Auto continue:', flags.autoContinue ? 'true' : 'false')
  console.log('Max passes:', flags.maxPasses || 'unlimited')
  console.log('Wait on blocked:', flags.waitOnBlocked ? 'true' : 'false')
  console.log('Max blocked handoffs:', flags.maxBlockedHandoffs || 'unlimited')

  if (flags.dryRun) {
    if (!hasCredential) {
      console.log('Dry run note: no model credential was found; a real run will require ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY.')
    }
    console.log('Dry run command:')
    console.log(`${process.execPath} ${redactCommand(cliArgs)} < [prompt omitted; see ${promptPath}]`)
    trace?.finalize({
      status: 'cancelled',
      finalAnswer: 'dry-run',
      metadata: {
        stopReason: 'dry-run',
        runLogPath,
        stdoutLogPath,
        stderrLogPath,
        streamJsonLogPath,
      },
    })
    writeRuntimeAgentState({
      runId,
      trace,
      scenario,
      profile: flags.profile,
      goal: taskPrompt,
      stage: 'done',
      currentUrl: url,
      lastAction: { action: 'dry-run' },
      finalStatus: 'incomplete',
    })
    writeRuntimeMetrics({ runId, trace, runDir, scenario, profile: flags.profile })
    return
  }

  let passIndex = 1
  let nextPrompt = prompt
  let lastExitCode = 0
  let blockedHandoffs = 0
  let stopReason = 'unknown'

  while (true) {
    const passSpan = trace?.startSpan({
      spanType: 'runtime_event',
      name: 'claude_pass',
      input: {
        passIndex,
        prompt: nextPrompt,
      },
      metadata: {
        outputFormat: flags.outputFormat,
        maxTurns: flags.maxTurns || null,
      },
    })
    const result = await runClaudePass({
      cliArgs,
      env,
      prompt: nextPrompt,
      runLogPath,
      stdoutLogPath,
      stderrLogPath,
      streamJsonLogPath,
      passIndex,
      flags,
    })
    lastExitCode = result.exitCode
    const streamTraceSummary = flags.outputFormat === 'stream-json'
      ? recordStreamJsonTrace(trace, result.stdout, {
          passIndex,
          parentSpanId: passSpan?.spanId,
        })
      : undefined
    passSpan?.end({
      status: result.exitCode === 0 ? 'success' : 'failed',
      output: {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        streamTraceSummary,
      },
    })
    writeRuntimeAgentState({
      runId,
      trace,
      scenario,
      profile: flags.profile,
      goal: taskPrompt,
      stage: 'claude_pass',
      currentUrl: url,
      lastAction: {
        passIndex,
        exitCode: result.exitCode,
        signal: result.signal,
      },
      lastFailure: result.exitCode === 0 ? undefined : {
        category: 'model',
        message: result.stderr || `Claude pass exited with ${result.exitCode}`,
        recoverable: false,
      },
      finalStatus: 'incomplete',
    })

    if (result.exitCode !== 0) {
      stopReason = 'nonzero-exit'
      appendRunEvent(runLogPath, 'stop', {
        reason: 'nonzero-exit',
        passIndex,
        exitCode: result.exitCode,
      })
      break
    }

    const status = classifyAgentStatus(result.stdout)
    appendRunEvent(runLogPath, 'agent_status', {
      passIndex,
      status,
    })

    if (status === 'completed') {
      stopReason = status
      appendRunEvent(runLogPath, 'stop', {
        reason: status,
        passIndex,
      })
      break
    }

    if (status === 'blocked') {
      if (
        flags.autoContinue &&
        flags.waitOnBlocked &&
        isManualBlockedOutput(result.stdout) &&
        (!flags.maxBlockedHandoffs || blockedHandoffs < flags.maxBlockedHandoffs)
      ) {
        blockedHandoffs += 1
        await performManualBrowserHandoff({
          env,
          flags,
          url,
          runDir,
          runLogPath,
          handoffIndex: blockedHandoffs,
        })
        writeMcpConfig({ runDir, env, flags })
        appendRunEvent(runLogPath, 'auto_continue_after_manual_handoff', {
          fromPass: passIndex,
          handoffIndex: blockedHandoffs,
        })
        passIndex += 1
        nextPrompt = buildManualHandoffContinuationPrompt({
          basePrompt: prompt,
          previousOutput: result.stdout,
          passIndex,
        })
        continue
      }

      appendRunEvent(runLogPath, 'stop', {
        reason: status,
        passIndex,
        waitOnBlocked: flags.waitOnBlocked,
        blockedHandoffs,
      })
      stopReason = status
      break
    }

    if (!flags.autoContinue) {
      stopReason = 'auto-continue-disabled'
      appendRunEvent(runLogPath, 'stop', {
        reason: 'auto-continue-disabled',
        passIndex,
        status,
      })
      break
    }

    if (flags.maxPasses && passIndex >= flags.maxPasses) {
      stopReason = 'max-passes'
      appendRunEvent(runLogPath, 'stop', {
        reason: 'max-passes',
        passIndex,
        status,
      })
      lastExitCode = 2
      break
    }

    appendRunEvent(runLogPath, 'auto_continue', {
      fromPass: passIndex,
      status,
    })
    passIndex += 1
    nextPrompt = buildContinuationPrompt({
      basePrompt: prompt,
      previousOutput: result.stdout,
      passIndex,
    })
  }

  trace?.finalize({
    status: stopReason === 'completed' ? 'success' : lastExitCode === 0 ? 'cancelled' : 'failed',
    finalAnswer: stopReason,
    metadata: {
      stopReason,
      lastExitCode,
      blockedHandoffs,
      passIndex,
      runLogPath,
      stdoutLogPath,
      stderrLogPath,
      streamJsonLogPath,
    },
  })
  writeRuntimeAgentState({
    runId,
    trace,
    scenario,
    profile: flags.profile,
    goal: taskPrompt,
    stage: 'done',
    currentUrl: url,
    lastAction: { stopReason, passIndex, blockedHandoffs },
    lastFailure: stopReason === 'completed' ? undefined : {
      category: stopReason === 'blocked' ? 'login' : 'unknown',
      message: stopReason,
      recoverable: stopReason === 'blocked',
    },
    finalStatus: stopReason === 'completed' ? 'completed' : stopReason === 'blocked' ? 'blocked' : lastExitCode === 0 ? 'incomplete' : 'failed',
  })
  writeRuntimeMetrics({ runId, trace, runDir, scenario, profile: flags.profile })
  process.exitCode = lastExitCode
}

main().catch((error) => {
  console.error(`claude-runtime-alibaba failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
