#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { generateAndWriteSafetyReport } from '../dist/policy/safety-report.js'
import { loadConfig } from '../dist/sdk/config.js'

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') flags.help = true
    else if (arg === '--run-id') flags.runId = requiredValue(argv, ++i, arg)
    else if (arg === '--session-id') flags.sessionId = requiredValue(argv, ++i, arg)
    else if (arg === '--trace-dir') flags.traceDir = requiredValue(argv, ++i, arg)
    else if (arg === '--run-dir') flags.runDir = requiredValue(argv, ++i, arg)
    else if (arg === '--output-dir') flags.outputDir = requiredValue(argv, ++i, arg)
    else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  return flags
}

function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (!value) throw new Error(`Option ${flag} requires a value.`)
  return value
}

function latestTraceDir(outputDir) {
  const tracesRoot = join(outputDir, 'traces')
  if (!existsSync(tracesRoot)) return undefined
  const dirs = readdirSync(tracesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(tracesRoot, entry.name)
      return { dir, mtimeMs: statSync(dir).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  return dirs[0]?.dir
}

const HELP = `
safety-report — generate safety-report.json from an existing Web Agent trace

USAGE
  node ./scripts/safety-report.mjs [options]

OPTIONS
  --run-id <id>        Resolve output/traces/run_<id>/run-manifest.json
  --session-id <id>    Resolve output/traces/<id>
  --trace-dir <path>   Read an explicit trace directory
  --run-dir <path>     Read an explicit legacy run directory
  --output-dir <path>  Override the configured TRACE_OUT_DIR
  -h, --help           Show this help

If no trace selector is provided, the latest directory under output/traces is used.
`

try {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.help) {
    console.log(HELP.trim())
    process.exit(0)
  }

  const config = loadConfig()
  const outputDir = resolve(flags.outputDir || config.trace.outDir)
  const traceDir = flags.traceDir
    ? resolve(flags.traceDir)
    : !flags.runId && !flags.sessionId && !flags.runDir
      ? latestTraceDir(outputDir)
      : undefined

  if (!flags.runId && !flags.sessionId && !traceDir && !flags.runDir) {
    throw new Error(`No trace found under ${join(outputDir, 'traces')}. Run a demo first or pass --run-id/--trace-dir.`)
  }

  const result = generateAndWriteSafetyReport({
    outputDir,
    runId: flags.runId,
    sessionId: flags.sessionId,
    traceDir,
    runDir: flags.runDir ? resolve(flags.runDir) : undefined,
  })

  console.log(`safety report : ${result.path}`)
  console.log(`run id        : ${result.report.runId}`)
  console.log(`status        : ${result.report.finalStatus}`)
  console.log(`summary       : ${result.report.summary}`)
  if (result.inputs.warnings.length > 0) {
    console.log('')
    console.log('warnings:')
    for (const warning of result.inputs.warnings) console.log(`- ${warning}`)
  }
} catch (error) {
  console.error(`safety-report failed: ${error instanceof Error ? error.message : String(error)}`)
  console.error('')
  console.error(HELP.trim())
  process.exit(1)
}
