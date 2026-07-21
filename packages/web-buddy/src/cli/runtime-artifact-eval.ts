import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { writeRuntimeArtifactEvalReport } from '../evals/runtime-artifact-report.js'
import { runRuntimeArtifactEval } from '../evals/runtime-artifact-runner.js'

interface CliOptions {
  casePath: string
  traceDir: string
  outDir: string
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2))
    const evalCase = JSON.parse(await readFile(options.casePath, 'utf8')) as unknown
    const result = runRuntimeArtifactEval({ traceDir: options.traceDir, evalCase })
    const paths = await writeRuntimeArtifactEvalReport({ result, outDir: options.outDir })
    console.log(`runtime artifact eval: ${result.passed ? 'PASS' : 'FAIL'}`)
    console.log(`json: ${paths.jsonPath}`)
    console.log(`markdown: ${paths.markdownPath}`)
    if (!result.passed) process.exitCode = 1
  } catch (error) {
    console.error(`runtime artifact eval: ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--case', '--trace-dir', '--out'].includes(key)) throw new Error(`Unknown option: ${key}`)
    const value = argv[index + 1]
    if (!value) throw new Error(`Option ${key} requires a value.`)
    values.set(key, value)
    index += 1
  }
  for (const key of ['--case', '--trace-dir', '--out']) {
    if (!values.has(key)) throw new Error(`Missing required option: ${key}`)
  }
  return {
    casePath: resolve(values.get('--case')!),
    traceDir: resolve(values.get('--trace-dir')!),
    outDir: resolve(values.get('--out')!),
  }
}

await main()
