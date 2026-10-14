import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileStat, LastApply, PendingTweaks, SkippedTweak } from '../types'
import { lineStats, unifiedDiff } from './diff'

// Written by the ui-tweak-kit overlay (POST /__ui-tweaks) in the project being served.
const FILE = '.ui-tweaks/pending.json'
const APPLIER = 'ui-tweaks:applier'

const pending = atom({ plugin: 'ui-tweaks', key: 'pending' } as const, null)
const run = atom({ plugin: 'ui-tweaks', key: 'run' } as const, null)
const attempted = atom({ plugin: 'ui-tweaks', key: 'attempted' } as const, [])
const lastApply = atom({ plugin: 'ui-tweaks', key: 'lastApply' } as const, null)
const dismissedApply = atom({ plugin: 'ui-tweaks', key: 'dismissedApply' } as const, null)
const diffView = atom({ plugin: 'ui-tweaks', key: 'diffView' } as const, null)
const DIFF_PANE = 'ui-tweaks-diff'
const LOG = '.ui-tweaks/log.json'

// Undo history, shared with the kit's dev server (POST /__ui-tweaks/undo):
// history.json lists the applies; each one's file copies sit in a reused slot file.
const HISTORY = '.ui-tweaks/history.json'
const SLOTS = 10
const STUCK_MS = 10 * 60 * 1000

type HistoryEntry = { id: string; at: number; by: 'haiku' | 'direct'; count: number; slot: string; files: string[] }
type SlotFile = { id: string; files: { path: string; before: string; after: string }[] }

// Each file as it was before the running Haiku apply edited it (one run at a time): the files the
// tweaks point at are copied before Haiku starts, and any other file just before its first edit.
const snapshots = new Map<string, string>()

// Several sessions can have this mod loaded in one project: a lock file lets one apply at a time.
const LOCK = '.ui-tweaks/lock.json'
const me = `s${Math.random().toString(36).slice(2, 10)}`

type Change = { prop?: string; to?: string; authoredIn?: { file?: string }[] }
type Tweak = {
  id?: string
  changes?: Record<string, Change>
  text?: { from?: string; to?: string }
  note?: string
  skipped?: string
  element?: { classes?: string[]; tag?: string; react?: { jsxSource?: string } }
}
type Batch = { id: string; page?: { path?: string }; tweaks?: Tweak[] }
type PendingFile = { version?: number; batches?: Batch[] }

// The server stamps ids on new tweaks; older batches fall back to batch id + index.
const tweakId = (batch: Batch, tweak: Tweak, i: number) => tweak.id ?? `${batch.id}-${i}`

export function summarize(text: string): PendingTweaks | null {
  const batches = (JSON.parse(text) as PendingFile).batches ?? []
  const all = batches.flatMap(b => (b.tweaks ?? []).map((t, i) => ({ id: tweakId(b, t, i), t })))
  if (all.length === 0) return null
  const changes = all.reduce(
    (n, { t }) => n + Object.keys(t.changes ?? {}).length + (t.text ? 1 : 0) + (t.note ? 1 : 0),
    0,
  )

  return {
    tweakIds: all.map(x => x.id),
    elements: all.length,
    changes,
    pages: [...new Set(batches.map(b => b.page?.path ?? '/'))],
    skipped: all.filter(x => x.t.skipped).map(x => ({ id: x.id, reason: x.t.skipped ?? '' })),
  }
}

/** Haiku's report: the last line of its answer, `{"applied":[...],"skipped":[{id,reason}]}`. */
export function parseReport(answer: string): { applied: string[]; skipped: SkippedTweak[] } | null {
  const line = answer.trim().split('\n').reverse().find(l => l.trim().startsWith('{'))
  if (!line) return null
  try {
    const report = JSON.parse(line.trim()) as { applied?: unknown; skipped?: unknown }
    const applied = Array.isArray(report.applied) ? report.applied.map(String) : []
    const skipped = Array.isArray(report.skipped)
      ? report.skipped.map(s => ({ id: String((s as SkippedTweak).id), reason: String((s as SkippedTweak).reason ?? '') }))
      : []
    return { applied, skipped }
  } catch {
    return null
  }
}

