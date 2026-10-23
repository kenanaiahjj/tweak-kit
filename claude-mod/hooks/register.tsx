import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileStat, LastApply, PendingTweaks, SkippedTweak, TweakRun } from '../types'
import { lineStats, unifiedDiff } from './diff'

// Written by the ui-tweak-kit overlay (POST /__ui-tweaks) in the project being served.
const FILE = '.ui-tweaks/pending.json'
const APPLIER = 'ui-tweaks:applier'
const DESIGNER = 'ui-tweaks:designer'
const VARIATOR = 'ui-tweaks:variations'
// "Ask Claude" from the panel: requests in asks.json (the dev server's), outcomes in asks/<id>.json (ours).
const ASKS = '.ui-tweaks/asks.json'
const askResult = (id: string) => `.ui-tweaks/asks/${id}.json`

const pending = atom({ plugin: 'ui-tweaks', key: 'pending' } as const, null)
const run = atom({ plugin: 'ui-tweaks', key: 'run' } as const, null)
const attempted = atom({ plugin: 'ui-tweaks', key: 'attempted' } as const, [])
const lastApply = atom({ plugin: 'ui-tweaks', key: 'lastApply' } as const, null)
const dismissedApply = atom({ plugin: 'ui-tweaks', key: 'dismissedApply' } as const, null)
const diffView = atom({ plugin: 'ui-tweaks', key: 'diffView' } as const, null)
const askRun = atom({ plugin: 'ui-tweaks', key: 'askRun' } as const, null)
const DIFF_PANE = 'ui-tweaks-diff'
const LOG = '.ui-tweaks/log.json'

// Undo history, shared with the kit's dev server (POST /__ui-tweaks/undo):
// history.json lists the applies; each one's file copies sit in a reused slot file.
const HISTORY = '.ui-tweaks/history.json'
const SLOTS = 10
const STUCK_MS = 10 * 60 * 1000

type HistoryEntry = { id: string; at: number; by: 'haiku' | 'direct' | 'claude' | 'tokens'; count: number; slot: string; files: string[] }
type SlotFile = { id: string; files: { path: string; before: string; after: string }[] }

// Each file as it was before the running Haiku apply edited it (one run at a time): the files the
// tweaks point at are copied before Haiku starts, and any other file just before its first edit.
const snapshots = new Map<string, string>()

// The project whose tweaks this session handles: the session's folder when a dev server with the kit
// runs there, else the most recently started dev server that answers (a session started elsewhere).
let projectRoot: string | null = null
const inProject = (rel: string) => (projectRoot !== null && !rel.startsWith('/') ? `${projectRoot}/${rel}` : rel)

// Several sessions can have this mod loaded in one project: a lock file lets one apply at a time.
const LOCK = '.ui-tweaks/lock.json'
// Mirrors the run below to disk, so the browser panel can show that Haiku (or Claude) is applying right now.
const RUNNING = '.ui-tweaks/running.json'

async function setRun($: EngineInterface, fn: (r: TweakRun | null) => TweakRun | null) {
  let next: TweakRun | null = null
  await update($, run, r => (next = fn(r)))
  const r = next as TweakRun | null
  await $.fs.write(inProject(RUNNING), JSON.stringify(r ? { by: r.by, count: r.tweakIds.length, startedAt: r.startedAt } : null)).catch(() => {})
}
const me = `s${Math.random().toString(36).slice(2, 10)}`

