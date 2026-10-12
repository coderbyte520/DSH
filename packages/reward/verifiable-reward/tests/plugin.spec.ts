import { describe, expect, it } from 'vitest'
import { Context } from '@vreal/cordis'
import AgentRegistry, { Inbox } from '@vreal/dsh-agent'
import type { Agent } from '@vreal/dsh-agent'
import { CallId } from '@vreal/dsh-llm'
import { Session, SessionId } from '@vreal/dsh-session'
import SystemPrompt from '@vreal/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@vreal/dsh-tools'
import type { JsonValue, ToolExecutionResult } from '@vreal/dsh-tools'
import * as reward from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { RewardCheckMeta } from '../src/types.ts'

const testToolSignal = new AbortController().signal

/** Canonical shell value the scripted body returns. */
type ShellValue = Record<string, JsonValue>

/** One registry-compatible live agent whose session receives the audit events. */
function stubAgent(rawId: string): Agent {
  const session = Session.create(SessionId(rawId))
  const status = 'running' as const
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/** One foreground shell canonical value with text-only streams. */
function foreground(stdout: string, exitCode = 0): ShellValue {
  return {
    kind: 'foreground',
    exitCode,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
  }
}

/**
 * The real tool registry over a scripted shell body: every case drives the
 * complete pipeline, so the observer sees exactly what production sees.
 */
interface Harness {
  readonly session: Session
  /** Value the shell body returns next; `'throw'` makes the body fail. */
  respond(value: ShellValue | 'throw'): void
  /** Execute one call as the harness agent's own initiator. */
  execute(name: string, args: unknown, asAgent?: boolean): Promise<ToolExecutionResult>
  /** The append-only reward audit records, with their envelope marker. */
  audits(): (RewardCheckMeta & { ignorable?: true })[]
  /** Dispose only the scoring plugin, leaving the registry and agent live. */
  disposeScoring(): Promise<void>
}

/** How the harness mounts the plugin. */
interface HarnessOptions {
  /** Invoke `apply` directly instead of mounting a Loader-normalized plugin. */
  readonly raw?: boolean
}

async function harness(config: Config = {}, options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)

  let scripted: ShellValue = foreground('')
  let thrown = false
  for (const name of ['bash', 'pwsh']) {
    ctx.tools.register(defineTool({
      name,
      description: `${name} test double`,
      parameters: { command: { type: 'string' } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: () => [{ type: 'text' as const, text: 'ran' }],
      },
      async execute() {
        if (thrown) throw new Error('shell executor unavailable')
        return scripted
      },
    }))
  }

  const agent = stubAgent(`verifiable-reward-${Math.random()}`)
  ctx.agents.register(agent)
  let unmount: () => Promise<void>
  if (options.raw === true) {
    reward.apply(ctx, config)
    unmount = () => Promise.resolve()
  } else {
    const fiber = await ctx.plugin(reward, config)
    unmount = () => fiber.dispose()
  }

  return {
    session: agent.session,
    respond(value) {
      if (value === 'throw') {
        thrown = true
        return
      }
      thrown = false
      scripted = value
    },
    async execute(name, args, asAgent = true) {
      const run = () => ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId(`call-${Math.random()}`),
        name,
        arguments: args,
        ...asAgent ? { agent } : {},
      })
      return asAgent ? ctx.agents.withInitiator(agent, run) : run()
    },
    audits() {
      return agent.session.events
        .filter(event => event.type === 'reward/check')
        .map(event => event.ignorable === true ? { ...event.data, ignorable: true } : { ...event.data })
    },
    disposeScoring: unmount,
  }
}

