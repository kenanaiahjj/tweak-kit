// Line diffs for the band's "+2 −1" counts and the Diff pane.
// Tweak edits are small: trim the common head and tail, then diff the middle with an LCS table.

type Op = { kind: ' ' | '-' | '+'; line: string; a: number; b: number }

const MAX_CELLS = 4_000_000

function middleOps(a: string[], b: string[], aStart: number, bStart: number): Op[] {
  const n = a.length
  const m = b.length
  if (n * m > MAX_CELLS) {
    // Too large to align: show it as one replacement.
    return [
      ...a.map((line, i) => ({ kind: '-' as const, line, a: aStart + i, b: bStart })),
      ...b.map((line, j) => ({ kind: '+' as const, line, a: aStart + n, b: bStart + j })),
    ]
  }
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]!, a: aStart + i, b: bStart + j })
      i++
      j++
    } else if (j < m && (i === n || table[i]![j + 1]! > table[i + 1]![j]!)) {
      ops.push({ kind: '+', line: b[j]!, a: aStart + i, b: bStart + j })
      j++
    } else {
      ops.push({ kind: '-', line: a[i]!, a: aStart + i, b: bStart + j })
      i++
    }
  }
  return ops
}

function lineOps(before: string, after: string): Op[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const ops: Op[] = a.slice(0, head).map((line, i) => ({ kind: ' ', line, a: i, b: i }))
  ops.push(...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail), head, head))
  const shift = b.length - a.length
  for (let i = a.length - tail; i < a.length; i++) ops.push({ kind: ' ', line: a[i]!, a: i, b: i + shift })
  return ops
}

export function lineStats(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 }
  const ops = lineOps(before, after)
  return { added: ops.filter(o => o.kind === '+').length, removed: ops.filter(o => o.kind === '-').length }
}

/** A unified diff with three lines of context. */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const ops = lineOps(before, after)
  const changed = ops.map((o, i) => (o.kind === ' ' ? -1 : i)).filter(i => i >= 0)
  if (changed.length === 0) return ''
  const hunks: [number, number][] = []
  for (const i of changed) {
    const last = hunks[hunks.length - 1]
    if (last && i - context <= last[1] + context) last[1] = i
    else hunks.push([i, i])
  }
  const out = [`--- a/${path}`, `+++ b/${path}`]
  for (const [first, lastChanged] of hunks) {
    const from = Math.max(0, first - context)
    const to = Math.min(ops.length - 1, lastChanged + context)
    const slice = ops.slice(from, to + 1)
    const aCount = slice.filter(o => o.kind !== '+').length
    const bCount = slice.filter(o => o.kind !== '-').length
    out.push(`@@ -${slice[0]!.a + 1},${aCount} +${slice[0]!.b + 1},${bCount} @@`)
    for (const o of slice) out.push(o.kind + o.line)
  }
  return out.join('\n')
}
