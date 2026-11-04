import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { lineStats, unifiedDiff } from '../hooks/diff'
import { askOutcome, askPrompt, cleanVariants, lastJson, paperPrompt, parseReport, pullPrompt, tokensPrompt, settle, summarize, verifyTweak } from '../hooks/register'

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

test('/apply-tweaks takes the lock and starts the Haiku applier on the waiting tweak ids', async ($, on) => {
  const spawns: { subagentType?: string; model?: string; prompt: string }[] = []
  const clock = mock.clock(on, { now: 1000 })
  const files: Record<string, string> = { '.ui-tweaks/pending.json': PENDING }
  fakeFs(on, files)
  on('session.cwd', () => ({ value: '/p' }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', ($, e) => {
    spawns.push({ subagentType: e.subagentType, model: e.model, prompt: e.prompt })
    return { model: 'haiku', agentId: 'agent-1' } as never
  })

  const pending = $.command.run({ command: 'apply-tweaks', args: '' } as never)
  await clock.advance(400) // the lock's settle wait
  const result = await pending
  expect(JSON.stringify(result)).toContain('Haiku is applying 2 UI tweak(s)')
  expect(spawns[0]?.model).toBe('haiku')
  expect(spawns[0]?.prompt).toContain('tabc-0, tabc-1')
  const lock = Object.entries(files).find(([path]) => path.endsWith('.ui-tweaks/lock.json'))?.[1]
  expect(JSON.parse(lock ?? '{}').owner).toMatch(/^s/)
})

