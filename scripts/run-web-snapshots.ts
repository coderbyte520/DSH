/**
 * Run serial browser owners before one bounded snapshot pool.
 *
 * Every browser scenario boots the assembled app — a host process plus a
 * browser executing the full client bundle set, which is CPU-bound. Two such
 * owners on the standard two-core runner starve each other's boot and the specs
 * fail on their own element waits, so the scenarios whose first wait is the
 * assembled boot run one at a time.
 */
import { spawn } from 'node:child_process'
import { pnpmInvocation } from './pnpm-invocation.ts'

const serialFiles = [
  'apps/web/tests/hmr-live.e2e.ts',
  'apps/web/tests/cordis-tool-round.e2e.ts',
  'apps/web/tests/chat-scroll-contract.e2e.ts',
  'apps/web/tests/goal-multi-turn-actions.e2e.ts',
  'apps/web/tests/queue-actions.e2e.ts',
  'apps/web/tests/shipped-composition.e2e.ts',
  'apps/web/tests/smoke-real.e2e.ts',
  'apps/web/tests/startup-auto-selection.e2e.ts',
  'apps/web/tests/steering.e2e.ts',
  'apps/web/tests/workflow-run.e2e.ts',
]
const workerRaw = process.env.DSH_WEB_SNAPSHOT_WORKERS
const workers = Number.parseInt(workerRaw ?? '', 10)
if (!Number.isSafeInteger(workers) || workers < 2 || String(workers) !== workerRaw) {
  throw new Error(`DSH_WEB_SNAPSHOT_WORKERS must be an integer greater than 1, got ${JSON.stringify(workerRaw)}.`)
}
const invocation = pnpmInvocation(['exec', 'vitest', 'run', '--config', 'vitest.web.config.ts'])
let serialStatus = 0
for (const file of serialFiles) {
  serialStatus = await run(invocation.command, [...invocation.args, file])
  if (serialStatus !== 0) break
}
if (serialStatus === 0) {
  process.exitCode = await run(invocation.command, [
    ...invocation.args,
    ...serialFiles.map(file => `--exclude=${file}`),
    '--fileParallelism',
    `--maxWorkers=${String(workers)}`,
  ])
} else {
  process.exitCode = serialStatus
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (exitCode, signalCode) => {
      if (signalCode !== null) {
        console.error(`web snapshots terminated by ${signalCode}`)
        resolveRun(1)
        return
      }
      resolveRun(exitCode ?? 1)
    })
  })
}
