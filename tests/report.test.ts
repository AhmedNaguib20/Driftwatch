import { describe, expect, it } from 'vitest'

import { buildResult, compareMetrics, isCiHost, protocolMismatches, quantumFor } from '../src/core/index.js'
import type {
  BaselinePlan,
  BaseSideResult,
  MeasurementProtocol,
  MetricResult,
  ResolvedConfig,
  ProjectProfile,
  SideMeasurement,
} from '../src/core/index.js'

/** Deterministic fixtures — every field fixed so the golden file cannot flap. */

function protocol(overrides: Partial<MeasurementProtocol> = {}): MeasurementProtocol {
  return {
    version: 1,
    workspace: 'worktree',
    cacheState: 'cold',
    nodeModules: 'cloned',
    gitMetadata: 'absent',
    nodeVersion: 'v20.20.0',
    platform: 'darwin',
    arch: 'arm64',
    buildCommand: 'npm run build',
    buildSamples: 3,
    warmupSamples: 1,
    routeSamples: 5,
    routeWarmupSamples: 1,
    browser: 'none',
    lighthouseProfile: 'none',
    hostLabels: [],
    env: { NEXT_TELEMETRY_DISABLED: '1' },
    ...overrides,
  }
}

function measured(
  id: MetricResult['id'],
  value: number,
  unit: 'ms' | 'bytes',
  label: string,
): MetricResult {
  return { id, status: 'measured', value, unit, label, collectedBy: 'test', samples: 3, sampleValues: [value + 10, value, value - 10] }
}

function skipped(id: MetricResult['id'], label: string, reason: string): MetricResult {
  return { id, status: 'skipped', label, reason }
}

function side(metrics: MetricResult[], proto = protocol()): SideMeasurement {
  return { metrics, protocol: proto, warnings: [], elapsedMs: 1000, layer2aElapsedMs: 0 }
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    detect: 'nextjs',
    measure: ['build_time', 'bundle_size'],
    serve: true,
    browser: true,
    verify: true,
    auto_fix: 'off',
    threshold: '5%',
    block_merge: false,
    base: 'main',
    provider: 'deepseek',
    model: 'deepseek-chat',
    thresholdPercent: 5,
    noiseFloorPercent: 2,
    sourcePath: null,
    warnings: [],
    ...overrides,
  }
}

function profile(): ProjectProfile {
  return {
    projectRoot: '/repo/app',
    gitRoot: '/repo',
    pathInRepo: 'app',
    language: 'javascript',
    framework: 'nextjs',
    frameworkVersion: '15.1.3',
    packageManager: 'npm',
    lockfile: 'package-lock.json',
    commands: {
      install: { bin: 'npm', args: ['ci'] },
      build: { bin: 'npm', args: ['run', 'build'] },
      serve: { bin: 'node_modules/.bin/next', args: ['start'] },
    },
    buildOutputDirs: ['.next'],
    cacheDirs: ['.next', 'node_modules/.cache'],
    routes: ['/', '/about'],
    supportedMetrics: ['build_time', 'bundle_size'],
    warnings: [],
    evidence: [{ fact: 'framework: nextjs', source: 'package.json' }],
  }
}

function plan(overrides: Partial<BaselinePlan> = {}): BaselinePlan {
  return {
    available: true,
    baseRef: 'main',
    baseSha: 'c0ffee0000000000000000000000000000000000',
    lockfileStatus: 'identical',
    dependenciesChanged: false,
    dependencies: 'clone',
    warnings: [],
    evidence: [{ fact: 'base: main @ c0ffee000000', source: 'git' }],
    ...overrides,
  }
}

function baseResult(s: SideMeasurement): BaseSideResult {
  return { side: s, sha: plan().baseSha, fromCache: false, measuredAt: null, cachePath: null }
}

const OPTS = { noiseFloorPercent: 2, thresholdPercent: 5, protocolMismatches: [] as string[] }

