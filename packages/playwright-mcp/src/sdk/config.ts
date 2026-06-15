import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export interface ModelConfig {
  /** OpenAI-compatible API key. null when the user has not configured one. */
  apiKey: string | null
  /** Base URL of an OpenAI-compatible endpoint. */
  baseUrl: string
  /** Model name to call. */
  name: string
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
}

export interface HumanLoopConfig {
  /** 'cli' prompts on stdin; 'auto' decides from policy without blocking. */
  mode: 'cli' | 'auto'
  /** Risk levels the auto gate may approve without a human. L3/L4 always gated. */
  autoApproveRisk: Array<'L0' | 'L1' | 'L2'>
}

export interface AgentConfig {
  model: ModelConfig
  resumePath: string
  alibabaCareersUrl: string
  alibabaProbeJobTitle: string
  browser: BrowserRuntimeConfig
  trace: { outDir: string }
  human: HumanLoopConfig
  /** How many top job cards to open for detail before matching. */
  maxJobsToDetail: number
  /** Cookie-login (storageState) path. Empty → derive per host under trace.outDir/auth. */
  auth: { storageStatePath: string }
  /** Agent loop tuning. */
  agent: { maxSteps: number }
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

function numEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Build a fully-resolved AgentConfig.
 *
 * Resolution order for every value: explicit `overrides` > process.env > .env
 * file > baked default. The model API key comes from MODEL_API_KEY; when it is
 * absent the SDK still runs on the deterministic heuristic path.
 */
export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dotEnv = loadDotEnv(join(REPO_ROOT, '.env'))
  const dotEnvPkg = loadDotEnv(join(process.cwd(), '.env'))
  const env: Record<string, string | undefined> = {
    ...dotEnv,
    ...dotEnvPkg,
    ...process.env,
  }

  const apiKey = overrides.model?.apiKey ?? env.MODEL_API_KEY ?? env.OPENAI_API_KEY ?? null
  const baseUrl =
    overrides.model?.baseUrl ?? env.MODEL_BASE_URL ?? env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  const modelName = overrides.model?.name ?? env.MODEL_NAME ?? env.OPENAI_MODEL ?? 'gpt-4o-mini'

  const headless = boolEnv(env, 'PLAYWRIGHT_HEADLESS', true)
  const visualHighlight = boolEnv(env, 'PLAYWRIGHT_VISUAL_HIGHLIGHT', !headless)

  const allowedDomainsRaw = overrides.browser?.allowedDomains ?? env.PLAYWRIGHT_ALLOWED_DOMAINS ?? ''
  const allowedDomains = allowedDomainsRaw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)

  return {
    model: { apiKey, baseUrl, name: modelName },
    resumePath: overrides.resumePath ?? env.RESUME_PDF_PATH ?? join(REPO_ROOT, 'tmp', 'pdfs', 'resume.pdf'),
    alibabaCareersUrl:
      overrides.alibabaCareersUrl ?? env.ALIBABA_CAREERS_URL ?? 'https://talent-holding.alibaba.com/off-campus/position-list?lang=zh',
    alibabaProbeJobTitle: overrides.alibabaProbeJobTitle ?? env.ALIBABA_PROBE_JOB_TITLE ?? '',
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
    },
    trace: {
      outDir: overrides.trace?.outDir ?? env.TRACE_OUT_DIR ?? join(REPO_ROOT, 'output'),
    },
    human: {
      mode: (env.HUMAN_GATE_MODE as 'cli' | 'auto' | undefined) ?? 'cli',
      autoApproveRisk: ['L0', 'L1', 'L2'],
    },
    maxJobsToDetail: overrides.maxJobsToDetail ?? numEnv(env, 'AGENT_MAX_JOBS_TO_DETAIL', 3),
    auth: { storageStatePath: env.PLAYWRIGHT_STORAGE_STATE ?? '' },
    agent: { maxSteps: numEnv(env, 'AGENT_MAX_STEPS', 16) },
  }
}

/** True when the user has supplied a model API key. Drives the LLM-enhanced path. */
export function hasModelKey(config: AgentConfig): boolean {
  return Boolean(config.model.apiKey && config.model.apiKey.trim())
}

export const repoRoot = REPO_ROOT