type Change = { prop?: string; to?: string; authoredIn?: { file?: string }[] }
type Tweak = {
  id?: string
  changes?: Record<string, Change>
  text?: { from?: string; to?: string }
  move?: { where?: string }
  remove?: boolean
  insert?: { kind?: string }
  props?: Record<string, { from?: unknown; to?: unknown }>
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
    (n, { t }) => n + Object.keys(t.changes ?? {}).length + (t.text ? 1 : 0) + (t.move ? 1 : 0) + (t.remove ? 1 : 0) + (t.insert ? 1 : 0) + Object.keys(t.props ?? {}).length + (t.note ? 1 : 0),
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

Read ${FILE}. It holds batches of tweaks; each tweak has an id, element.react.jsxSource (file:line of the JSX), element.classes, and changes: { "<css-prop>": { from, to, authoredIn: [{ file, selector, property, value, conditions }] } } with the most specific rule first, plus optional text: { from, to } (a copy edit), move (put the element somewhere else among its siblings), remove (delete the element) and note (my instruction). Moves and removals are JSX edits and are part of the job.

For each tweak, edit the source so the element renders each \`to\` value, sits where move says, or is gone when remove is set:
- Edit the rule in authoredIn[0] when its selector only targets this element. Keep !important if that rule has it. Edit inside its media query if it has conditions.
- If that selector is shared (a selector list, or a class used on other elements: Grep src for it), add a new class to the JSX at jsxSource and a rule for it right after the shared rule, with the same !important.
- Collapse four equal sides or corners into one shorthand. Leave other code alone.

- move { where: "before"|"after", anchor, parent, order, sameList } means: in the JSX, put this element directly before/after the anchor element (anchor.react.jsxSource), inside the same parent. order lists all the siblings in their final order (self marks this one). Move the whole JSX element, including its children and any condition wrapping it. sameList: both come from one array .map(): reorder the array's items if they are literal in the source, else skip.
- remove: true means delete this element's JSX (with its children), plus a condition that only wraps it and imports or variables left unused. One item of a .map(): remove that item from the array if it is literal in the source, else skip.
- insert { kind, where, anchor, parent } adds new JSX: put it before/after anchor (anchor.react.jsxSource), or as the first/last child of parent when where is "start"/"end". kind "copy": a copy of the element described by insert.of (copy its JSX at of.react.jsxSource, children included). kind "component": an instance of insert.component.name, written like its existing usage at insert.component.usedAt (same import, props). kind "element": a plain insert.tag with insert.text; give it a class and add a CSS rule next to its neighbours' rules. This tweak's changes, if any, are the new element's styles: put them in that rule.
- props { name: { from, to } } changes props of the component instance whose usage is at component.usedAt: edit those props in that JSX (add one that is missing; remove one when to is null).
- Follow the note when it is a clear change to this element (new copy, a value); a note may be the whole tweak.
- A change with a "state" ("hover", "active", "focus-visible"; its key is "<prop>:<state>") belongs in that state's rule, e.g. .btn:hover. Edit the one in authoredIn when it is a state rule, else add it right after the element's own rule.
- scope { kind: "viewport", width, query? } means: only around that screen width. When scope.query is set (e.g. "(max-width: 430px)"), use exactly that @media query, placed after the base rule it overrides. Otherwise put the change in a media query that holds at that width, reusing a breakpoint the file already uses.
- reach "all" means the change is meant for everything that rule styles: edit the rule in authoredIn[0] itself even when it is shared, and add no override class.
- directApplied lists properties already written to the source: leave them alone. directSkip only says why the automatic writer left the rest to you; it is never a reason to skip.
- warnings say a value cannot show (e.g. hidden under a gradient): skip that tweak with the warning as the reason, unless its note says what to do.

Skip a tweak, editing nothing for it, when: you cannot find its source; the new value would be hidden by another property (e.g. background-color under a background-image gradient); its note reaches beyond this element or is unclear; or you are unsure. Give a one-line reason.

Never edit ${FILE}. End your answer with exactly one line of JSON and nothing after it:
{"applied":["<id>"],"skipped":[{"id":"<id>","reason":"<why>"}]}`

const DESIGNER_PROMPT = `You are a product designer who writes production code. You get one design request about an element of a running web app, and where it lives in the source: react.jsxSource is the file:line of its JSX; react.components lists the components around it, nearest first, with where each is used. Make the change in the source so the app renders it.

- Read the JSX and the CSS that styles it first (Grep for its classes). Follow the project's patterns: its stylesheets and class naming, its components, and its design tokens (CSS custom properties such as var(--primary)). Reuse an existing component when one fits rather than writing a new one.
- Change only what the request needs and leave everything else as it is. Keep the code compiling: imports, types and props.
- New UI goes where the request says, next to the selected element by default.
- No inline styles unless the project already styles that way.
- If the request is unclear, or needs a decision you can't make from the code, make no edits and ask.

End with exactly one line of JSON and nothing after it: {"summary":"<one sentence: what changed>","needs":"<your question, only if you made no edits>"}`

const VARIATIONS_PROMPT = `You are a visual designer exploring alternatives for one element of a running web app. You get its subtree with the current computed styles (each node has a "target": ":scope" is the element itself, others are selectors relative to it), the project's design tokens, the screen width, and maybe a direction from the user. Propose distinct, polished visual variations made of CSS changes only (no new elements).

- Each variation is a different idea (hierarchy, density, emphasis, shape, colour), not the same idea three times, and fits the app: prefer var(--token) values that exist.
- Change only the targets given, with standard CSS properties and valid values; at most 14 changes per variation.
- Keep text readable (contrast) and the layout intact at the given width.
- You may Read the source files named in the request to understand the component. Do not edit anything.

Answer with exactly one line of JSON and nothing after it:
{"variants":[{"name":"<2-4 words>","why":"<one sentence>","changes":[{"target":":scope","prop":"padding","value":"16px 20px"}]}]}`

type Ask = { id: string; kind: 'edit' | 'variations'; instruction: string; element?: { selector?: string; tag?: string; classes?: string[]; text?: string; react?: { jsxSource?: string; components?: unknown[] } } | null; page?: { url?: string } | null; context?: unknown; count?: number; at?: number }
type AskOutcome = { status: 'running' | 'done' | 'failed'; startedAt?: number; summary?: string; needs?: string; files?: string[]; variants?: unknown[]; error?: string }

/** The last line of an answer that parses as a JSON object. */
export function lastJson(answer: string): Record<string, unknown> | null {
  for (const line of answer.trim().split('\n').reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t) as Record<string, unknown>
    } catch {
      // Not this line.
    }
  }
  return null
}