describe('metric verdicts', () => {
  it('no_change under the floor — and the delta is NOT reported', () => {
    const [m] = compareMetrics(
      [measured('build_time', 10000, 'ms', 'build time (cold)')],
      [measured('build_time', 10150, 'ms', 'build time (cold)')],
      OPTS,
    )
    expect(m!.verdict).toBe('no_change')
    expect(m!.delta).toBeNull()
    expect(m!.reason).toMatch(/noise floor/)
  })

  it('regressed beyond the floor, threshold flag only at/after the threshold', () => {
    const [under] = compareMetrics(
      [measured('build_time', 10000, 'ms', 'b')],
      [measured('build_time', 10300, 'ms', 'b')],
      OPTS,
    )
    expect(under!.verdict).toBe('regressed')
    expect(under!.delta).toEqual({ absolute: 300, percent: 3 })
    expect(under!.exceedsThreshold).toBe(false)

    const [over] = compareMetrics(
      [measured('build_time', 10000, 'ms', 'b')],
      [measured('build_time', 10600, 'ms', 'b')],
      OPTS,
    )
    expect(over!.verdict).toBe('regressed')
    expect(over!.exceedsThreshold).toBe(true)
  })

  it('improved never trips the threshold — it applies to regressions only', () => {
    const [m] = compareMetrics(
      [measured('bundle_size', 100000, 'bytes', 's')],
      [measured('bundle_size', 80000, 'bytes', 's')],
      OPTS,
    )
    expect(m!.verdict).toBe('improved')
    expect(m!.delta!.percent).toBe(-20)
    expect(m!.exceedsThreshold).toBe(false)
  })

  it('skipped on either side carries both reasons', () => {
    const [m] = compareMetrics(
      [skipped('build_time', 'b', 'build exited with code 1')],
      [measured('build_time', 9000, 'ms', 'b')],
      OPTS,
    )
    expect(m!.verdict).toBe('skipped')
    expect(m!.reason).toMatch(/base: build exited with code 1/)
    expect(m!.base).toBeNull()
    expect(m!.current).toBe(9000)
  })

  it('a zero baseline yields not_comparable, not a made-up percent', () => {
    const [m] = compareMetrics(
      [measured('bundle_size', 0, 'bytes', 's')],
      [measured('bundle_size', 500, 'bytes', 's')],
      OPTS,
    )
    expect(m!.verdict).toBe('not_comparable')
    expect(m!.delta).toBeNull()
  })
})

describe('protocol mismatch — the §5.1 enforcement point', () => {
  it('names the exact differing fields', () => {
    const diffs = protocolMismatches(
      protocol(),
      protocol({ nodeVersion: 'v22.1.0', buildSamples: 5, workspace: 'copy' }),
    )
    expect(diffs).toEqual([
      'nodeVersion: v20.20.0 (base) vs v22.1.0 (current)',
      'buildSamples: 3 (base) vs 5 (current)',
    ])
  })

  it('treats workspace kind and clone-vs-copy as equivalent, fresh-install as different', () => {
    expect(protocolMismatches(protocol(), protocol({ workspace: 'copy', nodeModules: 'copied' }))).toEqual([])
    expect(
      protocolMismatches(protocol(), protocol({ nodeModules: 'fresh-install' })),
    ).toEqual(['installState: preinstalled (base) vs fresh-install (current)'])
  })

  it('never computes a delta across mismatched protocols, however large the difference', () => {
    const [m] = compareMetrics(
      [measured('build_time', 10000, 'ms', 'b')],
      [measured('build_time', 20000, 'ms', 'b')],
      { ...OPTS, protocolMismatches: ['nodeVersion: v20.20.0 (base) vs v22.1.0 (current)'] },
    )
    expect(m!.verdict).toBe('not_comparable')
    expect(m!.delta).toBeNull()
    expect(m!.reason).toMatch(/nodeVersion: v20\.20\.0 \(base\) vs v22\.1\.0 \(current\)/)
  })
})

