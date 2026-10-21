// Design tokens: CSS custom properties in the project's stylesheets, grouped into modes
// (the selectors that declare them), with how often each is used, plus the raw values
// written out by hand. Also writes token edits back to the source.
import { promises as fs } from "node:fs";
import path from "node:path";
import { cssBlocks, sourceFiles } from "./direct-apply.mjs";

const STYLE_EXT = new Set([".css", ".scss", ".sass", ".less", ".pcss", ".postcss"]);
const NAMED = "transparent|currentcolor|white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|teal|cyan|magenta|navy|silver|gold";
const COLOR_FN = "(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\\(";
const COLOR_LITERAL = new RegExp(`#[0-9a-fA-F]{3,8}\\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\([^()]*\\)`, "g");
const MIN_MODE = 4; // a selector declaring at least this many tokens is a mode (theme); fewer are local

// Comments become spaces, so positions in the copy match the file.
const blank = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function lineOf(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Every declaration in a stylesheet: { prop, value, valueStart, valueEnd, line, context: [preludes] }. */
export function declarationsIn(text) {
  const src = blank(text);
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  const out = [];
  const visit = (from, to, context) => {
    for (const b of cssBlocks(src, from, to)) {
      const prelude = src.slice(b.start, b.open).trim().replace(/\s+/g, " ");
      const inner = cssBlocks(src, b.open + 1, b.close);
      if (/^@(media|supports|layer|container|document|scope)\b/.test(prelude) && !/^@layer [\w.-]+;/.test(prelude)) {
        visit(b.open + 1, b.close, [...context, prelude]);
        continue;
      }
      // The rule's own declarations: the body minus nested blocks.
      let cursor = b.open + 1;
      const segments = [];
      for (const n of inner) {
        segments.push([cursor, n.start]);
        cursor = n.close + 1;
      }
      segments.push([cursor, b.close]);
      for (const [s, e] of segments) {
        let p = s;
        for (const part of splitDeclarations(src.slice(s, e))) {
          const m = /^(\s*)(--[\w-]+|-?[a-zA-Z][\w-]*)\s*:/.exec(part);
          if (m) {
            const valueStart = p + m[0].length + (/^\s*/.exec(part.slice(m[0].length))[0].length);
            const valueEnd = p + part.replace(/\s+$/, "").length;
            if (valueEnd > valueStart) out.push({ prop: m[2], value: text.slice(valueStart, valueEnd), valueStart, valueEnd, line: lineOf(starts, valueStart), context: [...context, prelude] });
          }
          p += part.length + 1;
        }
      }
      if (inner.length) visit(b.open + 1, b.close, [...context, prelude]);
    }
  };
  visit(0, src.length, []);
  // Nested rules are visited after their parent's own declarations: put everything back in file order.
  return out.sort((a, b) => a.valueStart - b.valueStart);
}

// Splits on ; outside quotes and parentheses (data: URLs and strings can hold one).
function splitDeclarations(text) {
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// Which declarations a kind of hand-written value belongs to (the same split scanTokens uses).
const KIND_PROPS = {
  spacing: (p) => /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left)(-|$)/.test(p),
  radius: (p) => /radius/.test(p),
  type: (p) => p === "font-size",
  color: () => true,
};

export async function styleFiles(root) {
  return sourceFiles(root, STYLE_EXT);
}

const isColor = (v) => new RegExp(`^(?:#[0-9a-f]{3,8}|${COLOR_FN}|(?:${NAMED})$)`, "i").test(v.trim());
const isLength = (v) => /^-?[\d.]+(px|rem|em|%|vw|vh|ch)?$|^(calc|clamp|min|max)\(/.test(v.trim());

function category(name, value) {
  const n = name.toLowerCase(), v = value.trim();
  if (/shadow|elevation/.test(n) || (/^(inset\s+)?-?[\d.]+(px|rem)?\s+-?[\d.]+(px|rem)?\s/.test(v) && new RegExp(COLOR_FN + "|#[0-9a-f]{3}", "i").test(v))) return "shadow";
  if (/font-?(family|sans|serif|mono|display|body|heading)|^--font$|typeface/.test(n) || /["']|,\s*(sans-serif|serif|monospace|system-ui)/.test(v)) return "font";
  if (/radius|rounded|corner/.test(n)) return "radius";
  if (/duration|ease|easing|transition|timing|delay|motion/.test(n) || /^[\d.]+m?s$|cubic-bezier|steps\(/.test(v)) return "motion";
  if (/weight/.test(n) && /^\d{3}$/.test(v)) return "weight";
  if (/leading|line-height|lh\b/.test(n)) return "leading";
  if (/font-size|text-(xs|sm|base|md|lg|xl|\d)|^--fs|type-?scale|size-(xs|sm|md|lg|xl)/.test(n) && isLength(v)) return "type";
  if (/^--z\b|z-?index|layer/.test(n) && /^-?\d+$/.test(v)) return "z";
  if (isColor(v) || /color|^--(bg|fg|text|ink|border|surface|canvas|primary|accent)/.test(n) && /var\(|#|\(/.test(v)) return "color";
  if (isLength(v) || /space|spacing|gap|pad|margin|gutter|inset|size/.test(n)) return "spacing";
  return "other";
}

function modeLabel(key) {
  const k = key.toLowerCase();
  const dark = /dark|:not\(\.light/.test(k), light = /light/.test(k) && !dark;
  if (/prefers-color-scheme:\s*dark/.test(k)) return "Dark (system)";
  if (/^(:root|html|:host|@theme)(\s*,\s*:host)?$/.test(k)) return "Base";
  if (dark) return "Dark · " + key.split(" › ").pop();
  if (light) return "Light · " + key.split(" › ").pop();
  return key.split(" › ").pop();
}

/** Scans the project. */
export async function scanTokens(root) {
  const files = await styleFiles(root);
  const scopes = new Map(); // context key -> Map(name -> { value, file, line })
  const raw = { color: new Map(), spacing: new Map(), radius: new Map(), type: new Map() };
  const note = (map, value, where) => {
    const key = value.trim().toLowerCase().replace(/\s+/g, " ");
    const e = map.get(key) || { value: value.trim(), count: 0, at: [] };
    e.count++;
    if (e.at.length < 6) e.at.push(where);
    map.set(key, e);
  };
  const texts = [];
  for (const abs of files) {
    const text = await fs.readFile(abs, "utf8").catch(() => "");
    texts.push(text);
    const file = path.relative(root, abs);
    for (const d of declarationsIn(text)) {
      const where = `${file}:${d.line}`;
      if (d.prop.startsWith("--")) {
        const key = d.context.join(" › ");
        if (!scopes.has(key)) scopes.set(key, new Map());
        scopes.get(key).set(d.prop, { value: d.value.trim(), file, line: d.line }); // later declarations win, as in the cascade
        continue;
      }
      for (const m of d.value.matchAll(COLOR_LITERAL)) note(raw.color, m[0], where);
      const lengths = d.value.match(/(?<![\w.#-])-?\d*\.?\d+(px|rem)\b/g) || [];
      if (KIND_PROPS.spacing(d.prop)) lengths.forEach((v) => v !== "0px" && note(raw.spacing, v, where));
      if (KIND_PROPS.radius(d.prop)) lengths.forEach((v) => note(raw.radius, v, where));
      if (KIND_PROPS.type(d.prop)) lengths.forEach((v) => note(raw.type, v, where));
    }
  }
  // Uses of each token across the styles and the markup (style props, Tailwind arbitrary values).
  for (const abs of await sourceFiles(root)) texts.push(await fs.readFile(abs, "utf8").catch(() => ""));
  const uses = new Map();
  for (const t of texts) for (const m of t.matchAll(/var\(\s*(--[\w-]+)/g)) uses.set(m[1], (uses.get(m[1]) || 0) + 1);

  const big = [...scopes].filter(([, m]) => m.size >= MIN_MODE);
  const base = big.find(([k]) => /^(:root|html|:host|@theme)\b/.test(k)) || big.sort((a, b) => b[1].size - a[1].size)[0];
  const modes = [base, ...big.filter((s) => s !== base)].filter(Boolean).map(([key]) => ({ key, label: modeLabel(key) }));
  const local = [...scopes].filter(([, m]) => m.size < MIN_MODE);

  const names = new Map(); // name -> token
  for (const { key } of modes) {
    for (const [name, v] of scopes.get(key)) {
      const t = names.get(name) || { name, values: {}, uses: uses.get(name) || 0 };
      t.values[key] = v;
      names.set(name, t);
    }
  }
  const baseValue = (t) => Object.values(t.values)[0].value;
  const resolve = (value, depth = 0) => {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(value.trim());
    if (!m || depth > 8 || !names.has(m[1])) return value;
    return resolve(baseValue(names.get(m[1])), depth + 1);
  };
  const tokens = [...names.values()].map((t) => ({ ...t, category: category(t.name, resolve(baseValue(t))) }));
  const localTokens = local.flatMap(([key, m]) => [...m].map(([name, v]) => ({ name, scope: key, ...v, uses: uses.get(name) || 0, category: category(name, v.value) })));

  // Hand-written values, most used first, with the token that already holds the same value.
  // Only a token of the same kind counts (14px of padding isn't the 14px radius).
  const norm = (v) => v.toLowerCase().replace(/\s+/g, " ");
  // A token that is the same in every mode is a safe swap; a themed one changes the value in other modes.
  const top = (map, cat) => {
    const byValue = new Map();
    for (const t of tokens) {
      if (t.category !== cat) continue;
      const varies = new Set(Object.values(t.values).map((v) => norm(v.value))).size > 1;
      for (const v of Object.values(t.values)) {
        const prev = byValue.get(norm(v.value));
        if (!prev || (prev.varies && !varies)) byValue.set(norm(v.value), { name: t.name, varies });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 40).map((e) => {
      const m = byValue.get(norm(e.value));
      return { ...e, token: m && m.name, themed: m && m.varies ? true : undefined };
    });
  };
  return {
    modes,
    tokens,
    local: localTokens,
    raw: { color: top(raw.color, "color"), spacing: top(raw.spacing, "spacing"), radius: top(raw.radius, "radius"), type: top(raw.type, "type") },
    files: files.map((f) => path.relative(root, f)),
  };
}

/** Changes one token's value where it's declared. Returns the file's before/after for the undo history. */
export async function setToken(root, { name, file, line, from, to }) {
  if (!/^--[\w-]+$/.test(name || "")) throw Object.assign(new Error("Not a token name"), { status: 400 });
  if (typeof to !== "string" || !to.trim() || /[;{}]/.test(to)) throw Object.assign(new Error("Not a valid value"), { status: 400 });
  const abs = path.resolve(root, file || "");
  if (!abs.startsWith(path.resolve(root) + path.sep) || !STYLE_EXT.has(path.extname(abs))) throw Object.assign(new Error("Not a stylesheet in this project"), { status: 400 });
  const before = await fs.readFile(abs, "utf8");
  const d = declarationsIn(before).find((x) => x.prop === name && x.line === line);
  if (!d || d.value.trim() !== String(from).trim()) throw Object.assign(new Error(`${name} changed in ${file}; reload the page`), { status: 409 });
  const after = before.slice(0, d.valueStart) + to.trim() + before.slice(d.valueEnd);
  await fs.writeFile(abs, after);
  return { path: abs, before, after };
}

/** Swaps a hand-written value for var(--token) in every stylesheet declaration that uses it. */
export async function adoptToken(root, { value, token, kind = "color" }) {
  if (!/^--[\w-]+$/.test(token || "") || typeof value !== "string" || !value.trim()) throw Object.assign(new Error("Need a value and a token"), { status: 400 });
  const fits = KIND_PROPS[kind];
  if (!fits) throw Object.assign(new Error(`Unknown kind ${kind}`), { status: 400 });
  const want = value.trim().toLowerCase().replace(/\s+/g, " ");
  const esc = value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(`(?<![\\w#.-])${esc}(?![\\w-])`, "gi");
  const files = [];
  let count = 0;
  for (const abs of await styleFiles(root)) {
    const before = await fs.readFile(abs, "utf8");
    let after = before;
    for (const d of declarationsIn(before).reverse()) {
      if (d.prop.startsWith("--") || !fits(d.prop) || !d.value.toLowerCase().replace(/\s+/g, " ").includes(want)) continue;
      const next = d.value.replace(re, () => (count++, `var(${token})`));
      after = after.slice(0, d.valueStart) + next + after.slice(d.valueEnd);
    }
    if (after !== before) {
      await fs.writeFile(abs, after);
      files.push({ path: abs, before, after });
    }
  }
  return { files, count };
}

/** Adds a token to a mode (the selector block that declares that mode's tokens), or a new :root block. */
export async function createToken(root, { name, value, mode, kind = "color" }) {
  if (!/^--[a-zA-Z][\w-]*$/.test(name || "")) throw Object.assign(new Error("A token name looks like --brand-green"), { status: 400 });
  if (typeof value !== "string" || !value.trim() || /[;{}]/.test(value)) throw Object.assign(new Error("Not a valid value"), { status: 400 });
  const files = await styleFiles(root);
  if (!files.length) throw Object.assign(new Error("No stylesheet in this project"), { status: 400 });
  let target = null; // { abs, text, decl } the mode's last declaration
  for (const abs of files) {
    const text = await fs.readFile(abs, "utf8");
    for (const d of declarationsIn(text)) {
      if (!d.prop.startsWith("--") || d.context.join(" › ") !== mode) continue;
      if (d.prop === name) throw Object.assign(new Error(`${name} already exists`), { status: 409 });
      target = { abs, text, decl: d };
    }
  }
  let before, after, abs;
  if (target) {
    ({ abs, text: before } = target);
    const d = target.decl;
    const semi = /^\s*;/.exec(before.slice(d.valueEnd));
    const at = d.valueEnd + (semi ? semi[0].length : 0);
    const lineStart = before.lastIndexOf("\n", d.valueStart) + 1;
    const indent = /^\s*/.exec(before.slice(lineStart))[0];
    after = before.slice(0, at) + (semi ? "" : ";") + `\n${indent}${name}: ${value.trim()};` + before.slice(at);
  } else {
    abs = files[0];
    before = await fs.readFile(abs, "utf8");
    // After any leading @charset/@import/@tailwind lines.
    const head = /^(?:\s*(?:@charset|@import|@tailwind|@use|@forward)[^;]*;)*\s*/.exec(before)[0].length;
    after = before.slice(0, head) + `:root {\n  ${name}: ${value.trim()};\n}\n\n` + before.slice(head);
  }
  await fs.writeFile(abs, after);
  const adopted = await adoptToken(root, { value, token: name, kind });
  // One history entry per file: its state before the token, and after it's used.
  const merged = new Map([[abs, { path: abs, before, after }]]);
  for (const f of adopted.files) merged.set(f.path, { path: f.path, before: merged.get(f.path) ? before : f.before, after: f.after });
  return { files: [...merged.values()], count: adopted.count };
}
