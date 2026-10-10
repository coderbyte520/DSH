import { describe, expect, it } from 'vitest'
import { Context } from '@vreal/cordis'
import AgentRegistry, { Inbox } from '@vreal/dsh-agent'
import type { Agent, AgentStatus } from '@vreal/dsh-agent'
import GoalService from '@vreal/dsh-goal'
import { createUserMessage, CallId } from '@vreal/dsh-llm'
import type { MessageSource } from '@vreal/dsh-llm'
import { Session, SessionId } from '@vreal/dsh-session'
import type { GoalId } from '@vreal/dsh-goal/types'
import SubagentRuntime from '@vreal/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@vreal/dsh-subagent'
import SystemPrompt from '@vreal/dsh-system-prompt'
import ToolRuntime from '@vreal/dsh-tools'
import type { ToolExecutionResult } from '@vreal/dsh-tools'
import * as toolGoal from '@vreal/dsh-tool-goal'
import * as goalEvaluator from '../src/index.ts'
import type { Config as GoalEvaluatorConfig } from '../src/index.ts'
import type { GoalEvaluationMeta } from '../src/types.ts'

const testToolSignal = new AbortController().signal

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  setStatus(status: AgentStatus): void
}

/** Build one registry-compatible live agent whose injections enter the durable inbox. */
function stubAgent(rawId: string): StubAgent {
  const session = Session.create(SessionId(rawId))
  let status: AgentStatus = 'running'
  const agent: Agent = {
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
  return { agent, session, setStatus(value) { status = value } }
}

/** Open one message-triggered turn with its accepted model-visible input. */
function openTurn(stub: StubAgent, source: MessageSource, text = 'prompt'): number {
  const turn = stub.session.events
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
  stub.agent.inbox.append('next-turn', message)
  const claimed = stub.agent.inbox.claim('next-turn', turn)
  if (claimed.length === 0) throw new Error('expected queued turn input')
  stub.session.append('turn/start', { turn })
  for (const admitted of claimed) {
    stub.session.append('user/message', admitted, { surfaceOp: 'append' })
  }
  return turn
}

interface ProviderScript {
  structured?: unknown
  stopReason?: SubagentResult['stopReason']
  startError?: unknown
}

class ScriptedProvider implements SubagentProvider {
  readonly name = 'fresh'
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  readonly requests: SubagentStartRequest[] = []
  disposed = 0
  script: ProviderScript = {}

  constructor(options?: { outputSchema?: boolean; inheritsParentContext?: boolean }) {
    this.capabilities = {
      outputSchema: options?.outputSchema ?? true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    }
    this.inheritsParentContext = options?.inheritsParentContext ?? false
  }

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    this.requests.push(request)
    if (this.script.startError !== undefined) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise arbitrary provider rejection values.
      return Promise.reject(this.script.startError)
    }
    const settled: SubagentResult = {
      output: [],
      stopReason: this.script.stopReason ?? 'completed',
      ...this.script.structured === undefined ? {} : { structured: this.script.structured },
    }
    return Promise.resolve({
      id: request.parent.id,
      localAgent: undefined,
      result: Promise.resolve(settled),
      dispose: () => {
        this.disposed += 1
        return Promise.resolve()
      },
    })
  }
}

interface SetupOptions {
  evaluator?: GoalEvaluatorConfig
  toolGoalConfig?: toolGoal.Config
  provider?: ScriptedProvider
}

async function harness(options?: SetupOptions) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(GoalService)
  await ctx.plugin(SubagentRuntime)
  const provider = options?.provider ?? new ScriptedProvider()
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(toolGoal, options?.toolGoalConfig ?? {})
  const evaluatorOptions = options?.evaluator
  const evaluatorConfig: GoalEvaluatorConfig = {
    subagentProvider: evaluatorOptions?.subagentProvider ?? 'fresh',
    ...evaluatorOptions?.enabled === undefined ? {} : { enabled: evaluatorOptions.enabled },
    ...evaluatorOptions?.evaluatorModel === undefined ? {} : { evaluatorModel: evaluatorOptions.evaluatorModel },
  }
  const fiber = await ctx.plugin(goalEvaluator, evaluatorConfig)
  const root = stubAgent(`goal-evaluator-root-${Math.random()}`)
  ctx.agents.register(root.agent)
  return { ctx, provider, fiber, root }
}

