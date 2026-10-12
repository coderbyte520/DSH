import { describe, expect, it } from 'vitest'
import { Context } from '@vreal/cordis'
import AgentLoop from '@vreal/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@vreal/dsh-agent-loop-testkit'
import { CallId, createUserMessage } from '@vreal/dsh-llm'
import { SessionId } from '@vreal/dsh-session'
import { defineTool } from '@vreal/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as reward from '../src/index.ts'

/** One shell canonical value carrying a readable test summary. */
const shellValue = {
  kind: 'foreground',
  exitCode: 0,
  stdout: { text: '3 passed | 1 failed', truncated: false },
  stderr: { text: '', truncated: false },
}

describe('verifiable-reward over the real agent loop', () => {
  it('scores the turn\'s shell call without entering the model transcript', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineTool({
      name: 'bash',
      description: 'scripted shell',
      parameters: { command: { type: 'string' } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: () => [{ type: 'text' as const, text: 'ran the suite' }],
      },
      async execute() {
        return shellValue
      },
    }))
    await ctx.plugin(reward, {})
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'pnpm test' }),
      textResponse('The suite ran.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    const handle = await ctx.agents.create({
      sessionId: SessionId('verifiable-reward-live-turn'),
      meta: { cwd: '/tmp/verifiable-reward-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Run the suite.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const audits = handle.agent.session.events.filter(event => event.type === 'reward/check')
    expect(audits).toHaveLength(1)
    expect(audits[0]?.ignorable).toBe(true)
    expect(audits[0]?.data).toMatchObject({
      tool: 'bash',
      command: 'pnpm test',
      callId: CallId('call-1'),
      rootCallId: CallId('call-1'),
      check: { name: 'package-manager-test', kind: 'test', weight: 1 },
      exitCode: 0,
      parsed: true,
      passed: 3,
      failed: 1,
      score: 0.75,
    })
    // The record is log-only: the follow-up request carries the tool result and
    // nothing the observer wrote.
    const followUp = JSON.stringify(adapter.requests[1]?.messages)
    expect(followUp).toContain('ran the suite')
    expect(followUp).not.toContain('reward/check')
    expect(followUp).not.toContain('0.75')
  })
})
