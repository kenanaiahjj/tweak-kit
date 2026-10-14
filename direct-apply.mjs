// Applies the simple tweaks straight to the source, with no model:
// - a value on a CSS rule that only this element uses (one selector, one match on the page,
//   each of its classes used once in the source), at the top level or in a matching @media block;
// - a copy change on the element's JSX line.
// Anything else (notes, shared rules, shorthands with var(), states, width-scoped tweaks) is left for Haiku.
import { promises as fs } from "node:fs";
import path from "node:path";

const GROUPS = {
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  "border-radius": ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
  "border-width": ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"],
};
const SHORTHAND_OF = Object.fromEntries(Object.entries(GROUPS).flatMap(([s, longs]) => longs.map((l) => [l, s])));
const SOURCE_EXT = new Set([".tsx", ".jsx", ".ts", ".js", ".mjs", ".html", ".vue", ".svelte", ".astro"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".ui-tweaks", ".claude", "coverage"]);

// ---------- CSS text scanning ----------

/** Top-level blocks of a CSS text: { prelude, start, open, close } (offsets into text). */
export function cssBlocks(text, from = 0, to = text.length) {
  const blocks = [];
  let i = from, preludeStart = from, depth = 0, open = -1;
  while (i < to) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? to : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? to : end + 1;
      continue;
    }
    if (c === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && open >= 0) {
        blocks.push({ prelude: text.slice(preludeStart, open), start: preludeStart, open, close: i });
        preludeStart = i + 1;
        open = -1;
      }
    } else if (c === ";" && depth === 0) {
      preludeStart = i + 1; // @import / @charset statements
    }
    i++;
  }
  return blocks;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

export function normalizeSelector(s) {
  return stripComments(s).trim().replace(/\s+/g, " ").replace(/\s*([>+~,()])\s*/g, "$1").replace(/'/g, '"');
}

const normalizeCondition = (s) => stripComments(s).replace(/\s+/g, "").toLowerCase();

/** Declarations directly inside a block body: { name, valueStart, valueEnd, important }. */
export function declarations(text, bodyStart, bodyEnd) {
  const out = [];
  let i = bodyStart, start = bodyStart, depth = 0;
  const flush = (end) => {
    const raw = text.slice(start, end);
    const colon = raw.indexOf(":");
    if (colon > 0 && depth === 0) {
      const name = stripComments(raw.slice(0, colon)).trim().toLowerCase();
      if (/^-?[a-z][a-z0-9-]*$/.test(name)) {
        let valueStart = start + colon + 1;
        let valueEnd = end;
        while (valueStart < valueEnd && /\s/.test(text[valueStart])) valueStart++;
        while (valueEnd > valueStart && /\s/.test(text[valueEnd - 1])) valueEnd--;
        let value = text.slice(valueStart, valueEnd);
        const imp = /\s*!\s*important\s*$/i.exec(value);
        if (imp) valueEnd -= imp[0].length;
        out.push({ name, valueStart, valueEnd, important: !!imp, value: text.slice(valueStart, valueEnd) });
      }
    }
  };
  while (i < bodyEnd) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? bodyEnd : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? bodyEnd : end + 1;
      continue;
    }
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth--;
    else if (c === ";" && depth === 0) {
      flush(i);
      start = i + 1;
    }
    i++;
  }
  flush(bodyEnd);
  return out;
}

/** The one block for `selector` (inside @media `conditions`, if any), or a reason it can't be found. */
export function findRule(text, selector, conditions = []) {
  let from = 0, to = text.length;
  for (const condition of conditions) {
    if (condition.startsWith("@layer")) return { error: "inside @layer" };
    const media = cssBlocks(text, from, to).filter((b) => {
      const p = stripComments(b.prelude).trim();
      return /^@media/i.test(p) && normalizeCondition(p.replace(/^@media/i, "")) === normalizeCondition(condition);
    });
    if (media.length !== 1) return { error: `${media.length} @media ${condition} blocks` };
    from = media[0].open + 1;
    to = media[0].close;
  }
  const want = normalizeSelector(selector);
  const rules = cssBlocks(text, from, to).filter((b) => normalizeSelector(b.prelude) === want);
  if (rules.length !== 1) return { error: `${rules.length} rules for ${selector}` };
  return { rule: rules[0] };
}

// ---------- values ----------

function sides(value) {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 4 || /[(/]/.test(value)) return null;
  const [a, b = a, c = a, d = b] = parts;
  return [a, b, c, d];
}

