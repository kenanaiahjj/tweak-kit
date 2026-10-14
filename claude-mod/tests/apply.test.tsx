import { expect, mock, test } from 'claude-code/testing'

import { parseReport, settle, summarize } from '../hooks/register'

const PENDING = JSON.stringify({
  version: 1,
  batches: [
    {
      id: 'tabc',
      page: { path: '/' },
      tweaks: [
        { id: 'tabc-0', changes: { 'font-size': { from: '15px', to: '16px' }, color: { from: '#000', to: '#fff' } } },
        { id: 'tabc-1', changes: {}, text: { from: 'Go', to: 'Start' } },
      ],
    },
  ],
})

test('/apply-tweaks starts the Haiku applier on the waiting tweak ids', async ($, on) => {
  const spawns: { subagentType?: string; model?: string; prompt: string }[] = []
  on('fs.read', () => ({ value: PENDING }))
  on('agent.spawn', ($, e) => {
    spawns.push({ subagentType: e.subagentType, model: e.model, prompt: e.prompt })
    return { model: 'haiku', agentId: 'agent-1' } as never
  })

  const result = await $.command.run({ command: 'apply-tweaks', args: '' } as never)
  expect(JSON.stringify(result)).toContain('Haiku is applying 2 UI tweak(s)')
  expect(spawns.length).toBe(1)
  // subagentType is dropped here: the test never runs session.start, which registers ui-tweaks:applier.
  expect(spawns[0]?.model).toBe('haiku')
  expect(spawns[0]?.prompt).toContain('tabc-0, tabc-1')
})

test('/apply-tweaks claude sends them to the main model after the command returns', async ($, on) => {
  const prompts: string[] = []
  const clock = mock.clock(on)
  on('fs.read', () => ({ value: PENDING }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  const result = await $.command.run({ command: 'apply-tweaks', args: 'claude' } as never)
  expect(JSON.stringify(result)).toContain('Sending 3 UI tweak(s) to Claude')
  expect(prompts.length).toBe(0)
  await clock.advance(100)
  expect(prompts[0]).toContain('.ui-tweaks/pending.json')
})

test('nothing pending: the command says so and starts nothing', async ($, on) => {
  let started = false
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('agent.spawn', () => {
    started = true
    return { model: 'haiku', agentId: 'x' } as never
  })

  const result = await $.command.run({ command: 'apply-tweaks', args: '' } as never)
  expect(JSON.stringify(result)).toContain('No UI tweaks are waiting')
  expect(started).toBe(false)
})

test("Haiku's report settles the file: applied tweaks leave, skipped ones keep their reason", () => {
  const report = parseReport('Done.\n{"applied":["tabc-1"],"skipped":[{"id":"tabc-0","reason":"rule is shared"}]}')
  expect(report).toEqual({ applied: ['tabc-1'], skipped: [{ id: 'tabc-0', reason: 'rule is shared' }] })

  const left = summarize(settle(PENDING, report?.applied ?? [], report?.skipped ?? []))
  expect(left?.tweakIds).toEqual(['tabc-0'])
  expect(left?.skipped).toEqual([{ id: 'tabc-0', reason: 'rule is shared' }])

  expect(summarize(settle(PENDING, ['tabc-0', 'tabc-1'], []))).toBe(null)
  expect(parseReport('no json here')).toBe(null)
})
