// Tailwind projects: a tweak becomes a utility class on the element, not a hand-written CSS rule.
//   padding-top 8px -> 20px   ->  `pt-2` becomes `pt-5`
//   font-size 14px -> 18px    ->  `text-[18px]`   (arbitrary, because text-sm/lg also set line-height)
//   hover background          ->  `hover:bg-[#7c5cff]`
// Pure functions: planUtilities(classes, changes, { variant }) -> { classes, applied, skipped }.
// Same-property utilities at the same variant are replaced; broader ones (p-4 next to a new pt-5) stay, because
// Tailwind orders the more specific utility after them.
import { promises as fs } from "node:fs";
import path from "node:path";

/** { major } when the project depends on Tailwind, else null. */
export async function detectTailwind(root) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const range = deps.tailwindcss || deps["@tailwindcss/vite"] || deps["@tailwindcss/postcss"] || deps["@tailwindcss/cli"];
    if (!range) return null;
    const major = Number(/\d+/.exec(String(range))?.[0]);
    return { major: Number.isFinite(major) ? major : 3 };
  } catch {
    return null;
  }
}

export const TAILWIND_BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };

// ---------- values ----------

const SPACING = { 0: "0", 1: "px", 2: "0.5", 4: "1", 6: "1.5", 8: "2", 10: "2.5", 12: "3", 14: "3.5", 16: "4", 20: "5", 24: "6", 28: "7", 32: "8", 36: "9", 40: "10", 44: "11", 48: "12", 56: "14", 64: "16", 80: "20", 96: "24", 112: "28", 128: "32", 144: "36", 160: "40", 176: "44", 192: "48", 208: "52", 224: "56", 240: "60", 256: "64", 288: "72", 320: "80", 384: "96" };
const WEIGHTS = { 100: "thin", 200: "extralight", 300: "light", 400: "normal", 500: "medium", 600: "semibold", 700: "bold", 800: "extrabold", 900: "black" };

