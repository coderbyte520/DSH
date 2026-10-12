import { describe, expect, it } from 'vitest'
import { Context } from '@vreal/cordis'
import type { Agent } from '@vreal/dsh-agent'
import AgentLoop from '@vreal/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@vreal/dsh-agent-loop-testkit'
import GoalService from '@vreal/dsh-goal'
import type { GoalView } from '@vreal/dsh-goal/types'
import { createUserMessage } from '@vreal/dsh-llm'
import { SessionId } from '@vreal/dsh-session'
import SubagentRuntime from '@vreal/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@vreal/dsh-subagent-in-process-driver'
import * as spawn from '@vreal/dsh-subagent-spawn-in-process'
import * as toolGoal from '@vreal/dsh-tool-goal'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as goalEvaluator from '../src/index.ts'

type MockScript = ConstructorParameters<typeof MockAdapter>[0]

const CONTINUE_VERDICT = {
  verdict: 'continue',
  confirmed: ['Verified the first slice in the workspace.'],
  missing: ['EVAL_MISSING: finish the second slice.'],
  reasons: 'The first slice is verified, but the second slice is absent.',
}

const COMPLETE_VERDICT = {
  verdict: 'complete',
  confirmed: ['Verified both slices and their focused tests in the workspace.'],
  missing: [],
  reasons: 'Verified evidence proves the objective is satisfied.',
}

/** The real goal certification stack with one active goal on a fresh parent. */
interface Mounted {
  readonly ctx: Context
  readonly parent: Agent
  readonly goal: GoalView
  readonly handle: { dispose(): Promise<void> }
}

/** Mount the stack and create one active goal before any model request. */
async function mount(config: goalEvaluator.Config): Promise<Mounted> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GoalService)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(toolGoal, {})
  await ctx.plugin(goalEvaluator, config)
  const handle = await ctx.agents.create({
    sessionId: SessionId(`goal-evaluator-parent-${Math.random()}`),
    meta: { cwd: '/tmp/goal-evaluator-shared-workspace' },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const goal = ctx.goals.create(handle.agent, { objective: 'Complete both workspace slices.' })
  return { ctx, parent: handle.agent, goal, handle }
}

/** Bind the mock adapter and deliver the goal's first admitted round to the live loop. */
function startGoalRound(mounted: Mounted, script: MockScript): MockAdapter {
  const adapter = new MockAdapter(script)
  mounted.ctx.llm.registerAdapter(['mock'], adapter)
  mounted.parent.followup(createUserMessage({
    content: [{ type: 'text', text: 'GOAL_ROUND_PROMPT_MARKER' }],
    source: { kind: 'goal', goalId: mounted.goal.id, revision: mounted.goal.revision, round: 1 },
  }))
  return adapter
}

/** Collect the child agent ids of every evaluator run started below the parent. */
function childIdsOf(mounted: Mounted): () => string[] {
  const ids: string[] = []
  mounted.ctx.on('subagent/start', (info) => { ids.push(info.id) })
  return () => ids
}

describe('dsh-goal-evaluator over the real spawn stack', () => {
  it('rejects a premature claim on missing work and completes on evaluator confirmation', async () => {
    const mounted = await mount({ subagentProvider: 'spawn' })
    const goalId = mounted.goal.id
    const adapter = startGoalRound(mounted, [
      toolCallResponse('update-1', 'update_goal', { goal_id: goalId, revision: 1, action: 'complete' }),
      toolCallResponse('eval-1', STRUCTURED_OUTPUT_TOOL, CONTINUE_VERDICT),
      toolCallResponse('update-2', 'update_goal', { goal_id: goalId, revision: 1, action: 'complete' }),
      toolCallResponse('eval-2', STRUCTURED_OUTPUT_TOOL, COMPLETE_VERDICT),
      textResponse('The evaluator certified the objective complete.'),
    ])
    const childIds = childIdsOf(mounted)
    await mounted.parent.whenIdle()

    const { ctx, parent } = mounted
    expect(ctx.goals.get(parent)?.phase).toBe('complete')
    expect(adapter.requests).toHaveLength(5)
    const evaluatorOne = JSON.stringify(adapter.requests[1]!.messages)
    const evaluatorTwo = JSON.stringify(adapter.requests[3]!.messages)
    for (const serialized of [evaluatorOne, evaluatorTwo]) {
      expect(serialized).toContain('Complete both workspace slices.')
      expect(serialized).toContain('Do not trust the claim')
      expect(serialized).not.toContain('GOAL_ROUND_PROMPT_MARKER')
    }
    // The rejection carried the evaluator's missing work back into the parent request.
    const retryRequest = JSON.stringify(adapter.requests[2]!.messages)
    expect(retryRequest).toContain('EVAL_MISSING: finish the second slice.')
    const audits = parent.session.events.filter(event => event.type === 'goal/evaluation')
    expect(audits.map(event => event.data.verdict)).toEqual(['continue', 'complete'])
    expect(audits.every(event => event.ignorable === true)).toBe(true)
    const evaluatorChildIds = childIds()
    expect(evaluatorChildIds).toHaveLength(2)
    expect(new Set(evaluatorChildIds).size).toBe(2)
    await mounted.handle.dispose()
  })

  it('routes the evaluator child to a configured model override', async () => {
    const mounted = await mount({ subagentProvider: 'spawn', evaluatorModel: 'mock-strong' })
    const goalId = mounted.goal.id
    const adapter = startGoalRound(mounted, [
      toolCallResponse('update-1', 'update_goal', { goal_id: goalId, revision: 1, action: 'complete' }),
      toolCallResponse('eval-1', STRUCTURED_OUTPUT_TOOL, COMPLETE_VERDICT),
      textResponse('Certified.'),
    ])
    await mounted.parent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[0]!.model).toBe('mock')
    expect(adapter.requests[1]!.model).toBe('mock-strong')
    expect(mounted.ctx.goals.get(mounted.parent)?.phase).toBe('complete')
    await mounted.handle.dispose()
  })

  it('keeps the goal active when the evaluator child fails to produce a verdict', async () => {
    const mounted = await mount({ subagentProvider: 'spawn' })
    const goalId = mounted.goal.id
    const adapter = startGoalRound(mounted, [
      toolCallResponse('update-1', 'update_goal', { goal_id: goalId, revision: 1, action: 'complete' }),
      maxTokensResponse('unfinished evaluator output'),
      textResponse('Certification failed; the goal stays active.'),
    ])
    await mounted.parent.whenIdle()

    const { ctx, parent } = mounted
    expect(adapter.requests).toHaveLength(3)
    expect(ctx.goals.get(parent)?.phase).toBe('active')
    const audits = parent.session.events.filter(event => event.type === 'goal/evaluation')
    expect(audits.map(event => event.data.verdict)).toEqual(['failed'])
    // The rejection reached the parent request as a failed certification.
    const retryRequest = JSON.stringify(adapter.requests[2]!.messages)
    expect(retryRequest).toContain('the goal evaluator failed to certify the complete update')
    expect(retryRequest).toContain('stop reason: max-tokens')
    await mounted.handle.dispose()
  })
})
