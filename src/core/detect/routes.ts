import { readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Route discovery from the file structure.
 *
 * Spec §4 Layer 2a: "only an entry point, which the detector can infer (Next.js routes come
 * straight from the file structure)". M1 does not drive routes — M4 does — but they are free to
 * collect here, and knowing them now keeps the profile the single place downstream code looks.
 */

const PAGE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs'] as const
const APP_PAGE_FILES = PAGE_EXTENSIONS.map((ext) => `page.${ext}`)
const IGNORED_DIRS = new Set(['node_modules', '.next', '.git'])

/** Pages-router files that are framework plumbing rather than routes. */
const PAGES_ROUTER_SPECIALS = new Set(['_app', '_document', '_error', 'middleware'])

export interface RouteDetection {
  readonly routes: readonly string[]
  /** Which router produced them — the two can coexist in a migrating project. */
  readonly routers: readonly ('app' | 'pages')[]
  /** Directory the routes were read from, relative to the project root. */
  readonly sources: readonly string[]
}

export async function detectRoutes(projectRoot: string): Promise<RouteDetection> {
  const routes = new Set<string>()
  const routers: ('app' | 'pages')[] = []
  const sources: string[] = []

  // Next.js allows both `app/` and `src/app/`; same for `pages/`.
  for (const base of ['app', path.join('src', 'app')]) {
    const dir = path.join(projectRoot, base)
    const found = await collectAppRoutes(dir, '')
    if (found.length > 0) {
      found.forEach((r) => routes.add(r))
      if (!routers.includes('app')) routers.push('app')
      sources.push(base)
    }
  }

  for (const base of ['pages', path.join('src', 'pages')]) {
    const dir = path.join(projectRoot, base)
    const found = await collectPagesRoutes(dir, '')
    if (found.length > 0) {
      found.forEach((r) => routes.add(r))
      if (!routers.includes('pages')) routers.push('pages')
      sources.push(base)
    }
  }

  return { routes: [...routes].sort(), routers, sources }
}

async function readdirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

/**
 * App router: a route exists wherever a `page.*` file does. Route groups `(marketing)` and private
 * folders `_lib` contribute no URL segment; parallel routes `@modal` are not standalone URLs.
 */
async function collectAppRoutes(dir: string, urlPath: string): Promise<string[]> {
  const entries = await readdirSafe(dir)
  if (!entries) return []

  const routes: string[] = []

  if (entries.some((e) => e.isFile() && APP_PAGE_FILES.includes(e.name))) {
    routes.push(urlPath === '' ? '/' : urlPath)
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('@')) continue

    const isRouteGroup = entry.name.startsWith('(') && entry.name.endsWith(')')
    const nextUrl = isRouteGroup ? urlPath : `${urlPath}/${entry.name}`
    routes.push(...(await collectAppRoutes(path.join(dir, entry.name), nextUrl)))
  }

  return routes
}

/** Pages router: every file is a route, minus API handlers and the special files. */
async function collectPagesRoutes(dir: string, urlPath: string): Promise<string[]> {
  const entries = await readdirSafe(dir)
  if (!entries) return []

  const routes: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name === 'api') continue
      routes.push(
        ...(await collectPagesRoutes(path.join(dir, entry.name), `${urlPath}/${entry.name}`)),
      )
      continue
    }

    const ext = path.extname(entry.name).slice(1)
    if (!PAGE_EXTENSIONS.includes(ext as (typeof PAGE_EXTENSIONS)[number])) continue

    const stem = entry.name.slice(0, -(ext.length + 1))
    if (PAGES_ROUTER_SPECIALS.has(stem) || stem.startsWith('_')) continue

    routes.push(stem === 'index' ? urlPath || '/' : `${urlPath}/${stem}`)
  }

  return routes
}
