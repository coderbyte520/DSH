import { describe, expect, it, vi } from 'vitest'
import { Context } from '@vreal/cordis'
import Loader from '@vreal/cordis-plugin-loader'
import type { Agent } from '@vreal/dsh-agent'
import { CallId } from '@vreal/dsh-llm'
import { SessionId } from '@vreal/dsh-session'
import SubagentRuntime from '@vreal/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentRun, SubagentStartRequest } from '@vreal/dsh-subagent'
import SystemPrompt from '@vreal/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@vreal/dsh-tools'
import type { ToolExecutionResult } from '@vreal/dsh-tools'
import { WorkflowRunId, WorkflowEngine } from '@vreal/dsh-workflow'
import type { WorkflowResult, WorkflowRun, WorkflowStartRequest } from '@vreal/dsh-workflow'
import * as toolRalphEvaluated from '../src/index.ts'

const testToolSignal = new AbortController().signal

class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  settle!: (result: WorkflowResult) => void
  startError: Error | undefined
  onStart: (() => void) | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError !== undefined) throw this.startError
    this.requests.push(request)
    const result = new Promise<WorkflowResult>((resolve) => { this.settle = resolve })
    this.onStart?.()
    return {
      id: WorkflowRunId(`evaluated-ralph-${this.requests.length}`),
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({
          value: null,
          stopReason: 'cancelled',
          ...reason === undefined ? {} : { error: reason },
          agentsStarted: 0,
        })
      },
      dispose: () => {
        this.disposed += 1
        return Promise.resolve()
      },
    }
  }
}

class StubProvider implements SubagentProvider {
  readonly name = 'fresh'
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean

  constructor(options?: { outputSchema?: boolean; inheritsParentContext?: boolean }) {
    this.capabilities = {
      outputSchema: options?.outputSchema ?? true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    }
    this.inheritsParentContext = options?.inheritsParentContext ?? false
  }

  start(_request: SubagentStartRequest): Promise<SubagentRun> {
    return Promise.reject(new Error('StubProvider.start must not be reached behind StubEngine'))
  }
}

interface SetupOptions {
  config?: toolRalphEvaluated.Config
  provider?: StubProvider | false
}

async function setup(options?: SetupOptions) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  const provider = options?.provider === false ? undefined : options?.provider ?? new StubProvider()
  if (provider !== undefined) ctx.subagents.registerProvider(provider)
  await ctx.plugin(StubEngine)
  const config: toolRalphEvaluated.Config = { subagentProvider: 'fresh' }
  if (options?.config?.subagentProvider !== undefined) config.subagentProvider = options.config.subagentProvider
  if (options?.config?.maxRounds !== undefined) config.maxRounds = options.config.maxRounds
  if (options?.config?.maxHandoffChars !== undefined) config.maxHandoffChars = options.config.maxHandoffChars
  if (options?.config?.maxResultChars !== undefined) config.maxResultChars = options.config.maxResultChars
  if (options?.config?.evaluatorModel !== undefined) config.evaluatorModel = options.config.evaluatorModel
  const fiber = await ctx.plugin(toolRalphEvaluated, config)
  const parent = { id: SessionId('caller'), options: {} } as unknown as Agent
  return { ctx, engine: ctx.workflowEngine as StubEngine, parent, fiber }
}

function execute(
  ctx: Context,
  args: unknown,
  extra?: { agent?: Agent; signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: extra?.signal ?? testToolSignal,
    callId: CallId('ralph-evaluated-call'),
    name: 'ralph_evaluated',
    arguments: args,
    ...extra?.agent === undefined ? {} : { agent: extra.agent },
  })
}

const CONTINUE_SUMMARY = {
  workerSummary: 'Implemented the first slice.',
  workerEvidence: ['Focused tests pass.'],
  workerRemaining: ['Implement the second slice.'],
  workerBlocker: '',
  evaluatorConfirmed: ['The first slice is implemented and tested.'],
  evaluatorMissing: ['Implement the second slice.'],
  evaluatorReasons: 'The second slice remains unimplemented.',
}