/** Execute one registered tool as the agent's own driver initiator. */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  const run = () => ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return agent === undefined ? run() : ctx.agents.withInitiator(agent, run)
}

const COMPLETE_VERDICT = {
  verdict: 'complete',
  confirmed: ['The workspace contains the finished work.'],
  missing: [],
  reasons: 'Every objective item is verified in the workspace.',
}

const CONTINUE_VERDICT = {
  verdict: 'continue',
  confirmed: ['The first slice is finished.'],
  missing: ['The second slice is still missing.'],
  reasons: 'The second slice remains unimplemented.',
}

const BLOCKED_VERDICT = {
  verdict: 'blocked',
  confirmed: [],
  missing: [],
  reasons: 'The required credential is unavailable outside the workspace.',
}

/** Open the current goal's next admitted round on the root agent. */
function openGoalRound(root: StubAgent, goal: { id: GoalId; revision: number; roundsStarted: number }): number {
  return openTurn(root, {
    kind: 'goal', goalId: goal.id, revision: goal.revision, round: goal.roundsStarted + 1,
  })
}

/** Create a goal from a human turn, then open its first admitted round. */
function armedGoalRound(root: StubAgent, ctx: Context): number {
  const humanTurn = openTurn(root, { kind: 'user' })
  const created = ctx.goals.create(root.agent, { objective: 'ship verified support' })
  // Closing is not required for authority; the goal round turn opens next.
  void humanTurn
  return openGoalRound(root, created)
}

/** Read the audit events appended to the root session. */
function evaluations(root: StubAgent): (GoalEvaluationMeta & { ignorable?: true })[] {
  return root.session.events
    .filter(event => event.type === 'goal/evaluation')
    .map(event => event.ignorable === true ? { ...event.data, ignorable: true } : { ...event.data })
}

describe('goal evaluator configuration', () => {
  it('validates config when apply is called directly', () => {
    expect(() => { goalEvaluator.apply(new Context(), { subagentProvider: '' }) })
      .toThrow('subagentProvider must be a non-empty normalized string')
    expect(() => { goalEvaluator.apply(new Context(), { evaluatorModel: ' mock ' }) })
      .toThrow('evaluatorModel must be a normalized string (empty means no override)')
  })

  it('registers the certification prompt and disposes with the fiber', async () => {
    const { ctx, fiber } = await harness()
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'goal-evaluator')
    expect(section?.text).toContain('independent evaluator child')
    await fiber.dispose()
    const after = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'goal-evaluator')
    expect(after).toBeUndefined()
  })

  it('enabled false registers neither prompt nor interception', async () => {
    const { ctx, provider, root } = await harness({ evaluator: { enabled: false } })
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'goal-evaluator')
    expect(section).toBeUndefined()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(provider.requests).toHaveLength(0)
    expect(result.isError).toBe(false)
    expect(ctx.goals.get(root.agent)?.phase).toBe('complete')
  })
})

describe('goal evaluator interception scope', () => {
  it('ignores other tools and non-terminal update_goal actions', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    await execute(ctx, 'get_goal', {}, root.agent)
    await execute(ctx, 'update_goal', {
      goal_id: 'goal-x', revision: 1, action: 'pause',
    }, root.agent).catch(() => undefined)
    expect(provider.requests).toHaveLength(0)
  })

  it('delegates direct-human terminal claims without evaluation', async () => {
    const { ctx, provider, root } = await harness()
    openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'human owned' })
    const result = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'complete',
    }, root.agent)
    expect(provider.requests).toHaveLength(0)
    expect(result.isError).toBe(false)
    expect(evaluations(root)).toHaveLength(0)
  })

  it('delegates claims without any authority so tool-goal rejects them', async () => {
    const { ctx, provider, root } = await harness()
    openTurn(root, { kind: 'plugin', plugin: 'test' })
    const result = await execute(ctx, 'update_goal', {
      goal_id: 'goal-missing', revision: 1, action: 'complete',
    }, root.agent)
    expect(provider.requests).toHaveLength(0)
    expect(result.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
  })

  it('delegates non-object update_goal arguments so tool-goal rejects them', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const result = await execute(ctx, 'update_goal', [goal.id, goal.revision], root.agent)
    expect(provider.requests).toHaveLength(0)
    expect(result.isError).toBe(true)
  })
})

