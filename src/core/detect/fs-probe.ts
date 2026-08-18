import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Filesystem probes shared by the detectors.
 *
 * Every function here answers "is this true of the repo?" and returns a value rather than throwing.
 * Detection runs before we know anything about the project, so an unreadable or malformed file is
 * an ordinary outcome, not an error: it means "we could not conclude this", which the caller
 * records as such (hard rule 3).
 */

export async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** Returns the first of `names` that exists in `dir`, or null. */
export async function firstExisting(
  dir: string,
  names: readonly string[],
): Promise<string | null> {
  for (const name of names) {
    if (await exists(path.join(dir, name))) return name
  }
  return null
}

export async function readText(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8')
  } catch {
    return null
  }
}

/** Minimal shape of the fields we read out of a `package.json`. */
export interface PackageJson {
  name?: string
  version?: string
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  workspaces?: unknown
}

export async function readPackageJson(dir: string): Promise<PackageJson | null> {
  const raw = await readText(path.join(dir, 'package.json'))
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as PackageJson
  } catch {
    return null
  }
}

/** Looks up a dependency's declared range across all dependency fields. */
export function declaredDependency(pkg: PackageJson, name: string): string | null {
  return (
    pkg.dependencies?.[name] ??
    pkg.devDependencies?.[name] ??
    pkg.peerDependencies?.[name] ??
    null
  )
}

/**
 * Reads the version actually installed in `node_modules`, which is the number that will really be
 * built — unlike the declared range, which is a wish. Null when dependencies are not installed.
 */
export async function installedVersion(
  projectRoot: string,
  name: string,
): Promise<string | null> {
  const raw = await readText(path.join(projectRoot, 'node_modules', name, 'package.json'))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}