describe('run verdict', () => {
  const now = () => new Date('2026-08-19T12:00:00Z')

  function result(baseMetrics: MetricResult[], currentMetrics: MetricResult[], overrides: { plan?: Partial<BaselinePlan>; config?: Partial<ResolvedConfig>; baseProto?: Partial<MeasurementProtocol>; currentProto?: Partial<MeasurementProtocol> } = {}) {
    return buildResult({
      profile: profile(),
      config: config(overrides.config),
      plan: plan(overrides.plan),
      base: baseResult(side(baseMetrics, protocol(overrides.baseProto))),
      current: side(currentMetrics, protocol({ workspace: 'copy', ...overrides.currentProto })),
      now,
    })
  }

  const cleanPair = () => [
    [measured('build_time', 10000, 'ms', 'b'), measured('bundle_size', 100000, 'bytes', 's')],
    [measured('build_time', 10100, 'ms', 'b'), measured('bundle_size', 100100, 'bytes', 's')],
  ] as [MetricResult[], MetricResult[]]

  it('ok when key metrics are no_change', () => {
    const [b, c] = cleanPair()
    expect(result(b, c).verdict).toBe('ok')
  })

  it('ok on a regression below the threshold — reported, but not a verdict', () => {
    const r = result(
      [measured('build_time', 10000, 'ms', 'b'), measured('bundle_size', 100000, 'bytes', 's')],
      [measured('build_time', 10300, 'ms', 'b'), measured('bundle_size', 100100, 'bytes', 's')],
    )
    expect(r.comparison.metrics.find((m) => m.id === 'build_time')!.verdict).toBe('regressed')
    expect(r.verdict).toBe('ok')
  })

  it('regression when a key metric crosses the threshold', () => {
    const r = result(
      [measured('build_time', 10000, 'ms', 'b'), measured('bundle_size', 100000, 'bytes', 's')],
      [measured('build_time', 11000, 'ms', 'b'), measured('bundle_size', 100100, 'bytes', 's')],
    )
    expect(r.verdict).toBe('regression')
  })

  it('inconclusive when a key metric is skipped', () => {
    const r = result(
      [skipped('build_time', 'b', 'build failed'), measured('bundle_size', 100000, 'bytes', 's')],
      [measured('build_time', 10000, 'ms', 'b'), measured('bundle_size', 100100, 'bytes', 's')],
    )
    expect(r.verdict).toBe('inconclusive')
  })

  it('inconclusive — never ok — across mismatched protocols', () => {
    const [b, c] = cleanPair()
    const r = result(b, c, { currentProto: { nodeVersion: 'v22.1.0' } })
    expect(r.comparison.protocolsMatch).toBe(false)
    expect(r.comparison.metrics.every((m) => m.verdict === 'not_comparable')).toBe(true)
    expect(r.verdict).toBe('inconclusive')
  })

  it('inconclusive when the base is unavailable, with every metric skipped and the reason carried', () => {
    const r = buildResult({
      profile: profile(),
      config: config(),
      plan: { available: false, reason: 'base ref "main" does not resolve to a commit in this repository' },
      base: null,
      current: side(cleanPair()[1], protocol({ workspace: 'copy' })),
      now,
    })
    expect(r.verdict).toBe('inconclusive')
    expect(r.base).toEqual({ available: false, reason: expect.stringMatching(/does not resolve/) })
    expect(r.comparison.metrics.every((m) => m.verdict === 'skipped')).toBe(true)
    expect(r.comparison.metrics[0]!.reason).toMatch(/base unavailable/)
  })

  it('install deltas are refused — §5.1 sixth instance: cache state differs between sides', () => {
    const r = result(
      [measured('install_time', 30000, 'ms', 'install time'), measured('build_time', 10000, 'ms', 'b'), measured('bundle_size', 100000, 'bytes', 's')],
      [measured('install_time', 42000, 'ms', 'install time'), measured('build_time', 10100, 'ms', 'b'), measured('bundle_size', 100100, 'bytes', 's')],
      { plan: { lockfileStatus: 'changed', dependenciesChanged: true, dependencies: 'install' }, baseProto: { nodeModules: 'fresh-install' }, currentProto: { nodeModules: 'fresh-install' } },
    )
    expect(r.comparison.dependenciesChanged).toBe(true)
    expect(r.comparison.lockfileStatus).toBe('changed')
    const install = r.comparison.metrics.find((m) => m.id === 'install_time')!
    // Values reported, delta refused: the base installs first (cold pm cache), current second.
    expect(install.verdict).toBe('not_comparable')
    expect(install.base).toBe(30000)
    expect(install.current).toBe(42000)
    expect(install.delta).toBeNull()
    expect(install.reason).toMatch(/cache state differs/)
    // Contextual metric: its refusal does not make the run inconclusive.
    expect(r.verdict).toBe('ok')
  })

  it('keeps the evidence trail through to the result', () => {
    const [b, c] = cleanPair()
    const r = result(b, c)
    const facts = r.project.evidence.map((e) => e.fact)
    expect(facts).toContain('framework: nextjs')
    expect(facts).toContain('base: main @ c0ffee000000')
  })
})

