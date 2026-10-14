import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PendingTweaks, SkippedTweak } from '../types'

// Written by the ui-tweak-kit overlay (POST /__ui-tweaks) in the project being served.
const FILE = '.ui-tweaks/pending.json'
const APPLIER = 'ui-tweaks:applier'

const pending = atom({ plugin: 'ui-tweaks', key: 'pending' } as const, null)
const run = atom({ plugin: 'ui-tweaks', key: 'run' } as const, null)

type Tweak = { id?: string; changes?: Record<string, unknown>; text?: unknown; note?: string; skipped?: string }
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

const APPLIER_PROMPT = `You apply visual UI tweaks to source code. Be brief; do not explain your process.

Read ${FILE}. It holds batches of tweaks; each tweak has an id, element.react.jsxSource (file:line of the JSX), element.classes, and changes: { "<css-prop>": { from, to, authoredIn: [{ file, selector, property, value, conditions }] } } with the most specific rule first, plus optional text: { from, to } (a copy edit) and note (my instruction).

For each tweak, edit the source so the element renders each \`to\` value:
- Edit the rule in authoredIn[0] when its selector only targets this element. Keep !important if that rule has it. Edit inside its media query if it has conditions.
- If that selector is shared (a selector list, or a class used on other elements: Grep src for it), add a new class to the JSX at jsxSource and a rule for it right after the shared rule, with the same !important.
- Collapse four equal sides or corners into one shorthand. Leave other code alone.

Skip a tweak, editing nothing for it, when: you cannot find its source; the new value would be hidden by another property (e.g. background-color under a background-image gradient); its note asks for more than the listed changes; or you are unsure. Give a one-line reason.

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

async function refresh($: EngineInterface) {
  const next = await readPending($)
  const before = await read($, pending)
  if (JSON.stringify(next) === JSON.stringify(before)) return
  const isNew = next !== null && next.tweakIds.some(id => !(before?.tweakIds ?? []).includes(id))
  await update($, pending, () => next)
  const current = await read($, run)
  // A main-model run is done once its tweaks have left the file.
  if (current?.by === 'claude' && !current.tweakIds.some(id => next?.tweakIds.includes(id))) {
    await update($, run, () => null)
  }
  if (isNew) $.ui.toast(`UI tweaks arrived from the browser: ${next.changes} change(s)`)
}

async function applyWithHaiku($: EngineInterface): Promise<string> {
  const summary = await readPending($)
  if (summary === null) return `No UI tweaks are waiting (${FILE} is empty or missing).`
  const todo = summary.tweakIds.filter(id => !summary.skipped.some(s => s.id === id))
  if (todo.length === 0) return 'Haiku already skipped every waiting tweak; use "Send to Claude".'
  await update($, run, () => ({ by: 'haiku' as const, tweakIds: todo }))
  const started = await $.agent.spawn({
    subagentType: APPLIER,
    model: 'haiku',
    description: 'Apply UI tweaks',
    prompt: `Apply these tweak ids from ${FILE}: ${todo.join(', ')}. Ignore any other tweaks in the file.`,
  })
  if ('deny' in started) {
    await update($, run, () => null)
    return `Could not start Haiku: ${String(started.deny)}`
  }
  await update($, run, r => (r ? { ...r, agentId: started.agentId } : r))

  return `Haiku is applying ${todo.length} UI tweak(s).`
}

async function applyWithClaude($: EngineInterface): Promise<string> {
  const summary = await readPending($)
  if (summary === null) return `No UI tweaks are waiting (${FILE} is empty or missing).`
  await update($, run, () => ({ by: 'claude' as const, tweakIds: summary.tweakIds }))
  // Submitted once the caller returns: a command.run hook may not submit while it holds the turn.
  $.clock.after(50, () => void $.prompt.submit({ text: claudePrompt(summary) }))

  return `Sending ${summary.changes} UI tweak(s) to Claude.`
}

async function finishHaiku($: EngineInterface, answer: string) {
  await update($, run, () => null)
  const report = parseReport(answer)
  if (report === null) {
    $.ui.toast('Haiku finished without a report; the tweaks are still waiting.')
    return
  }
  try {
    await $.fs.write(FILE, settle(await $.fs.read(FILE), report.applied, report.skipped))
  } catch {
    // The file is gone: nothing left to settle.
  }
  await refresh($)
  const skipped = report.skipped.length ? `, skipped ${report.skipped.length}` : ''
  $.ui.toast(`Haiku applied ${report.applied.length} UI tweak(s)${skipped}`)
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
      description: 'Apply the visual tweaks sent from the browser overlay (Haiku; add "claude" to use the main model)',
      argumentHint: '[claude]',
    })
    $.clock.every(1500, () => void refresh($))
    await refresh($)

    return next(e)
  })

  // Only this mod starts the applier; keep it out of the main model's agent list.
  on('agent.offer', { agent: APPLIER }, () => ({ isOffered: false }))

  on('command.run', { command: 'apply-tweaks' }, async ($, e) => ({
    text: (e.args ?? '').trim() === 'claude' ? await applyWithClaude($) : await applyWithHaiku($),
  }))

  on('turn.complete', async ($, e, next) => {
    const current = await read($, run)
    if (current?.by === 'haiku' && e.agentId !== undefined && e.agentId === current.agentId) {
      await finishHaiku($, 'answer' in e ? e.answer : '')
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const summary = await read($, pending)
    if (e.props.hasSurvey || summary === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, run)

    if (current !== null) {
      return (
        <Box>
          <Text color="magenta">◆ </Text>
          <Text dimColor>
            {current.by === 'haiku' ? 'Haiku' : 'Claude'} is applying {current.tweakIds.length} UI tweak
            {current.tweakIds.length === 1 ? '' : 's'}…
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