describe('verifiable-reward observer', () => {
  it('appends one ignorable audit record and leaves the tool result untouched', async () => {
    const mounted = await harness()
    const value = foreground('3 passed | 1 failed')
    mounted.respond(value)

    const result = await mounted.execute('bash', { command: 'pnpm test' })

    expect(result).toEqual({ isError: false, value, content: [{ type: 'text', text: 'ran' }] })
    expect(mounted.audits()).toEqual([{
      kind: 'reward/check',
      version: 1,
      callId: expect.any(String) as unknown as string,
      rootCallId: expect.any(String) as unknown as string,
      tool: 'bash',
      command: 'pnpm test',
      check: { name: 'package-manager-test', kind: 'test', weight: 1 },
      exitCode: 0,
      isError: false,
      sandboxDenied: false,
      parsed: true,
      passed: 3,
      failed: 1,
      forbiddenHits: [],
      score: 0.75,
      stdout: { truncated: false },
      stderr: { truncated: false },
      ignorable: true,
    }])
  })

  it('appends nothing when the deployment disables scoring', async () => {
    const mounted = await harness({ enabled: false })
    mounted.respond(foreground('1 passed'))

    await mounted.execute('bash', { command: 'pnpm test' })

    expect(mounted.audits()).toEqual([])
  })

  it('resolves the bundled defaults when a caller invokes apply directly', async () => {
    const mounted = await harness({}, { raw: true })
    mounted.respond(foreground('1 passed'))

    await mounted.execute('bash', { command: 'pnpm test' })

    const [record] = mounted.audits()
    expect(record?.check).toEqual({ name: 'package-manager-test', kind: 'test', weight: 1 })
    expect(record?.score).toBe(1)
  })

  it('observes only the configured tool names', async () => {
    const mounted = await harness({ tools: ['pwsh'] })
    mounted.respond(foreground('1 passed'))

    await mounted.execute('bash', { command: 'pnpm test' })
    expect(mounted.audits()).toEqual([])

    await mounted.execute('pwsh', { command: 'pnpm test' })
    expect(mounted.audits().map(record => record.tool)).toEqual(['pwsh'])
  })

  it('appends nothing for a command no check matches', async () => {
    const mounted = await harness()
    mounted.respond(foreground(''))

    await mounted.execute('bash', { command: 'ls -la' })

    expect(mounted.audits()).toEqual([])
  })

  it('appends nothing when the call carries no command string', async () => {
    const mounted = await harness()
    mounted.respond(foreground(''))

    await mounted.execute('bash', {})
    await mounted.execute('bash', 'pnpm test')
    await mounted.execute('bash', null)
    await mounted.execute('bash', { command: '' })

    expect(mounted.audits()).toEqual([])
  })

  it('appends nothing for a canonical value that is not a foreground result', async () => {
    const mounted = await harness()
    mounted.respond({ kind: 'background', jobId: 'job-1' })

    await mounted.execute('bash', { command: 'pnpm test' })

    expect(mounted.audits()).toEqual([])
  })

  it('appends nothing when no agent owns the call', async () => {
    const mounted = await harness()
    mounted.respond(foreground('1 passed'))

    await mounted.execute('bash', { command: 'pnpm test' }, false)

    expect(mounted.audits()).toEqual([])
  })

  it('records an unparsed outcome without count fields', async () => {
    const mounted = await harness()
    mounted.respond(foreground('no summary here'))

    await mounted.execute('bash', { command: 'pnpm test' })

    const [record] = mounted.audits()
    if (record === undefined) throw new Error('expected one audit record')
    expect(record.parsed).toBe(false)
    expect('passed' in record).toBe(false)
    expect('failed' in record).toBe(false)
    expect(record.score).toBe(1)
  })

  it('records a failed call with the command-scoped hits it could still scan', async () => {
    const mounted = await harness()
    mounted.respond('throw')

    const result = await mounted.execute('bash', { command: 'pnpm test && rm -rf / --no-preserve-root' })

    expect(result.isError).toBe(true)
    expect(mounted.audits()).toEqual([{
      kind: 'reward/check',
      version: 1,
      callId: expect.any(String) as unknown as string,
      rootCallId: expect.any(String) as unknown as string,
      tool: 'bash',
      command: 'pnpm test && rm -rf / --no-preserve-root',
      check: { name: 'package-manager-test', kind: 'test', weight: 1 },
      exitCode: null,
      isError: true,
      sandboxDenied: false,
      parsed: false,
      forbiddenHits: [{ name: 'recursive-delete-root', penalty: 1, scope: 'command' }],
      score: 0,
      ignorable: true,
    }])
  })

  it('honors deployment checks, penalties, and tool names', async () => {
    const mounted = await harness({
      tools: ['bash'],
      checks: [{ name: 'lint', kind: 'build', commandPattern: 'mytool lint', weight: 3 }],
      forbiddenPatterns: [{ name: 'no-warnings', pattern: 'warning', scope: 'stdout', penalty: 0.5 }],
    })
    mounted.respond(foreground('2 warnings'))

    await mounted.execute('bash', { command: 'mytool lint' })

    const [record] = mounted.audits()
    expect(record?.check).toEqual({ name: 'lint', kind: 'build', weight: 3 })
    expect(record?.forbiddenHits).toEqual([{ name: 'no-warnings', penalty: 0.5, scope: 'stdout' }])
    expect(record?.score).toBe(0.5)
    expect(record?.exitCode).toBe(0)
    expect(record?.parsed).toBe(false)
  })

  it('stops observing once the plugin is disposed', async () => {
    const mounted = await harness()
    mounted.respond(foreground('1 passed'))
    await mounted.execute('bash', { command: 'pnpm test' })
    expect(mounted.audits()).toHaveLength(1)

    await mounted.disposeScoring()
    await mounted.execute('bash', { command: 'pnpm test' })

    expect(mounted.audits()).toHaveLength(1)
  })
})

describe('verifiable-reward config schema', () => {
  it('resolves the bundled defaults', () => {
    const resolved = new reward.Config({})
    expect(resolved.enabled).toBe(true)
    expect(resolved.tools).toEqual(['bash', 'pwsh'])
    expect(resolved.checks?.map(check => check.name)).toEqual([
      'go-test',
      'make-test',
      'js-test-runner',
      'package-manager-test',
      'compiler-build',
      'package-manager-build',
      'script-run',
    ])
    expect(resolved.checks?.every(check => check.weight === 1 && check.passedPattern === '')).toBe(true)
    expect(resolved.forbiddenPatterns?.map(pattern => pattern.name)).toEqual([
      'recursive-delete-root',
      'force-push',
      'pipe-to-shell',
    ])
    expect(resolved.forbiddenPatterns?.every(pattern => pattern.penalty === 1)).toBe(true)
  })

  it('rejects unusable configuration at load', () => {
    expect(() => new reward.Config({ tools: [''] })).toThrow()
    expect(() => new reward.Config({ checks: [{ name: '', kind: 'test', commandPattern: 'x' }] })).toThrow()
    expect(() => new reward.Config({ checks: [{ name: 'x', kind: 'test', commandPattern: '' }] })).toThrow()
    expect(() => new reward.Config({ checks: [{ name: 'x', kind: 'test', commandPattern: 'x', weight: -1 }] })).toThrow()
    expect(() => new reward.Config({ forbiddenPatterns: [{ name: 'x', pattern: '' }] })).toThrow()
    expect(() => new reward.Config({ forbiddenPatterns: [{ name: 'x', pattern: 'x', penalty: -1 }] })).toThrow()
  })
})
