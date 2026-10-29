// Applies tweaks straight to the source, with no model:
// - a value on a CSS rule that only this element uses (one selector, one match on the page,
//   each of its classes used once in the source) is edited in place, top level or in its @media block;
// - a value on a shared rule (or one no rule sets yet) becomes an override: the element's JSX gets a
//   class of its own (e.g. primary-button--t3f2a) and a more specific rule for it goes right after the shared one;
// - a copy change on the element's JSX line is edited in place.
// - a tweak scoped to a width (the panel's "At 430px and below") is written as an @media rule for the
//   project's own breakpoint, in place when that block already has the rule.
// - a hover/active/focus change edits the state's own rule, or adds one on the element's own class.
// Notes and style props are left for Haiku.
import { promises as fs } from "node:fs";
import path from "node:path";
import { detectTailwind, planUtilities } from "./tailwind.mjs";

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
  for (const [key, change] of Object.entries(changes)) {
    const prop = change.state ? change.prop || key.split(":")[0] : key; // a state change's key is "prop:state"
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

/**
 * Writes declarations for `selector` inside an `@media <query>` block: edits the ones the block already has,
 * adds the rest, or creates the block right after the base rule. A block that sits above the base rule can't
 * win for new declarations (same specificity, earlier), so that case is left for a model.
 */
export function planMediaEdits(text, { selector, query, items }) {
  const base = findRule(text, selector);
  if (base.error) return { error: base.error };
  const want = normalizeCondition(query);
  const blocks = cssBlocks(text).filter((b) => {
    const p = stripComments(b.prelude).trim();
    return /^@media/i.test(p) && normalizeCondition(p.replace(/^@media/i, "")) === want;
  });
  if (blocks.length > 1) return { error: `${blocks.length} @media ${query} blocks` };
  const decl = (d) => `${d.prop}: ${d.value}${d.important ? " !important" : ""};`;
  if (!blocks.length) {
    const body = items.map((d) => `    ${decl(d)}`).join("\n");
    return { edits: [{ start: base.rule.close + 1, end: base.rule.close + 1, value: `\n\n@media ${query} {\n  ${selector} {\n${body}\n  }\n}` }] };
  }
  const block = blocks[0];
  const below = block.start > base.rule.start;
  const inner = cssBlocks(text, block.open + 1, block.close).filter((b) => normalizeSelector(b.prelude) === normalizeSelector(selector));
  if (inner.length > 1) return { error: `${inner.length} rules for ${selector} in @media ${query}` };
  const trimEnd = (at) => {
    while (at > 0 && /\s/.test(text[at - 1])) at--;
    return at;
  };
  if (inner.length === 0) {
    if (!below) return { error: `the @media ${query} block comes before ${selector}` };
    const body = items.map((d) => `    ${decl(d)}`).join("\n");
    const at = trimEnd(block.close);
    return { edits: [{ start: at, end: at, value: `\n\n  ${selector} {\n${body}\n  }` }] };
  }
  const rule = inner[0];
  const existing = declarations(text, rule.open + 1, rule.close);
  const edits = [];
  const add = [];
  for (const d of items) {
    const found = existing.filter((x) => x.name === d.prop).pop();
    if (found) edits.push({ start: found.valueStart, end: found.valueEnd, value: d.value });
    else add.push(d);
  }
  if (add.length) {
    if (!below) return { error: `the @media ${query} block comes before ${selector}` };
    const last = existing[existing.length - 1];
    const lineStart = last ? text.lastIndexOf("\n", last.valueStart) + 1 : 0;
    const indent = last ? /^\s*/.exec(text.slice(lineStart))[0] : "    ";
    const at = trimEnd(rule.close);
    const needSemi = existing.length > 0 && text[at - 1] !== ";";
    edits.push({ start: at, end: at, value: (needSemi ? ";" : "") + add.map((d) => `\n${indent}${decl(d)}`).join("") });
  }
  return { edits };
}

// ---------- ownership ----------

export async function sourceFiles(root, extensions = SOURCE_EXT) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (extensions.has(path.extname(entry.name))) out.push(full);
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

// ---------- overrides ----------

const OVERRIDE_RE = /--t[0-9a-z]{4}$/;

/** The element's own override class: one it already has, else a new one named after its first class. */
export function overrideClass(tweak) {
  const classes = (tweak.element && tweak.element.classes) || [];
  const existing = classes.find((c) => OVERRIDE_RE.test(c));
  if (existing) return existing;
  const base = classes.find((c) => !OVERRIDE_RE.test(c)) || (tweak.element && tweak.element.tag) || "el";
  const seed = (tweak.element && tweak.element.selector) || tweak.id || base;
  const hash = [...seed].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7).toString(36).slice(-4).padStart(4, "0");
  return `${base}--t${hash}`;
}