test('another session holding the lock: nothing starts', async ($, on) => {
  let started = false
  mock.clock(on, { now: 1000 })
  fakeFs(on, { '.ui-tweaks/pending.json': PENDING, '.ui-tweaks/lock.json': JSON.stringify({ owner: 'sOTHER', at: 900 }) })
  on('agent.spawn', () => {
    started = true
    return { model: 'haiku', agentId: 'x' } as never
  })

  const result = await $.command.run({ command: 'apply-tweaks', args: '' } as never)
  expect(JSON.stringify(result)).toContain('Another Claude Code session')
  expect(started).toBe(false)
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
  expect(JSON.parse(fileAt(files, '.ui-tweaks/history.json')).entries).toEqual([])
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

const ASKS = JSON.stringify({
  asks: [
    { id: 'ask1', kind: 'edit', instruction: 'Add a status pill', element: { selector: '.card', react: { jsxSource: 'src/App.tsx:4' } }, page: { url: 'http://localhost/' } },
    { id: 'ask2', kind: 'variations', instruction: '', element: { selector: '.card' }, context: { width: 390 }, count: 3 },
  ],
})

test('/apply-tweaks asks takes the lock, snapshots nothing extra and starts the designer on the oldest waiting ask', async ($, on) => {
  const spawns: { model?: string; prompt: string }[] = []
  const clock = mock.clock(on, { now: 1000 })
  const files: Record<string, string> = { '.ui-tweaks/asks.json': ASKS, 'src/App.tsx': 'old' }
  fakeFs(on, files)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('agent.spawn', ($, e) => {
    spawns.push({ model: e.model, prompt: e.prompt })
    return { model: 'sonnet', agentId: 'design-1' } as never
  })
  const started = $.command.run({ command: 'apply-tweaks', args: 'asks' } as never)
  await clock.advance(400)
  expect(JSON.stringify(await started)).toContain('ask1')
  expect(spawns[0]?.model).toBe('sonnet')
  expect(spawns[0]?.prompt).toContain('Design request: Add a status pill')
  expect(JSON.parse(fileAt(files, '.ui-tweaks/asks/ask1.json')).status).toBe('running')
  expect(JSON.parse(fileAt(files, '.ui-tweaks/lock.json')).owner).toMatch(/^s/)
})

test('the next ask waits for the running one; a finished one is skipped', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const files: Record<string, string> = { '.ui-tweaks/asks.json': ASKS, '.ui-tweaks/asks/ask1.json': '{"status":"done"}' }
  fakeFs(on, files)
  on('ui.toast', () => ({ value: undefined }) as never)
  const prompts: string[] = []
  on('agent.spawn', ($, e) => {
    prompts.push(e.prompt)
    return { model: 'sonnet', agentId: 'var-1' } as never
  })
  const first = $.command.run({ command: 'apply-tweaks', args: 'asks' } as never)
  await clock.advance(400)
  await first
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Propose 3 variations')
  await $.command.run({ command: 'apply-tweaks', args: 'asks' } as never)
  expect(prompts.length).toBe(1)
})

test('ask outcomes: changed files, a question back, cleaned variants', () => {
  expect(askOutcome('edit', 'ok\n{"summary":"Added a pill"}', ['App.tsx'])).toEqual({ status: 'done', summary: 'Added a pill', files: ['App.tsx'] })
  expect(askOutcome('edit', '{"summary":"","needs":"Which card?"}', [])).toEqual({ status: 'failed', summary: '', needs: 'Which card?' })
  expect(askOutcome('edit', 'nothing', [])).toEqual({ status: 'failed', summary: '', error: 'No files changed.' })
  expect(askOutcome('edit', '{"summary":"The screens were already set up; nothing to change."}', [])).toEqual({ status: 'done', summary: 'The screens were already set up; nothing to change.', files: [] })
  const v = askOutcome('variations', '{"variants":[{"name":"Bold","why":"x","changes":[{"target":":scope","prop":"padding","value":"20px"},{"prop":"color; x","value":"red"}]}]}', [])
  expect(v.variants).toEqual([{ name: 'Bold', why: 'x', changes: [{ target: ':scope', prop: 'padding', value: '20px' }] }])
  expect(askOutcome('variations', 'no json', []).status).toBe('failed')
})

test('answer parsing and prompts', () => {
  expect(lastJson('text\n{"a":1}\n')).toEqual({ a: 1 })
  expect(lastJson('{bad\nno json')).toBe(null)
  expect(cleanVariants([{ name: 'A', changes: [] }, 'x', { name: 'B', changes: [{ prop: 'gap', value: '8px' }] }])).toEqual([{ name: 'B', why: '', changes: [{ target: ':scope', prop: 'gap', value: '8px' }] }])
  expect(askPrompt({ id: 'a', kind: 'variations', instruction: 'calmer', count: 2 }, '/p')).toContain('Propose 2 variations, unless the direction asks for a different number (then that many, at most 4). Direction: calmer')
  const skills = [
    { name: 'impeccable', dir: '/h/.claude/skills/impeccable', label: 'Impeccable', lens: 'craft' },
    { name: 'emil-design-eng', dir: '/h/.agents/skills/emil-design-eng', label: 'Emil Kowalski', lens: 'polish' },
  ]
  const withRefs = askPrompt({ id: 'a', kind: 'variations', instruction: '', refs: ['.ui-tweaks/refs/r1.png', '../secret.png'] }, '/p', skills)
  expect(withRefs).toContain('/p/.ui-tweaks/refs/r1.png')
  expect(withRefs).not.toContain('secret.png')
  // No pick: the agent chooses among the installed ones, read from the project's copy.
  expect(withRefs).toContain('Installed design skills: impeccable (Impeccable: craft) at .ui-tweaks/skills/impeccable/SKILL.md')
  expect(withRefs).toContain('Pick the one that fits')
  expect(withRefs).toContain('only the JSON')
  // Picked in the panel: only those, spread across the variations, each one naming its skill.
  const picked = askPrompt({ id: 'a2', kind: 'variations', instruction: '', skills: ['emil-design-eng', 'unknown'] }, '/p', skills)
  expect(picked).toContain('Design skills chosen by the person: Emil Kowalski (emil-design-eng: polish) at .ui-tweaks/skills/emil-design-eng/SKILL.md')
  expect(picked).not.toContain('impeccable')
  expect(picked).toContain('set "skill" to its name')
  expect(askPrompt({ id: 's', kind: 'variations', instruction: '', scope: 'screen' }, '/p')).toContain('The element is the whole screen')
  expect(cleanVariants([{ name: 'A', skill: 'emil-design-eng', changes: [{ prop: 'gap', value: '8px' }] }])[0]?.skill).toBe('emil-design-eng')
  expect(askPrompt({ id: 'b', kind: 'edit', instruction: 'tidy it' }, '/p')).not.toContain('Design skill')
  expect(askPrompt({ id: 'b2', kind: 'edit', instruction: 'tidy it', skills: ['impeccable'] }, '/p', skills)).toContain('Design skills chosen by the person: Impeccable')
  // Layout variations: rebuilt markup, cleaned of anything that could run.
  const [layout] = cleanVariants([{ name: 'Row', html: '<div class="card" onclick="x()"><img src="a.png" onerror="steal()"><script>bad()</script><a href="javascript:go()">x</a><p>Hi</p></div>' }])
  expect(layout?.html).toBe('<div class="card"><img src="a.png"><a >x</a><p>Hi</p></div>')
  expect(cleanVariants([{ name: 'Junk', html: 'just text' }])).toEqual([])
  expect(askPrompt({ id: 'c', kind: 'variations', instruction: '', mode: 'layout' }, '/p')).toContain('Kinds: layout variations only')
  expect(askPrompt({ id: 'd', kind: 'variations', instruction: '' }, '/p')).toContain('make at least one a layout variation')
})

const fileAt = (files: Record<string, string>, rel: string) => Object.entries(files).find(([k]) => k === rel || k.endsWith('/' + rel))?.[1] ?? '{}'

test('/studio connects the running standalone studio to this project and opens it in the browser pane', async ($, on) => {
  const clock = mock.clock(on)
  const posts: { url: string; body?: string }[] = []
  const prompts: string[] = []
  fakeFs(on, {})
  on('session.cwd', () => ({ value: '/p' }) as never)
  on('session.surfaces', () => ({ value: ['desktop'] }) as never)
  on('http.fetch', ($, e) => {
    if (e.init?.method === 'POST') {
      posts.push({ url: e.url, body: e.init.body as string })
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, up: true }) } } as never
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ target: null, root: null, up: false }) } } as never
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  const result = await $.command.run({ command: 'studio', args: 'http://localhost:5173' } as never)
  await clock.advance(100)
  expect(JSON.stringify(result)).toContain('Studio for /p on http://localhost:5173')
  expect(posts[0]?.url).toBe('http://localhost:5600/__ui-tweaks/connection')
  expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({ target: 'http://localhost:5173', root: '/p' })
  expect(prompts[0]).toContain('http://localhost:5600/__ui-tweaks/studio')
})

