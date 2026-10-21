// The project's own breakpoints, read from its @media rules, so "only on small screens" becomes a media
// query the project already uses, in the direction it already writes them (desktop-first max-width,
// or mobile-first min-width), not a one-off query at the exact width of the preview.
import { promises as fs } from "node:fs";
import { styleFiles } from "./tokens.mjs";

const toPx = (n, unit) => Math.round(Number(n) * (unit === "px" ? 1 : 16) * 100) / 100;

/** Width conditions in the @media preludes of a CSS text: [{ kind: "max" | "min", px }] (one per use). */
export function breakpointsIn(text) {
  const out = [];
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/@media([^{;]+)\{/g)) {
    for (const c of m[1].matchAll(/\(\s*(max|min)-width\s*:\s*([\d.]+)(px|em|rem)\s*\)/gi)) out.push({ kind: c[1].toLowerCase(), px: toPx(c[2], c[3].toLowerCase()) });
    for (const c of m[1].matchAll(/\(\s*width\s*(<=|>=)\s*([\d.]+)(px|em|rem)\s*\)/gi)) out.push({ kind: c[1] === "<=" ? "max" : "min", px: toPx(c[2], c[3].toLowerCase()) });
  }
  return out;
}

/** { style: "max" | "min" | null, max: [{ px, uses }], min: [{ px, uses }] } for a list of uses. */
export function summarize(uses) {
  const tally = (kind) => {
    const counts = new Map();
    for (const u of uses) if (u.kind === kind) counts.set(u.px, (counts.get(u.px) || 0) + 1);
    return [...counts].map(([px, n]) => ({ px, uses: n })).sort((a, b) => a.px - b.px);
  };
  const max = tally("max"), min = tally("min");
  const total = (list) => list.reduce((n, b) => n + b.uses, 0);
  const style = !max.length && !min.length ? null : total(min) > total(max) ? "min" : "max";
  return { style, max, min };
}

/**
 * The media query a width-scoped tweak should use at `width`, or null when the project has no breakpoint for it
 * (the tweak then goes to Haiku with the exact width).
 *  desktop-first: the smallest max-width breakpoint at or above the width ("430px and below")
 *  mobile-first: the largest min-width breakpoint at or below the width ("from 768px up")
 */
export function scopeFor(summary, width) {
  if (summary.style === "min") {
    const bp = summary.min.filter((b) => b.px <= width).pop();
    return bp ? { query: `(min-width: ${bp.px}px)`, label: `From ${bp.px}px up`, px: bp.px } : null;
  }
  const bp = summary.max.find((b) => b.px >= width);
  return bp ? { query: `(max-width: ${bp.px}px)`, label: `At ${bp.px}px and below`, px: bp.px } : null;
}

export async function scanBreakpoints(root) {
  const uses = [];
  for (const file of await styleFiles(root)) uses.push(...breakpointsIn(await fs.readFile(file, "utf8").catch(() => "")));
  return summarize(uses);
}