/** Variants as the panel can preview them: named, with changes of a target, a property and a value. */
export function cleanVariants(raw: unknown, max = 4): { name: string; why: string; changes: { target: string; prop: string; value: string }[] }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(v => {
      const o = (v ?? {}) as { name?: unknown; why?: unknown; changes?: unknown }
      const changes = (Array.isArray(o.changes) ? o.changes : [])
        .map(c => c as { target?: unknown; prop?: unknown; value?: unknown })
        .filter(c => typeof c.prop === 'string' && /^-?[a-z][a-z-]*$/.test(c.prop) && typeof c.value === 'string' && !/[;{}]/.test(c.value))
        .map(c => ({ target: typeof c.target === 'string' && c.target.trim() ? c.target.trim() : ':scope', prop: c.prop as string, value: (c.value as string).trim() }))
        .slice(0, 20)
      return { name: String(o.name ?? 'Variation').slice(0, 40), why: String(o.why ?? '').slice(0, 200), changes }
    })
    .filter(v => v.changes.length > 0)
    .slice(0, max)
}

export function askPrompt(ask: Ask, root: string | null): string {
  const where = root ? `The project is ${root}; file paths are relative to it.` : ''
  if (ask.kind === 'edit') {
    return [`Design request: ${ask.instruction}`, `Screen: ${ask.page?.url ?? '?'}`, `Selected element: ${JSON.stringify(ask.element ?? {})}`, where].join('\n')
  }
  return [
    `Propose ${ask.count ?? 3} variations.${ask.instruction ? ` Direction: ${ask.instruction}` : ''}`,
    `Screen: ${ask.page?.url ?? '?'}`,
    `Element: ${JSON.stringify(ask.element ?? {})}`,
    `Subtree, tokens and width: ${JSON.stringify(ask.context ?? {})}`,
    where,
  ].join('\n')
}

async function readAsksFile($: EngineInterface): Promise<Ask[]> {
  try {
    return (JSON.parse(await $.fs.read(inProject(ASKS))) as { asks?: Ask[] }).asks ?? []
  } catch {
    return []
  }
}

async function writeOutcome($: EngineInterface, id: string, outcome: AskOutcome) {
  await $.fs.write(inProject(askResult(id)), JSON.stringify(outcome, null, 2) + '\n')
}

/** Starts the oldest waiting ask, one at a time, never alongside an apply that edits files. */
// One start at a time, claimed before the first await: a Haiku apply and an ask (or two ticks of the
// timer) must not both see an empty slot while the other is still taking the lock.
let starting = false

async function runAsks($: EngineInterface) {
  if (starting) return
  starting = true
  try {
    await startNextAsk($)
  } finally {
    starting = false
  }
}

async function startNextAsk($: EngineInterface) {
  const current = await read($, askRun)
  if (current !== null) {
    if ((await $.clock.now()) - current.startedAt > STUCK_MS) {
      await writeOutcome($, current.id, { status: 'failed', error: 'Took too long; try again.' })
      if (current.kind === 'edit') await releaseLock($)
      await update($, askRun, () => null)
    }
    return
  }
  if ((await read($, run)) !== null) return
  let next: Ask | undefined
  for (const a of await readAsksFile($)) {
    if ((await $.fs.read(inProject(askResult(a.id))).catch(() => null)) === null) {
      next = a
      break
    }
  }
  if (!next) return
  if (next.kind === 'edit') {
    if (!(await takeLock($))) return
    snapshots.clear()
    const jsx = /^(.*):\d+$/.exec(next.element?.react?.jsxSource ?? '')
    if (jsx?.[1]) {
      const file = inProject(jsx[1])
      const text = await $.fs.read(file).catch(() => null)
      if (text !== null) snapshots.set(file, text)
    }
  }
  const startedAt = await $.clock.now()
  await writeOutcome($, next.id, { status: 'running', startedAt })
  await update($, askRun, () => ({ id: next.id, kind: next.kind, startedAt }))
  const started = await $.agent.spawn({
    subagentType: next.kind === 'edit' ? DESIGNER : VARIATOR,
    model: 'sonnet',
    description: next.kind === 'edit' ? 'Design change' : 'Design variations',
    prompt: askPrompt(next, projectRoot),
    ...(projectRoot ? { cwd: projectRoot } : {}),
  })
  if ('deny' in started) {
    await writeOutcome($, next.id, { status: 'failed', error: `Could not start: ${String(started.deny)}` })
    if (next.kind === 'edit') await releaseLock($)
    await update($, askRun, () => null)
    return
  }
  await update($, askRun, r => (r ? { ...r, agentId: started.agentId } : r))
  $.ui.toast(next.kind === 'edit' ? `Claude is designing: ${next.instruction.slice(0, 60)}` : 'Claude is sketching variations…')
}

/** What the panel shows for a finished ask, from the agent's answer and the files it changed. */
export function askOutcome(kind: Ask['kind'], answer: string, changed: string[]): AskOutcome {
  const report = lastJson(answer)
  if (kind === 'edit') {
    const summary = typeof report?.summary === 'string' ? report.summary : ''
    const needs = typeof report?.needs === 'string' && report.needs ? report.needs : undefined
    if (changed.length) return { status: 'done', summary, files: changed }
    // A clear report with nothing to change (e.g. "these screens are already set up") is a finished ask, not a failure.
    if (!needs && summary) return { status: 'done', summary, files: [] }
    return { status: 'failed', summary, ...(needs ? { needs } : { error: 'No files changed.' }) }
  }
  const variants = cleanVariants(report?.variants)
  return variants.length ? { status: 'done', variants } : { status: 'failed', error: 'No usable variations came back; try again.' }
}

