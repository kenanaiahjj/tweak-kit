// "Copy as code" for the panel: an element's JSX as written in the source, and styles as Tailwind classes.
import { promises as fs } from "node:fs";
import path from "node:path";
import { utilityFor } from "./tailwind.mjs";

/** Tailwind classes for { prop: value } (only what maps to a utility), plus what didn't map. */
export function toTailwind(styles) {
  const classes = [], skipped = [];
  for (const [prop, value] of Object.entries(styles || {})) {
    const u = utilityFor(prop, String(value));
    if (u.error) skipped.push(`${prop}: ${value}`);
    else if (!classes.includes(u.cls)) classes.push(u.cls);
  }
  return { classes: classes.join(" "), skipped };
}

// Is the `<` at i the start of a JSX tag (not a comparison or a type argument)?
function tagStart(text, i) {
  const next = text[i + 1];
  if (!(next === ">" || next === "/" || /[A-Za-z]/.test(next || ""))) return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  return j < 0 || /[(,?:{=>&|[;}]/.test(text[j]) || /\breturn$/.test(text.slice(Math.max(0, j - 5), j + 1));
}

/** The JSX element that starts on `line` (1-based), as written: its opening tag through its closing tag. */
export function extractJsx(text, line) {
  const lineStart = text.split("\n").slice(0, Math.max(0, line - 1)).join("\n").length + (line > 1 ? 1 : 0);
  let start = text.indexOf("<", lineStart);
  while (start >= 0 && !tagStart(text, start)) start = text.indexOf("<", start + 1);
  const lineEnd = text.indexOf("\n", lineStart);
  if (start < 0 || (lineEnd >= 0 && start > lineEnd)) return null; // the element must start on that line
  // depth: open elements; expr: open {…} inside children. In children text a "<" is always a tag;
  // inside an expression it may be a comparison, so the heuristic decides.
  let depth = 0, expr = 0, i = start;
  const limit = Math.min(text.length, start + 60000);
  while (i < limit) {
    const c = text[i];
    if (depth > 0 && expr > 0 && (c === '"' || c === "'" || c === "`")) {
      const e = text.indexOf(c, i + 1);
      i = e < 0 ? limit : e + 1;
      continue;
    }
    if (depth > 0 && c === "{") { expr++; i++; continue; }
    if (depth > 0 && c === "}") { expr = Math.max(0, expr - 1); i++; continue; }
    const isTag = c === "<" && (i === start || (depth > 0 && expr === 0 ? /[A-Za-z>/]/.test(text[i + 1] || "") : text[i + 1] === "/" || tagStart(text, i)));
    if (isTag) {
      const closing = text[i + 1] === "/";
      // Walk to the end of this tag, skipping strings and {expressions}.
      let j = i + 1, braces = 0;
      for (; j < limit; j++) {
        const ch = text[j];
        if (ch === '"' || ch === "'" || ch === "`") {
          const e = text.indexOf(ch, j + 1);
          j = e < 0 ? limit : e;
        } else if (ch === "{") braces++;
        else if (ch === "}") braces--;
        else if (ch === ">" && braces === 0) break;
      }
      const selfClosing = text[j - 1] === "/";
      depth += closing ? -1 : selfClosing ? 0 : 1;
      i = j + 1;
      if (depth === 0) {
        // Keep the tag's indentation when it starts its line, so nested lines dedent with it.
        const ls = text.lastIndexOf("\n", start - 1) + 1;
        const lead = /^\s*$/.test(text.slice(ls, start)) ? text.slice(ls, start) : "";
        return dedent(lead + text.slice(start, i)).trimEnd();
      }
      continue;
    }
    i++;
  }
  return null;
}

function dedent(snippet) {
  const lines = snippet.split("\n");
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
  return lines.map((l) => l.slice(pad)).join("\n");
}

/** The JSX at `file:line` in the project, or null. */
export async function jsxAt(root, loc) {
  const m = /^(.*):(\d+)$/.exec(loc || "");
  if (!m) return null;
  const abs = path.resolve(root, m[1]);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  const text = await fs.readFile(abs, "utf8").catch(() => null);
  return text === null ? null : extractJsx(text, Number(m[2]));
}
