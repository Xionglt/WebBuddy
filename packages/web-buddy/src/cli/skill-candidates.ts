import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { processSkillGenerationRequest } from '../skills/candidates/pipeline.js'
import {
  FileSkillCandidateStore,
  defaultSkillCandidateRoot,
} from '../skills/candidates/store.js'
import { TemplateSkillCandidateSynthesizer } from '../skills/candidates/synthesizer.js'
import type { SkillGenerationResult } from '../skills/candidates/pipeline.js'

type CandidateCommand =
  | { command: 'generate'; traceDir: string; storeDir: string }
  | { command: 'process-pending'; traceRoot: string; storeDir: string }
  | { command: 'list'; storeDir: string }
  | { command: 'show'; candidateId: string; storeDir: string }

async function main(): Promise<void> {
  try {
    const command = parseCommand(process.argv.slice(2))
    const store = new FileSkillCandidateStore({ rootDir: command.storeDir })
    if (command.command === 'generate') {
      const result = await generateCandidate(command.traceDir, store)
      printJson(result)
      if (terminalFailure(result)) process.exitCode = 1
      return
    }
    if (command.command === 'process-pending') {
      const results = await processPending(command.traceRoot, store)
      printJson(results)
      if (results.some(terminalFailure)) process.exitCode = 1
      return
    }
    if (command.command === 'list') {
      printJson(await store.listCandidates())
      return
    }
    printJson(await store.readCandidate(command.candidateId))
  } catch (error) {
    console.error(`skill candidates: ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}

function parseCommand(argv: string[]): CandidateCommand {
  if (argv[0] !== 'candidate') throw new Error('Expected command group: candidate')
  const command = argv[1]
  const rest = argv.slice(2)
  if (command === 'generate') {
    const parsed = parseOptions(rest, ['--trace-dir', '--store'])
    return {
      command,
      traceDir: resolve(requiredOption(parsed.options, '--trace-dir')),
      storeDir: resolveStore(parsed.options.get('--store')),
    }
  }
  if (command === 'process-pending') {
    const parsed = parseOptions(rest, ['--trace-root', '--store'])
    return {
      command,
      traceRoot: resolve(requiredOption(parsed.options, '--trace-root')),
      storeDir: resolveStore(parsed.options.get('--store')),
    }
  }
  if (command === 'list') {
    const parsed = parseOptions(rest, ['--store'])
    return { command, storeDir: resolveStore(parsed.options.get('--store')) }
  }
  if (command === 'show') {
    const parsed = parseOptions(rest, ['--store'], 1)
    return {
      command,
      candidateId: parsed.positionals[0],
      storeDir: resolveStore(parsed.options.get('--store')),
    }
  }
  throw new Error(`Unknown candidate command: ${command ?? '<missing>'}`)
}

function parseOptions(
  argv: string[],
  allowed: string[],
  positionalCount = 0,
): { options: Map<string, string>; positionals: string[] } {
  const options = new Map<string, string>()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    if (!allowed.includes(value)) throw new Error(`Unknown option: ${value}`)
    if (options.has(value)) throw new Error(`Duplicate option: ${value}`)
    const optionValue = argv[index + 1]
    if (!optionValue || optionValue.startsWith('--')) {
      throw new Error(`Option ${value} requires a value.`)
    }
    options.set(value, optionValue)
    index += 1
  }
  if (positionals.length !== positionalCount) {
    throw new Error(`Expected ${positionalCount} positional argument(s).`)
  }
  return { options, positionals }
}

function requiredOption(options: Map<string, string>, key: string): string {
  const value = options.get(key)
  if (!value) throw new Error(`Missing required option: ${key}`)
  return value
}

function resolveStore(value: string | undefined): string {
  return value ? resolve(value) : defaultSkillCandidateRoot()
}

async function generateCandidate(
  traceDir: string,
  store: FileSkillCandidateStore,
): Promise<SkillGenerationResult> {
  const requestDir = join(traceDir, 'skill-learning', 'requests')
  const names = (await readdir(requestDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
  if (names.length !== 1) {
    throw new Error(`Expected exactly one generation request, found ${names.length}.`)
  }
  const request = await store.readRequest(join(requestDir, names[0]))
  return processSkillGenerationRequest({
    traceDir,
    request,
    store,
    synthesizer: new TemplateSkillCandidateSynthesizer(),
  })
}

async function processPending(
  traceRoot: string,
  store: FileSkillCandidateStore,
): Promise<SkillGenerationResult[]> {
  const traceEntries = (await readdir(traceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  const results: SkillGenerationResult[] = []
  for (const traceEntry of traceEntries) {
    const traceDir = join(traceRoot, traceEntry.name)
    const requestDir = join(traceDir, 'skill-learning', 'requests')
    let requestEntries
    try {
      requestEntries = await readdir(requestDir, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    const requestNames = requestEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
    for (const requestName of requestNames) {
      const request = await store.readRequest(join(requestDir, requestName))
      results.push(await processSkillGenerationRequest({
        traceDir,
        request,
        store,
        synthesizer: new TemplateSkillCandidateSynthesizer(),
      }))
    }
  }
  return results
}

function terminalFailure(result: SkillGenerationResult): boolean {
  return result.status === 'ineligible' || result.status === 'rejected'
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

await main()
