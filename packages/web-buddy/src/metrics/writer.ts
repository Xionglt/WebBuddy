import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { aggregateMetrics } from './aggregate.js'
import { resolveTraceInputs, type ResolveTraceInputsOptions, type ResolvedTraceInputs } from './trace-inputs.js'
import type { RunMetrics } from './schema.js'

export interface MetricsWriteResult {
  metrics: RunMetrics
  inputs: ResolvedTraceInputs
  path: string
}

export function metricsPathForTraceDir(traceDir: string): string {
  return join(traceDir, 'metrics.json')
}

export function writeMetrics(metrics: RunMetrics, path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(metrics, null, 2))
  return path
}

export function generateAndWriteMetrics(options: ResolveTraceInputsOptions): MetricsWriteResult {
  const inputs = resolveTraceInputs(options)
  const metrics = aggregateMetrics(inputs)
  const path = metricsPath(inputs)
  writeMetrics(metrics, path)
  return { metrics, inputs, path }
}

function metricsPath(inputs: ResolvedTraceInputs): string {
  if (inputs.traceDir) return metricsPathForTraceDir(inputs.traceDir)
  if (inputs.runDir) return join(inputs.runDir, 'metrics.json')
  throw new Error('Cannot write metrics without traceDir or runDir.')
}
