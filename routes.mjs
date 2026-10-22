// The app's pages, for the studio's ☰ list: file-based routes (Next.js, SvelteKit, Nuxt, Remix, React Router's
// routes.ts, TanStack Router, Astro, plain HTML) and route paths written in code (React Router, Vue Router…),
// nested ones joined to their parents. Parameter segments are kept in the framework's own spelling.
import { promises as fs } from "node:fs";
import path from "node:path";
import { sourceFiles } from "./direct-apply.mjs";

const EXT = new Set([".tsx", ".jsx", ".ts", ".js", ".mjs", ".html", ".vue", ".svelte", ".astro", ".md", ".mdx"]);

const join = (...parts) => ("/" + parts.filter(Boolean).join("/")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
const isParam = (p) => /\[[^\]]+\]|(^|\/)[:$][\w-]+|\*/.test(p);

/** The route a file stands for under one of the file-routing conventions, or null. */
export function routeOfFile(rel) {
  let m;
  // Next.js app router: app/**/page.*, without (groups) and @slots.
  if ((m = /^(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/.exec(rel))) return { path: join(...(m[1] || "").split("/").filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"))), source: "Next.js app" };
  // Next.js pages router (also Nuxt's pages/*.vue).
  if ((m = /^(?:src\/)?pages\/(.*)\.(tsx|jsx|ts|js|vue)$/.exec(rel)) && !/(^|\/)(_app|_document|_error|404|500)$/.test(m[1]) && !m[1].startsWith("api/")) {
    return { path: join(m[1].replace(/(^|\/)index$/, "")), source: m[2] === "vue" ? "Nuxt" : "Next.js pages" };
  }
  // Astro: src/pages/**/*.astro|md|mdx.
  if ((m = /^src\/pages\/(.*)\.(astro|md|mdx)$/.exec(rel)) && !m[1].split("/").some((s) => s.startsWith("_"))) return { path: join(m[1].replace(/(^|\/)index$/, "")), source: "Astro" };
  // SvelteKit: src/routes/**/+page.svelte, without (groups).
  if ((m = /^src\/routes\/(?:(.*)\/)?\+page\.svelte$/.exec(rel))) return { path: join(...(m[1] || "").split("/").filter((s) => !/^\(.*\)$/.test(s))), source: "SvelteKit" };
  // Remix / React Router flat routes: app/routes/a.b.$id.tsx (dots are slashes, _index is the index,
  // a leading _ is a pathless layout, a trailing _ opts out of nesting, [x] escapes).
  if ((m = /^app\/routes\/([^/]+?)(?:\/route)?\.(tsx|jsx|ts|js|mdx)$/.exec(rel))) {
    const segs = m[1].replace(/\[(.*?)\]/g, (_, x) => x.replace(/\./g, "\u0000")).split(".").map((s) => s.replace(/\u0000/g, "."));
    const out = segs.filter((s) => s !== "_index" && s !== "index" && !/^_/.test(s)).map((s) => s.replace(/_$/, ""));
    if (segs.some((s) => s === "root")) return null;
    return { path: join(...out), source: "Remix" };
  }
  return null;
}

// Nesting depth (brackets, braces, parentheses) at each offset, skipping strings and comments.
function depths(text) {
  const at = new Int32Array(text.length + 1);
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    at[i] = d;
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); const end = e < 0 ? text.length : e; for (let j = i; j < end; j++) at[j] = d; i = end - 1; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); const end = e < 0 ? text.length : e + 2; for (let j = i; j < end; j++) at[j] = d; i = end - 1; continue; }
    if (c === '"' || c === "'" || c === "`") { let j = i + 1; while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1; for (let k = i; k <= j && k < text.length; k++) at[k] = d; i = j; continue; }
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
  }
  at[text.length] = d;
  return (i) => at[i];
}