/** Drops applied tweaks from the file and notes why the rest were skipped. */
export function settle(text: string, applied: string[], skipped: SkippedTweak[]): string {
  const file = JSON.parse(text) as PendingFile
  const reasons = new Map(skipped.map(s => [s.id, s.reason]))
  const batches = (file.batches ?? [])
    .map(b => ({
      ...b,
      tweaks: (b.tweaks ?? [])
        .map((t, i) => ({ ...t, id: tweakId(b, t, i) }))
        .filter(t => !applied.includes(t.id))
        .map(t => (reasons.has(t.id) ? { ...t, skipped: reasons.get(t.id) } : t)),
    }))
    .filter(b => b.tweaks.length > 0)

  return JSON.stringify({ ...file, batches }, null, 2) + '\n'
}

const occurrences = (text: string, needle: string) => (needle ? text.split(needle).length - 1 : 0)

/** Ways a value may be written in source: as given, either case, and #abc for #aabbcc. */
function spellings(value: string): string[] {
  const v = value.trim()
  const out = new Set([v, v.toLowerCase(), v.toUpperCase()])
  const hex = /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i.exec(v)
  if (hex) out.add(`#${hex[1]}${hex[2]}${hex[3]}`.toLowerCase())
  return [...out]
}

/**
 * Checks a tweak Haiku reported as applied against the files it actually changed:
 * every new value (and new copy) must appear more often after the edit than before.
 * Returns null when it holds, or why not.
 */
export function verifyTweak(tweak: Tweak, files: { before: string; after: string }[]): string | null {
  if (files.length === 0) return 'Haiku reported it applied, but no file changed'
  const grew = (value: string) => spellings(value).some(v => files.some(f => occurrences(f.after, v) > occurrences(f.before, v)))
  for (const [key, change] of Object.entries(tweak.changes ?? {})) {
    if (change.to !== undefined && !grew(change.to)) return `${change.prop ?? key} → ${change.to} is not in the edited files`
  }
  if (tweak.text?.to && !grew(tweak.text.to.trim())) return `the new text "${tweak.text.to.trim()}" is not in the edited files`
  return null
}

const APPLIER_PROMPT = `You apply visual UI tweaks to source code. Be brief; do not explain your process.

Read ${FILE}. It holds batches of tweaks; each tweak has an id, element.react.jsxSource (file:line of the JSX), element.classes, and changes: { "<css-prop>": { from, to, authoredIn: [{ file, selector, property, value, conditions }] } } with the most specific rule first, plus optional text: { from, to } (a copy edit) and note (my instruction).

For each tweak, edit the source so the element renders each \`to\` value:
- Edit the rule in authoredIn[0] when its selector only targets this element. Keep !important if that rule has it. Edit inside its media query if it has conditions.
- If that selector is shared (a selector list, or a class used on other elements: Grep src for it), add a new class to the JSX at jsxSource and a rule for it right after the shared rule, with the same !important.
- Collapse four equal sides or corners into one shorthand. Leave other code alone.

- Follow the note when it is a clear change to this element (new copy, a value); a note may be the whole tweak.
- A change with a "state" ("hover", "active", "focus-visible"; its key is "<prop>:<state>") belongs in that state's rule, e.g. .btn:hover. Edit the one in authoredIn when it is a state rule, else add it right after the element's own rule.
- scope { kind: "viewport", width } means: only around that screen width. Put the change in a media query that holds at that width, reusing a breakpoint the file already uses.
- directApplied lists properties already written to the source: leave them alone.
- warnings say a value cannot show (e.g. hidden under a gradient): skip that tweak with the warning as the reason, unless its note says what to do.

Skip a tweak, editing nothing for it, when: you cannot find its source; the new value would be hidden by another property (e.g. background-color under a background-image gradient); its note reaches beyond this element or is unclear; or you are unsure. Give a one-line reason.

Never edit ${FILE}. End your answer with exactly one line of JSON and nothing after it:
{"applied":["<id>"],"skipped":[{"id":"<id>","reason":"<why>"}]}`

export function claudePrompt(summary: PendingTweaks): string {
  const skippedNote = summary.skipped.length
    ? ` Haiku skipped ${summary.skipped.length} of them; each skipped tweak says why in its "skipped" field.`
    : ''
  return [
    `Apply the UI tweaks in ${FILE}: ${summary.changes} change(s) on ${summary.elements} element(s), page ${summary.pages.join(', ')}.${skippedNote}`,
    'Each tweak names its JSX line (element.react.jsxSource) and the CSS rules setting each property (changes[prop].authoredIn, most specific first). Edit that source so it renders each `to` value; no inline overrides. Scope changes to this element when the rule is shared, unless the note says otherwise. If a value would be hidden by another property, ask me what I meant instead of guessing.',
    `When done, delete ${FILE}, reload the browser pane to check, and list what changed per file.`,
  ].join('\n')
}

