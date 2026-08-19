import path from 'node:path'
import { parse } from 'yaml'
import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  NOISE_FLOOR_PERCENT,
  parsePercent,
} from './config-schema.js'
import type { PerfConfig, ResolvedConfig } from './config-schema.js'
import type { Framework, MetricId } from './types.js'
import { readText } from './fs-probe.js'

/**
 * Loads `perf.yml`, falling back to detected defaults for anything missing or malformed.
 *
 * A broken config never aborts a run — it degrades to defaults and says so, per the convention
 * that errors are recorded rather than fatal. Unknown keys and bad values are each flagged.
 */
export async function loadConfig(
  projectRoot: string,
  fallback: PerfConfig = DEFAULT_CONFIG,
): Promise<ResolvedConfig> {
  const target = path.join(projectRoot, CONFIG_FILENAME)
  const raw = await readText(target)
  const warnings: string[] = []

  if (raw === null) {
    return resolve(fallback, null, warnings)
  }

  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (error) {
    warnings.push(
      `${CONFIG_FILENAME} could not be parsed (${(error as Error).message}) — using detected defaults.`,
    )
    return resolve(fallback, target, warnings)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${CONFIG_FILENAME} is not a YAML mapping — using detected defaults.`)
    return resolve(fallback, target, warnings)
  }

  const record = parsed as Record<string, unknown>
  const config: PerfConfig = {
    detect: pickFramework(record.detect, fallback.detect, warnings),
    measure: pickMetrics(record.measure, fallback.measure, warnings),
    serve: pickBoolean(record.serve, fallback.serve, 'serve', warnings),
    threshold: pickString(record.threshold, fallback.threshold, 'threshold', warnings),
    block_merge: pickBoolean(record.block_merge, fallback.block_merge, 'block_merge', warnings),
    base: pickString(record.base, fallback.base, 'base', warnings),
    provider: pickString(record.provider, fallback.provider, 'provider', warnings),
    model: pickString(record.model, fallback.model, 'model', warnings),
  }

  for (const key of Object.keys(record)) {
    if (!(key in DEFAULT_CONFIG)) {
      warnings.push(`${CONFIG_FILENAME}: unknown key "${key}" ignored.`)
    }
  }

  return resolve(config, target, warnings)
}

function resolve(
  config: PerfConfig,
  sourcePath: string | null,
  warnings: string[],
): ResolvedConfig {
  const parsedThreshold = parsePercent(config.threshold)
  if (parsedThreshold === null) {
    warnings.push(
      `${CONFIG_FILENAME}: threshold "${config.threshold}" is not a percentage — using ${DEFAULT_CONFIG.threshold}.`,
    )
  }

  return {
    ...config,
    thresholdPercent: parsedThreshold ?? parsePercent(DEFAULT_CONFIG.threshold)!,
    noiseFloorPercent: NOISE_FLOOR_PERCENT,
    sourcePath,
    warnings,
  }
}

const KNOWN_METRIC_NAMES = ['build_time', 'bundle_size', 'install_time'] as const

function isKnownMetric(entry: string): entry is MetricId {
  return (
    (KNOWN_METRIC_NAMES as readonly string[]).includes(entry) || entry.startsWith('route_latency:')
  )
}

function pickFramework(value: unknown, fallback: Framework, warnings: string[]): Framework {
  if (value === 'nextjs' || value === 'unknown') return value
  if (value !== undefined) {
    warnings.push(`${CONFIG_FILENAME}: unsupported detect "${String(value)}" — using "${fallback}".`)
  }
  return fallback
}

function pickMetrics(
  value: unknown,
  fallback: readonly MetricId[],
  warnings: string[],
): readonly MetricId[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value)) {
    warnings.push(`${CONFIG_FILENAME}: measure must be a list — using detected metrics.`)
    return fallback
  }

  const kept: MetricId[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && isKnownMetric(entry)) {
      kept.push(entry)
    } else {
      warnings.push(`${CONFIG_FILENAME}: unknown metric "${String(entry)}" ignored.`)
    }
  }
  return kept
}

function pickString(value: unknown, fallback: string, key: string, warnings: string[]): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number') return String(value)
  if (value !== undefined) {
    warnings.push(`${CONFIG_FILENAME}: ${key} must be a string — using "${fallback}".`)
  }
  return fallback
}

function pickBoolean(value: unknown, fallback: boolean, key: string, warnings: string[]): boolean {
  if (typeof value === 'boolean') return value
  if (value !== undefined) {
    warnings.push(`${CONFIG_FILENAME}: ${key} must be true or false — using ${fallback}.`)
  }
  return fallback
}