async function finishAsk($: EngineInterface, answer: string) {
  const current = await read($, askRun)
  if (current === null) return
  let names: string[] = []
  if (current.kind === 'edit') {
    const files = await changedFiles($)
    await recordApply($, files.length ? 1 : 0, files, 'claude')
    await releaseLock($)
    names = files.map(f => f.path.split('/').at(-1) ?? f.path)
  }
  const outcome = askOutcome(current.kind, answer, names)
  await writeOutcome($, current.id, outcome)
  if (current.kind === 'edit') $.ui.toast(outcome.status === 'done' ? `Claude changed ${names.join(', ')}` : `Claude made no change${outcome.needs ? `: ${outcome.needs}` : ''}`)
  await update($, askRun, () => null)
}

// Repeated in each spawn, so a session whose applier was registered before these rules still follows them.
const STRUCTURE_NOTE = ' A tweak with "move", "remove", "insert" or "props" is in scope even with no CSS changes: move puts the JSX element (with its children) directly before/after move.anchor (anchor.react.jsxSource) in the same parent; remove deletes it; insert adds new JSX as insert describes; props edits the component usage at component.usedAt. For siblings from one .map(), change the literal array or skip.'

export function claudePrompt(summary: PendingTweaks): string {
  const skippedNote = summary.skipped.length
    ? ` Haiku skipped ${summary.skipped.length} of them; each skipped tweak says why in its "skipped" field.`
    : ''
  return [
    `Apply the UI tweaks in ${inProject(FILE)}: ${summary.changes} change(s) on ${summary.elements} element(s), page ${summary.pages.join(', ')}.${skippedNote}`,
    'Each tweak names its JSX line (element.react.jsxSource) and the CSS rules setting each property (changes[prop].authoredIn, most specific first). Edit that source so it renders each `to` value; no inline overrides. A tweak with move puts the JSX of the element before/after move.anchor; remove deletes the JSX of the element. Scope changes to this element when the rule is shared, unless the note says otherwise. If a value would be hidden by another property, ask me what I meant instead of guessing.',
    `When done, delete ${inProject(FILE)}, reload the browser pane to check, and list what changed per file.`,
  ].join('\n')
}

async function readPending($: EngineInterface): Promise<PendingTweaks | null> {
  try {
    return summarize(await $.fs.read(inProject(FILE)))
  } catch {
    return null
  }
}

async function readHistory($: EngineInterface): Promise<HistoryEntry[]> {
  try {
    return (JSON.parse(await $.fs.read(inProject(HISTORY))) as { entries?: HistoryEntry[] }).entries ?? []
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
      const saved = JSON.parse(await $.fs.read(inProject(last.slot)).catch(() => '{"files":[]}')) as SlotFile
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
    entries = (JSON.parse(await $.fs.read(inProject(LOG))) as { entries?: unknown[] }).entries ?? []
  } catch {
    // No log yet.
  }
  await $.fs.write(inProject(LOG), JSON.stringify({ entries: [...entries, ...items].slice(-300) }, null, 2) + '\n')
}

async function recordApply($: EngineInterface, count: number, files: SlotFile['files'], by: HistoryEntry['by'] = 'haiku') {
  if (files.length === 0) return
  const entries = await readHistory($)
  const lastSlot = Number(/(\d+)\.json$/.exec(entries.at(-1)?.slot ?? '')?.[1] ?? -1)
  const slot = `.ui-tweaks/history/slot-${(lastSlot + 1) % SLOTS}.json`
  const at = await $.clock.now()
  const id = `h${at.toString(36)}`
  await $.fs.write(inProject(slot), JSON.stringify({ id, files } satisfies SlotFile))
  const next = [...entries.filter(e => e.slot !== slot), { id, at, by, count, slot, files: files.map(f => f.path) }]
  await $.fs.write(inProject(HISTORY), JSON.stringify({ entries: next.slice(-SLOTS) }, null, 2) + '\n')
  await syncLastApply($)
}

/** Puts back the files Haiku's newest apply changed, unless one has changed since. */
async function undoLastApply($: EngineInterface): Promise<string> {
  const entries = await readHistory($)
  const last = entries.at(-1)
  if (!last) return 'There is no apply to undo.'
  const saved = JSON.parse(await $.fs.read(inProject(last.slot))) as SlotFile
  if (saved.id !== last.id) return 'The undo history is out of date; nothing was changed.'
  const changed: string[] = []
  for (const f of saved.files) if ((await $.fs.read(f.path).catch(() => null)) !== f.after) changed.push(f.path)
  if (changed.length) {
    return `Not undone: ${changed.map(p => p.split('/').at(-1)).join(', ')} changed after the apply. Undo by hand or with Claude.`
  }
  for (const f of saved.files) await $.fs.write(f.path, f.before)
  await $.fs.write(inProject(HISTORY), JSON.stringify({ entries: entries.slice(0, -1) }, null, 2) + '\n')
  await syncLastApply($)

  if ((await read($, diffView))?.id === last.id) await $.ui.close({ id: DIFF_PANE })

  return `Undid the last apply: ${saved.files.map(f => f.path.split('/').at(-1)).join(', ')} restored.`
}