describe('goal evaluator verdict handling', () => {
  it('certifies an agreeing complete verdict and records the audit event', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = COMPLETE_VERDICT
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.isError).toBe(false)
    expect(provider.requests).toHaveLength(1)
    expect(provider.disposed).toBe(1)
    const after = ctx.goals.get(root.agent)
    expect(after?.phase).toBe('complete')
    const [audit] = evaluations(root)
    expect(audit).toMatchObject({
      kind: 'goal/evaluation',
      version: 1,
      goalId: goal.id,
      revision: goal.revision,
      round: 1,
      requestedAction: 'complete',
      verdict: 'complete',
      confirmed: COMPLETE_VERDICT.confirmed,
      missing: [],
      provider: 'fresh',
    })
    expect(audit?.ignorable).toBe(true)
  })

  it('rejects a continue verdict with the evaluator missing work', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = CONTINUE_VERDICT
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected rejection')
    expect(result.error.info?.code).toBe('GOAL_EVALUATOR_REJECTED')
    expect(result.content[0]).toMatchObject({ type: 'text' })
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('The second slice is still missing.')
    expect(ctx.goals.get(root.agent)?.phase).toBe('active')
    expect(evaluations(root)[0]).toMatchObject({ verdict: 'continue', requestedAction: 'complete' })
  })

  it('rejects a mismatched blocked verdict on a complete claim', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = BLOCKED_VERDICT
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_REJECTED')
    expect(ctx.goals.get(root.agent)?.phase).toBe('active')
    expect(evaluations(root)[0]).toMatchObject({ verdict: 'blocked', requestedAction: 'complete' })
  })

  it('certifies an agreeing blocked verdict while tool-goal still owns the threshold', async () => {
    const { ctx, provider, root } = await harness({ toolGoalConfig: { blockedAfterConsecutiveRounds: 2 } })
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = BLOCKED_VERDICT
    const below = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'blocked',
      blocked_reason: 'The required credential is unavailable.',
    }, root.agent)
    expect(below.error?.info?.code).toBe('GOAL_TOOL_BLOCK_THRESHOLD')
    expect(provider.requests).toHaveLength(1)
    openGoalRound(root, ctx.goals.get(root.agent) ?? goal)
    const blocked = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'blocked',
      blocked_reason: 'The required credential is unavailable.',
    }, root.agent)
    expect(blocked.isError).toBe(false)
    expect(ctx.goals.get(root.agent)?.phase).toBe('blocked')
  })

  it('rejects a complete verdict on a blocked claim', async () => {
    const { ctx, provider, root } = await harness({ toolGoalConfig: { blockedAfterConsecutiveRounds: 1 } })
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = COMPLETE_VERDICT
    // blocked_reason omitted on purpose: the evaluator runs before tool-goal's
    // own argument validation, so the claim still reaches certification.
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'blocked',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_REJECTED')
    expect(ctx.goals.get(root.agent)?.phase).toBe('active')
  })
})

