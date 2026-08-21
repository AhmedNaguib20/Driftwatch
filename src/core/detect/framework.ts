import path from 'node:path'
import type { Evidence, Framework } from './types.js'
import { declaredDependency, firstExisting, installedVersion, readText } from './fs-probe.js'
import type { PackageJson } from './fs-probe.js'

/**
 * Framework detection.
 *
 * M1 recognises Next.js and nothing else — deliberately. The honest failure mode for an
 * unrecognised project is `framework: 'unknown'` with a warning, not a guess that produces numbers
 * we can't stand behind (hard rule 3). Adding a framework means adding a case here plus its output
 * and cache directories; nothing downstream changes.
 */

const NEXT_CONFIG_FILES = [
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
  'next.config.ts',
] as const

export interface FrameworkDetection {
  readonly framework: Framework
  readonly version: string | null
  readonly buildOutputDirs: readonly string[]
  readonly cacheDirs: readonly string[]
  /** Boots the built app; the port is appended by the server layer at spawn time. */
  readonly serve: { readonly bin: string; readonly args: readonly string[] } | null
  readonly evidence: readonly Evidence[]
  readonly warnings: readonly string[]
}

export async function detectFramework(
  projectRoot: string,
  pkg: PackageJson | null,
): Promise<FrameworkDetection> {
  const evidence: Evidence[] = []
  const warnings: string[] = []

  const declared = pkg ? declaredDependency(pkg, 'next') : null
  const configFile = await firstExisting(projectRoot, NEXT_CONFIG_FILES)

  if (!declared && !configFile) {
    warnings.push(
      'No supported framework detected here. Driftwatch measures Next.js projects today; ' +
        'build and bundle metrics need one, so they will be skipped.',
    )
    return {
      framework: 'unknown',
      version: null,
      buildOutputDirs: [],
      cacheDirs: [],
      serve: null,
      evidence,
      warnings,
    }
  }

  if (declared) {
    evidence.push({
      fact: 'framework: nextjs',
      source: 'package.json',
      detail: `depends on next@${declared}`,
    })
  }
  if (configFile) {
    evidence.push({ fact: 'framework: nextjs', source: configFile, detail: 'Next.js config file' })
  }

  // The installed version is what will actually be built; the declared range is only a wish.
  const installed = await installedVersion(projectRoot, 'next')
  if (installed) {
    evidence.push({
      fact: `next version: ${installed}`,
      source: 'node_modules/next/package.json',
      detail: 'installed version — this is what gets built',
    })
  } else if (declared) {
    warnings.push(
      'Dependencies are not installed, so the exact Next.js version is unknown — only the declared range is available.',
    )
  }

  const distDir = configFile ? await sniffCustomDistDir(projectRoot, configFile) : null
  if (distDir) {
    warnings.push(
      `${configFile} appears to set a custom distDir. Driftwatch measures the default '.next'; ` +
        'bundle size and cold-build clearing may target the wrong directory.',
    )
  }

  return {
    framework: 'nextjs',
    version: installed ?? declared,
    // `.next` holds both the build output and the build cache, so it serves as both.
    buildOutputDirs: ['.next'],
    cacheDirs: ['.next', path.join('node_modules', '.cache')],
    // Relative bin, resolved against the workspace at spawn — the workspace's own Next serves
    // the workspace's own build. `-p <port>` is appended by the server layer.
    serve: { bin: path.join('node_modules', '.bin', 'next'), args: ['start'] },
    evidence,
    warnings,
  }
}

/**
 * Looks for a `distDir` assignment in the Next config without executing it.
 *
 * Reading the real value would mean evaluating arbitrary user code inside the tool, which is not a
 * trade we want for one config key. Detecting the string is enough to warn honestly that our
 * assumption may be wrong — better than silently weighing an empty directory.
 */
async function sniffCustomDistDir(projectRoot: string, configFile: string): Promise<boolean> {
  const source = await readText(path.join(projectRoot, configFile))
  if (source === null) return false
  return /(^|[^A-Za-z0-9_])distDir\s*:/.test(source)
}