describe('timing resolution quantum', () => {
  it('treats a big percentage on a tiny duration as unresolvable, not a regression', () => {
    const [m] = compareMetrics(
      [measured('build_time', 150, 'ms', 'b')],
      [measured('build_time', 190, 'ms', 'b')], // +26.7%, but only 40ms
      OPTS,
    )
    expect(m!.verdict).toBe('no_change')
    expect(m!.reason).toMatch(/metric class's 100ms resolution/)
  })

  it('does not apply the quantum to bytes', () => {
    const [m] = compareMetrics(
      [measured('bundle_size', 1000, 'bytes', 's')],
      [measured('bundle_size', 1090, 'bytes', 's')], // +9%, 90 "units"
      OPTS,
    )
    expect(m!.verdict).toBe('regressed')
  })

  // Spec §5 (decided M6 acceptance): the machine is part of the instrument — browser-timing
  // quanta are coarser on shared CI runners (hostLabels present). Byte and non-browser classes
  // are environment-independent.
  it('browser-timing quanta are environment-conditional; everything else is not', () => {
    for (const [id, local, ci] of [
      ['lcp:/', 25, 200],
      ['fcp:/blog', 25, 200],
      ['tbt:/live', 50, 100],
      ['route_latency:/live', 5, 5],
      ['build_time', 100, 100],
    ] as const) {
      expect(quantumFor(id, 'ms', false), `${id} local`).toBe(local)
      expect(quantumFor(id, 'ms', true), `${id} ci`).toBe(ci)
    }
    expect(quantumFor('transfer_size:/', 'bytes', true)).toBe(1024)
    expect(isCiHost({ DRIFTWATCH_HOST_LABELS: 'ubuntu-latest' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isCiHost({} as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe('Layer 2a verdict wiring', () => {
  const layerOpts = { noiseFloorPercent: 2, thresholdPercent: 5, protocolMismatches: [] as string[] }

  it('applies per-class quanta: 5ms routes, 25ms lcp, 50ms tbt, 1KB transfer', () => {
    const cases: [MetricResult['id'], number, number, string][] = [
      ['route_latency:/live', 4, 8, 'no_change'], // +4ms < 5ms quantum despite +100%
      ['route_latency:/live', 4, 12, 'regressed'], // +8ms ≥ 5ms
      ['lcp:/', 1700, 1720, 'no_change'], // +20ms < 25ms
      ['lcp:/', 1700, 1780, 'regressed'], // +80ms
      ['tbt:/', 2, 40, 'no_change'], // +38ms < 50ms despite +1900%
      ['tbt:/', 2, 90, 'regressed'],
      ['transfer_size:/', 231000, 231500, 'no_change'], // +500B < 1KB
      ['transfer_size:/', 231000, 301000, 'regressed'], // +70KB
    ]
    for (const [id, base, current, expected] of cases) {
      const unit = id.startsWith('transfer') ? 'bytes' as const : 'ms' as const
      const [m] = compareMetrics(
        [measured(id, base, unit, id)],
        [measured(id, current, unit, id)],
        layerOpts,
      )
      expect(m!.verdict, `${id} ${base}→${current}`).toBe(expected)
    }
  })

  it('class tokens in measure make per-route metrics KEY', async () => {
    const r = buildResult({
      profile: profile(),
      config: config({ measure: ['build_time', 'bundle_size', 'route_latency'] }),
      plan: plan(),
      base: baseResult(side([measured('route_latency:/live', 4, 'ms', 'route /live'), measured('build_time', 10000, 'ms', 'b'), measured('bundle_size', 100000, 'bytes', 's')])),
      current: side([measured('route_latency:/live', 90, 'ms', 'route /live'), measured('build_time', 10100, 'ms', 'b'), measured('bundle_size', 100100, 'bytes', 's')], protocol({ workspace: 'copy' })),
      now: () => new Date('2026-08-19T12:00:00Z'),
    })
    expect(r.comparison.metrics.find((m) => m.id === 'route_latency:/live')!.verdict).toBe('regressed')
    expect(r.verdict).toBe('regression') // +2150% crosses the threshold, class is key
  })
})

describe('policy exclusions never gate the verdict', () => {
  it('SSG-excluded key-class rows leave the run ok; a failed boot does not', () => {
    const ssgSkip: MetricResult = {
      id: 'route_latency:/about', status: 'skipped', label: 'route /about',
      reason: 'prerendered (SSG) — excluded', excluded: true,
    }
    const bootFail: MetricResult = {
      id: 'route_latency:/live', status: 'skipped', label: 'route /live',
      reason: 'server did not answer 200 within 60s',
    }
    const clean = [measured('build_time', 10000, 'ms', 'b'), measured('bundle_size', 100000, 'bytes', 's')]
    const build = (extra: MetricResult) =>
      buildResult({
        profile: profile(),
        config: config({ measure: ['build_time', 'bundle_size', 'route_latency'] }),
        plan: plan(),
        base: baseResult(side([...clean, extra])),
        current: side([...clean.map((m) => ({ ...m })), extra], protocol({ workspace: 'copy' })),
        now: () => new Date('2026-08-19T12:00:00Z'),
      })

    const withPolicy = build(ssgSkip)
    expect(withPolicy.comparison.metrics.find((m) => m.id === 'route_latency:/about')!.excluded).toBe(true)
    expect(withPolicy.verdict).toBe('ok')

    const withFailure = build(bootFail)
    expect(withFailure.verdict).toBe('inconclusive')
  })
})