describe('goal evaluator failure handling', () => {
  it('rejects the update when the evaluator child errors', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.stopReason = 'error'
    provider.script.structured = COMPLETE_VERDICT
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    expect(ctx.goals.get(root.agent)?.phase).toBe('active')
    expect(evaluations(root)[0]).toMatchObject({ verdict: 'failed' })
  })

  it('rejects the update when the evaluator child is cancelled', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.stopReason = 'aborted'
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    if (!result.isError) throw new Error('expected rejection')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('cancelled')
  })

  it('rejects the update when a completed child returns no structured verdict', async () => {
    const { ctx, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
  })

  it('rejects the update when the structured verdict violates its semantics', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = { ...COMPLETE_VERDICT, missing: ['Unmet item.'] }
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    if (!result.isError) throw new Error('expected rejection')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('a complete goal-evaluator verdict needs confirmed evidence')
    expect(ctx.goals.get(root.agent)?.phase).toBe('active')
  })

  it('rejects the update when the provider is missing', async () => {
    const { ctx, root } = await harness({ evaluator: { subagentProvider: 'absent' } })
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    if (!result.isError) throw new Error('expected rejection')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('is not registered')
    expect(evaluations(root)[0]).toMatchObject({ verdict: 'failed', provider: 'absent' })
  })

  it('rejects the update when the provider inherits parent context', async () => {
    const provider = new ScriptedProvider({ inheritsParentContext: true })
    const { ctx, root } = await harness({ provider })
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects the update when the provider lacks structured output', async () => {
    const provider = new ScriptedProvider({ outputSchema: false })
    const { ctx, root } = await harness({ provider })
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
  })

  it('rejects the update when starting the evaluator child throws', async () => {
    const provider = new ScriptedProvider()
    provider.script.startError = new Error('provider exploded')
    const { ctx, root } = await harness({ provider })
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    if (!result.isError) throw new Error('expected rejection')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('provider exploded')
  })

  it('rejects the update when starting the evaluator child throws a non-error', async () => {
    const provider = new ScriptedProvider()
    provider.script.startError = 'plain string failure'
    const { ctx, root } = await harness({ provider })
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const result = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    if (!result.isError) throw new Error('expected rejection')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('plain string failure')
  })

  it('rejects a verdict whose confirmed or missing entries are not normalized', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = { ...COMPLETE_VERDICT, confirmed: [''] }
    const confirmed = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(confirmed.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    if (!confirmed.isError) throw new Error('expected rejection')
    const confirmedText = confirmed.content[0]?.type === 'text' ? confirmed.content[0].text : ''
    expect(confirmedText).toContain('confirmed and missing must contain only non-empty normalized strings')
    provider.script.structured = { ...CONTINUE_VERDICT, missing: [' padded '] }
    const missing = await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(missing.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
    expect(ctx.goals.get(root.agent)?.phase).toBe('active')
  })

  it('rejects structurally invalid verdicts', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    const cases: { structured: unknown; detail: string }[] = [
      { structured: null, detail: 'returned no structured verdict' },
      { structured: { ...COMPLETE_VERDICT, reasons: '' }, detail: 'reasons must be non-empty and normalized' },
      { structured: { ...COMPLETE_VERDICT, verdict: 'nonsense' }, detail: 'verdict is invalid' },
      {
        structured: { verdict: 'continue', confirmed: [], missing: [], reasons: 'nothing listed' },
        detail: 'a continuing goal-evaluator verdict needs at least one missing entry',
      },
    ]
    for (const item of cases) {
      provider.script.structured = item.structured
      const result = await execute(ctx, 'update_goal', {
        goal_id: goal.id, revision: goal.revision, action: 'complete',
      }, root.agent)
      expect(result.error?.info?.code).toBe('GOAL_EVALUATOR_FAILED')
      if (!result.isError) throw new Error('expected rejection')
      const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
      expect(text).toContain(item.detail)
    }
    expect(ctx.goals.get(root.agent)?.phase).toBe('active')
  })
})

describe('goal evaluator child request', () => {
  it('carries the objective, round, claim, and blocked reason in a fresh prompt', async () => {
    const { ctx, provider, root } = await harness()
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = BLOCKED_VERDICT
    await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'blocked',
      blocked_reason: 'The required credential is unavailable.',
    }, root.agent)
    const request = provider.requests[0]
    expect(request?.label).toBe('Goal evaluator round 1')
    expect(request?.parent).toBe(root.agent)
    expect(request?.outputSchema).toMatchObject({ type: 'object' })
    expect(request?.agentOptions).toBeUndefined()
    const block = request?.prompt[0]
    if (block?.type !== 'text') throw new Error('expected one text prompt block')
    expect(block.text).toContain('"ship verified support"')
    expect(block.text).toContain('Goal round: 1 of ')
    expect(block.text).toContain('claims the objective is blocked')
    expect(block.text).toContain('The required credential is unavailable.')
    expect(block.text).toContain('Do not modify the workspace')
  })

  it('routes the evaluator to a configured model override', async () => {
    const { ctx, provider, root } = await harness({ evaluator: { evaluatorModel: 'mock-strong' } })
    armedGoalRound(root, ctx)
    const goal = ctx.goals.get(root.agent)
    if (goal === undefined) throw new Error('expected armed goal')
    provider.script.structured = COMPLETE_VERDICT
    await execute(ctx, 'update_goal', {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    }, root.agent)
    expect(provider.requests[0]?.agentOptions).toEqual({ model: 'mock-strong' })
    expect(evaluations(root)[0]).toMatchObject({ evaluatorModel: 'mock-strong' })
  })
})