/** Adds `cls` to the className of the JSX element that starts on `line`. */
export function planClassAdd(text, line, cls) {
  const lines = text.split("\n");
  const lineStart = lines.slice(0, Math.max(0, line - 1)).join("\n").length + (line > 1 ? 1 : 0);
  const lt = text.indexOf("<", lineStart);
  if (lt < 0 || lt - lineStart > 200) return { error: "no JSX tag at the JSX line" };
  let i = lt + 1, depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if ((c === '"' || c === "'" || c === "`") && depth >= 0) {
      const end = text.indexOf(c, i + 1);
      if (end < 0) break;
      i = end;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  const tag = text.slice(lt, i);
  const name = /^<([A-Za-z][\w.]*)/.exec(tag);
  if (!name) return { error: "no JSX tag at the JSX line" };
  if (/^[A-Z]/.test(name[1])) return { error: `<${name[1]}> is a component; its className may not reach the element` };
  const literal = /\bclassName\s*=\s*(["'])([^"']*)\1/.exec(tag);
  if (literal) {
    if (literal[2].split(/\s+/).includes(cls)) return { edits: [] };
    const at = lt + literal.index + literal[0].length - 1;
    return { edits: [{ start: at, end: at, value: (literal[2] ? " " : "") + cls }] };
  }
  if (/\bclassName\s*=/.test(tag)) return { error: "its className is an expression" };
  const at = lt + 1 + name[1].length;
  return { edits: [{ start: at, end: at, value: ` className="${cls}"` }] };
}

/**
 * Rewrites the class list of the JSX element that starts on `line`: `fn(classes) -> classes`.
 * Handles className="a b", className={"a b"}-less literals, and cn()/clsx()/classNames()/twMerge() whose first
 * argument is a plain string (that string is edited). Any other className expression is left for a model.
 */
export function planClassEdit(text, line, fn) {
  const lines = text.split("\n");
  const lineStart = lines.slice(0, Math.max(0, line - 1)).join("\n").length + (line > 1 ? 1 : 0);
  const lt = text.indexOf("<", lineStart);
  if (lt < 0 || lt - lineStart > 200) return { error: "no JSX tag at the JSX line" };
  let i = lt + 1, depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if ((c === '"' || c === "'" || c === "`") && depth >= 0) {
      const end = text.indexOf(c, i + 1);
      if (end < 0) break;
      i = end;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  const tag = text.slice(lt, i);
  const name = /^<([A-Za-z][\w.]*)/.exec(tag);
  if (!name) return { error: "no JSX tag at the JSX line" };
  if (/^[A-Z]/.test(name[1])) return { error: `<${name[1]}> is a component; its className may not reach the element` };
  const edit = (index, quote, inner) => {
    const start = lt + index + 1; // just after the opening quote
    return { edits: [{ start, end: start + inner.length, value: fn(inner.split(/\s+/).filter(Boolean)).join(" ") }] };
  };
  const literal = /\bclassName\s*=\s*(["'])([^"']*)\1/.exec(tag);
  if (literal) return edit(literal.index + literal[0].indexOf(literal[1]), literal[1], literal[2]);
  const call = /\bclassName\s*=\s*\{\s*(?:cn|clsx|classNames|classnames|twMerge|cx)\(\s*(["'`])([^"'`$\\]*)\1/.exec(tag);
  if (call) return edit(call.index + call[0].lastIndexOf(call[1], call[0].length - call[2].length - 2), call[1], call[2]);
  if (/\bclassName\s*=/.test(tag)) return { error: "its className is an expression" };
  const at = lt + 1 + name[1].length;
  return { edits: [{ start: at, end: at, value: ` className="${fn([]).join(" ")}"` }] };
}

/** Four matching longhands of a group become its shorthand. */
function collapseDecls(items) {
  const out = [...items];
  for (const [shorthand, longs] of Object.entries(GROUPS)) {
    const found = longs.map((l) => out.find((d) => d.prop === l));
    if (found.some((d) => !d) || new Set(found.map((d) => d.important)).size > 1) continue;
    const at = out.indexOf(found[0]);
    const rest = out.filter((d) => !found.includes(d));
    rest.splice(at, 0, { prop: shorthand, value: collapse(found.map((d) => d.value)), important: found[0].important });
    out.splice(0, out.length, ...rest);
  }
  return out;
}

/** Edits that write `items` into `${base}.${cls}`: into that rule if it exists, else as a new rule after `anchor`. */
/**
 * The project stylesheet a JSX file imports (`import "./styles.css"`), relative to the project root; the
 * nearest one to it otherwise (index.css, styles.css, globals.css and the like up to the root), or null.
 * Module CSS (.module.css) is left out: its class names are rewritten.
 */
export async function importedStylesheet(root, jsxAbs, read) {
  const text = await read(jsxAbs).catch(() => "");
  for (const m of text.matchAll(/^\s*import\s+(?:[^'"]*?from\s+)?["']([^"']+\.css)["']/gm)) {
    if (/\.module\.css$/i.test(m[1]) || !m[1].startsWith(".")) continue;
    const abs = path.resolve(path.dirname(jsxAbs), m[1]);
    if (abs.startsWith(path.resolve(root) + path.sep) && (await read(abs).then(() => true, () => false))) return path.relative(root, abs);
  }
  for (let dir = path.dirname(jsxAbs); dir.startsWith(path.resolve(root)); dir = path.dirname(dir)) {
    for (const name of ["index.css", "styles.css", "style.css", "globals.css", "global.css", "app.css", "App.css", "main.css"]) {
      const abs = path.join(dir, name);
      if (await read(abs).then(() => true, () => false)) return path.relative(root, abs);
    }
    if (dir === path.resolve(root)) break;
  }
  return null;
}

export function planOverride(text, { base, anchor, conditions, items, state }, cls) {
  if (base && base.includes("::")) return { error: "the rule targets a pseudo-element" };
  const selector = base ? `${base}.${cls}` : `.${cls}${state ? ":" + state : ""}`;
  const decls = collapseDecls(items);
  const existing = findRule(text, selector, conditions);
  if (existing.rule) {
    const edits = [];
    const current = declarations(text, existing.rule.open + 1, existing.rule.close);
    let k = existing.rule.close;
    while (k > existing.rule.open + 1 && /\s/.test(text[k - 1])) k--;
    const missing = [];
    for (const d of decls) {
      const found = current.filter((c) => c.name === d.prop).pop();
      if (found) edits.push({ start: found.valueStart, end: found.valueEnd, value: d.value });
      else missing.push(d);
    }
    if (missing.length) {
      const semi = text[k - 1] === ";" || text[k - 1] === "{" ? "" : ";";
      const indent = conditions.length ? "    " : "  ";
      edits.push({ start: k, end: k, value: semi + missing.map((d) => `\n${indent}${d.prop}: ${d.value}${d.important ? " !important" : ""};`).join("") });
    }
    return { edits };
  }
  const indent = conditions.length ? "  " : "";
  const body = decls.map((d) => `${indent}  ${d.prop}: ${d.value}${d.important ? " !important" : ""};`).join("\n");
  const block = `${indent}${selector} {\n${body}\n${indent}}`;
  if (anchor) {
    const a = findRule(text, anchor, conditions);
    if (a.error) return { error: a.error };
    return { edits: [{ start: a.rule.close + 1, end: a.rule.close + 1, value: `\n\n${block}` }] };
  }
  if (conditions.length) return { error: "no rule to place the override next to" };
  return { edits: [{ start: text.length, end: text.length, value: `${text.endsWith("\n") ? "" : "\n"}\n${block}\n` }] };
}

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

  const tailwind = await detectTailwind(root);
  // Tailwind sets a value when no hand-written rule in a source stylesheet does: the winning rule is a generated
  // utility (not in any source CSS file), or there is none. A rule the author wrote keeps the normal path.
  const tailwindOwns = async (c, r) => {
    if (c.inlineBefore) return false;
    if (c.state && !["hover", "active", "focus", "focus-visible"].includes(c.state)) return false;
    if (!r) return true;
    if (!r.file || !/\.css$/i.test(r.file)) return true;
    const text = await read(path.resolve(root, r.file)).catch(() => "");
    return !text || !!findRule(text, r.selector, r.conditions || []).error;
  };
  const applied = []; // { id, props, text, files }
  const remaining = []; // tweaks (with only what is left) + directSkip
  for (const tweak of batch.tweaks) {
    const jsxLoc = /^(.*):(\d+)$/.exec((tweak.element && tweak.element.react && tweak.element.react.jsxSource) || "");
    const tw = {}; // prop key -> true: written as a Tailwind utility on the element's className
    const changes = Object.entries(tweak.changes || {});
    const blocked = {}; // prop key -> reason
    const newState = {}; // prop key -> state, for a state no rule sets yet
    const overridable = {}; // prop key -> true when an override rule can do it
    const scopeQuery = tweak.scope && tweak.scope.kind === "viewport" && tweak.scope.query ? tweak.scope.query : null;
    const mediaWrite = {}; // prop key -> true: written as an @media rule for scopeQuery
    const whole = tweak.note ? "has a note" : tweak.scope && tweak.scope.kind === "viewport" && !scopeQuery ? "scoped to one screen width" : null;
    let textReason = tweak.text ? whole : null;
    if (whole) {
      for (const [k] of changes) blocked[k] = whole;
    } else {
      for (const [k, c] of changes) {
        const r = c.authoredIn && c.authoredIn[0];
        const shared = (reason) => {
          blocked[k] = reason;
          if (!scopeQuery) overridable[k] = true; // an override class has no width scope
        };
        if (tailwind && jsxLoc && tweak.reach !== "all" && (await tailwindOwns(c, r))) {
          tw[k] = true; // a utility class sets this (or nothing does yet): write a utility, not a CSS rule
          continue;
        }
        if (c.state && scopeQuery) blocked[k] = "a state at one screen width";
        else if (c.state && !(r && r.forState)) {
          // No rule for this state yet: a new :state rule on the element's own class.
          blocked[k] = `no :${c.state} rule yet`;
          overridable[k] = true;
          newState[k] = c.state;
        } else if (c.state && !/\.css$/i.test(r.file || "")) blocked[k] = `rule lives in ${r.file || "an unknown file"}`;
        else if (c.state && tweak.reach === "all") continue;
        else if (c.state) {
          // The state's own rule: edited in place when its classes are this element's alone (no page match count: it isn't hovered).
          if (r.selector.includes(",")) shared(`${r.selector} is a shared selector list`);
          else if (r.usesVariable && !/^var\(/.test(c.to)) shared(`${r.property} uses a CSS variable`);
        } else if (c.inlineBefore) blocked[k] = "set by the element's style prop";
        else if (!r) shared("not set by any rule yet");
        else if (!/\.css$/i.test(r.file || "")) blocked[k] = `rule lives in ${r.file || "an unknown file"}`;
        else if (scopeQuery && tweak.reach === "all") blocked[k] = "Everywhere and a width scope together";
        else if (scopeQuery && (r.conditions || []).length && !(r.conditions.length === 1 && normalizeCondition(r.conditions[0]) === normalizeCondition(scopeQuery))) blocked[k] = "a different @media rule wins here";
        else if (tweak.reach === "all") continue; // "Everywhere": edit the rule itself, shared or not
        else if (r.selector.includes(",")) shared(`${r.selector} is a shared selector list`);
        else if (r.matches !== 1) shared(`${r.selector} matches ${r.matches ?? "?"} elements on the page`);
        else if (r.usesVariable && !/^var\(/.test(c.to)) shared(`${r.property} uses a CSS variable`);
        else if (scopeQuery && !(r.conditions || []).length) mediaWrite[k] = true;
      }
      const open = changes.filter(([k]) => !blocked[k] && !tw[k]);
      if (open.length && tweak.reach !== "all") {
        const classes = [...new Set(open.flatMap(([, c]) => classesIn(c.authoredIn[0].selector)))];
        const uses = countClassUses(await markupTexts(), classes);
        for (const [k, c] of open) {
          const shared = classesIn(c.authoredIn[0].selector).find((cls) => uses[cls] > 1);
          if (shared) {
            blocked[k] = `.${shared} is used ${uses[shared]} times in the source`;
            if (!scopeQuery) overridable[k] = true;
            delete mediaWrite[k];
          }
        }
      }
    }

    // Plan the edits for what is still open; a file whose plan fails sends its changes to Haiku.
    const plans = new Map(); // abs path -> edits
    const byFile = new Map();
    const mediaGroups = new Map(); // `${file}|${selector}` -> { abs, selector, items, keys }
    for (const [k, c] of changes) {
      if (blocked[k] || tw[k]) continue;
      const abs = path.resolve(root, c.authoredIn[0].file);
      if (mediaWrite[k]) {
        const g = c.authoredIn[0];
        const key = `${abs}|${g.selector}`;
        if (!mediaGroups.has(key)) mediaGroups.set(key, { abs, selector: g.selector, items: [], keys: [] });
        mediaGroups.get(key).items.push({ prop: c.prop || k, value: c.to, important: /!important$/.test(g.value || "") });
        mediaGroups.get(key).keys.push(k);
        continue;
      }
      byFile.set(abs, { ...(byFile.get(abs) || {}), [k]: c });
    }
    for (const g of mediaGroups.values()) {
      const plan = planMediaEdits(await read(g.abs).catch(() => ""), { selector: g.selector, query: scopeQuery, items: g.items });
      if (plan.error) for (const k of g.keys) blocked[k] = plan.error;
      else plans.set(g.abs, [...(plans.get(g.abs) || []), ...plan.edits]);
    }
    const twChanges = changes.filter(([k]) => tw[k] && !blocked[k]);
    if (twChanges.length) {
      const abs = path.resolve(root, jsxLoc[1]);
      let result = null;
      const plan = planClassEdit(await read(abs).catch(() => ""), Number(jsxLoc[2]), (classes) => {
        result = planUtilities(classes, twChanges.map(([k, c]) => ({ id: k, prop: c.prop || k, to: c.to, state: c.state })), { query: scopeQuery });
        return result.classes;
      });
      if (plan.error) for (const [k] of twChanges) blocked[k] = plan.error;
      else {
        for (const sk of result.skipped) blocked[sk.id] = sk.reason;
        if (result.applied.length) plans.set(abs, [...(plans.get(abs) || []), ...plan.edits]);
      }
    }
    for (const [abs, fileChanges] of byFile) {
      const plan = planStyleEdits(await read(abs).catch(() => ""), fileChanges);
      if (plan.error) {
        for (const k of Object.keys(fileChanges)) {
          blocked[k] = plan.error;
          overridable[k] = true;
        }
      } else plans.set(abs, [...(plans.get(abs) || []), ...plan.edits]);
    }

    // Shared rules: give this element a class of its own and a more specific rule for it.
    const toOverride = changes.filter(([k]) => blocked[k] && overridable[k]);
    const jsx = /^(.*):(\d+)$/.exec((tweak.element && tweak.element.react && tweak.element.react.jsxSource) || "");
    if (toOverride.length && jsx) {
      const cls = overrideClass(tweak);
      const jsxAbs = path.resolve(root, jsx[1]);
      const classPlan = planClassAdd(await read(jsxAbs).catch(() => ""), Number(jsx[2]), cls);
      if (classPlan.error) {
        for (const [k] of toOverride) blocked[k] += `; ${classPlan.error}`;
      } else {
        // Where a value no rule sets yet goes: next to the tweak's other rules, else the stylesheet the component imports.
        const fallbackFile = changes.map(([, c]) => c.authoredIn && c.authoredIn[0] && c.authoredIn[0].file).find((f) => /\.css$/i.test(f || "")) || (await importedStylesheet(root, jsxAbs, read));
        const groups = new Map();
        for (const [k, c] of toOverride) {
          const r = c.authoredIn && c.authoredIn[0];
          const st = newState[k];
          const file = r ? r.file : fallbackFile;
          // A new state rule hangs off the element's own class (.x--t1234:hover), next to the rule it varies.
          const base = st ? "" : r ? r.part || (r.selector.includes(",") ? null : r.selector) : "";
          if (!file || !/\.css$/i.test(file) || base === null) continue;
          const conditions = (!st && r && r.conditions) || [];
          const key = `${file}|${conditions.join("&")}|${base}|${st || ""}`;
          if (!groups.has(key)) groups.set(key, { file, base, state: st, anchor: st ? (r && !(r.conditions || []).length && !r.selector.includes(",") ? r.selector : null) : r && r.selector, conditions, items: [], keys: [] });
          groups.get(key).items.push({ prop: c.prop || k.split(":")[0], value: c.to, important: !!(r && !st && /!important$/.test(r.value || "")) });
          groups.get(key).keys.push(k);
        }
        // A value no rule sets yet joins the element's other override rule in that file, when there is one.
        for (const [key, g] of groups) {
          if (g.base !== "" || g.state) continue;
          const host = [...groups.values()].find((o) => o !== g && o.file === g.file && o.base && !o.state && !o.conditions.length);
          if (!host) continue;
          host.items.push(...g.items);
          host.keys.push(...g.keys);
          groups.delete(key);
        }
        let used = false;
        for (const g of groups.values()) {
          const abs = path.resolve(root, g.file);
          const plan = planOverride(await read(abs).catch(() => ""), g, cls);
          if (plan.error) {
            for (const k of g.keys) blocked[k] += `; ${plan.error}`;
            continue;
          }
          plans.set(abs, [...(plans.get(abs) || []), ...plan.edits]);
          for (const k of g.keys) delete blocked[k];
          used = true;
        }
        if (used) plans.set(jsxAbs, [...(plans.get(jsxAbs) || []), ...classPlan.edits]);
      }
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
    // Moving or removing JSX is Haiku's: it needs to read the component.
    const structural = tweak.move ? "moving JSX needs Haiku" : tweak.remove ? "removing JSX needs Haiku" : tweak.insert ? "inserting JSX needs Haiku" : tweak.props ? "changing component props needs Haiku" : null;
    if (Object.keys(left).length || (tweak.text && !textDone) || (tweak.note && !doneProps.length) || structural) {
      const reasons = [...new Set([...Object.values(blocked), ...(textReason ? [textReason] : []), ...(structural ? [structural] : [])])];
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