const arbitrary = (v) => `[${String(v).trim().replace(/\s+/g, "_")}]`;
const isVar = (v) => /^var\(/.test(String(v).trim());
const pxOf = (v) => {
  const m = /^(-?[\d.]+)px$/.exec(String(v).trim());
  return m ? Number(m[1]) : /^0$/.test(String(v).trim()) ? 0 : null;
};

/** A spacing-scale class for an exact px match, else an arbitrary value. `negative` allows -mt-4 style. */
function scaled(prefix, value, { negative = false, scale = true } = {}) {
  const v = String(value).trim();
  const px = pxOf(v);
  if (scale && px !== null && SPACING[Math.abs(px)] !== undefined && (px >= 0 || negative)) return (px < 0 ? "-" : "") + `${prefix}-${SPACING[Math.abs(px)]}`;
  return `${prefix}-${arbitrary(v)}`;
}

// prop -> how to write it. kind "space" tries the scale, "raw" is always arbitrary, "color" and "length" add a type
// hint to var() values, "keyword" maps values to fixed class names.
const KEYWORDS = {
  "text-align": { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify", start: "text-start", end: "text-end" },
  display: { block: "block", "inline-block": "inline-block", inline: "inline", flex: "flex", "inline-flex": "inline-flex", grid: "grid", "inline-grid": "inline-grid", none: "hidden", contents: "contents" },
  position: { static: "static", relative: "relative", absolute: "absolute", fixed: "fixed", sticky: "sticky" },
  "flex-direction": { row: "flex-row", "row-reverse": "flex-row-reverse", column: "flex-col", "column-reverse": "flex-col-reverse" },
  "justify-content": { "flex-start": "justify-start", start: "justify-start", center: "justify-center", "flex-end": "justify-end", end: "justify-end", "space-between": "justify-between", "space-around": "justify-around", "space-evenly": "justify-evenly" },
  "align-items": { "flex-start": "items-start", start: "items-start", center: "items-center", "flex-end": "items-end", end: "items-end", baseline: "items-baseline", stretch: "items-stretch" },
  "flex-wrap": { wrap: "flex-wrap", nowrap: "flex-nowrap", "wrap-reverse": "flex-wrap-reverse" },
  overflow: { visible: "overflow-visible", hidden: "overflow-hidden", auto: "overflow-auto", scroll: "overflow-scroll", clip: "overflow-clip" },
  "text-transform": { uppercase: "uppercase", lowercase: "lowercase", capitalize: "capitalize", none: "normal-case" },
  "font-style": { italic: "italic", normal: "not-italic" },
};

const PREFIXES = {
  "padding-top": ["pt", "space"], "padding-right": ["pr", "space"], "padding-bottom": ["pb", "space"], "padding-left": ["pl", "space"],
  "margin-top": ["mt", "space", true], "margin-right": ["mr", "space", true], "margin-bottom": ["mb", "space", true], "margin-left": ["ml", "space", true],
  gap: ["gap", "space"], "row-gap": ["gap-y", "space"], "column-gap": ["gap-x", "space"],
  width: ["w", "space"], height: ["h", "space"],
  "min-width": ["min-w", "raw"], "max-width": ["max-w", "raw"], "min-height": ["min-h", "raw"], "max-height": ["max-h", "raw"],
  top: ["top", "space", true], right: ["right", "space", true], bottom: ["bottom", "space", true], left: ["left", "space", true],
  "font-size": ["text", "length"], "line-height": ["leading", "raw"], "letter-spacing": ["tracking", "raw"],
  color: ["text", "color"], "background-color": ["bg", "color"], "border-color": ["border", "color"], "border-top-color": ["border-t", "color"],
  "border-top-width": ["border-t", "length"], "border-right-width": ["border-r", "length"], "border-bottom-width": ["border-b", "length"], "border-left-width": ["border-l", "length"],
  "border-top-left-radius": ["rounded-tl", "raw"], "border-top-right-radius": ["rounded-tr", "raw"], "border-bottom-right-radius": ["rounded-br", "raw"], "border-bottom-left-radius": ["rounded-bl", "raw"],
  opacity: ["opacity", "raw"], "box-shadow": ["shadow", "raw"],
};

/** The utility class (without variants) that sets `prop: value`, or { error }. */
export function utilityFor(prop, value) {
  const v = String(value).trim();
  if (!v) return { error: `empty ${prop}` };
  if (KEYWORDS[prop]) {
    const cls = KEYWORDS[prop][v];
    return cls ? { cls, group: `kw:${prop}` } : { error: `no Tailwind class for ${prop}: ${v}` };
  }
  if (prop === "font-weight") {
    const cls = WEIGHTS[v] ? `font-${WEIGHTS[v]}` : `font-${arbitrary(v)}`;
    return { cls, group: "font-weight" };
  }
  if (prop === "border-radius") return { cls: `rounded-${arbitrary(v)}`, group: "rounded" };
  const entry = PREFIXES[prop];
  if (!entry) return { error: `no Tailwind class for ${prop}` };
  const [prefix, kind, negative] = entry;
  const group = prop === "color" ? "text-color" : prop === "font-size" ? "text-size" : prop === "border-top-color" ? "border-t-color" : prop === "border-color" ? "border-color" : prefix;
  if (kind === "space") return { cls: scaled(prefix, v, { negative }), group };
  if (kind === "color") return { cls: `${prefix}-${isVar(v) ? `[color:${v.replace(/\s+/g, "_")}]` : arbitrary(v)}`, group };
  if (kind === "length") return { cls: `${prefix}-${isVar(v) ? `[length:${v.replace(/\s+/g, "_")}]` : arbitrary(v)}`, group: prefix.startsWith("border-") ? `${prefix}-width` : group };
  return { cls: `${prefix}-${arbitrary(v)}`, group };
}

// ---------- which existing classes a new one replaces ----------

const TEXT_SIZES = new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]);
const TEXT_ALIGN = new Set(["left", "center", "right", "justify", "start", "end"]);
const TEXT_OTHER = new Set(["wrap", "nowrap", "balance", "pretty", "ellipsis", "clip"]);
const BG_OTHER = /^(cover|contain|auto|center|top|bottom|left|right|repeat|repeat-x|repeat-y|repeat-round|repeat-space|no-repeat|fixed|local|scroll|none|clip-.*|origin-.*|blend-.*|gradient-to-.*|linear-.*|radial.*|conic.*|\[(url|image|length|position|linear).*)$/;
const BORDER_STYLE = new Set(["solid", "dashed", "dotted", "double", "hidden", "none", "collapse", "separate", "spacing"]);
const isLengthArb = (v) => /^\[(length:)?-?[\d.]+(px|rem|em|%)?\]$|^\[length:/.test(v);

/** Splits `md:hover:pt-4` into { variants: "md:hover:", base: "pt-4" } (arbitrary variants like max-[430px]: included). */
export function splitVariants(token) {
  let depth = 0, last = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) last = i;
  }
  return { variants: token.slice(0, last + 1), base: token.slice(last + 1) };
}

