// A small unified line diff for previewing what a Send would write.
// Edits are tiny next to the file, so the common head and tail are trimmed and only the middle is diffed.

function lcsOps(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [...a.map((l) => ["-", l]), ...b.map((l) => ["+", l])]; // a big rewrite: show it whole
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push([" ", a[i++]]), j++;
    else if (table[i + 1][j] >= table[i][j + 1]) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

/** Hunks of a line diff: [{ oldStart, newStart, lines: [[" "|"-"|"+", text]] }], with `context` unchanged lines around each change. */
export function diffHunks(before, after, context = 2) {
  if (before === after) return [];
  const a = before.split("\n"), b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops = [
    ...a.slice(0, head).map((l) => [" ", l]),
    ...lcsOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((l) => [" ", l]),
  ];
  const hunks = [];
  let oldLine = 1, newLine = 1, current = null, quiet = 0;
  const pending = []; // unchanged lines since the last change, kept as leading context for the next hunk
  for (const op of ops) {
    const [kind] = op;
    if (kind === " ") {
      if (current) {
        if (quiet < context) {
          current.lines.push(op);
          quiet++;
        } else {
          hunks.push(current);
          current = null;
          pending.length = 0;
          pending.push({ op, oldLine, newLine });
        }
      } else {
        pending.push({ op, oldLine, newLine });
        if (pending.length > context) pending.shift();
      }
      oldLine++;
      newLine++;
    } else {
      if (!current) {
        const lead = pending.splice(0);
        current = { oldStart: lead.length ? lead[0].oldLine : oldLine, newStart: lead.length ? lead[0].newLine : newLine, lines: lead.map((p) => p.op) };
      }
      quiet = 0;
      current.lines.push(op);
      if (kind === "-") oldLine++;
      else newLine++;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/** Unified-diff text for one file, or "" when nothing changed. */
export function unifiedDiff(name, before, after, context = 2) {
  const hunks = diffHunks(before, after, context);
  if (!hunks.length) return "";
  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (const h of hunks) {
    const oldLen = h.lines.filter(([k]) => k !== "+").length;
    const newLen = h.lines.filter(([k]) => k !== "-").length;
    out.push(`@@ -${h.oldStart},${oldLen} +${h.newStart},${newLen} @@`);
    for (const [k, l] of h.lines) out.push(k + l);
  }
  return out.join("\n");
}
