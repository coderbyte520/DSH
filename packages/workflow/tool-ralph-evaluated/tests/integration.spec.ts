import { describe, expect, it } from 'vitest'
import { Context } from '@vreal/cordis'
import type { Agent } from '@vreal/dsh-agent'
import AgentLoop from '@vreal/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@vreal/dsh-agent-loop-testkit'
import { createUserMessage, CallId } from '@vreal/dsh-llm'
import { SessionId } from '@vreal/dsh-session'
import SubagentRuntime from '@vreal/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@vreal/dsh-subagent-in-process-driver'
import * as spawn from '@vreal/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@vreal/dsh-workflow-worker-thread'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as toolRalphEvaluated from '../src/index.ts'

type MockScript = ConstructorParameters<typeof MockAdapter>[0]
const testToolSignal = new AbortController().signal

/** Mount the shipped evaluated Ralph execution stack around one keyless model script. */
async function mountEvaluatedRalph(script: MockScript, config: toolRalphEvaluated.Config) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(WorkerThreadWorkflowEngine, {})
  await ctx.plugin(toolRalphEvaluated, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parentHandle = await ctx.agents.create({
    sessionId: SessionId('evaluated-ralph-parent'),
    meta: { cwd: '/tmp/evaluated-ralph-shared-workspace' },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, adapter, parentHandle, parent: parentHandle.agent }
}

/** One valid worker report for the round that keeps the loop going. */
const CONTINUING_WORKER_REPORT = {
  summary: 'ROUND_ONE_WORKER_SUMMARY',
  evidence: ['Created migration-a.ts.'],
  remaining: [],
  blocker: '',
}

const CONTINUING_VERDICT = {
  verdict: 'continue',
  confirmed: ['Verified migration-a.ts in the workspace.'],
  missing: ['EVAL_ONE_MISSING: finish migration-b.ts.'],
  reasons: 'The worker claimed completion, but migration-b.ts is absent.',
}

const COMPLETE_WORKER_REPORT = {
  summary: 'Both migration slices are complete.',
  evidence: ['Focused migration tests pass.'],
  remaining: [],
  blocker: '',
}

const COMPLETE_VERDICT = {
  verdict: 'complete',
  confirmed: ['Verified both migration slices and their focused tests in the workspace.'],
  missing: [],
  reasons: 'Verified evidence proves the objective is satisfied.',
}

describe('dsh-tool-ralph-evaluated over the real spawn and worker-thread stack', () => {
  it('overturns a premature worker claim and completes only on evaluator confirmation', async () => {
    const ctx = new Context()
    const adapter = new MockAdapter([
      textResponse('PARENT_HISTORY_MARKER'),
      toolCallResponse('worker-1', STRUCTURED_OUTPUT_TOOL, CONTINUING_WORKER_REPORT),
      toolCallResponse('evaluator-1', STRUCTURED_OUTPUT_TOOL, CONTINUING_VERDICT),
      toolCallResponse('worker-2', STRUCTURED_OUTPUT_TOOL, COMPLETE_WORKER_REPORT),
      toolCallResponse('evaluator-2', STRUCTURED_OUTPUT_TOOL, COMPLETE_VERDICT),
    ])
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(WorkerThreadWorkflowEngine, {})
    await ctx.plugin(toolRalphEvaluated, { maxRounds: 2 })
    ctx.llm.registerAdapter(['mock'], adapter)

    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('evaluated-ralph-parent'),
      meta: { cwd: '/tmp/evaluated-ralph-shared-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = parentHandle.agent
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'PARENT_PROMPT_MARKER' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const children: Agent[] = []
    const phases: string[] = []
    ctx.on('workflow/phase', (_run, title) => { phases.push(title) })
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      expect(agent).toBeDefined()
      children.push(agent!)
    })
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('evaluated-ralph-integration'),
      name: 'ralph_evaluated',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 2 },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text)
      .toContain('The evaluator confirmed completion after 2 rounds.')
    expect(phases).toEqual(['Evaluated Ralph rounds'])
    expect(children).toHaveLength(4)
    expect(new Set(children.map(child => child.id)).size).toBe(4)
    for (const child of children) {
      expect(child.session.header.cwd).toBe('/tmp/evaluated-ralph-shared-workspace')
      expect(child.session.header.parentSession).toBe(parent.session.header.id)
      expect(child.session.header.seedLength).toBeUndefined()
      expect(ctx.agents.get(child.id)).toBeUndefined()
    }

    expect(adapter.requests).toHaveLength(5)
    const workerOneRequest = JSON.stringify(adapter.requests[1]!.messages)
    const evaluatorOneRequest = JSON.stringify(adapter.requests[2]!.messages)
    const workerTwoRequest = JSON.stringify(adapter.requests[3]!.messages)
    for (const serialized of [workerOneRequest, evaluatorOneRequest, workerTwoRequest]) {
      expect(serialized).not.toContain('PARENT_PROMPT_MARKER')
      expect(serialized).not.toContain('PARENT_HISTORY_MARKER')
    }
    expect(workerOneRequest).not.toContain('EVAL_ONE_MISSING')
    expect(evaluatorOneRequest).not.toContain('EVAL_ONE_MISSING')
    expect(workerTwoRequest).toContain('EVAL_ONE_MISSING')
    expect(evaluatorOneRequest).toContain('ROUND_ONE_WORKER_SUMMARY')
    expect(evaluatorOneRequest).toContain('Do not trust the worker report')

    await parentHandle.dispose()
  })

  it('routes the evaluator child to the configured model override while workers keep the loop model', async () => {
    const { ctx, adapter, parent, parentHandle } = await mountEvaluatedRalph([
      toolCallResponse('worker-1', STRUCTURED_OUTPUT_TOOL, COMPLETE_WORKER_REPORT),
      toolCallResponse('evaluator-1', STRUCTURED_OUTPUT_TOOL, COMPLETE_VERDICT),
    ], { maxRounds: 2, evaluatorModel: 'mock-strong' })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('evaluated-ralph-model-override'),
      name: 'ralph_evaluated',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 2 },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]!.model).toBe('mock')
    expect(adapter.requests[1]!.model).toBe('mock-strong')
    await parentHandle.dispose()
  })

  it('reports the failed round and last good handoff when a round-two child fails', async () => {
    const { ctx, parent, parentHandle } = await mountEvaluatedRalph([
      toolCallResponse('worker-1', STRUCTURED_OUTPUT_TOOL, CONTINUING_WORKER_REPORT),
      toolCallResponse('evaluator-1', STRUCTURED_OUTPUT_TOOL, CONTINUING_VERDICT),
      maxTokensResponse('unfinished child output'),
    ], { maxRounds: 2 })
    const children: Agent[] = []
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      if (agent !== undefined) children.push(agent)
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('evaluated-ralph-child-failure'),
      name: 'ralph_evaluated',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 2 },
      agent: parent,
    })

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Evaluated Ralph round 2 child failed before producing its structured output.')
    expect(text).toContain('Last successful handoff:')
    expect(text).toContain('EVAL_ONE_MISSING')
    expect(children).toHaveLength(3)
    for (const child of children) expect(ctx.agents.get(child.id)).toBeUndefined()
    await parentHandle.dispose()
  })

  it.each([
    {
      name: 'blocked verdict',
      workerReport: {
        summary: 'External authorization is required.',
        evidence: ['The local implementation is ready.'],
        remaining: ['Continue after authorization.'],
        blocker: 'The required external authorization is unavailable.',
      },
      verdict: {
        verdict: 'blocked',
        confirmed: ['The local implementation is ready.'],
        missing: [],
        reasons: 'The required external authorization is unavailable.',
      },
      config: { maxRounds: 2 },
      expectedError: false,
      expectedText: 'The evaluator declared a blocker after 1 round.',
    },
    {
      name: 'budget-limited verdict',
      workerReport: CONTINUING_WORKER_REPORT,
      verdict: {
        verdict: 'continue',
        confirmed: ['The first slice is implemented.'],
        missing: ['Implement the remaining slice.'],
        reasons: 'Work remains.',
      },
      config: { maxRounds: 1 },
      expectedError: false,
      expectedText: 'The evaluated Ralph loop reached its 1 round limit; the evaluator still listed missing work.',
    },
    {
      name: 'unnormalized worker report',
      workerReport: {
        summary: ' padded summary ',
        evidence: ['A focused test passes.'],
        remaining: ['Continue implementation.'],
        blocker: '',
      },
      verdict: COMPLETE_VERDICT,
      config: { maxRounds: 1 },
      expectedError: true,
      expectedText: 'worker summary must be non-empty and normalized',
    },
    {
      name: 'invalid continuing verdict',
      workerReport: COMPLETE_WORKER_REPORT,
      verdict: {
        verdict: 'continue',
        confirmed: ['Verified.'],
        missing: [],
        reasons: 'Work allegedly remains.',
      },
      config: { maxRounds: 1 },
      expectedError: true,
      expectedText: 'a continuing evaluated Ralph verdict needs at least one missing entry',
    },
    {
      name: 'invalid completion verdict',
      workerReport: COMPLETE_WORKER_REPORT,
      verdict: {
        verdict: 'complete',
        confirmed: [],
        missing: ['A gap remains.'],
        reasons: 'Claimed completion.',
      },
      config: { maxRounds: 1 },
      expectedError: true,
      expectedText: 'a complete evaluated Ralph verdict needs confirmed evidence and no missing entries',
    },
    {
      name: 'oversized handoff',
      workerReport: {
        summary: 'x'.repeat(300),
        evidence: ['A focused test passes.'],
        remaining: [],
        blocker: '',
      },
      verdict: CONTINUING_VERDICT,
      config: { maxRounds: 1, maxHandoffChars: 100 },
      expectedError: true,
      expectedText: 'handoff exceeds maxHandoffChars',
    },
  ])('enforces the fixed script for $name', async ({ workerReport, verdict, config, expectedError, expectedText }) => {
    const { ctx, parent, parentHandle } = await mountEvaluatedRalph([
      toolCallResponse('worker-report', STRUCTURED_OUTPUT_TOOL, workerReport),
      toolCallResponse('evaluator-verdict', STRUCTURED_OUTPUT_TOOL, verdict),
    ], config)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('evaluated-ralph-script-enforcement'),
      name: 'ralph_evaluated',
      arguments: { objective: 'Complete the scoped work.', maxRounds: config.maxRounds },
      agent: parent,
    })

    expect(result.isError).toBe(expectedError)
    expect((result.content[0] as { text: string }).text).toContain(expectedText)
    await parentHandle.dispose()
  })

  it('cancels the real worker and fresh child to quiescence', { timeout: 20_000 }, async () => {
    const { ctx, parent, parentHandle } = await mountEvaluatedRalph(['hang'], { maxRounds: 2 })
    const children: Agent[] = []
    const outcomes: string[] = []
    let resolveChildStarted!: (child: Agent) => void
    const childStarted = new Promise<Agent>((resolve) => { resolveChildStarted = resolve })
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      if (agent !== undefined) {
        children.push(agent)
        resolveChildStarted(agent)
      }
    })
    ctx.on('workflow/agent-end', (_run, child) => { outcomes.push(child.outcome) })
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      callId: CallId('evaluated-ralph-real-cancel'),
      name: 'ralph_evaluated',
      arguments: { objective: 'Keep working until cancelled.', maxRounds: 2 },
      agent: parent,
      signal: controller.signal,
    })
    await childStarted

    controller.abort()
    const result = await pending

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('Evaluated Ralph workflow was cancelled')
    expect(outcomes).toEqual(['cancelled'])
    expect(ctx.agents.get(children[0]!.id)).toBeUndefined()
    await parentHandle.dispose()
  })
})
