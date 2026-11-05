// Handoff: read-only versions of the app's screens for developers, PMs and QA. The studio captures every
// screen (a static snapshot each) as a version; screens and stylesheets are stored once by content, so a
// version that changes two screens costs two files. The viewer (handoff-page.mjs) shows them; an export is
// one self-contained file (images and fonts inlined) that Claude can publish as a shareable page.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { listRefs } from "./versions.mjs";
import { handoffPage } from "./handoff-page.mjs";
import { GITIGNORE } from "./ignore.mjs";

export const handoffDir = (root) => path.join(root, ".ui-tweaks", "handoff");
const hash = (t) => createHash("sha1").update(t).digest("hex").slice(0, 16);
const clip = (v, n) => String(v ?? "").slice(0, n);

// <style> blocks repeat on every screen: each is kept once (styles/<hash>.css) and the screen points at it.
export function splitStyles(html) {
  const styles = {};
  const out = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (all, css) => {
    const h = hash(css);
    styles[h] = css;
    return `<style data-uit-style="${h}"></style>`;
  });
  return { html: out, styles };
}

export async function readIndex(root) {
  try {
    const index = JSON.parse(await fs.readFile(path.join(handoffDir(root), "index.json"), "utf8"));
    return Array.isArray(index.versions) ? index : { versions: [] };
  } catch {
    return { versions: [] };
  }
}

async function writeOnce(file, text) {
  try { await fs.access(file); } catch { await fs.writeFile(file, text); }
}

