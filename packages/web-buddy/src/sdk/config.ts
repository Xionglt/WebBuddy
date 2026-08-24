import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isPermissionMode, type PermissionMode } from '../permission/permission-types.js'
import type { ToolOrchestrationRuntimeModeV1 } from '../tools/tool-orchestrator.js'

export type { PermissionMode } from '../permission/permission-types.js'

/**
 * Minimal .env loader — keeps the SDK dependency-free (no dotenv).
 * Reads KEY=VALUE lines, ignores comments / blanks, does NOT override
 * values already present on process.env.
 */
function loadDotEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(filePath)) return out
  const text = readFileSync(filePath, 'utf8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export type LlmProvider = 'openai' | 'anthropic'
export type PromptCacheTtl = '5m' | '30m' | '1h' | '24h'

export interface PromptCacheConfig {
  /**
   * Undefined enables request-side caching only for the official provider
   * hosts. Set true to opt an explicitly compatible proxy in, or false to
   * disable cache-aware scheduling.
   */
  enabled?: boolean
  /** Provider/model cache lifetime used by the compaction scheduler. */
  ttl?: PromptCacheTtl
  /** Start treating the cache as expiring this many milliseconds before TTL. */
  safetyMarginMs?: number
}

export interface ModelConfig {
  /** API key (OpenAI `Authorization: Bearer`) or null. */
  apiKey: string | null
  /** Anthropic `x-api-key` token (used when provider='anthropic'). */
  authToken?: string | null
  /** Wire format / provider. */
  provider: LlmProvider
  /**
   * Base URL.
   *  - openai    → `${baseUrl}/chat/completions`
   *  - anthropic → `${baseUrl}/v1/messages` (baseUrl should already include any
   *                provider path, e.g. https://open.bigmodel.cn/api/anthropic)
   */
  baseUrl: string
  /** Model name to call. */
  name: string
  /** Anthropic API version header. */
  anthropicVersion?: string
  /** Provider-specific OpenAI-compatible request fields, e.g. Qwen enable_thinking. */
  extraBody?: Record<string, unknown>
  /** Prompt-cache request and lifecycle controls. */
  promptCache?: PromptCacheConfig
}

export interface BrowserRuntimeConfig {
  headless: boolean
  /** Inject visible cursor-move + element outline before click/type when headful. */
  visualHighlight: boolean
  /** Per-character typing delay (ms) so the fill process is visible. */
  typeDelayMs: number
  /** Playwright slowMo between actions (ms). */
  slowMoMs: number
  allowedDomains: string[]
  blockLocalhost: boolean
  viewport: { width: number; height: number }
  userAgent: string
  navigationTimeoutMs: number
  actionTimeoutMs: number
  keepBrowserOpen: boolean
}

export interface HumanLoopConfig {
  /** 'cli' prompts on stdin; 'auto' decides from policy without blocking. */
  mode: 'cli' | 'auto'
  /** User-facing permission profile. Defaults to safe. */
  permissionMode: PermissionMode
  /** Future explicit switch for final submit. Defaults false and is not exposed by CLI/env. */
  allowFinalSubmit: boolean
  /** Risk levels the legacy auto gate may approve without a human. */
  autoApproveRisk: Array<'L0' | 'L1' | 'L2'>
}

export interface AsyncTaskConfig {
  /** Feature flag for the local read-only Researcher/Comparison runtime. Disabled by default for rollout. */
  enabled: boolean
  maxQueuedTasks: number
  maxConcurrentReadOnlyLlmTasks: number
  maxConcurrentDeterministicTasks: number
  notificationWaitMs: number
}

/**
 * Trusted rollout input for foreground tool orchestration. Wave 4 only
 * activates `shadow`; other modes remain behaviorally serial until their
 * respective release gates are accepted.
 */
export interface ToolOrchestrationConfig {
  mode: ToolOrchestrationRuntimeModeV1
  maxConcurrency: number
  parallelAllowlist: readonly string[]
}

export interface BackgroundToolPilotConfig {
  /** Runtime kill switch. Default false. */
  enabled: boolean
  /** Trusted code/config allowlist; Wave 6 accepts exactly trace_summarization. */
  allowlist: readonly string[]
}

export interface AgentConfig {
  model: ModelConfig
  resumePath: string
  alibabaCareersUrl: string
  alibabaProbePositionId: string
  alibabaProbeJobTitle: string
  browser: BrowserRuntimeConfig
  trace: { outDir: string }
  human: HumanLoopConfig
  /** How many top job cards to open for detail before matching. */
  maxJobsToDetail: number
  /** How many list pages/batches to scan before coarse ranking. */
  maxJobPagesToCrawl: number
  /** Maximum unique list candidates to keep during fast crawl. */
  maxJobsToCrawl: number
  /** Minimum final match score required before entering an application flow. */
  matchThreshold: number
  /** Cookie-login (storageState) path. Empty → derive per host under trace.outDir/auth. */
  auth: { storageStatePath: string }
  /** Agent loop tuning. */
  agent: {
    maxSteps: number
    asyncTasks?: AsyncTaskConfig
    toolOrchestration: ToolOrchestrationConfig
    backgroundToolPilot: BackgroundToolPilotConfig
  }
  /** User-scoped runtime memory files. */
  memory: {
    answerStorePath: string
    permissionRulesPath: string
    memdirPath: string
  }
}

export interface AgentConfigOverrides extends Partial<Omit<
  AgentConfig,
  'model' | 'browser' | 'trace' | 'human' | 'auth' | 'agent' | 'memory'
>> {
  model?: Partial<ModelConfig>
  browser?: Partial<BrowserRuntimeConfig>
  trace?: Partial<AgentConfig['trace']>
  human?: Partial<HumanLoopConfig>
  auth?: Partial<AgentConfig['auth']>
  agent?: Partial<Omit<AgentConfig['agent'], 'asyncTasks' | 'toolOrchestration' | 'backgroundToolPilot'>> & {
    asyncTasks?: Partial<AsyncTaskConfig>
    toolOrchestration?: Partial<ToolOrchestrationConfig>
    backgroundToolPilot?: Partial<BackgroundToolPilotConfig>
  }
  memory?: Partial<AgentConfig['memory']>
}

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
)

