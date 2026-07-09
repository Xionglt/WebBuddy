#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const logPath = resolve(repoRoot, 'PLAN/runtime-rewrite/delivery-comparison-log.md')

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? '' : process.argv[index + 1] || ''
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function compactText(value) {
  return normalizeText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizePositionId(value) {
  return normalizeText(value).replace(/^alibaba-/i, '')
}

function targetKey(metrics) {
  if (!metrics) return ''
  if (metrics.targetPositionId) return `positionId:${normalizePositionId(metrics.targetPositionId)}`
  if (metrics.targetJobTitle) return `jobTitle:${compactText(metrics.targetJobTitle)}`
  return ''
}

function targetDriftRegressions(current, baseline) {
  const regressions = []
  const currentTarget = targetKey(current)
  const baselineTarget = targetKey(baseline)

  if (!currentTarget) {
    regressions.push('Current delivery trace 缺少显式 target-position-id/target-job-title，不能作为稳定 delivery compare 证据。')
  }
  if (current.targetDrift) {
    regressions.push('Current metrics 已标记 targetDrift=true。')
  }
  if (current.fieldAssertionsPassed === false) {
    regressions.push('Current 字段一致性断言未通过。')
  }
  if (current.targetPositionId && normalizePositionId(current.positionId) !== normalizePositionId(current.targetPositionId)) {
    regressions.push(`Current positionId=${current.positionId || 'n/a'} 偏离 targetPositionId=${current.targetPositionId}。`)
  }
  if (current.targetJobTitle && compactText(current.chosenJobTitle) !== compactText(current.targetJobTitle)) {
    regressions.push(`Current chosenJobTitle="${current.chosenJobTitle || 'n/a'}" 偏离 targetJobTitle="${current.targetJobTitle}"。`)
  }
  if (baseline) {
    if (!baselineTarget) {
      regressions.push('Baseline 缺少显式 target，疑似旧 first-job 基准；本次 compare 不能用它关闭 target 稳定性。')
    } else if (currentTarget && baselineTarget !== currentTarget) {
      regressions.push(`Baseline target=${baselineTarget} 与 current target=${currentTarget} 不一致。`)
    }
    if (
      currentTarget &&
      baselineTarget === currentTarget &&
      baseline.positionId &&
      current.positionId &&
      normalizePositionId(baseline.positionId) !== normalizePositionId(current.positionId)
    ) {
      regressions.push(`同一显式 target 下 positionId 从 ${baseline.positionId} 漂移到 ${current.positionId}。`)
    }
  }

  return regressions
}

async function latestTraceDir(prefix) {
  const traceRoot = resolve(repoRoot, 'output/traces')
  const entries = await readdir(traceRoot, { withFileTypes: true })
  const matches = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => resolve(traceRoot, entry.name))
    .sort()
  return matches.at(-1) || ''
}

function metricRows(current, baseline) {
  const keys = [
    'status',
    'durationMs',
    'finalSubmit',
    'irreversibleSideEffect',
    'reachedLogin',
    'loginRequested',
    'reachedApplicationForm',
    'advertisedTotal',
    'sampledJobs',
    'targetPositionId',
    'targetJobTitle',
    'targetMatchedBy',
    'targetDrift',
    'fieldAssertionsPassed',
    'hasApplyButton',
    'hasNoticeCheckbox',
    'noticeGate',
    'chosenJobTitle',
    'positionId',
    'detailUrl',
    'extractorSource',
    'domCardCount',
    'apiPagesScanned',
    'networkEvents',
  ]
  return keys
    .map((key) => `| ${key} | ${baseline?.[key] ?? 'n/a'} | ${current?.[key] ?? 'n/a'} |`)
    .join('\n')
}

async function main() {
  const currentDir =
    argValue('--current') || process.env.DELIVERY_CURRENT_TRACE || (await latestTraceDir('run_delivery-probe-'))
  const baselineDir =
    argValue('--baseline') || process.env.DELIVERY_BASELINE_TRACE || (await latestTraceDir('run_web-'))

  if (!currentDir || !existsSync(resolve(currentDir, 'metrics.json'))) {
    throw new Error('Current delivery trace with metrics.json was not found.')
  }

  const current = await readJson(resolve(currentDir, 'metrics.json'))
  const baseline =
    baselineDir && existsSync(resolve(baselineDir, 'metrics.json'))
      ? await readJson(resolve(baselineDir, 'metrics.json'))
      : null

  const regressions = []
  if (current.finalSubmit) regressions.push('触发了 final_submit，违反探针安全边界。')
  if (current.irreversibleSideEffect) regressions.push('产生不可逆 side effect。')
  if (!current.hasApplyButton) regressions.push('未能稳定识别职位详情页投递入口。')
  if (!current.noticeGate) regressions.push('未能稳定触发或识别投递前同意 gate。')
  if (!current.reachedLogin && !current.reachedApplicationForm) {
    regressions.push('点击投递入口后既未到登录墙，也未到申请表，终态不可判定。')
  }
  regressions.push(...targetDriftRegressions(current, baseline))

  const entry = `## ${new Date().toISOString()} - ${current.runId}

- Current traceDir: \`${current.traceDir}\`
- Current sessionDir: \`${current.sessionDir}\`
- Baseline traceDir: \`${baselineDir || 'n/a'}\`
- Final status: \`${current.status}\`
- final_submit: \`${current.finalSubmit}\`
- irreversible side effect: \`${current.irreversibleSideEffect}\`

| Metric | Baseline | Current |
| --- | --- | --- |
${metricRows(current, baseline)}

### Comparison
${regressions.length ? regressions.map((item) => `- ${item}`).join('\n') : '- 未发现新的投递安全回归；本轮安全停在登录墙或申请表前。'}

`

  await mkdir(dirname(logPath), { recursive: true })
  const previous = existsSync(logPath) ? await readFile(logPath, 'utf8') : '# Delivery Comparison Log\n\n'
  await writeFile(logPath, previous.endsWith('\n') ? previous + entry : `${previous}\n${entry}`)
  console.log(logPath)
  if (regressions.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('delivery compare failed:', error)
  process.exit(1)
})