const COMPLETE_SUMMARY = {
  workerSummary: 'The objective is complete.',
  workerEvidence: ['All required gates pass.'],
  workerRemaining: [],
  workerBlocker: '',
  evaluatorConfirmed: ['All required gates pass.'],
  evaluatorMissing: [],
  evaluatorReasons: 'Verified evidence proves the objective is satisfied.',
}

const BLOCKED_SUMMARY = {
  workerSummary: 'No local work can progress.',
  workerEvidence: ['The required remote service is unavailable.'],
  workerRemaining: ['Retry after service recovery.'],
  workerBlocker: 'The required remote service is unavailable.',
  evaluatorConfirmed: [],
  evaluatorMissing: [],
  evaluatorReasons: 'The required external service is unavailable.',
}

async function settleCompleted(
  engine: StubEngine,
  pending: Promise<ToolExecutionResult>,
  value: unknown,
  agentsStarted = 1,
): Promise<ToolExecutionResult> {
  await vi.waitFor(() => { expect(engine.requests.length).toBeGreaterThan(0) })
  engine.settle({ value, stopReason: 'completed', agentsStarted })
  return pending
}

describe('dsh-tool-ralph-evaluated', () => {
  it('starts the fixed workflow with a doubled child budget and renders evaluator-confirmed completion', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxRounds: 9, maxHandoffChars: 9000 } })
    const pending = execute(ctx, { objective: '  Finish the migration.  ', maxRounds: 4 }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    expect(engine.requests[0]).toMatchObject({
      meta: { name: 'ralph-evaluated-loop' },
      args: { objective: 'Finish the migration.', maxRounds: 4, maxHandoffChars: 9000, evaluatorModel: undefined },
      subagentProvider: 'fresh',
      maxTotalAgents: 8,
      parent,
    })
    expect(engine.requests[0]!.script).toContain("status: 'budget-limited'")
    expect(engine.requests[0]!.script).toContain('verdictSchema')
    const result = await settleCompleted(engine, pending, {
      status: 'complete',
      roundsStarted: 1,
      report: COMPLETE_SUMMARY,
    }, 2)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected evaluated Ralph success')
    expect(result.value).toEqual({
      runId: 'evaluated-ralph-1',
      agentsStarted: 2,
      result: { status: 'complete', roundsStarted: 1, report: COMPLETE_SUMMARY },
    })
    expect((result.content[0] as { text: string }).text)
      .toContain('The evaluator confirmed completion after 1 round.')
    expect((result.content[0] as { text: string }).text).toContain('All required gates pass.')
    expect(engine.disposed).toBe(1)
  })

  it('carries a configured evaluator model override into the workflow args', async () => {
    const { ctx, engine, parent } = await setup({ config: { evaluatorModel: 'mock-strong' } })
    const pending = execute(ctx, { objective: 'Ship it.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    expect(engine.requests[0]).toMatchObject({ args: { evaluatorModel: 'mock-strong' } })
    await settleCompleted(engine, pending, {
      status: 'complete',
      roundsStarted: 1,
      report: COMPLETE_SUMMARY,
    }, 2)
  })

  it('renders blocked and budget-limited terminal outcomes as bounded successful results', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxRounds: 2 } })
    const blocked = execute(ctx, { objective: 'Ship it.' }, { agent: parent })
    const blockedResult = await settleCompleted(engine, blocked, {
      status: 'blocked',
      roundsStarted: 2,
      report: BLOCKED_SUMMARY,
    }, 4)
    expect((blockedResult.content[0] as { text: string }).text)
      .toContain('The evaluator declared a blocker after 2 rounds.')

    const limited = execute(ctx, { objective: 'Ship it.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    const limitedResult = await settleCompleted(engine, limited, {
      status: 'budget-limited',
      roundsStarted: 2,
      report: CONTINUE_SUMMARY,
    }, 4)
    expect((limitedResult.content[0] as { text: string }).text)
      .toContain('The evaluated Ralph loop reached its 2 rounds limit; the evaluator still listed missing work.')
  })

  it('bounds the complete parent result and labels evaluator-confirmed completion', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxResultChars: 160 } })
    const pending = execute(ctx, { objective: 'Ship it.' }, { agent: parent })
    const result = await settleCompleted(engine, pending, {
      status: 'complete',
      roundsStarted: 1,
      report: { ...COMPLETE_SUMMARY, evaluatorConfirmed: ['x'.repeat(500)] },
    })
    const text = (result.content[0] as { text: string }).text
    expect(text).toHaveLength(160)
    expect(text).toContain('The evaluator confirmed completion after 1 round.')
    expect(text).toMatch(/… \[truncated\]$/)
  })

  it('honors a result limit shorter than the truncation marker', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxResultChars: 5 } })
    const result = await settleCompleted(engine, execute(ctx, { objective: 'Ship it.' }, { agent: parent }), {
      status: 'complete',
      roundsStarted: 1,
      report: COMPLETE_SUMMARY,
    })
    expect((result.content[0] as { text: string }).text).toBe('\n… [t')
  })

  it('reports a worker or evaluator failure with the failed round and last durable handoff', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxRounds: 2 } })
    const first = execute(ctx, { objective: 'Ship it.', maxRounds: 2 }, { agent: parent })
    const firstResult = await settleCompleted(engine, first, {
      status: 'round-failed',
      roundsStarted: 1,
      lastReport: null,
    })
    expect(firstResult.isError).toBe(true)
    expect((firstResult.content[0] as { text: string }).text).toContain('Evaluated Ralph round 1 child failed')
    expect((firstResult.content[0] as { text: string }).text).toContain('No previous handoff was available.')

    const later = execute(ctx, { objective: 'Ship it.', maxRounds: 2 }, { agent: parent })
    const laterResult = await settleCompleted(engine, later, {
      status: 'round-failed',
      roundsStarted: 2,
      lastReport: CONTINUE_SUMMARY,
    })
    expect(laterResult.isError).toBe(true)
    expect((laterResult.content[0] as { text: string }).text).toContain('Evaluated Ralph round 2 child failed')
    expect((laterResult.content[0] as { text: string }).text).toContain('Implemented the first slice.')
  })

  it('maps workflow error and cancellation reasons to tool errors and always disposes', async () => {
    const { ctx, engine, parent } = await setup()
    const failed = execute(ctx, { objective: 'Work.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settle({ value: null, stopReason: 'error', error: 'child report malformed', agentsStarted: 1 })
    expect(((await failed).content[0] as { text: string }).text)
      .toContain('Evaluated Ralph workflow failed: child report malformed')

    const unknown = execute(ctx, { objective: 'Work.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    engine.settle({ value: null, stopReason: 'error', agentsStarted: 0 })
    expect(((await unknown).content[0] as { text: string }).text).toContain('unknown error')

    const cancelled = execute(ctx, { objective: 'Work.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(3) })
    engine.settle({ value: null, stopReason: 'cancelled', error: 'user stopped', agentsStarted: 0 })
    expect(((await cancelled).content[0] as { text: string }).text).toContain('cancelled (user stopped)')

    const bare = execute(ctx, { objective: 'Work.' }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(4) })
    engine.settle({ value: null, stopReason: 'cancelled', agentsStarted: 0 })
    expect(((await bare).content[0] as { text: string }).text).toMatch(/cancelled$/)
    expect(engine.disposed).toBe(4)
  })

  it('bridges mid-flight cancellation and skips dispatch for an already-aborted parent signal', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { objective: 'Work.' }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    controller.abort()
    expect((await pending).isError).toBe(true)

    const already = new AbortController()
    already.abort()
    const skipped = await execute(ctx, { objective: 'Work.' }, { agent: parent, signal: already.signal })
    expect(skipped.error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
    expect(engine.requests).toHaveLength(1)
    expect(engine.cancels).toEqual(['parent step aborted'])
    expect(engine.disposed).toBe(1)
  })

  it('bridges cancellation that arrives while the workflow is starting', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    engine.onStart = () => { controller.abort() }

    const result = await execute(ctx, { objective: 'Work.' }, { agent: parent, signal: controller.signal })

    expect(result.isError).toBe(true)
    expect(engine.requests[0]?.signal).toBe(controller.signal)
    expect(engine.cancels).toEqual(['parent step aborted'])
    expect(engine.disposed).toBe(1)
  })

  it('rejects absent authority, empty objectives, bad round caps, and schema-invalid calls before start', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxRounds: 3 } })
    expect((await execute(ctx, { objective: 'Work.' })).isError).toBe(true)
    expect((await execute(ctx, { objective: '   ' }, { agent: parent })).isError).toBe(true)
    for (const maxRounds of [0, 1.5, Number.NaN, 4]) {
      expect((await execute(ctx, { objective: 'Work.', maxRounds }, { agent: parent })).isError).toBe(true)
    }
    const missing = await execute(ctx, {}, { agent: parent })
    expect(missing.error?.info?.code).toBe('INVALID_ARGS')
    expect(engine.requests).toHaveLength(0)
  })

  it('rejects missing, unstructured, and parent-context-inheriting provider routes', async () => {
    const missing = await setup({ provider: false })
    expect(((await execute(missing.ctx, { objective: 'Work.' }, { agent: missing.parent })).content[0] as { text: string }).text)
      .toContain('is not registered')
    expect(missing.engine.requests).toHaveLength(0)

    const unstructured = await setup({ provider: new StubProvider({ outputSchema: false }) })
    expect(((await execute(unstructured.ctx, { objective: 'Work.' }, { agent: unstructured.parent })).content[0] as { text: string }).text)
      .toContain('does not support structured output')

    const inherited = await setup({ provider: new StubProvider({ inheritsParentContext: true }) })
    expect(((await execute(inherited.ctx, { objective: 'Work.' }, { agent: inherited.parent })).content[0] as { text: string }).text)
      .toContain('inherits parent context')
  })

  it('rejects invalid direct-apply config before touching injected services', () => {
    expect(() => { toolRalphEvaluated.apply(new Context(), { subagentProvider: ' ' }) }).toThrow('non-empty normalized')
    expect(() => { toolRalphEvaluated.apply(new Context(), { maxRounds: 0 }) }).toThrow('positive safe integer')
    expect(() => { toolRalphEvaluated.apply(new Context(), { maxHandoffChars: 1.5 }) }).toThrow('positive safe integer')
    expect(() => { toolRalphEvaluated.apply(new Context(), { maxResultChars: 0 }) }).toThrow('positive safe integer')
    expect(() => { toolRalphEvaluated.apply(new Context(), { evaluatorModel: ' mock ' }) }).toThrow('normalized string')
  })

  it('turns malformed fixed-workflow terminal values and summaries into errors', async () => {
    const cases: { value: unknown; message: string; config?: toolRalphEvaluated.Config }[] = [
      { value: null, message: 'malformed terminal result' },
      { value: { status: 'complete', roundsStarted: 0, report: COMPLETE_SUMMARY }, message: 'malformed terminal result' },
      { value: { status: 'complete', roundsStarted: 3, report: COMPLETE_SUMMARY }, message: 'malformed terminal result', config: { maxRounds: 2 } },
      { value: { status: 'mystery', roundsStarted: 1, report: COMPLETE_SUMMARY }, message: 'unknown terminal status' },
      { value: { status: 'budget-limited', roundsStarted: 1, report: CONTINUE_SUMMARY }, message: 'before the round limit', config: { maxRounds: 2 } },
      { value: { status: 'complete', roundsStarted: 1, report: null }, message: 'malformed round summary' },
      { value: { status: 'complete', roundsStarted: 1, report: COMPLETE_SUMMARY, extra: true }, message: 'malformed terminal result' },
      { value: { status: 'blocked', roundsStarted: 1, report: BLOCKED_SUMMARY, extra: true }, message: 'malformed terminal result' },
      { value: { status: 'budget-limited', roundsStarted: 1, report: CONTINUE_SUMMARY, extra: true }, message: 'malformed terminal result', config: { maxRounds: 1 } },
      { value: { status: 'complete', roundsStarted: 1, report: { ...COMPLETE_SUMMARY, evaluatorMissing: ['One gap.'] } }, message: 'invalid completion summary' },
      { value: { status: 'complete', roundsStarted: 1, report: { ...COMPLETE_SUMMARY, evaluatorConfirmed: [] } }, message: 'invalid completion summary' },
      { value: { status: 'budget-limited', roundsStarted: 1, report: { ...CONTINUE_SUMMARY, evaluatorMissing: [] } }, message: 'invalid continuing summary', config: { maxRounds: 1 } },
      { value: { status: 'complete', roundsStarted: 1, report: { ...COMPLETE_SUMMARY, workerSummary: ' padded ' } }, message: 'malformed round summary' },
      { value: { status: 'complete', roundsStarted: 1, report: { ...COMPLETE_SUMMARY, evaluatorReasons: 'x'.repeat(500) } }, message: 'oversized handoff', config: { maxHandoffChars: 100 } },
      { value: { status: 'round-failed', roundsStarted: 1 }, message: 'malformed terminal result' },
      { value: { status: 'round-failed', roundsStarted: 1, lastReport: CONTINUE_SUMMARY }, message: 'invalid first-round failure' },
      { value: { status: 'round-failed', roundsStarted: 2, lastReport: null }, message: 'without its last handoff', config: { maxRounds: 2 } },
      { value: { status: 'round-failed', roundsStarted: 2, lastReport: { ...CONTINUE_SUMMARY, evaluatorMissing: [] } }, message: 'invalid continuing summary', config: { maxRounds: 2 } },
    ]
    for (const testCase of cases) {
      const { ctx, engine, parent } = await setup(
        testCase.config === undefined ? undefined : { config: testCase.config },
      )
      const result = await settleCompleted(
        engine,
        execute(ctx, { objective: 'Work.', ...testCase.config?.maxRounds === undefined ? {} : { maxRounds: testCase.config.maxRounds } }, { agent: parent }),
        testCase.value,
      )
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain(testCase.message)
    }
  })

  it('surfaces a synchronous engine start failure without inventing a run', async () => {
    const { ctx, engine, parent } = await setup()
    engine.startError = new Error('engine refused fixed script')
    const result = await execute(ctx, { objective: 'Work.' }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('engine refused fixed script')
    expect(engine.disposed).toBe(0)
  })

  it('registers scoped guidance and pure replay-safe generic presentation', async () => {
    const { ctx, fiber } = await setup()
    const section = (await ctx.systemPrompt.assemble()).sections.find(candidate => candidate.name === 'tool:ralph_evaluated')
    expect(section?.text).toContain('ONLY when the direct human explicitly asks')
    expect(section?.text).toContain('The worker never decides completion')
    const tool = ctx.tools.get('ralph_evaluated')!
    expect(tool.description).toContain('alone decides')
    expect(tool.presentCall!({ objective: 'Finish it.' })).toEqual({
      card: 'generic',
      title: 'ralph_evaluated',
      rawInput: 'Finish it.',
    })
    expect(tool.presentResult!({ objective: 'Finish it.' }, { content: [], isError: false })).toEqual({ card: 'generic' })
    expect(tool.presentCall!({ nope: true })).toBeUndefined()
    await fiber.dispose()
    expect(ctx.tools.get('ralph_evaluated')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.some(candidate => candidate.name === 'tool:ralph_evaluated')).toBe(false)
  })

  it('has the namespace-plugin export shape', () => {
    expect('default' in toolRalphEvaluated).toBe(false)
    expect(toolRalphEvaluated.name).toBe('tool-ralph-evaluated')
    expect(toolRalphEvaluated.inject).toEqual(['tools', 'workflowEngine', 'subagents', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolRalphEvaluated) as Record<string, unknown>
    expect(unwrapped).toBe(toolRalphEvaluated)
    expect(typeof unwrapped.apply).toBe('function')
  })
})