async function openDiff($: EngineInterface) {
  const last = (await readHistory($)).at(-1)
  if (!last) return
  const saved = JSON.parse(await $.fs.read(inProject(last.slot))) as SlotFile
  const cwd = projectRoot ?? (await $.session.cwd())
  const rel = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)
  await update($, diffView, () => ({ id: last.id, files: saved.files.map(f => ({ path: rel(f.path), diff: unifiedDiff(rel(f.path), f.before, f.after) })) }))
  await $.ui.open({ id: DIFF_PANE, title: 'UI tweaks: last apply' })
}

// "A session is listening": the panel warns when tweaks wait and nothing has written this lately.
const LISTENER = '.ui-tweaks/listener.json'
let heardAt = 0
async function heartbeat($: EngineInterface) {
  if (projectRoot === null) return
  const now = await $.clock.now()
  if (now - heardAt < 10000) return
  heardAt = now
  await $.fs.write(inProject(LISTENER), JSON.stringify({ at: now, session: me })).catch(() => {})
}

async function refresh($: EngineInterface) {
  if (!applierRegistered) await registerApplier($)
  await devServer($)
  await heartbeat($)
  await syncLastApply($)
  const next = await readPending($)
  const current = await read($, run)
  if (current !== null && (await $.clock.now()) - current.startedAt > STUCK_MS) {
    await setRun($, () => null)
    await releaseLock($)
  }
  // Send to Claude in the browser applies right away: start Haiku on tweaks it has not tried yet.
  const asking = await read($, askRun)
  if (next !== null && (await read($, run)) === null && (asking === null || asking.kind === 'variations')) {
    const tried = await read($, attempted)
    const fresh = next.tweakIds.filter(id => !tried.includes(id) && !next.skipped.some(s => s.id === id))
    if (fresh.length && !starting) {
      starting = true
      void applyWithHaiku($, fresh).finally(() => (starting = false))
    }
  }
  if (!starting) await runAsks($)
  const before = await read($, pending)
  if (JSON.stringify(next) === JSON.stringify(before)) return
  const isNew = next !== null && next.tweakIds.some(id => !(before?.tweakIds ?? []).includes(id))
  await update($, pending, () => next)
  // A main-model run is done once its tweaks have left the file.
  const latest = await read($, run)
  if (latest?.by === 'claude' && !latest.tweakIds.some(id => next?.tweakIds.includes(id))) {
    await setRun($, () => null)
  }
  if (isNew && latest === null) $.ui.toast(`UI tweaks arrived from the browser: ${next.changes} change(s)`)
}

async function takeLock($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  const held = await $.fs.read(inProject(LOCK)).then(t => JSON.parse(t) as { owner?: string | null; at?: number }).catch(() => ({}) as { owner?: string | null; at?: number })
  if (held.owner && held.owner !== me && now - (held.at ?? 0) < STUCK_MS) return false
  await $.fs.write(inProject(LOCK), JSON.stringify({ owner: me, at: now }))
  await $.clock.sleep(300)
  // Another session may have written at the same moment: the last write wins, the other backs off.
  const after = await $.fs.read(inProject(LOCK)).then(t => JSON.parse(t) as { owner?: string }).catch(() => ({}) as { owner?: string })
  return after.owner === me
}

async function releaseLock($: EngineInterface) {
  const held = await $.fs.read(inProject(LOCK)).then(t => JSON.parse(t) as { owner?: string }).catch(() => ({}) as { owner?: string })
  if (held.owner === me) await $.fs.write(inProject(LOCK), JSON.stringify({ owner: null, at: 0 }))
}