test("/studio uses the project's own dev server when the kit is installed there", async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  fakeFs(on, { '.ui-tweaks/server.json': JSON.stringify({ url: 'http://localhost:5188', root: '/p' }) })
  on('session.cwd', () => ({ value: '/p' }) as never)
  on('session.surfaces', () => ({ value: ['desktop'] }) as never)
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }) as never)
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  const result = await $.command.run({ command: 'studio', args: '' } as never)
  await clock.advance(100)
  expect(JSON.stringify(result)).toContain('on your dev server (http://localhost:5188)')
  expect(prompts[0]).toContain('http://localhost:5188/__ui-tweaks/studio')
})

test('a publish ask has the main model publish the review page, and is marked done', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const prompts: string[] = []
  const files: Record<string, string> = {
    '.ui-tweaks/asks.json': JSON.stringify({ asks: [{ id: 'askpub1', kind: 'publish', instruction: 'Publish', file: '.ui-tweaks/reviews/first-look-2026-10-23-1405.html', title: 'First look', at: 900 }] }),
  }
  fakeFs(on, files)
  on('session.cwd', () => ({ value: '/p' }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })

  await $.command.run({ command: 'apply-tweaks', args: 'asks' } as never)
  await clock.advance(100)
  expect(prompts[0]).toContain('first-look-2026-10-23-1405.html')
  expect(prompts[0]).toContain('"First look"')
  const outcome = Object.entries(files).find(([p]) => p.endsWith('askpub1.json'))?.[1]
  expect(JSON.parse(outcome ?? '{}').status).toBe('done')
})

