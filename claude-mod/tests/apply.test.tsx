import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { lineStats, unifiedDiff } from '../hooks/diff'
import { parseReport, settle, summarize, verifyTweak } from '../hooks/register'

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
  mock.clock(on)
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

// A tiny file system for the undo tests: path -> text.
function fakeFs(on: On, files: Record<string, string>) {
  // The engine hands hooks absolute paths; match the relative keys by suffix.
  const key = (path: string) => Object.keys(files).find(k => path === k || path.endsWith('/' + k)) ?? path
  on('fs.read', ($, e) => {
    const text = files[key(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[key(e.path)] = e.text
    return { value: undefined } as never
  })
}

const HISTORY = JSON.stringify({ entries: [{ id: 'h1', at: 1, by: 'haiku', count: 2, slot: '.ui-tweaks/history/slot-0.json', files: ['/p/src/styles.css'] }] })
const SLOT = JSON.stringify({ id: 'h1', files: [{ path: '/p/src/styles.css', before: 'a { color: red }', after: 'a { color: blue }' }] })

test("/apply-tweaks undo restores the files Haiku's last apply changed", async ($, on) => {
  const files: Record<string, string> = {
    '.ui-tweaks/history.json': HISTORY,
    '.ui-tweaks/history/slot-0.json': SLOT,
    '/p/src/styles.css': 'a { color: blue }',
  }
  fakeFs(on, files)

  const result = await $.command.run({ command: 'apply-tweaks', args: 'undo' } as never)
  expect(JSON.stringify(result)).toContain('styles.css restored')
  expect(files['/p/src/styles.css']).toBe('a { color: red }')
  expect(JSON.parse(files['.ui-tweaks/history.json'] ?? '{}').entries).toEqual([])
})

test('undo refuses a file that changed after Haiku edited it', async ($, on) => {
  const files: Record<string, string> = {
    '.ui-tweaks/history.json': HISTORY,
    '.ui-tweaks/history/slot-0.json': SLOT,
    '/p/src/styles.css': 'a { color: green }',
  }
  fakeFs(on, files)

  const result = await $.command.run({ command: 'apply-tweaks', args: 'undo' } as never)
  expect(JSON.stringify(result)).toContain('Not undone')
  expect(files['/p/src/styles.css']).toBe('a { color: green }')
})

test('verifyTweak trusts the files, not the report', () => {
  const before = '.a { color: #111; font-size: 15px; }\n'
  const tweak = { changes: { color: { prop: 'color', to: '#222222' }, 'font-size': { prop: 'font-size', to: '16px' } } }
  expect(verifyTweak(tweak, [{ before, after: '.a { color: #222; font-size: 16px; }\n' }])).toBe(null)
  expect(verifyTweak(tweak, [{ before, after: '.a { color: #222; font-size: 15px; }\n' }])).toContain('font-size → 16px')
  expect(verifyTweak(tweak, [])).toContain('no file changed')
  expect(verifyTweak({ text: { from: 'Go', to: 'Start' } }, [{ before: '<b>Go</b>', after: '<b>Start</b>' }])).toBe(null)
})

test('line stats and unified diffs', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
  const after = ['a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n')
  expect(lineStats(before, after)).toEqual({ added: 2, removed: 1 })
  const diff = unifiedDiff('x.css', before, after)
  // Changes 8 lines apart get a hunk each, with 3 lines of context.
  expect(diff.split('\n').filter(l => l.startsWith('@@'))).toEqual(['@@ -1,6 +1,6 @@', '@@ -8,3 +8,4 @@'])
  expect(diff).toContain('-c\n+C')
})
