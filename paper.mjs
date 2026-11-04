// Send to Paper: the panel captures an element (or a screen) as Paper-ready HTML, this saves it in
// .ui-tweaks/paper/ and queues an ask; the Claude Code mod has Claude place it in the open Paper file.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { addAsk } from "./asks.mjs";

const KEEP = 40;
const MAX = 1_000_000;
const TYPES = { png: "png", jpeg: "jpg", jpg: "jpg", webp: "webp", gif: "gif", "svg+xml": "svg", avif: "avif" };

/**
 * Images Paper can load: the app's own files become paper-asset:// paths on disk (Paper reads local files
 * that way), inline data: images are written out as files first. Other web URLs stay as they are.
 */
export async function localizeImages(root, html, origin, assetsDir) {
  const found = new Map();
  const rx = /(src=")([^"]+)(")|(url\(&quot;|url\(["']?)([^"')&]+)(&quot;\)|["']?\))/g;
  for (const m of html.matchAll(rx)) found.set(m[2] || m[5], null);
  for (const url of found.keys()) found.set(url, await localPath(root, url.replace(/&amp;/g, "&"), origin, assetsDir));
  return html.replace(rx, (all, a, u1, c, d, u2, f) => {
    const to = found.get(u1 || u2);
    if (!to) return all;
    return u1 ? a + to + c : d + to + f;
  });
}

async function localPath(root, url, origin, assetsDir) {
  const data = /^data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
  if (data) {
    const ext = TYPES[data[1].toLowerCase()];
    if (!ext) return null;
    const bytes = Buffer.from(data[2], "base64");
    const file = path.join(assetsDir, `${createHash("sha1").update(bytes).digest("hex").slice(0, 12)}.${ext}`);
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(file, bytes);
    return "paper-asset://" + file;
  }
  let u;
  try { u = new URL(url, origin); } catch { return null; }
  if (u.origin !== origin) return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return null; }
  if (rel.includes("\0") || rel.startsWith("/@")) return null;
  // Where a dev server serves files from: public/ first, then the project itself.
  for (const base of [path.join(root, "public"), root]) {
    const file = path.resolve(base, "." + rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) continue;
    const ok = await fs.stat(file).then((s) => s.isFile(), () => false);
    if (ok) return "paper-asset://" + file;
  }
  return null;
}

const name = (t, fallback) => String(t || fallback).slice(0, 120);

/**
 * Saves one capture or several (every screen, or an element's states) and queues one ask for them.
 * target is "paper" or "figma": which design tool Claude places them in.
 */
export async function sendToPaper(root, body, origin) {
  const list = Array.isArray(body && body.screens) ? body.screens : [body || {}];
  const screens = list.filter((x) => x && String(x.html || "").trim());
  if (!screens.length) throw Object.assign(new Error("Nothing to send"), { status: 400 });
  if (screens.length > 30) throw Object.assign(new Error("Thirty at most in one go"), { status: 413 });
  for (const x of screens) if (String(x.html).length > MAX) throw Object.assign(new Error(`“${name(x.title, "A screen")}” is too big to send in one go: pick a smaller part`), { status: 413 });
  const dir = path.join(root, ".ui-tweaks", "paper");
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (const x of screens) {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await fs.writeFile(path.join(dir, `${id}.html`), await localizeImages(root, String(x.html), origin, path.join(dir, "assets")));
    files.push({ file: `.ui-tweaks/paper/${id}.html`, title: name(x.title, "Screen"), width: x.width, height: x.height });
  }
  const keep = Math.max(KEEP, files.length);
  const old = (await fs.readdir(dir)).filter((n) => /^p[a-z0-9]+\.html$/.test(n)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - keep))) await fs.rm(path.join(dir, n), { force: true });
  const target = body.target === "figma" ? "figma" : "paper";
  const tool = target === "figma" ? "Figma" : "Paper";
  const title = name(body.title || files[0].title, "Screen");
  return addAsk(root, {
    kind: "paper",
    target,
    files,
    title,
    whole: !!body.whole,
    page: body.page || null,
    instruction: files.length > 1 ? `Send ${files.length} ${body.whole ? "screens" : `versions of “${title}”`} to ${tool}` : `Send ${body.whole ? "the screen" : `“${title}”`} to ${tool}`,
  });
}