function inGroup(base, group) {
  const b = base.replace(/^!/, "");
  if (group.startsWith("kw:")) return Object.values(KEYWORDS[group.slice(3)]).includes(b);
  switch (group) {
    case "font-weight": return /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(b) || /^font-\[\d+\]$/.test(b);
    case "rounded": return /^rounded(-\[.*\]|-(none|sm|md|lg|xl|2xl|3xl|full))?$/.test(b);
    case "text-size": {
      const v = b.startsWith("text-") ? b.slice(5) : null;
      return v !== null && (TEXT_SIZES.has(v) || isLengthArb(v));
    }
    case "text-color": {
      const v = b.startsWith("text-") ? b.slice(5) : null;
      return v !== null && !TEXT_SIZES.has(v) && !TEXT_ALIGN.has(v) && !TEXT_OTHER.has(v) && !isLengthArb(v);
    }
    case "bg": return b.startsWith("bg-") && !BG_OTHER.test(b.slice(3));
    case "border-color": return b.startsWith("border-") && !/^border-[trblxyse]-/.test(b) && (() => { const v = b.slice(7); return !BORDER_STYLE.has(v) && !/^\d+$/.test(v) && !isLengthArb(v); })();
    case "border-t-color": case "border-r-color": case "border-b-color": case "border-l-color": {
      const side = group[7];
      return b.startsWith(`border-${side}-`) && (() => { const v = b.slice(9); return !/^\d+$/.test(v) && !isLengthArb(v); })();
    }
    case "border-t-width": case "border-r-width": case "border-b-width": case "border-l-width": {
      const side = group[7];
      return b === `border-${side}` || (b.startsWith(`border-${side}-`) && (() => { const v = b.slice(9); return /^\d+$/.test(v) || isLengthArb(v); })());
    }
    case "shadow": return /^shadow(-\[.*\]|-(sm|md|lg|xl|2xl|inner|none))?$/.test(b);
    case "gap": return /^gap-(?![xy]-)/.test(b);
    default: return new RegExp(`^-?${group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-`).test(b);
  }
}

// ---------- variants ----------

const STATE_VARIANTS = { hover: "hover:", active: "active:", focus: "focus:", "focus-visible": "focus-visible:" };

/** The Tailwind variant prefix for a CSS state and/or width query, or { error }. */
export function variantFor({ state, query } = {}) {
  let prefix = "";
  if (query) {
    const m = /^\(\s*(max|min)-width\s*:\s*([\d.]+)px\s*\)$/.exec(query.trim());
    if (!m) return { error: `no Tailwind variant for @media ${query}` };
    const px = Number(m[2]);
    if (m[1] === "min") {
      const name = Object.entries(TAILWIND_BREAKPOINTS).find(([, v]) => v === px)?.[0];
      prefix += name ? `${name}:` : `min-[${px}px]:`;
    } else {
      const name = Object.entries(TAILWIND_BREAKPOINTS).find(([, v]) => v - 1 === px)?.[0];
      prefix += name ? `max-${name}:` : `max-[${px}px]:`;
    }
  }
  if (state) {
    if (!STATE_VARIANTS[state]) return { error: `no Tailwind variant for the ${state} state` };
    prefix += STATE_VARIANTS[state];
  }
  return { prefix };
}

// ---------- planning ----------

/**
 * New class list for an element after `changes` ([{ prop, to, state? }]) at `variant` (a prefix like "md:").
 * `applied` lists the ids (else props) written; `skipped` the ones with no utility, with a reason.
 */
export function planUtilities(classes, changes, { query } = {}) {
  let out = [...classes];
  const applied = [];
  const skipped = [];
  for (const c of changes) {
    const variant = variantFor({ state: c.state, query });
    if (variant.error) {
      skipped.push({ id: c.id ?? c.prop, prop: c.prop, reason: variant.error });
      continue;
    }
    const u = utilityFor(c.prop, c.to);
    if (u.error) {
      skipped.push({ id: c.id ?? c.prop, prop: c.prop, reason: u.error });
      continue;
    }
    out = out.filter((token) => {
      const { variants, base } = splitVariants(token);
      return !(variants === variant.prefix && inGroup(base, u.group));
    });
    out.push(variant.prefix + u.cls);
    applied.push(c.id ?? c.prop);
  }
  return { classes: out, applied, skipped };
}
