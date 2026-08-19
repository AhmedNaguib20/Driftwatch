import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ROUTE_LIMIT, measureRoutes, selectRoutes } from '../src/core/measure/route-latency.js'
import { startServer, sweepStaleServers } from '../src/core/measure/serve.js'
import type { ServerHandle } from '../src/core/measure/serve.js'

const temps: string[] = []
const servers: ServerHandle[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-srv-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** A tiny real HTTP app: /, /about answer 200 with a small delay; /broken answers 500. */
const APP = `
const http = require('http')
const port = Number(process.argv[process.argv.indexOf('-p') + 1] || process.env.PORT)
const server = http.createServer((req, res) => {
  if (req.url === '/broken') { res.writeHead(500); res.end('boom'); return }
  setTimeout(() => { res.writeHead(200, {'content-type':'text/html'}); res.end('<html>ok ' + req.url + '</html>') }, 5)
})
server.listen(port, '127.0.0.1', () => console.log('listening on ' + port))
`

async function bootApp(dir: string): Promise<ServerHandle> {
  await writeFile(path.join(dir, 'server.js'), APP, 'utf8')
  const outcome = await startServer(dir, { bin: 'node', args: ['server.js'] }, {})
  if (!outcome.ok) throw new Error(outcome.reason)
  servers.push(outcome.server)
  return outcome.server
}

describe('server lifecycle', () => {
  it('boots the app on a dynamic port, waits for 200 readiness, and stops it', async () => {
    const dir = await scratch()
    const server = await bootApp(dir)

    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    await server.stop()
    await expect(fetch(server.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  })

  it('a server that exits immediately reports the failure with its last output', async () => {
    const dir = await scratch()
    await writeFile(path.join(dir, 'server.js'), 'console.error("missing module: nope"); process.exit(1)', 'utf8')

    const outcome = await startServer(dir, { bin: 'node', args: ['server.js'] }, {})

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/exited before becoming ready/)
      expect(outcome.reason).toMatch(/missing module: nope/)
    }
  })

  it('sweeps a server whose owning driftwatch died — but only if it still looks like node', async () => {
    const dir = await scratch()
    const server = await bootApp(dir)

    // Forge the marker: pretend the owner is a dead pid.
    const markers = (await import('node:fs/promises')).readdir
    const entries = (await markers(tmpdir())).filter((n) => n.startsWith('driftwatch-serve-'))
    let forged = 0
    for (const entry of entries) {
      const file = path.join(tmpdir(), entry, 'owner.json')
      try {
        const data = JSON.parse(await readFile(file, 'utf8'))
        if (data.serverPid && (await fetch(server.url).then(() => true).catch(() => false))) {
          await writeFile(file, JSON.stringify({ ...data, ownerPid: 999999999 }), 'utf8')
          forged += 1
        }
      } catch { /* other tests' leftovers */ }
    }
    expect(forged).toBeGreaterThan(0)

    const killed = await sweepStaleServers()

    expect(killed.length).toBeGreaterThan(0)
    await expect(fetch(server.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  })

  it('the sweep never kills a pid that no longer looks like a node process', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'driftwatch-serve-'))
    temps.push(dir)
    await writeFile(
      path.join(dir, 'owner.json'),
      JSON.stringify({ serverPid: process.pid, ownerPid: 999999999 }),
      'utf8',
    )

    const killed = await sweepStaleServers(async () => false) // "not a node process"

    expect(killed).toEqual([])
    // We are still alive to make this assertion — that IS the test.
  })
})

describe('route selection', () => {
  it('/ first, then shortest, capped, dynamic segments skipped with reasons', () => {
    const routes = ['/blog/[slug]', '/dashboard', '/a', '/bb', '/', '/ccc', '/dddd', '/eeeee']
    const { selected, skipped } = selectRoutes(routes)

    expect(selected).toEqual(['/', '/a', '/bb', '/ccc', '/dddd'])
    expect(selected.length).toBeLessThanOrEqual(ROUTE_LIMIT)
    expect(skipped).toContainEqual({ route: '/blog/[slug]', reason: 'dynamic segment — no concrete URL to measure' })
    expect(skipped.some((s) => s.route === '/eeeee' && /cap/.test(s.reason))).toBe(true)
  })

  it('prerendered routes are excluded with the SSG reason; dynamic routes lead', () => {
    const routes = ['/', '/about', '/live', '/feed']
    const { selected, skipped } = selectRoutes(routes, new Set(['/', '/about']))

    expect(selected).toEqual(['/feed', '/live'])
    expect(skipped.filter((s) => /prerendered/.test(s.reason)).map((s) => s.route).sort()).toEqual(['/', '/about'])
  })
})

describe('route measurement', () => {
  it('measures sequentially with warm-up discarded and raw samples recorded', async () => {
    const dir = await scratch()
    const server = await bootApp(dir)

    const metrics = await measureRoutes(server, ['/', '/about'])
    const root = metrics.find((m) => m.id === 'route_latency:/')!

    expect(root.status).toBe('measured')
    if (root.status === 'measured') {
      expect(root.unit).toBe('ms')
      expect(root.samples).toBe(5)
      expect(root.sampleValues).toHaveLength(5)
      expect(root.collectedBy).toMatch(/sequential/)
      expect(root.value).toBeGreaterThanOrEqual(5) // the app sleeps 5ms
    }
  })

  it('a non-200 route is skipped with the status and server log tail', async () => {
    const dir = await scratch()
    const server = await bootApp(dir)

    const metrics = await measureRoutes(server, ['/broken'])
    const broken = metrics.find((m) => m.id === 'route_latency:/broken')!

    expect(broken.status).toBe('skipped')
    if (broken.status === 'skipped') expect(broken.reason).toMatch(/HTTP 500/)
  })
})