async function readPending($: EngineInterface): Promise<PendingTweaks | null> {
  try {
    return summarize(await $.fs.read(FILE))
  } catch {
    return null
  }
}

async function readHistory($: EngineInterface): Promise<HistoryEntry[]> {
  try {
    return (JSON.parse(await $.fs.read(HISTORY)) as { entries?: HistoryEntry[] }).entries ?? []
  } catch {
    return []
  }
}

// Line counts per apply id: slot files can be large, so each is read once.
const statsById = new Map<string, FileStat[]>()

async function syncLastApply($: EngineInterface) {
  const last = (await readHistory($)).at(-1)
  let next: LastApply | null = null
  if (last) {
    if (!statsById.has(last.id)) {
      const saved = JSON.parse(await $.fs.read(last.slot).catch(() => '{"files":[]}')) as SlotFile
      statsById.set(last.id, saved.files.map(f => ({ path: f.path, ...lineStats(f.before, f.after) })))
    }
    next = { id: last.id, by: last.by, count: last.count, files: statsById.get(last.id) ?? [] }
  }
  if (JSON.stringify(next) !== JSON.stringify(await read($, lastApply))) await update($, lastApply, () => next)
}

/** The files the running Haiku apply changed, from the copies taken before its edits. */
async function changedFiles($: EngineInterface): Promise<SlotFile['files']> {
  const files: SlotFile['files'] = []
  for (const [path, before] of snapshots) {
    const after = await $.fs.read(path).catch(() => null)
    if (after !== null && after !== before) files.push({ path, before, after })
  }
  snapshots.clear()
  return files
}

type LogItem = { at: number; id: string; element: string; by: 'haiku'; outcome: string; props?: string[]; reason?: string; files?: string[] }

async function appendLog($: EngineInterface, items: LogItem[]) {
  if (items.length === 0) return
  let entries: unknown[] = []
  try {
    entries = (JSON.parse(await $.fs.read(LOG)) as { entries?: unknown[] }).entries ?? []
  } catch {
    // No log yet.
  }
  await $.fs.write(LOG, JSON.stringify({ entries: [...entries, ...items].slice(-300) }, null, 2) + '\n')
}

async function recordApply($: EngineInterface, count: number, files: SlotFile['files']) {
  if (files.length === 0) return
  const entries = await readHistory($)
  const lastSlot = Number(/(\d+)\.json$/.exec(entries.at(-1)?.slot ?? '')?.[1] ?? -1)
  const slot = `.ui-tweaks/history/slot-${(lastSlot + 1) % SLOTS}.json`
  const at = await $.clock.now()
  const id = `h${at.toString(36)}`
  await $.fs.write(slot, JSON.stringify({ id, files } satisfies SlotFile))
  const next = [...entries.filter(e => e.slot !== slot), { id, at, by: 'haiku' as const, count, slot, files: files.map(f => f.path) }]
  await $.fs.write(HISTORY, JSON.stringify({ entries: next.slice(-SLOTS) }, null, 2) + '\n')
  await syncLastApply($)
}

/** Puts back the files Haiku's newest apply changed, unless one has changed since. */
async function undoLastApply($: EngineInterface): Promise<string> {
  const entries = await readHistory($)
  const last = entries.at(-1)
  if (!last) return 'There is no apply to undo.'
  const saved = JSON.parse(await $.fs.read(last.slot)) as SlotFile
  if (saved.id !== last.id) return 'The undo history is out of date; nothing was changed.'
  const changed: string[] = []
  for (const f of saved.files) if ((await $.fs.read(f.path).catch(() => null)) !== f.after) changed.push(f.path)
  if (changed.length) {
    return `Not undone: ${changed.map(p => p.split('/').at(-1)).join(', ')} changed after the apply. Undo by hand or with Claude.`
  }
  for (const f of saved.files) await $.fs.write(f.path, f.before)
  await $.fs.write(HISTORY, JSON.stringify({ entries: entries.slice(0, -1) }, null, 2) + '\n')
  await syncLastApply($)

  if ((await read($, diffView))?.id === last.id) await $.ui.close({ id: DIFF_PANE })

  return `Undid the last apply: ${saved.files.map(f => f.path.split('/').at(-1)).join(', ')} restored.`
}