export function collapse([a, b, c, d]) {
  if (a === b && b === c && c === d) return a;
  if (a === c && b === d) return `${a} ${b}`;
  if (b === d) return `${a} ${b} ${c}`;
  return `${a} ${b} ${c} ${d}`;
}

/** Edits for one tweak's style changes in one file's text, or a reason it needs a model. */
function planStyleEdits(text, changes) {
  const edits = []; // { start, end, value }
  const byShorthand = new Map(); // `${ruleOpen}|${shorthand}` -> { decl, values }
  for (const [prop, change] of Object.entries(changes)) {
    let rule = change.authoredIn && change.authoredIn[0];
    if (!rule) return { error: `${prop} is not set by any rule yet` };
    const found = findRule(text, rule.selector, rule.conditions || []);
    if (found.error) return { error: found.error };
    // The browser reports longhands even when the file declares a shorthand: take whichever is written last.
    const names = [...new Set([rule.property, prop, SHORTHAND_OF[prop]].filter(Boolean))];
    const decls = declarations(text, found.rule.open + 1, found.rule.close).filter((d) => names.includes(d.name));
    const decl = decls[decls.length - 1];
    if (!decl) return { error: `${rule.property} not found in ${rule.selector}` };
    rule = { ...rule, property: decl.name };
    if (rule.property === prop) {
      edits.push({ start: decl.valueStart, end: decl.valueEnd, value: change.to });
    } else if (SHORTHAND_OF[prop] === rule.property) {
      const key = `${found.rule.open}|${rule.property}`;
      if (!byShorthand.has(key)) {
        const current = sides(decl.value);
        if (!current) return { error: `${rule.property}: ${decl.value} is not a plain shorthand` };
        byShorthand.set(key, { decl, values: current });
      }
      byShorthand.get(key).values[GROUPS[rule.property].indexOf(prop)] = change.to;
    } else {
      return { error: `${prop} is set through ${rule.property}` };
    }
  }
  for (const { decl, values } of byShorthand.values()) edits.push({ start: decl.valueStart, end: decl.valueEnd, value: collapse(values) });
  return { edits };
}

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].end > sorted[i - 1].start) return null; // overlapping
  return sorted.reduce((t, e) => t.slice(0, e.start) + e.value + t.slice(e.end), text);
}

// ---------- ownership ----------

async function sourceFiles(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (SOURCE_EXT.has(path.extname(entry.name))) out.push(full);
    }
  };
  await walk(root);
  return out;
}

/** How many times each class name appears as a whole word in the markup/source files. */
export function countClassUses(texts, classes) {
  const counts = Object.fromEntries(classes.map((c) => [c, 0]));
  for (const text of texts) {
    for (const c of classes) {
      const re = new RegExp(`(^|[\\s"'\`{])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s"'\`}]|$)`, "g");
      counts[c] += (text.match(re) || []).length;
    }
  }
  return counts;
}

const classesIn = (selector) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);

// ---------- text ----------

function planTextEdit(text, line, from, to) {
  const lines = text.split("\n");
  const startOffset = lines.slice(0, Math.max(0, line - 1)).join("\n").length;
  const windowText = lines.slice(Math.max(0, line - 1), line + 20).join("\n");
  const needle = from.trim();
  if (!needle || needle.length < 2) return { error: "text too short to find safely" };
  const first = windowText.indexOf(needle);
  if (first < 0) return { error: "text not found near the JSX line" };
  if (windowText.indexOf(needle, first + 1) >= 0) return { error: "text appears twice near the JSX line" };
  const start = startOffset + (line > 1 ? 1 : 0) + first;
  return { edits: [{ start, end: start + needle.length, value: to.trim() }] };
}

// ---------- entry point ----------

/**
 * Splits a batch's tweaks into ones applied directly and ones left for a model.
 * A tweak can be split: the simple properties are applied, the rest stays for Haiku.
 * Returns { applied: [{ id, props, text, files }], remaining: [tweak with what is left + directSkip], files: [{ path, before, after }] }.
 */