/** Copies of the files the tweaks point at (their CSS rules and JSX lines), taken before Haiku edits. */
async function snapshotTargets($: EngineInterface, ids: string[]) {
  snapshots.clear()
  const cwd = projectRoot ?? (await $.session.cwd())
  const abs = (p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`)
  const batches = (JSON.parse(await $.fs.read(inProject(FILE))) as PendingFile).batches ?? []
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

async function applyWithHaiku($: EngineInterface, ids?: string[], retryNote?: string): Promise<string> {
  const summary = await readPending($)
  if (summary === null) return `No UI tweaks are waiting (${FILE} is empty or missing).`
  if ((await read($, run)) !== null) return 'An apply is already running; wait for it to finish.'
  if ((await read($, askRun))?.kind === 'edit') return 'Claude is making a design change; wait for it to finish.'
  const todo = ids ?? summary.tweakIds.filter(id => !summary.skipped.some(s => s.id === id))
  if (todo.length === 0) return 'Haiku already skipped every waiting tweak; use "Send to Claude".'
  if (!(await takeLock($))) return 'Another Claude Code session is applying tweaks in this project.'
  await snapshotTargets($, todo)
  const startedAt = await $.clock.now()
  await setRun($, () => ({ by: 'haiku' as const, tweakIds: todo, startedAt }))
  await update($, attempted, list => [...new Set([...list, ...todo])].slice(-500))
  const started = await $.agent.spawn({
    subagentType: APPLIER,
    model: 'haiku',
    description: 'Apply UI tweaks',
    prompt: `Apply these tweak ids from ${inProject(FILE)}: ${todo.join(', ')}. Ignore any other tweaks in the file.${retryNote ? ` ${retryNote}` : ''}${STRUCTURE_NOTE}${projectRoot ? ` The project is ${projectRoot}: file paths in the tweaks (src/..., file:line) are relative to it.` : ''}`,
  })
  if ('deny' in started) {
    await setRun($, () => null)
    await releaseLock($)
    return `Could not start Haiku: ${String(started.deny)}`
  }
  await setRun($, r => (r ? { ...r, agentId: started.agentId } : r))

  return `Haiku is applying ${todo.length} UI tweak(s).`
}

async function applyWithClaude($: EngineInterface): Promise<string> {
  const summary = await readPending($)
  if (summary === null) return `No UI tweaks are waiting (${FILE} is empty or missing).`
  if ((await read($, run)) !== null) return 'An apply is already running; wait for it to finish.'
  if ((await read($, askRun))?.kind === 'edit') return 'Claude is making a design change; wait for it to finish.'
  const startedAt = await $.clock.now()
  await setRun($, () => ({ by: 'claude' as const, tweakIds: summary.tweakIds, startedAt }))
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
    // Nothing to check its edits against: undo them rather than keep changes nobody verified.
    for (const f of files) await $.fs.write(f.path, f.before).catch(() => {})
    await setRun($, () => null)
    $.ui.toast(`Haiku finished without a report${files.length ? '; its edits were undone' : ''}. The tweaks are still waiting.`)
    return
  }

  // Trust the files, not the report: a tweak counts as applied only if its new values are in them.
  let tweaks = new Map<string, Tweak>()
  let text = ''
  try {
    text = await $.fs.read(inProject(FILE))
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
  // Nothing checked out: put the files back, so a run never leaves half a change behind (a class with no rule).
  const unchecked = skipped.filter(s => s.reason.startsWith('Not verified'))
  const reverted = applied.length === 0 && files.length > 0
  if (reverted) {
    for (const f of files) await $.fs.write(f.path, f.before).catch(() => {})
  } else {
    await recordApply($, applied.length, files)
  }
  await setRun($, () => null)
  if (text) await $.fs.write(inProject(FILE), settle(text, applied, skipped))
  // One more try for tweaks whose edits didn't check out, told what went wrong.
  const retry = unchecked.map(s => s.id).filter(id => !retried.has(id))
  if (retry.length) {
    for (const id of retry) retried.add(id)
    const why = unchecked.filter(s => retry.includes(s.id)).map(s => `${s.id}: ${s.reason.replace(/^Not verified: /, '')}`).join('; ')
    const note = `A first attempt didn't put the new values into the source (${why}). Write each new value itself into a CSS rule that applies to the element (adding a class to its JSX when it has none, and the rule for that class), check the file holds it, and report only what you actually wrote.`
    $.clock.after(100, () => void applyWithHaiku($, retry, note))
  }

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

  const summary =
    `Haiku applied ${applied.length} UI tweak(s)` +
    (skipped.length ? `, skipped ${skipped.length}` : '') +
    (reverted ? ' (its edits were undone, as none checked out)' : '') +
    (retry.length ? `; trying ${retry.length} again` : '')
  $.ui.toast(summary)
  if (skipped.length && !retry.length) void $.ui.notify(`${summary}: ${skipped[0]!.reason}`, { title: 'UI tweaks' })
}

// ---------- finding the project ----------
// The dev server announces itself in <project>/.ui-tweaks/server.json and in ~/.ui-tweaks/servers,
// so a session started in another folder still finds the project whose tweaks it should apply.
const SERVER = '.ui-tweaks/server.json'
// Tweaks already given their one automatic retry this session.
const retried = new Set<string>()
let serverUrl: string | null = null
let serverCheckedAt = 0

type ServerEntry = { url?: string; root?: string; at?: number }

async function answers($: EngineInterface, url: string): Promise<boolean> {
  const res = await $.http.fetch(`${url}/__ui-tweaks/status`).catch(() => null)
  return res?.ok ?? false
}