/**
 * Route paths written in code, nested ones joined to their parent:
 *  - objects:  { path: "settings", children: [{ path: "profile" }] }      -> /settings, /settings/profile
 *  - JSX:      <Route path="/app"><Route path="inbox" /></Route>         -> /app, /app/inbox
 *  - calls:    route("about", "routes/about.tsx"), createFileRoute("/posts/$id")
 */
export function routesInCode(text) {
  const found = [];
  // Objects: a path belongs to the nearest enclosing object that also has a path.
  const depthAt = depths(text);
  const stack = []; // { depth, path }
  for (const m of text.matchAll(/\bpath\s*:\s*["'`]([^"'`\s]*)["'`]/g)) {
    const d = depthAt(m.index);
    while (stack.length && stack[stack.length - 1].depth >= d) stack.pop();
    const own = m[1];
    if (own.startsWith(".") || /\.\w{2,4}$/.test(own) || !/^[\w\-/:$[\]*.]*$/.test(own)) continue; // a file path or something else, not a route
    const full = own.startsWith("/") ? join(own) : join(stack.length ? stack[stack.length - 1].path : "", own);
    if (own !== "" || stack.length) found.push(full);
    stack.push({ depth: d, path: full });
  }
  // JSX <Route path="..."> elements, nested by their open and close tags (attributes can hold {<A/>}).
  const jsx = [];
  for (const m of text.matchAll(/<Route\b|<\/Route>/g)) {
    if (m[0] === "</Route>") { jsx.pop(); continue; }
    let j = m.index + 6, braces = 0;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '"' || c === "'" || c === "`") { const e = text.indexOf(c, j + 1); j = e < 0 ? text.length : e; }
      else if (c === "{") braces++;
      else if (c === "}") braces--;
      else if (c === ">" && braces === 0) break;
    }
    const attrs = text.slice(m.index + 6, j);
    const selfClosing = text[j - 1] === "/";
    const p = /\bpath\s*=\s*\{?\s*["'`]([^"'`]*)["'`]/.exec(attrs.replace(/\{[^{}]*\}/g, (x) => (/^\{\s*["'`]/.test(x) ? x : "")));
    const parent = [...jsx].reverse().find((x) => x !== null);
    const full = p ? (p[1].startsWith("/") ? join(p[1]) : join(parent || "", p[1])) : null;
    if (full !== null) found.push(full);
    if (!selfClosing) jsx.push(full);
  }
  // React Router's routes.ts helpers and TanStack Router's file routes.
  for (const m of text.matchAll(/\broute\(\s*["'`]([^"'`]+)["'`]\s*,/g)) found.push(join(m[1]));
  for (const m of text.matchAll(/\bcreate(?:File|Lazy)?Route\(\s*["'`](\/[^"'`]*)["'`]/g)) if (!m[1].startsWith("/__")) found.push(join(m[1].replace(/\/_[\w-]+/g, "")));
  return found;
}

export async function findRoutes(root) {
  const routes = new Map(); // path -> source
  const add = (p, source) => {
    if (p && !routes.has(p)) routes.set(p, source);
  };
  for (const file of await sourceFiles(root, EXT)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const byFile = routeOfFile(rel);
    if (byFile) {
      add(byFile.path, byFile.source);
      continue;
    }
    if (rel.endsWith(".html") && !rel.startsWith(".")) {
      add(join(rel === "index.html" ? "" : rel.replace(/(^|\/)index\.html$/, "$1")), "HTML");
      continue;
    }
    if (!/\.(tsx|jsx|ts|js|mjs|vue|svelte)$/.test(rel)) continue;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (!/\bpath\b|createFileRoute|route\(/.test(text)) continue;
    for (const p of routesInCode(text)) add(p, "router");
  }
  if (!routes.size) add("/", "");
  return [...routes].map(([p, source]) => ({ path: p, source, params: isParam(p) || undefined })).sort((a, b) => a.path.localeCompare(b.path));
}