function boolEnv(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined) return fallback
  return raw === 'true' || raw === '1' || raw === 'yes'
}

function optionalBoolEnv(env: Record<string, string | undefined>, key: string): boolean | undefined {
  return env[key] === undefined ? undefined : boolEnv(env, key, false)
}

function numEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function parseJsonObjectEnv(env: Record<string, string | undefined>, key: string): Record<string, unknown> {
  const raw = env[key]
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function promptCacheTtlEnv(env: Record<string, string | undefined>): PromptCacheTtl | undefined {
  const raw = env.MODEL_PROMPT_CACHE_TTL?.trim()
  if (!raw) return undefined
  if (raw === '5m' || raw === '30m' || raw === '1h' || raw === '24h') return raw
  throw new Error(`Invalid MODEL_PROMPT_CACHE_TTL="${raw}". Expected one of: 5m, 30m, 1h, 24h.`)
}

function permissionModeEnv(env: Record<string, string | undefined>): PermissionMode {
  const raw = env.PERMISSION_MODE
  if (raw === undefined || !raw.trim()) return 'safe'
  const value = raw.trim()
  if (isPermissionMode(value)) return value
  throw new Error(`Invalid PERMISSION_MODE="${raw}". Expected one of: safe, review, trusted, autopilot.`)
}

function humanGateModeEnv(env: Record<string, string | undefined>): HumanLoopConfig['mode'] {
  return env.HUMAN_GATE_MODE === 'auto' ? 'auto' : 'cli'
}

function toolOrchestrationModeEnv(env: Record<string, string | undefined>): ToolOrchestrationRuntimeModeV1 {
  const mode = env.WEB_BUDDY_TOOL_ORCHESTRATION_MODE
  return mode === 'shadow' || mode === 'serial' || mode === 'parallel' || mode === 'legacy'
    ? mode
    : 'legacy'
}

function toolOrchestrationMaxConcurrencyEnv(env: Record<string, string | undefined>): number {
  const requested = numEnv(env, 'WEB_BUDDY_MAX_TOOL_CONCURRENCY', 4)
  return Math.min(4, Math.max(1, Math.floor(requested)))
}

function expandKnownRecruitmentAllowedDomains(domains: string[]): string[] {
  const expanded = new Set(domains)
  if (expanded.has('talent-holding.alibaba.com')) {
    expanded.add('talent.alibaba.com')
  }
  return [...expanded]
}

function normalizeAllowedDomains(value: string | string[]): string[] {
  const domains = Array.isArray(value) ? value : value.split(',')
  return domains
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Build a fully-resolved AgentConfig.
 *
 * Resolution order for every value: explicit `overrides` > process.env > .env
 * file > baked default. The model API key comes from MODEL_API_KEY; when it is
 * absent the SDK still runs on the deterministic heuristic path.
 */
export function loadConfig(overrides: AgentConfigOverrides = {}): AgentConfig {
  const dotEnv = loadDotEnv(join(REPO_ROOT, '.env'))
  const dotEnvPkg = loadDotEnv(join(process.cwd(), '.env'))
  const env: Record<string, string | undefined> = {
    ...dotEnv,
    ...dotEnvPkg,
    ...process.env,
  }

  // Model resolution. Prefer an explicit override; then Anthropic-format env
  // (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL, e.g. Zhipu GLM); then OpenAI env.
  const envProvider = env.MODEL_PROVIDER === 'openai' || env.MODEL_PROVIDER === 'anthropic'
    ? env.MODEL_PROVIDER
    : undefined
  const ovrProvider = overrides.model?.provider ?? envProvider
  const anthropicToken = firstNonEmpty(env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY)
  const useAnthropic =
    ovrProvider ? ovrProvider === 'anthropic' : Boolean(overrides.model?.authToken ?? anthropicToken)
  const promptCacheEnabled = optionalBoolEnv(env, 'MODEL_PROMPT_CACHE_ENABLED')
  const promptCacheTtl = promptCacheTtlEnv(env)
  const promptCache: PromptCacheConfig = {
    ...(promptCacheEnabled !== undefined ? { enabled: promptCacheEnabled } : {}),
    ...(promptCacheTtl ? { ttl: promptCacheTtl } : {}),
    ...(env.MODEL_PROMPT_CACHE_SAFETY_MARGIN_MS !== undefined
      ? { safetyMarginMs: numEnv(env, 'MODEL_PROMPT_CACHE_SAFETY_MARGIN_MS', 0) }
      : {}),
    ...(overrides.model?.promptCache ?? {}),
  }

  let model: ModelConfig
  if (useAnthropic) {
    // GLM (open.bigmodel.cn) exposes its Anthropic-compat API under /api/anthropic.
    let base = (firstNonEmpty(env.ANTHROPIC_API_BASE, env.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com')
      .replace(/\/+$/, '')
    if (!base.includes('/api/anthropic') && base.includes('bigmodel.cn')) base += '/api/anthropic'
    model = {
      provider: 'anthropic',
      authToken: overrides.model?.authToken ?? anthropicToken,
      apiKey: overrides.model?.authToken ?? anthropicToken,
      baseUrl: overrides.model?.baseUrl ?? base,
      name: overrides.model?.name ?? firstNonEmpty(env.ANTHROPIC_MODEL) ?? 'glm-4.7',
      anthropicVersion: firstNonEmpty(env.ANTHROPIC_VERSION) ?? '2023-06-01',
      ...(Object.keys(promptCache).length ? { promptCache } : {}),
    }
  } else {
    const apiKey =
      overrides.model?.apiKey ?? firstNonEmpty(env.MODEL_API_KEY, env.OPENAI_API_KEY, env.DASHSCOPE_API_KEY)
    const baseUrl =
      overrides.model?.baseUrl ??
      firstNonEmpty(env.MODEL_BASE_URL, env.OPENAI_BASE_URL, env.DASHSCOPE_BASE_URL) ??
      'https://api.openai.com/v1'
    const modelName =
      overrides.model?.name ?? firstNonEmpty(env.MODEL_NAME, env.OPENAI_MODEL, env.DASHSCOPE_MODEL) ?? 'gpt-4o-mini'
    const extraBody = {
      ...parseJsonObjectEnv(env, 'MODEL_EXTRA_BODY_JSON'),
      ...(env.MODEL_ENABLE_THINKING === undefined
        ? {}
        : { enable_thinking: boolEnv(env, 'MODEL_ENABLE_THINKING', false) }),
      ...(overrides.model?.extraBody ?? {}),
    }
    model = {
      provider: 'openai',
      apiKey,
      baseUrl,
      name: modelName,
      ...(Object.keys(extraBody).length ? { extraBody } : {}),
      ...(Object.keys(promptCache).length ? { promptCache } : {}),
    }
  }

  const headless = boolEnv(env, 'PLAYWRIGHT_HEADLESS', true)
  const visualHighlight = boolEnv(env, 'PLAYWRIGHT_VISUAL_HIGHLIGHT', !headless)

  const allowedDomainsRaw = overrides.browser?.allowedDomains ?? env.PLAYWRIGHT_ALLOWED_DOMAINS ?? ''
  const allowedDomains = expandKnownRecruitmentAllowedDomains(normalizeAllowedDomains(allowedDomainsRaw))

  return {
    model,
    resumePath: overrides.resumePath ?? env.RESUME_PDF_PATH ?? join(REPO_ROOT, 'tmp', 'pdfs', 'resume.pdf'),
    alibabaCareersUrl:
      overrides.alibabaCareersUrl ?? env.ALIBABA_CAREERS_URL ?? 'https://talent-holding.alibaba.com/off-campus/position-list?lang=zh',
    alibabaProbePositionId:
      overrides.alibabaProbePositionId ?? env.ALIBABA_PROBE_POSITION_ID ?? env.DELIVERY_TARGET_POSITION_ID ?? '',
    alibabaProbeJobTitle:
      overrides.alibabaProbeJobTitle ?? env.ALIBABA_PROBE_JOB_TITLE ?? env.DELIVERY_TARGET_JOB_TITLE ?? '',
    browser: {
      headless,
      visualHighlight,
      typeDelayMs: numEnv(env, 'PLAYWRIGHT_TYPE_DELAY_MS', headless ? 0 : 12),
      slowMoMs: numEnv(env, 'PLAYWRIGHT_SLOWMO_MS', headless ? 0 : 80),
      allowedDomains,
      blockLocalhost: env.PLAYWRIGHT_BLOCK_LOCALHOST !== 'false',
      viewport: {
        width: numEnv(env, 'PLAYWRIGHT_VIEWPORT_WIDTH', 1280),
        height: numEnv(env, 'PLAYWRIGHT_VIEWPORT_HEIGHT', 840),
      },
      userAgent:
        env.PLAYWRIGHT_USER_AGENT ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      navigationTimeoutMs: numEnv(env, 'PLAYWRIGHT_NAVIGATION_TIMEOUT_MS', 45000),
      actionTimeoutMs: numEnv(env, 'PLAYWRIGHT_ACTION_TIMEOUT_MS', 12000),
      keepBrowserOpen: boolEnv(env, 'PLAYWRIGHT_KEEP_BROWSER_OPEN', false),
    },
    trace: {
      outDir: resolve(REPO_ROOT, overrides.trace?.outDir ?? env.TRACE_OUT_DIR ?? 'output'),
    },
    human: {
      mode: overrides.human?.mode ?? humanGateModeEnv(env),
      permissionMode: overrides.human?.permissionMode ?? permissionModeEnv(env),
      allowFinalSubmit: overrides.human?.allowFinalSubmit ?? false,
      autoApproveRisk: overrides.human?.autoApproveRisk ?? ['L0', 'L1', 'L2'],
    },
    maxJobsToDetail: overrides.maxJobsToDetail ?? numEnv(env, 'AGENT_MAX_JOBS_TO_DETAIL', 10),
    maxJobPagesToCrawl: overrides.maxJobPagesToCrawl ?? numEnv(env, 'AGENT_MAX_JOB_PAGES_TO_CRAWL', 5),
    maxJobsToCrawl: overrides.maxJobsToCrawl ?? numEnv(env, 'AGENT_MAX_JOBS_TO_CRAWL', 100),
    matchThreshold: overrides.matchThreshold ?? numEnv(env, 'AGENT_MATCH_THRESHOLD', 0.45),
    auth: { storageStatePath: env.PLAYWRIGHT_STORAGE_STATE ?? '' },
    agent: {
      maxSteps: numEnv(env, 'AGENT_MAX_STEPS', 16),
      asyncTasks: {
        enabled: overrides.agent?.asyncTasks?.enabled ?? boolEnv(env, 'WEB_BUDDY_ASYNC_TASKS_ENABLED', false),
        maxQueuedTasks: overrides.agent?.asyncTasks?.maxQueuedTasks ?? numEnv(env, 'WEB_BUDDY_ASYNC_TASK_MAX_QUEUED', 32),
        maxConcurrentReadOnlyLlmTasks: overrides.agent?.asyncTasks?.maxConcurrentReadOnlyLlmTasks
          ?? numEnv(env, 'WEB_BUDDY_ASYNC_TASK_MAX_LLM', 2),
        maxConcurrentDeterministicTasks: overrides.agent?.asyncTasks?.maxConcurrentDeterministicTasks
          ?? numEnv(env, 'WEB_BUDDY_ASYNC_TASK_MAX_DETERMINISTIC', 4),
        notificationWaitMs: overrides.agent?.asyncTasks?.notificationWaitMs
          ?? numEnv(env, 'WEB_BUDDY_ASYNC_TASK_WAIT_MS', 15_000),
      },
      toolOrchestration: {
        mode: overrides.agent?.toolOrchestration?.mode ?? toolOrchestrationModeEnv(env),
        maxConcurrency: overrides.agent?.toolOrchestration?.maxConcurrency
          ?? toolOrchestrationMaxConcurrencyEnv(env),
        // Kept empty until the Wave 5 allowlist gate. Model output cannot widen this.
        parallelAllowlist: overrides.agent?.toolOrchestration?.parallelAllowlist ?? [],
      },
      backgroundToolPilot: {
        enabled: overrides.agent?.backgroundToolPilot?.enabled
          ?? boolEnv(env, 'WEB_BUDDY_TRACE_SUMMARIZATION_BACKGROUND_ENABLED', false),
        allowlist: overrides.agent?.backgroundToolPilot?.allowlist
          ?? (boolEnv(env, 'WEB_BUDDY_TRACE_SUMMARIZATION_BACKGROUND_ENABLED', false) ? ['trace_summarization'] : []),
      },
    },
    memory: {
      answerStorePath: resolve(
        overrides.memory?.answerStorePath ??
          env.WEB_BUDDY_ANSWER_STORE_PATH ??
          join(defaultMemoryDir(env), 'answers.json'),
      ),
      permissionRulesPath: resolve(
        overrides.memory?.permissionRulesPath ??
          env.WEB_BUDDY_PERMISSION_RULES_PATH ??
          join(defaultMemoryDir(env), 'permission-rules.json'),
      ),
      memdirPath: resolve(
        overrides.memory?.memdirPath ??
          env.WEB_BUDDY_MEMDIR_PATH ??
          defaultMemoryDir(env),
      ),
    },
  }
}

function defaultMemoryDir(env: Record<string, string | undefined>): string {
  return env.WEB_BUDDY_MEMORY_DIR ?? join(homedir(), '.web-buddy', 'memory')
}

/** True when the user has supplied a model API key. Drives the LLM-enhanced path. */
export function hasModelKey(config: AgentConfig): boolean {
  return Boolean(config.model.apiKey && config.model.apiKey.trim())
}

export const repoRoot = REPO_ROOT