export async function applyDirect(root, batch) {
  const contents = new Map(); // abs path -> text (current, as edited so far)
  const originals = new Map();
  const read = async (abs) => {
    if (!contents.has(abs)) {
      const text = await fs.readFile(abs, "utf8");
      contents.set(abs, text);
      originals.set(abs, text);
    }
    return contents.get(abs);
  };
  let markup = null;
  const markupTexts = async () => (markup ??= await Promise.all((await sourceFiles(root)).map((f) => fs.readFile(f, "utf8").catch(() => ""))));

  const applied = []; // { id, props, text, files }
  const remaining = []; // tweaks (with only what is left) + directSkip
  for (const tweak of batch.tweaks) {
    const changes = Object.entries(tweak.changes || {});
    const blocked = {}; // prop key -> reason
    const whole = tweak.note ? "has a note" : tweak.scope && tweak.scope.kind === "viewport" ? "scoped to one screen width" : null;
    let textReason = tweak.text ? whole : null;
    if (whole) {
      for (const [k] of changes) blocked[k] = whole;
    } else {
      for (const [k, c] of changes) {
        const r = c.authoredIn && c.authoredIn[0];
        if (c.state) blocked[k] = "changes a hover/active/focus state";
        else if (!r) blocked[k] = "not set by any rule yet";
        else if (!/\.css$/i.test(r.file || "")) blocked[k] = `rule lives in ${r.file || "an unknown file"}`;
        else if (r.selector.includes(",")) blocked[k] = `${r.selector} is a shared selector list`;
        else if (r.matches !== 1) blocked[k] = `${r.selector} matches ${r.matches ?? "?"} elements on the page`;
        else if (r.usesVariable && !/^var\(/.test(c.to)) blocked[k] = `${r.property} uses a CSS variable`;
      }
      const open = changes.filter(([k]) => !blocked[k]);
      if (open.length) {
        const classes = [...new Set(open.flatMap(([, c]) => classesIn(c.authoredIn[0].selector)))];
        const uses = countClassUses(await markupTexts(), classes);
        for (const [k, c] of open) {
          const shared = classesIn(c.authoredIn[0].selector).find((cls) => uses[cls] > 1);
          if (shared) blocked[k] = `.${shared} is used ${uses[shared]} times in the source`;
        }
      }
    }

    // Plan the edits for what is still open; a file whose plan fails sends its changes to Haiku.
    const plans = new Map(); // abs path -> edits
    const byFile = new Map();
    for (const [k, c] of changes) {
      if (blocked[k]) continue;
      const abs = path.resolve(root, c.authoredIn[0].file);
      byFile.set(abs, { ...(byFile.get(abs) || {}), [k]: c });
    }
    for (const [abs, fileChanges] of byFile) {
      const plan = planStyleEdits(await read(abs).catch(() => ""), fileChanges);
      if (plan.error) for (const k of Object.keys(fileChanges)) blocked[k] = plan.error;
      else plans.set(abs, [...(plans.get(abs) || []), ...plan.edits]);
    }
    if (tweak.text && !textReason) {
      const source = tweak.element && tweak.element.react && tweak.element.react.jsxSource;
      const m = source && /^(.*):(\d+)$/.exec(source);
      if (!m) textReason = "no JSX line for the text change";
      else {
        const abs = path.resolve(root, m[1]);
        const plan = planTextEdit(await read(abs).catch(() => ""), Number(m[2]), tweak.text.from, tweak.text.to);
        if (plan.error) textReason = plan.error;
        else plans.set(abs, [...(plans.get(abs) || []), ...plan.edits]);
      }
    }

    // Apply to the in-memory copies; overlapping edits send the whole tweak to Haiku.
    const next = new Map();
    let overlap = false;
    for (const [abs, edits] of plans) {
      const out = applyEdits(contents.get(abs), edits);
      if (out === null) overlap = true;
      else next.set(abs, out);
    }
    if (overlap) {
      remaining.push({ ...tweak, directSkip: "edits overlap" });
      continue;
    }
    for (const [abs, out] of next) contents.set(abs, out);
    const doneProps = changes.map(([k]) => k).filter((k) => !blocked[k]);
    const textDone = !!tweak.text && !textReason;
    if (doneProps.length || textDone) applied.push({ id: tweak.id, props: doneProps, text: textDone, files: [...next.keys()].map((f) => path.relative(root, f)) });

    const left = Object.fromEntries(changes.filter(([k]) => blocked[k]));
    if (Object.keys(left).length || (tweak.text && !textDone) || (tweak.note && !doneProps.length)) {
      const reasons = [...new Set([...Object.values(blocked), ...(textReason ? [textReason] : [])])];
      remaining.push({
        ...tweak,
        changes: left,
        text: textDone ? undefined : tweak.text,
        directApplied: doneProps.length || textDone ? [...doneProps, ...(textDone ? ["text"] : [])] : undefined,
        directSkip: reasons.join("; ") || "nothing to change",
      });
    }
  }

  const files = [...contents].filter(([abs, after]) => originals.get(abs) !== after).map(([abs, after]) => ({ path: abs, before: originals.get(abs), after }));
  return { applied, remaining, files };
}
