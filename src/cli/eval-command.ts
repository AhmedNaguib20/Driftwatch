import path from 'node:path'
import pc from 'picocolors'

/**
 * `driftwatch eval` — dev command (spec §7.2): runs the captured regression cases against the
 * live provider and judges each expectation. This is how every prompt change gets measured
 * instead of argued about. Exits 1 on failure — this command exists for driftwatch development,
 * not for user pipelines, so a red eval should stop a merge.
 */
export async function evalCommand(options: { cases: string }): Promise<void> {
  // eval is the one command that genuinely cannot run without the AI tier — it grades live
  // provider behaviour. That makes it a REFUSAL with a remedy, not a stack trace: every failure
  // carries its own fix (spec §9a), and the tier's own commands are held to that too.
  const { AI_KEY_ENV, DEFAULT_CONFIG, capabilitiesOf, resolveAiKey } = await import('../core/index.js')
  const resolved = await resolveAiKey({ provider: DEFAULT_CONFIG.provider, key_command: null })
  if (resolved.problem) {
    console.error(pc.yellow(`driftwatch eval: ${resolved.problem}`))
    process.exitCode = 1
    return
  }
  if (!resolved.key) {
    const why = capabilitiesOf('ai').find((c) => c.id === 'eval')?.why ?? ''
    console.error(pc.yellow(`driftwatch eval needs the AI tier: ${why}.`))
    console.error('')
    console.error(pc.dim('Set your key and re-run:'))
    console.error('')
    console.error(`    export ${AI_KEY_ENV}=<your DeepSeek or OpenAI key>`)
    console.error('')
    console.error(pc.dim('Measurement needs no key — `driftwatch run`, `record`, `trend` and `alerts` all work without one.'))
    process.exitCode = 1
    return
  }

  const { runEvalCases } = await import('../ai/eval/runner.js')

  // Every output identifies its build (spec v50) — the eval most of all: it is the surface where
  // a stale binary looked like a model problem for two milestones.
  const { buildStamp } = await import('../core/index.js')
  console.log(pc.dim(buildStamp()))

  const results = await runEvalCases(
    path.resolve(options.cases),
    (m) => console.error(pc.dim(`→ ${m}`)),
    resolved.key,
  )

  let failed = 0
  for (const result of results) {
    const badge = result.passed ? pc.green('PASS') : pc.red('FAIL')
    const cost = result.costUsd !== null ? `$${result.costUsd.toFixed(4)}` : 'cost unknown'
    console.log(
      `${badge} ${result.name} ${pc.dim(
        `(prompts v${result.promptVersion ?? '?'} · ${result.tokens.input}→${result.tokens.output} tok${
          result.stageOutput.length > 0
            ? ` [${result.stageOutput.map((s) => `${s.stage} out ${s.output}`).join(', ')}]`
            : ''
        } · ${cost} · ${(result.durationMs / 1000).toFixed(1)}s)`,
      )}`,
    )
    for (const check of result.checks) {
      const mark = check.ok ? pc.green('  ✓') : pc.red('  ✗')
      console.log(`${mark} ${check.check} ${pc.dim(`— ${check.detail}`)}`)
    }
    if (!result.passed) failed += 1
  }

  const total = results.length
  console.log(
    failed === 0
      ? pc.green(`\n${total}/${total} cases passed`)
      : pc.red(`\n${total - failed}/${total} cases passed`),
  )
  if (failed > 0) process.exitCode = 1
}