async function openDiff($: EngineInterface) {
  const last = (await readHistory($)).at(-1)
  if (!last) return
  const saved = JSON.parse(await $.fs.read(last.slot)) as SlotFile
  const cwd = await $.session.cwd()
  const rel = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)
  await update($, diffView, () => ({ id: last.id, files: saved.files.map(f => ({ path: rel(f.path), diff: unifiedDiff(rel(f.path), f.before, f.after) })) }))
  await $.ui.open({ id: DIFF_PANE, title: 'UI tweaks: last apply' })
}

async function refresh($: EngineInterface) {
  await syncLastApply($)
  const next = await readPending($)
  const current = await read($, run)
  if (current !== null && (await $.clock.now()) - current.startedAt > STUCK_MS) {
    await update($, run, () => null)
    await releaseLock($)
  }
  // Send to Claude in the browser applies right away: start Haiku on tweaks it has not tried yet.
  if (next !== null && (await read($, run)) === null) {
    const tried = await read($, attempted)
    const fresh = next.tweakIds.filter(id => !tried.includes(id) && !next.skipped.some(s => s.id === id))
    if (fresh.length) void applyWithHaiku($, fresh)
  }
  const before = await read($, pending)
  if (JSON.stringify(next) === JSON.stringify(before)) return
  const isNew = next !== null && next.tweakIds.some(id => !(before?.tweakIds ?? []).includes(id))
  await update($, pending, () => next)
  // A main-model run is done once its tweaks have left the file.
  const latest = await read($, run)
  if (latest?.by === 'claude' && !latest.tweakIds.some(id => next?.tweakIds.includes(id))) {
    await update($, run, () => null)
  }
  if (isNew && latest === null) $.ui.toast(`UI tweaks arrived from the browser: ${next.changes} change(s)`)
}

async function takeLock($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  const held = await $.fs.read(LOCK).then(t => JSON.parse(t) as { owner?: string | null; at?: number }).catch(() => ({}) as { owner?: string | null; at?: number })
  if (held.owner && held.owner !== me && now - (held.at ?? 0) < STUCK_MS) return false
  await $.fs.write(LOCK, JSON.stringify({ owner: me, at: now }))
  await $.clock.sleep(300)
  // Another session may have written at the same moment: the last write wins, the other backs off.
  const after = await $.fs.read(LOCK).then(t => JSON.parse(t) as { owner?: string }).catch(() => ({}) as { owner?: string })
  return after.owner === me
}

async function releaseLock($: EngineInterface) {
  const held = await $.fs.read(LOCK).then(t => JSON.parse(t) as { owner?: string }).catch(() => ({}) as { owner?: string })
  if (held.owner === me) await $.fs.write(LOCK, JSON.stringify({ owner: null, at: 0 }))
}

