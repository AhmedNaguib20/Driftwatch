/**
 * The project profile — what detection concluded about a repo, and why.
 *
 * Detection is the first link in the chain (spec §3.3): everything downstream (what to build, what
 * to clear for a cold build, what to weigh for bundle size) reads from here. Because hard rule 3
 * forbids reporting anything we didn't actually observe, every conclusion carries `Evidence`
 * naming the file it came from. A profile is a set of findings, not a set of assumptions.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export type Framework = 'nextjs' | 'unknown'

export type Language = 'javascript' | 'unknown'

/** Metric identifiers. Per-route classes carry the route in the id (M4, Layer 2a). */
export type MetricId =
  | 'build_time'
  | 'bundle_size'
  | 'install_time'
  | `route_latency:${string}`
  | `lcp:${string}`
  | `tbt:${string}`
  | `fcp:${string}`
  | `transfer_size:${string}`

/** A command to run, kept as bin + args so it is executed without a shell. */
export interface Command {
  readonly bin: string
  readonly args: readonly string[]
}

/** Why we believe something. `source` is a path relative to the project root, or a marker. */
export interface Evidence {
  readonly fact: string
  readonly source: string
  readonly detail?: string
}

export interface ProjectProfile {
  /** Absolute path to the directory holding the project's `package.json`. */
  readonly projectRoot: string

  /**
   * Absolute path to the enclosing git repository, and the project's path within it.
   *
   * The baseline step checks the base commit out into a `git worktree` (hard rule 2), and must then
   * find the project inside that worktree. For a project at the repo root `pathInRepo` is `'.'`;
   * for one nested in a monorepo it is the subdirectory. Without this, a nested project would
   * measure the wrong directory.
   */
  readonly gitRoot: string | null
  readonly pathInRepo: string | null

  readonly language: Language
  readonly framework: Framework
  readonly frameworkVersion: string | null

  readonly packageManager: PackageManager
  /** Lockfile name relative to the project root, e.g. `package-lock.json`. */
  readonly lockfile: string | null

  readonly commands: {
    readonly install: Command | null
    readonly build: Command | null
    /** Boots the BUILT app (never dev mode). Null for unservable projects (libraries). */
    readonly serve: Command | null
  }

  /** Directories produced by the build — where bundle size is weighed. */
  readonly buildOutputDirs: readonly string[]

  /**
   * Directories removed before every measured build, on both sides of a comparison.
   *
   * This is hard rule 5 in concrete form: a fresh worktree can never have a warm cache, so both
   * sides are forced cold. Measured at 22% apart on the M1 fixture (spec §5.1).
   */
  readonly cacheDirs: readonly string[]

  /** Route paths inferred from the file structure. Unused in M1; M4 (Layer 2a) drives them. */
  readonly routes: readonly string[]

  /** Metrics this profile can actually produce. Never lists a metric we cannot collect. */
  readonly supportedMetrics: readonly MetricId[]

  /** Conditions that will degrade or block measurement. Surfaced, never swallowed. */
  readonly warnings: readonly string[]

  readonly evidence: readonly Evidence[]
}