/** Finds the dev server (and so the project): the session's folder first, then the registry in ~/.ui-tweaks/servers. */
async function devServer($: EngineInterface): Promise<string | null> {
  const now = await $.clock.now()
  // Checked again every few seconds: servers come and go, and the session's own project wins once its
  // server is up (a server found while it was down must not keep this session on another project).
  if (serverCheckedAt !== 0 && now - serverCheckedAt < (serverUrl !== null ? 5000 : 3000)) return serverUrl
  serverCheckedAt = now
  const cwd = await $.session.cwd().catch(() => null)
  const own = await $.fs.read(cwd ? `${cwd}/${SERVER}` : SERVER).then(t => JSON.parse(t) as ServerEntry).catch(() => null)
  if (own?.url && (await answers($, own.url))) {
    serverUrl = own.url
    projectRoot = own.root ?? cwd
    return serverUrl
  }
  if (serverUrl !== null && (await answers($, serverUrl))) return serverUrl
  serverUrl = null
  const home = await $.env.get('HOME').catch(() => undefined)
  if (!home) return null
  const dir = `${home}/.ui-tweaks/servers`
  const entries = await $.fs.list(dir).catch(() => [])
  const servers: ServerEntry[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    const server = await $.fs.read(`${dir}/${entry.name}`).then(t => JSON.parse(t) as ServerEntry).catch(() => null)
    if (server?.url && server.root) servers.push(server)
  }
  servers.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  for (const server of servers) {
    if (await answers($, server.url!)) {
      serverUrl = server.url!
      projectRoot = server.root!
      return serverUrl
    }
  }
  return null
}

// Copies a file before the first edit of it by the running apply or design change, so it can be undone.
// A file the agent creates has an empty "before".
async function snapshotFor($: EngineInterface, agentId: string | undefined, file: string, isNew: boolean) {
  if (agentId === undefined || snapshots.has(file)) return
  const current = await read($, run)
  const asking = await read($, askRun)
  const ours = (current?.by === 'haiku' && (current.agentId ?? agentId) === agentId) || (asking?.kind === 'edit' && (asking.agentId ?? agentId) === agentId)
  if (!ours) return
  const before = await $.fs.read(file).catch(() => null)
  if (before !== null) snapshots.set(file, before)
  else if (isNew) snapshots.set(file, '')
}

// ---------- /studio ----------
// Opens the studio for this session's project: the project's own dev server's studio when the kit is
// installed there, otherwise the standalone studio (started here, in front of any dev server). In the
// desktop app Claude opens it in its browser pane; elsewhere it opens in the system browser.
const STUDIO_PORT = 5600
const STUDIO_URL = `http://localhost:${STUDIO_PORT}`
const KIT_SPEC = 'github:kenanaiahjj/tweak-kit'

type StudioConnection = { target: string | null; root: string | null; up: boolean }

async function studioConnection($: EngineInterface): Promise<StudioConnection | null> {
  const res = await $.http.fetch(`${STUDIO_URL}/__ui-tweaks/connection`).catch(() => null)
  if (!res?.ok) return null
  try {
    return JSON.parse(res.text) as StudioConnection
  } catch {
    return null
  }
}

let studioStarting = false
async function startStudio($: EngineInterface, root: string): Promise<string | null> {
  if (studioStarting) return null
  studioStarting = true
  // The kit the project has installed, if any; else the latest from GitHub.
  const local = `${root}/node_modules/ui-tweak-kit/cli.mjs`
  const hasLocal = await $.fs.read(local).then(() => true, () => false)
  const argv = hasLocal
    ? ['node', local, 'studio', '--root', root, '--port', String(STUDIO_PORT)]
    : ['npx', '-y', KIT_SPEC, 'studio', '--root', root, '--port', String(STUDIO_PORT)]
  let ended: string | null = null
  const out: string[] = []
  // The studio lives as long as this session (or until this mod reloads).
  void (async () => {
    try {
      const child = $.process.spawn({ argv, cwd: root })
      for await (const { text } of child) {
        out.push(text)
        if (out.length > 40) out.shift()
      }
      ended = out.join('').trim().split('\n').slice(-6).join('\n') || 'the studio stopped'
    } catch (error) {
      ended = String(error instanceof Error ? error.message : error)
    } finally {
      studioStarting = false
    }
  })()
  // npx fetches the kit the first time, so give it a while.
  const started = await $.clock.now()
  while ((await $.clock.now()) - started < 120000) {
    if (ended !== null) return `Couldn't start the studio:\n${ended}`
    if ((await studioConnection($)) !== null) return null
    await $.clock.sleep(500)
  }
  return 'The studio took over two minutes to start.'
}

async function showInBrowser($: EngineInterface, url: string): Promise<string> {
  const surfaces = await $.session.surfaces().catch(() => [] as const)
  if (surfaces.includes('desktop')) {
    // After the command returns: a command can't submit a turn while it holds this one.
    $.clock.after(50, () => void $.prompt.submit({ text: `Open ${url} in your browser pane (preview_start with that url). That's all: it's the UI tweaks studio, don't do anything else with it.` }))
    return 'opening it in the browser pane'
  }
  for (const cmd of [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url]]) {
    const r = await $.process.run(cmd, { timeoutMs: 5000 }).catch(() => null)
    if (r && r.exitCode === 0) return 'opened it in your browser'
  }
  return `open ${url} in your browser`
}