/** Saves a version: { label, screens: [{ id, name, url, size, x, y, heading, html }] }. */
export async function saveHandoff(root, body) {
  const screens = Array.isArray(body && body.screens) ? body.screens.filter((s) => s && typeof s.html === "string" && s.html.startsWith("<!doctype") && s.html.length < 8_000_000) : [];
  if (!screens.length) throw Object.assign(new Error("Nothing was captured"), { status: 400 });
  const dir = handoffDir(root);
  await fs.mkdir(path.join(dir, "screens"), { recursive: true });
  await fs.mkdir(path.join(dir, "styles"), { recursive: true });
  // Versions are shared through git (see ignore.mjs): the team compares against the same history.
  await fs.writeFile(path.join(root, ".ui-tweaks", ".gitignore"), GITIGNORE);
  const index = await readIndex(root);
  const prev = index.versions[index.versions.length - 1];
  const out = [];
  for (const s of screens.slice(0, 200)) {
    const split = splitStyles(s.html);
    for (const [h, css] of Object.entries(split.styles)) await writeOnce(path.join(dir, "styles", `${h}.css`), css);
    const h = hash(split.html);
    await writeOnce(path.join(dir, "screens", `${h}.html`), split.html);
    const before = prev && prev.screens.find((p) => p.id === s.id);
    const size = Array.isArray(s.size) ? s.size.slice(0, 2).map((n) => Math.max(100, Math.min(4000, Math.round(Number(n) || 0)))) : [390, 844];
    out.push({ id: clip(s.id, 40), name: clip(s.name, 120), url: clip(s.url, 500), size, x: Math.round(Number(s.x) || 0), y: Math.round(Number(s.y) || 0), heading: clip(s.heading, 120), ...(s.group ? { group: clip(s.group, 120), state: clip(s.state, 60), stateGroup: clip(s.stateGroup, 40) } : {}), hash: h, status: !prev ? "first" : !before ? "new" : before.hash === h ? "same" : "changed" });
  }
  let cur = {};
  try { cur = (await listRefs(root)).current || {}; } catch {}
  // The hosted app (a preview deploy) for clicking through it: http(s) only.
  const appUrl = /^https?:\/\/[^\s"<>]+$/i.test(String(body.appUrl || "").trim()) ? String(body.appUrl).trim().slice(0, 500) : null;
  const version = { id: `v${Date.now().toString(36)}`, ...(appUrl ? { appUrl } : {}), label: clip(body.label, 60).trim() || `Version ${index.versions.length + 1}`, note: clip(body.note, 500), at: Date.now(), commit: cur.sha || null, branch: cur.name || null, dirty: !!cur.dirty, screens: out };
  index.versions.push(version);
  await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return { version, changed: out.filter((s) => s.status === "changed").length, added: out.filter((s) => s.status === "new").length };
}

/** Everything the viewer needs: the versions, each distinct screen and stylesheet once, and the flow map. */
export async function handoffData(root, only = null) {
  const index = await readIndex(root);
  const versions = only ? index.versions.filter((v) => only.includes(v.id)) : index.versions;
  const dir = handoffDir(root);
  const screens = {}, styles = {};
  for (const v of versions) {
    for (const s of v.screens) {
      if (screens[s.hash] !== undefined) continue;
      const html = await fs.readFile(path.join(dir, "screens", `${s.hash}.html`), "utf8").catch(() => "");
      screens[s.hash] = html;
      for (const m of html.matchAll(/data-uit-style="([0-9a-f]+)"/g)) {
        if (styles[m[1]] === undefined) styles[m[1]] = await fs.readFile(path.join(dir, "styles", `${m[1]}.css`), "utf8").catch(() => "");
      }
    }
  }
  // Where comments live: the shared handoff's comments endpoint (on its Vercel project), once it's shared.
  const shared = index.shared && index.shared.comments ? index.shared.url + "/api/comments" : null;
  return { project: path.basename(root), versions, screens, styles, commentsApi: shared };
}

// ---------- export ----------
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", ico: "image/x-icon" };
// An asset of the app (an image, a font) as a data: URI, so the exported page needs no dev server.
async function dataUri(root, url, origin, cache) {
  if (cache.has(url)) return cache.get(url);
  let out = null;
  try {
    const u = new URL(url, origin);
    if (u.origin === origin) {
      const rel = decodeURIComponent(u.pathname);
      const type = MIME[(/\.([a-z0-9]+)$/i.exec(rel) || [])[1]?.toLowerCase()];
      if (type && !rel.includes("\0")) {
        for (const base of [path.join(root, "public"), root]) {
          const file = path.resolve(base, "." + rel);
          if (!file.startsWith(path.resolve(root) + path.sep)) continue;
          const bytes = await fs.readFile(file).catch(() => null);
          if (bytes && bytes.length <= 4_000_000) { out = `data:${type};base64,${bytes.toString("base64")}`; break; }
        }
      }
    }
  } catch {}
  cache.set(url, out);
  return out;
}
export async function inlineAssets(root, text, origin, cache = new Map()) {
  const rx = /(src=["']|poster=["'])([^"']+)(["'])|(url\((?:&quot;|["'])?)([^"')&]+)((?:&quot;|["'])?\))/g;
  const urls = new Set();
  for (const m of text.matchAll(rx)) { const u = m[2] || m[5]; if (u && !u.startsWith("data:")) urls.add(u); }
  const map = new Map();
  for (const u of urls) map.set(u, await dataUri(root, u.replace(/&amp;/g, "&"), origin, cache));
  return text.replace(rx, (all, a, u1, c, d, u2, f) => {
    const to = map.get(u1 || u2);
    if (!to) return all;
    return u1 ? a + to + c : d + to + f;
  });
}
const LIMIT = 15_500_000;
/** Writes .ui-tweaks/handoff/export-<id>.html: the viewer with the data inside. Returns its path. */
export async function exportHandoff(root, origin, versionId) {
  const index = await readIndex(root);
  const at = versionId ? index.versions.findIndex((v) => v.id === versionId) : index.versions.length - 1;
  if (at < 0) throw Object.assign(new Error("No such version"), { status: 404 });
  // Every version up to this one if it fits; else this one and the one before (for comparing).
  for (const ids of [index.versions.slice(0, at + 1).map((v) => v.id), index.versions.slice(Math.max(0, at - 1), at + 1).map((v) => v.id)]) {
    const data = await handoffData(root, ids);
    const cache = new Map();
    for (const k of Object.keys(data.screens)) data.screens[k] = (await inlineAssets(root, data.screens[k], origin, cache)).replace(/<base\b[^>]*>/i, "");
    for (const k of Object.keys(data.styles)) data.styles[k] = await inlineAssets(root, data.styles[k], origin, cache);
    data.start = index.versions[at].id;
    const page = handoffPage({ embedded: data });
    if (page.length > LIMIT && ids.length > 2) continue;
    if (page.length > LIMIT) throw Object.assign(new Error("The handoff is too big to share as one page (its images are large); open it from the dev server instead"), { status: 413 });
    const file = `.ui-tweaks/handoff/export-${index.versions[at].id}.html`;
    await fs.writeFile(path.join(root, file), page);
    return { file, title: `${data.project} · ${index.versions[at].label}`, bytes: page.length };
  }
}

// ---------- sharing on Vercel ----------
// The handoff page (with every version up to the chosen one) goes to a Vercel project of its own, named after
// the app (oneqr-handoff), with the Vercel CLI the person is logged in to. A production deploy, so its
// .vercel.app address opens for anyone with the link; each new share replaces it at the same address.
let deploying = null;
function run(cmd, args, cwd, ms = 240_000) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: "0" } });
    const finish = (code) => { if (!done) { done = true; resolve({ code, out }); } };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => { out += String(e && e.message); finish(-1); });
    child.on("close", finish);
    setTimeout(() => { child.kill("SIGTERM"); out += "\nTimed out"; finish(-1); }, ms);
  });
}
export async function deployHandoff(root, origin, versionId) {
  if (deploying) throw Object.assign(new Error("Already sharing a version; wait for it to finish"), { status: 409 });
  deploying = (async () => {
    const out = await exportHandoff(root, origin, versionId || null);
    const name = (path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app") + "-handoff";
    const site = path.join(handoffDir(root), name);
    await fs.mkdir(site, { recursive: true });
    await fs.copyFile(path.join(root, out.file), path.join(site, "index.html"));
    await fs.writeFile(path.join(site, "vercel.json"), JSON.stringify({ cleanUrls: true, headers: [{ source: "/(.*)", headers: [{ key: "X-Robots-Tag", value: "noindex" }] }] }, null, 2) + "\n");
    // Comments: a small endpoint beside the page, storing them in a Blob store of the project's own.
    await fs.mkdir(path.join(site, "api"), { recursive: true });
    await fs.copyFile(new URL("./handoff-api/comments.js", import.meta.url), path.join(site, "api", "comments.js"));
    await fs.writeFile(path.join(site, "package.json"), JSON.stringify({ name: name, private: true, type: "module", dependencies: { "@vercel/blob": "2.8.2" } }, null, 2) + "\n");
    // With several teams, the CLI won't pick one on its own: use the one it has selected (vercel switch).
    let res = await run("vercel", ["deploy", "--prod", "--yes"], site);
    if (res.code !== 0 && /multiple teams/i.test(res.out)) {
      const teams = await run("vercel", ["teams", "ls"], site, 60_000);
      const current = (/✔\s+(\S+)/.exec(teams.out) || [])[1];
      if (current) res = await run("vercel", ["deploy", "--prod", "--yes", "--scope", current], site);
    }
    if (res.code !== 0) {
      const why = /not found|ENOENT/i.test(res.out) ? "The Vercel CLI isn't installed (npm i -g vercel)" : /log ?in|credentials|token/i.test(res.out) ? "The Vercel CLI isn't logged in: run vercel login in a terminal" : res.out.trim().split("\n").slice(-3).join(" ");
      throw Object.assign(new Error(why), { status: 502 });
    }
    // The stable address (the alias), else the deployment's own.
    const urls = [...res.out.matchAll(/https:\/\/[a-z0-9.-]+\.vercel\.app/gi)].map((m) => m[0]);
    const alias = urls.find((u) => u.includes(`//${name}.`) || /Aliased/i.test(res.out.split(u)[0].split("\n").pop())) || urls[urls.length - 1];
    if (!alias) throw Object.assign(new Error("Vercel didn't say where it deployed"), { status: 502 });
    // The first share: give the project a Blob store for comments (connected to it, so the endpoint gets its
    // token), then deploy again so the page knows where comments live.
    let index = await readIndex(root);
    let comments = !!(index.shared && index.shared.comments && index.shared.project === name);
    if (!comments) {
      const envs = await run("vercel", ["env", "ls", "production"], site, 60_000);
      if (!/BLOB_READ_WRITE_TOKEN/.test(envs.out)) await run("vercel", ["blob", "create-store", `${name}-comments`, "--access", "public", "--yes"], site, 120_000);
      const again = await run("vercel", ["env", "ls", "production"], site, 60_000);
      comments = /BLOB_READ_WRITE_TOKEN/.test(again.out);
      if (comments) {
        index.shared = { ...(index.shared || {}), url: alias, project: name, comments: true };
        await fs.writeFile(path.join(handoffDir(root), "index.json"), JSON.stringify(index, null, 2) + "\n");
        const rebuilt = await exportHandoff(root, origin, versionId || null);
        await fs.copyFile(path.join(root, rebuilt.file), path.join(site, "index.html"));
        await run("vercel", ["deploy", "--prod", "--yes"], site);
      }
    }
    index = await readIndex(root);
    index.shared = { url: alias, version: versionId || (index.versions[index.versions.length - 1] || {}).id, at: Date.now(), project: name, comments };
    await fs.writeFile(path.join(handoffDir(root), "index.json"), JSON.stringify(index, null, 2) + "\n");
    return { url: alias, project: name, bytes: out.bytes, comments };
  })();
  try { return await deploying; } finally { deploying = null; }
}