/** Copies of the files the tweaks point at (their CSS rules and JSX lines), taken before Haiku edits. */
async function snapshotTargets($: EngineInterface, ids: string[]) {
  snapshots.clear()
  const cwd = await $.session.cwd()
  const abs = (p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`)
  const batches = (JSON.parse(await $.fs.read(FILE)) as PendingFile).batches ?? []
  const files = new Set<string>()
  for (const b of batches) {
    ;(b.tweaks ?? []).forEach((t, i) => {
      if (!ids.includes(tweakId(b, t, i))) return
      for (const c of Object.values(t.changes ?? {})) for (const r of c.authoredIn ?? []) if (r.file && !r.file.startsWith('<')) files.add(abs(r.file))
      const jsx = /^(.*):\d+$/.exec(t.element?.react?.jsxSource ?? '')
      if (jsx?.[1]) files.add(abs(jsx[1]))
    })
  }
  for (const f of files) {
    const text = await $.fs.read(f).catch(() => null)
    if (text !== null) snapshots.set(f, text)
  }
}

async function applyWithHaiku($: EngineInterface, ids?: string[]): Promise<string> {
  const summary = await readPending($)
  if (summary === null) return `No UI tweaks are waiting (${FILE} is empty or missing).`
  if ((await read($, run)) !== null) return 'An apply is already running; wait for it to finish.'
  const todo = ids ?? summary.tweakIds.filter(id => !summary.skipped.some(s => s.id === id))
  if (todo.length === 0) return 'Haiku already skipped every waiting tweak; use "Send to Claude".'
  if (!(await takeLock($))) return 'Another Claude Code session is applying tweaks in this project.'
  await snapshotTargets($, todo)
  const startedAt = await $.clock.now()
  await update($, run, () => ({ by: 'haiku' as const, tweakIds: todo, startedAt }))
  await update($, attempted, list => [...new Set([...list, ...todo])].slice(-500))
  const started = await $.agent.spawn({
    subagentType: APPLIER,
    model: 'haiku',
    description: 'Apply UI tweaks',
    prompt: `Apply these tweak ids from ${FILE}: ${todo.join(', ')}. Ignore any other tweaks in the file.`,
  })
  if ('deny' in started) {
    await update($, run, () => null)
    await releaseLock($)
    return `Could not start Haiku: ${String(started.deny)}`
  }
  await update($, run, r => (r ? { ...r, agentId: started.agentId } : r))

  return `Haiku is applying ${todo.length} UI tweak(s).`
}

async function applyWithClaude($: EngineInterface): Promise<string> {
  const summary = await readPending($)
  if (summary === null) return `No UI tweaks are waiting (${FILE} is empty or missing).`
  if ((await read($, run)) !== null) return 'An apply is already running; wait for it to finish.'
  const startedAt = await $.clock.now()
  await update($, run, () => ({ by: 'claude' as const, tweakIds: summary.tweakIds, startedAt }))
  // Submitted once the caller returns: a command.run hook may not submit while it holds the turn.
  $.clock.after(50, () => void $.prompt.submit({ text: claudePrompt(summary) }))

  return `Sending ${summary.changes} UI tweak(s) to Claude.`
}

async function finishHaiku($: EngineInterface, answer: string) {
  const files = await changedFiles($)
  const report = parseReport(answer)
  const runIds = (await read($, run))?.tweakIds ?? []
  await releaseLock($)
  if (report === null) {
    await recordApply($, 0, files)
    await update($, run, () => null)
    $.ui.toast('Haiku finished without a report; the tweaks are still waiting.')
    return
  }

  // Trust the files, not the report: a tweak counts as applied only if its new values are in them.
  let tweaks = new Map<string, Tweak>()
  let text = ''
  try {
    text = await $.fs.read(FILE)
    const batches = (JSON.parse(text) as PendingFile).batches ?? []
    tweaks = new Map(batches.flatMap(b => (b.tweaks ?? []).map((t, i) => [tweakId(b, t, i), t] as const)))
  } catch {
    // The file is gone: nothing to check against.
  }
  const applied: string[] = []
  const skipped = [...report.skipped]
  for (const id of report.applied) {
    const tweak = tweaks.get(id)
    const why = tweak ? verifyTweak(tweak, files) : null
    if (why) skipped.push({ id, reason: `Not verified: ${why}` })
    else applied.push(id)
  }
  await recordApply($, applied.length, files)
  await update($, run, () => null)
  if (text) await $.fs.write(FILE, settle(text, applied, skipped))

  const at = await $.clock.now()
  const label = (id: string) => {
    const el = tweaks.get(id)?.element
    return el ? (el.classes?.[0] ? '.' + el.classes[0] : (el.tag ?? '?')) : '?'
  }
  const fileNames = files.map(f => f.path.split('/').at(-1) ?? f.path)
  const unreported = runIds.filter(id => !applied.includes(id) && !skipped.some(s => s.id === id))
  await appendLog($, [
    ...applied.map(id => ({ at, id, element: label(id), by: 'haiku' as const, outcome: 'applied', files: fileNames })),
    ...skipped.map(s => ({ at, id: s.id, element: label(s.id), by: 'haiku' as const, outcome: 'skipped', reason: s.reason })),
    ...unreported.map(id => ({ at, id, element: label(id), by: 'haiku' as const, outcome: 'not reported' })),
  ])
  await refresh($)

  const summary = `Haiku applied ${applied.length} UI tweak(s)` + (skipped.length ? `, skipped ${skipped.length}` : '')
  $.ui.toast(summary)
  if (skipped.length) void $.ui.notify(`${summary}: ${skipped[0]!.reason}`, { title: 'UI tweaks' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: 'applier',
      description: 'Applies visual tweaks from the ui-tweaks overlay to source code',
      prompt: APPLIER_PROMPT,
      model: 'haiku',
      tools: ['Read', 'Grep', 'Glob', 'Edit'],
      omitClaudeMd: true,
      maxTurns: 30,
    })
    await $.command.register({
      name: 'apply-tweaks',
      description: 'Apply the waiting browser tweaks with Haiku ("claude": main model; "undo": revert Haiku\'s last apply)',
      argumentHint: '[claude|undo]',
    })
    $.clock.every(1500, () => void refresh($))
    await refresh($)

    return next(e)
  })

  // Only this mod starts the applier; keep it out of the main model's agent list.
  on('agent.offer', { agent: APPLIER }, () => ({ isOffered: false }))

  on('command.run', { command: 'apply-tweaks' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'undo') return { text: await undoLastApply($) }

    return { text: arg === 'claude' ? await applyWithClaude($) : await applyWithHaiku($) }
  })

  // Copy each file before Haiku's first edit of it in a run, so the apply can be undone.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const current = await read($, run)
    const isHaikus = current?.by === 'haiku' && e.agentId !== undefined && (current.agentId ?? e.agentId) === e.agentId
    if (isHaikus && !snapshots.has(e.file_path)) {
      const before = await $.fs.read(e.file_path).catch(() => null)
      if (before !== null) snapshots.set(e.file_path, before)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const current = await read($, run)
    if (current?.by === 'haiku' && e.agentId !== undefined && e.agentId === current.agentId) {
      await finishHaiku($, 'answer' in e ? e.answer : '')
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const { Box, Code, Text } = $.ui.resolve(e)
    const view = await read($, diffView)
    if (view === null) return <Text dimColor>No apply to show.</Text>

    return (
      <Box flexDirection="column">
        {view.files.map(f => (f.diff ? <Code format="diff" source={f.diff} path={f.path} /> : <Text dimColor>{f.path}: no changes</Text>))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const summary = await read($, pending)
    const current = await read($, run)
    const last = await read($, lastApply)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (summary === null && current === null) {
      if (last === null || last.id === (await read($, dismissedApply))) return next(e)
      return (
        <Box>
          <Text color="magenta">◆ </Text>
          <Text>
            {last.by === 'direct' ? 'Applied' : 'Haiku applied'} {last.count} UI tweak{last.count === 1 ? '' : 's'}:{' '}
          </Text>
          {last.files.map(f => (
            <Text>
              {f.path.split('/').at(-1)} <Text color="green">+{f.added}</Text> <Text color="red">−{f.removed}</Text>{'  '}
            </Text>
          ))}
          <Button key="diff" label="Diff" hotkey="d" onPress={() => void openDiff($)} />
          <Button key="undo" label="Undo" hotkey="u" onPress={() => void undoLastApply($).then(text => $.ui.toast(text))} />
          <Button key="dismiss" label="Dismiss" plain onPress={() => void update($, dismissedApply, () => last.id)} />
        </Box>
      )
    }

    if (current !== null || summary === null) {
      const count = current?.tweakIds.length ?? 0
      return (
        <Box>
          <Text color="magenta">◆ </Text>
          <Text dimColor>
            {current?.by === 'claude' ? 'Claude' : 'Haiku'} is applying {count} UI tweak
            {count === 1 ? '' : 's'}…
          </Text>
        </Box>
      )
    }

    const fresh = summary.elements - summary.skipped.length
    const firstReason = summary.skipped[0]?.reason

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="magenta">◆ </Text>
          <Text>
            UI tweaks: {summary.changes} change{summary.changes === 1 ? '' : 's'} on {summary.elements} element
            {summary.elements === 1 ? '' : 's'}{' '}
          </Text>
          <Text dimColor>({summary.pages.join(', ')}) </Text>
          {fresh > 0 && (
            <Button key="haiku" label="Apply with Haiku" variant="primary" hotkey="a" onPress={() => void applyWithHaiku($)} />
          )}
          <Button key="claude" label="Send to Claude" hotkey="c" onPress={() => void applyWithClaude($)} />
        </Box>
        {firstReason !== undefined && (
          <Text dimColor>
            Haiku skipped {summary.skipped.length}: {firstReason}
          </Text>
        )}
      </Box>
    )
  })
}