test('send to Paper: the prompt names the files, the artboards and Paper rules', () => {
  const screen = paperPrompt([{ file: '/p/.ui-tweaks/paper/pabc.html', title: 'Home · /', width: 390, height: 844 }], { whole: true, page: { url: 'http://localhost:5188/' } })
  expect(screen).toContain('Put this screen (from http://localhost:5188/) into my open Paper file')
  expect(screen).toContain('1. “Home · /”, 390×844px: /p/.ui-tweaks/paper/pabc.html')
  expect(screen).toContain('get_guide')
  expect(screen).toContain('finish_working_on_nodes')
  expect(screen).toContain('no margin')
  const states = paperPrompt([{ file: '/a.html', title: 'Card' }, { file: '/b.html', title: 'Card · Hover' }], { title: 'Card' })
  expect(states).toContain('these 2 versions of “Card”')
  expect(states).toContain('2. “Card · Hover”, its captured size: /b.html')
  const figma = paperPrompt([{ file: '/a.html', title: 'Card' }], { target: 'figma' })
  expect(figma).toContain('open Figma file')
  expect(figma).toContain('figma:figma-generate-design')
  expect(figma).not.toContain('get_guide')
})

test('pull from Paper: compares with the original capture and edits the source', () => {
  const p = pullPrompt({ title: 'Home', page: { url: 'http://localhost:5188/' } }, '/proj', '/proj/.ui-tweaks/paper/pabc.html')
  expect(p).toContain('the artboard I have selected in Paper, or else the one named “Home”')
  expect(p).toContain('The project is /proj.')
  expect(p).toContain('captured at /proj/.ui-tweaks/paper/pabc.html')
  expect(p).toContain('get_jsx')
  const f = pullPrompt({ target: 'figma' }, '/proj', null)
  expect(f).toContain('frame I have selected in Figma')
  expect(f).toContain("There's no capture")
  expect(f).toContain('figma:figma-design-to-code')
})

test('missing states: the prompt asks for the states it lacks, and variants keep state and when', () => {
  const p = askPrompt({ id: 'a', kind: 'variations', instruction: '', mode: 'states', element: { react: { jsxSource: 'src/List.tsx:4' } } }, '/p')
  expect(p).toContain('Design the states this element is missing.')
  expect(p).toContain('"when"')
  expect(p).not.toContain('Kinds:')
  const v = cleanVariants([
    { name: 'Empty', why: 'x', html: '<div class="list">No events yet</div>', state: 'Empty', when: 'events.length === 0' },
    { name: 'Odd', why: 'x', changes: [{ prop: 'color', value: 'red' }], state: 'empty' },
    { name: 'Bad', html: '<div>x</div>', state: 'drop table;' },
  ])
  expect(v[0]?.state).toBe('empty')
  expect(v[0]?.when).toBe('events.length === 0')
  expect(v[1]?.state).toBe(undefined)
  expect(v[2]?.state).toBe(undefined)
})

test('tokens: push creates them in Paper or as Figma variables, pull edits the CSS', () => {
  const push = tokensPrompt({ direction: 'push' }, '/p/.ui-tweaks/paper/tokens.json', '/p')
  expect(push).toContain('create_tokens')
  expect(push).toContain('/p/.ui-tweaks/paper/tokens.json')
  const figma = tokensPrompt({ direction: 'push', target: 'figma' }, '/t.json', '/p')
  expect(figma).toContain('variable collection named "Tokens"')
  const pull = tokensPrompt({ direction: 'pull' }, '/t.json', '/p')
  expect(pull).toContain('change it in the CSS at the file and line listed')
  expect(pull).toContain('get_tokens')
  expect(paperPrompt([{ file: '/a.html', title: 'A' }], {})).toContain('use var(--name) wherever a captured value equals')
})