async function openStudio($: EngineInterface, arg: string): Promise<string> {
  const root = await $.session.cwd()
  const target = arg.trim() || null
  // The kit installed in the project: its dev server has the studio already.
  const own = await $.fs.read(`${root}/${SERVER}`).then(t => JSON.parse(t) as ServerEntry).catch(() => null)
  if (!target && own?.url && own.url !== STUDIO_URL && (await answers($, own.url))) {
    const how = await showInBrowser($, `${own.url}/__ui-tweaks/studio`)
    return `The studio is on your dev server (${own.url}): ${how}.`
  }
  if ((await studioConnection($)) === null) {
    const failed = await startStudio($, root)
    if (failed !== null) return failed
  }
  const res = await $.http.fetch(`${STUDIO_URL}/__ui-tweaks/connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target ? { target, root } : { root }),
  }).catch(() => null)
  if (!res) return "Couldn't reach the studio."
  const answer = (() => {
    try {
      return JSON.parse(res.text) as { up?: boolean; target?: string | null; error?: string }
    } catch {
      return {}
    }
  })()
  if (!res.ok) return `The studio didn't take that: ${answer.error ?? res.status}`
  const ready = !!answer.up
  const how = await showInBrowser($, `${STUDIO_URL}/__ui-tweaks/${ready ? 'studio' : 'connect'}`)
  if (ready) return `Studio for ${root} on ${target ?? answer.target}: ${how}.`
  if (target) return `Nothing answers at ${target} yet. The studio's start page is up (${how}): start your dev server there or here, then open it.`
  return `Studio for ${root}: ${how}. Give it your dev server's address, or press "Start its dev server". (Next time: /studio http://localhost:5173)`
}

// Registered at start, and again the first time a reloaded copy of this module runs, so prompt changes take effect.
let applierRegistered = false
async function registerApplier($: EngineInterface) {
  applierRegistered = true
  await $.agent.register({
    name: 'designer',
    description: 'Makes a design change asked for in the ui-tweaks panel, in the source',
    prompt: DESIGNER_PROMPT,
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    maxTurns: 40,
  })
  await $.agent.register({
    name: 'variations',
    description: 'Proposes visual variations of an element as CSS changes',
    prompt: VARIATIONS_PROMPT,
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob'],
    omitClaudeMd: true,
    maxTurns: 12,
  })
  await $.agent.register({
    name: 'applier',
    description: 'Applies visual tweaks from the ui-tweaks overlay to source code',
    prompt: APPLIER_PROMPT,
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob', 'Edit'],
    omitClaudeMd: true,
    maxTurns: 30,
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerApplier($)
    await $.command.register({
      name: 'apply-tweaks',
      description: 'Apply the waiting browser tweaks with Haiku ("claude": main model; "undo": revert the last apply; "asks": run waiting Ask Claude requests)',
      argumentHint: '[claude|undo|asks]',
    })
    await $.command.register({
      name: 'studio',
      description: "Open the UI tweaks studio for this project (give your dev server's address, or pick it in the studio)",
      argumentHint: '[http://localhost:5173]',
    })
    $.clock.every(1500, () => void refresh($))
    await refresh($)

    return next(e)
  })

  // Only this mod starts the applier; keep it out of the main model's agent list.
  on('agent.offer', { agent: APPLIER }, () => ({ isOffered: false }))
  on('agent.offer', { agent: DESIGNER }, () => ({ isOffered: false }))
  on('agent.offer', { agent: VARIATOR }, () => ({ isOffered: false }))

  on('command.run', { command: 'studio' }, async ($, e) => ({ text: await openStudio($, e.args ?? '') }))

  on('command.run', { command: 'apply-tweaks' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'undo') return { text: await undoLastApply($) }
    if (arg === 'asks') {
      await runAsks($)
      const asking = await read($, askRun)
      return { text: asking ? `Running the "Ask Claude" request ${asking.id}.` : 'No "Ask Claude" request is waiting (or an apply is running).' }
    }

    return { text: arg === 'claude' ? await applyWithClaude($) : await applyWithHaiku($) }
  })

  // Copy each file before Haiku's first edit of it in a run, so the apply can be undone.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    await snapshotFor($, e.agentId, e.file_path, false)
    return next(e)
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    await snapshotFor($, e.agentId, e.file_path, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const current = await read($, run)
    if (current?.by === 'haiku' && e.agentId !== undefined && e.agentId === current.agentId) {
      await finishHaiku($, 'answer' in e ? e.answer : '')
    }
    const asking = await read($, askRun)
    if (asking !== null && e.agentId !== undefined && e.agentId === asking.agentId) {
      await finishAsk($, 'answer' in e ? e.answer : '')
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
          {/* Who wrote it: the kit directly (no model), a Haiku agent, Claude, or a token edit. */}
          {last.by === 'direct' ? (
            <Text color="green">[direct · no AI] </Text>
          ) : last.by === 'claude' ? (
            <Text color="cyan">[Claude] </Text>
          ) : last.by === 'tokens' ? (
            <Text color="green">[tokens · no AI] </Text>
          ) : (
            <Text color="yellow">[Haiku agent] </Text>
          )}
          <Text>
            Applied {last.count} UI tweak{last.count === 1 ? '' : 's'}:{' '}
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
          {current?.by === 'claude' ? <Text color="cyan">[Claude] </Text> : <Text color="yellow">[Haiku agent] </Text>}
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
