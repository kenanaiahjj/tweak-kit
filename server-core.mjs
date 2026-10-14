// Shared request handler for the UI Tweaks overlay.
// Serves the overlay script and stores batches of tweaks in <root>/.ui-tweaks/pending.json,
// which the Claude Code "ui-tweaks" mod watches.
import { promises as fs, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyDirect } from "./direct-apply.mjs";

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_PATH = path.join(KIT_DIR, "overlay.js");
const PREFIX = "/__ui-tweaks";

export function tweaksDir(root) {
  return path.join(root, ".ui-tweaks");
}

async function readPending(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(tweaksDir(root), "pending.json"), "utf8"));
    return Array.isArray(parsed.batches) ? parsed : { version: 1, batches: [] };
  } catch {
    return { version: 1, batches: [] };
  }
}

async function writePending(root, pending) {
  const dir = tweaksDir(root);
  await fs.mkdir(dir, { recursive: true });
  // Keep the folder out of git without touching the project's .gitignore.
  await fs.writeFile(path.join(dir, ".gitignore"), "*\n");
  const file = path.join(dir, "pending.json");
  if (pending.batches.length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.writeFile(file, JSON.stringify(pending, null, 2) + "\n");
}

// Undo history written by the Claude Code mod: history.json lists Haiku's applies,
// each apply's file copies sit in history/slot-N.json.
async function readHistory(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(tweaksDir(root), "history.json"), "utf8")).entries || [];
  } catch {
    return [];
  }
}

const SLOTS = 10;

/** Records an apply for undo, in the same format the Claude Code mod writes. */
export async function recordHistory(root, { by, count, files }) {
  if (!files.length) return null;
  const dir = tweaksDir(root);
  const entries = await readHistory(root);
  const lastSlot = Number((/(\d+)\.json$/.exec(entries.length ? entries[entries.length - 1].slot : "") || [])[1] ?? -1);
  const slot = `.ui-tweaks/history/slot-${(lastSlot + 1) % SLOTS}.json`;
  const at = Date.now();
  const id = `h${at.toString(36)}`;
  await fs.mkdir(path.join(dir, "history"), { recursive: true });
  await fs.writeFile(path.resolve(root, slot), JSON.stringify({ id, files }));
  const next = [...entries.filter((e) => e.slot !== slot), { id, at, by, count, slot, files: files.map((f) => f.path) }].slice(-SLOTS);
  await fs.writeFile(path.join(dir, "history.json"), JSON.stringify({ entries: next }, null, 2) + "\n");
  return id;
}

/** Appends outcomes to .ui-tweaks/log.json (newest last, last 300 kept). */
export async function appendLog(root, items) {
  if (!items.length) return;
  const file = path.join(tweaksDir(root), "log.json");
  let log = [];
  try {
    log = JSON.parse(await fs.readFile(file, "utf8")).entries || [];
  } catch {}
  await fs.writeFile(file, JSON.stringify({ entries: [...log, ...items].slice(-300) }, null, 2) + "\n");
}

/** Restores the files of the newest apply, unless one changed since; same rules as the mod's undo. */
async function undoLastApply(root) {
  const entries = await readHistory(root);
  const last = entries[entries.length - 1];
  if (!last) return { status: 404, body: { error: "There is no apply to undo." } };
  const saved = JSON.parse(await fs.readFile(path.resolve(root, last.slot), "utf8"));
  if (saved.id !== last.id) return { status: 409, body: { error: "The undo history is out of date." } };
  const changed = [];
  for (const f of saved.files) {
    const now = await fs.readFile(path.resolve(root, f.path), "utf8").catch(() => null);
    if (now !== f.after) changed.push(path.basename(f.path));
  }
  if (changed.length) return { status: 409, body: { error: `${changed.join(", ")} changed after the apply.`, changed } };
  for (const f of saved.files) await fs.writeFile(path.resolve(root, f.path), f.before);
  await fs.writeFile(path.join(tweaksDir(root), "history.json"), JSON.stringify({ entries: entries.slice(0, -1) }, null, 2) + "\n");
  return { status: 200, body: { ok: true, files: saved.files.map((f) => path.basename(f.path)) } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  // The overlay may be served by a sidecar on another port (Next.js and other dev servers).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * Docked mode: the app in a frame on the left, the overlay's own panel docked on the right.
 * The overlay inside the frame finds #ui-tweaks-root here and moves its panel into it.
 */
export function studioPage(appPath) {
  const safe = typeof appPath === "string" && appPath.startsWith("/") && !appPath.startsWith("//") ? appPath : "/";
  const src = JSON.stringify(safe).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-ui-tweaks-studio>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>UI Tweaks</title>
<style>
  :root { --bg: #141414; --bar: #1e1e1e; --line: #2c2c2c; --text: #e6e6e6; --dim: #9a9a9a; --accent: #0d99ff; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 12px/1.4 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .studio { display: flex; height: 100vh; }
  .stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .toolbar { height: 40px; flex: none; display: flex; align-items: center; gap: 2px; padding: 0 6px; background: var(--bar); border-bottom: 1px solid var(--line); min-width: 0; }
  .toolbar button { height: 26px; padding: 0 7px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text); font: inherit; cursor: pointer; flex: none; }
  .toolbar button:hover { background: #2c2c2c; }
  .toolbar button.on { background: var(--accent); color: #fff; }
  .toolbar .sep { width: 1px; height: 16px; background: var(--line); margin: 0 4px; flex: none; }
  .toolbar .size { color: var(--dim); margin: 0 6px; font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
  .toolbar .path { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
  .canvas { flex: 1; min-height: 0; overflow: hidden; display: flex; justify-content: center; align-items: flex-start; background: var(--bg); background-image: radial-gradient(#ffffff0d 1px, transparent 1px); background-size: 16px 16px; }
  .device { padding: 12px; }
  .wrap { flex: none; width: 100%; height: 100%; overflow: hidden; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; transform-origin: top left; }
  .device .wrap { box-shadow: 0 0 0 1px var(--line), 0 12px 40px rgba(0,0,0,.45); border-radius: 4px; }
  #ui-tweaks-root { width: 280px; flex: none; background: #1e1e1e; border-left: 1px solid var(--line); overflow: hidden; }
  .waiting { padding: 24px 18px; color: var(--dim); line-height: 1.5; text-align: center; }
  @media (max-width: 720px) { #ui-tweaks-root { width: 264px; } .toolbar .path { display: none; } }
</style>
</head>
<body>
<div class="studio">
  <div class="stage">
    <div class="toolbar">
      <button class="exit" title="Leave docked mode">✕</button>
      <button class="reload" title="Reload the app">↻</button>
      <span class="sep"></span>
      <button data-width="" title="Fill the space">Fit</button>
      <button data-width="390" title="Phone, 390px">390</button>
      <button data-width="768" title="Tablet, 768px">768</button>
      <button data-width="1280" title="Laptop, 1280px">1280</button>
      <span class="size"></span>
      <span class="path"></span>
    </div>
    <div class="canvas"><div class="wrap"><iframe id="ui-tweaks-frame" title="Your app"></iframe></div></div>
  </div>
  <div id="ui-tweaks-root"><div class="waiting">Loading your app…<br />The panel docks here once it's up.</div></div>
</div>
<script>
  const frame = document.getElementById("ui-tweaks-frame");
  const canvas = document.querySelector(".canvas");
  const size = document.querySelector(".size");
  const pathLabel = document.querySelector(".path");
  frame.src = ${src};
  const wrap = document.querySelector(".wrap");
  const KEY = "ui-tweaks:studio-width";
  let width = "";
  // A device width wider than the space is laid out at its real width, then scaled to fit.
  function layout() {
    const w = Number(width) || 0;
    canvas.classList.toggle("device", !!w);
    if (!w) {
      Object.assign(wrap.style, { width: "100%", height: "100%" });
      Object.assign(frame.style, { width: "100%", height: "100%", transform: "" });
      size.textContent = Math.round(canvas.clientWidth) + "px";
      return;
    }
    const availW = canvas.clientWidth - 24, availH = canvas.clientHeight - 24;
    const scale = Math.min(1, availW / w);
    Object.assign(frame.style, { width: w + "px", height: availH / scale + "px", transform: scale < 1 ? "scale(" + scale + ")" : "" });
    Object.assign(wrap.style, { width: w * scale + "px", height: availH + "px" });
    size.textContent = w + "px" + (scale < 1 ? " · " + Math.round(scale * 100) + "%" : "");
  }
  function setWidth(w) {
    width = w || "";
    for (const b of document.querySelectorAll("[data-width]")) b.classList.toggle("on", b.dataset.width === width);
    try { localStorage.setItem(KEY, width); } catch {}
    layout();
  }
  let saved = "";
  try { saved = localStorage.getItem(KEY) || ""; } catch {}
  setWidth(saved);
  for (const b of document.querySelectorAll("[data-width]")) b.addEventListener("click", () => setWidth(b.dataset.width));
  new ResizeObserver(layout).observe(canvas);
  const appUrl = () => { try { return frame.contentWindow.location; } catch { return null; } };
  frame.addEventListener("load", () => {
    const loc = appUrl();
    if (!loc) return;
    const path = loc.pathname + loc.search + loc.hash;
    pathLabel.textContent = path;
    history.replaceState(null, "", "?path=" + encodeURIComponent(path));
    try { frame.contentDocument.title && (document.title = "UI Tweaks · " + frame.contentDocument.title); } catch {}
  });
  document.querySelector(".reload").addEventListener("click", () => frame.contentWindow.location.reload());
  document.querySelector(".exit").addEventListener("click", () => {
    const loc = appUrl();
    location.href = loc ? loc.href : ${src};
  });
</script>
</body>
</html>`;
}

/**
 * Tells the Claude Code mod where this dev server is: <root>/.ui-tweaks/server.json, and a registry
 * entry in ~/.ui-tweaks/servers/ for sessions started in another folder. The entry goes when we exit
 * cleanly; the mod checks a server answers before using it, so a stale entry is harmless.
 */
export async function announceServer(root, url) {
  const dir = tweaksDir(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".gitignore"), "*\n");
  const entry = JSON.stringify({ url, root, pid: process.pid, at: Date.now() }) + "\n";
  await fs.writeFile(path.join(dir, "server.json"), entry);
  const registry = path.join(os.homedir(), ".ui-tweaks", "servers");
  const file = path.join(registry, createHash("sha1").update(root).digest("hex").slice(0, 12) + ".json");
  await fs.mkdir(registry, { recursive: true });
  await fs.writeFile(file, entry);
  process.once("exit", () => {
    try {
      unlinkSync(file);
    } catch {}
  });
}

/**
 * Connect-style middleware. `getVersion` (optional) returns a number that changes when
 * the served files change; the overlay reloads the page when it does (static mode only).
 */
export function createTweaksHandler({ root, getVersion }) {
  return async function handle(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) return next();
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (req.method === "GET" && url.pathname === `${PREFIX}/studio`) {
        return send(res, 200, studioPage(url.searchParams.get("path") || "/"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/overlay.js`) {
        return send(res, 200, await fs.readFile(OVERLAY_PATH, "utf8"), "text/javascript");
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/status`) {
        const pending = await readPending(root);
        const last = (await readHistory(root)).slice(-1)[0];
        return send(res, 200, {
          lastApply: last ? { id: last.id, by: last.by, count: last.count, files: last.files.map((f) => path.basename(f)) } : null,
          pendingIds: pending.batches.map((b) => b.id),
          // Per tweak, so the overlay can drop previews one at a time and show Haiku's skip reasons.
          pendingTweaks: pending.batches.flatMap((b) => (b.tweaks || []).map((t, i) => ({ id: t.id || `${b.id}-${i}`, skipped: t.skipped }))),
          version: getVersion ? getVersion() : null,
        });
      }
      if (req.method === "POST" && url.pathname === `${PREFIX}/undo`) {
        const { status, body } = await undoLastApply(root);
        return send(res, status, body);
      }
      if (req.method === "POST" && url.pathname === PREFIX) {
        const batch = JSON.parse(await readBody(req));
        if (!batch || !Array.isArray(batch.tweaks) || batch.tweaks.length === 0) {
          return send(res, 400, { error: "batch.tweaks must be a non-empty array" });
        }
        batch.id = `t${Date.now().toString(36)}`;
        batch.createdAt = new Date().toISOString();
        batch.tweaks.forEach((t, i) => (t.id = `${batch.id}-${i}`));
        // Simple tweaks go straight into the source; the rest wait for Haiku.
        const direct = await applyDirect(root, batch);
        for (const f of direct.files) await fs.writeFile(f.path, f.after);
        await fs.mkdir(tweaksDir(root), { recursive: true });
        await fs.writeFile(path.join(tweaksDir(root), ".gitignore"), "*\n");
        await recordHistory(root, { by: "direct", count: direct.applied.length, files: direct.files });
        const label = (t) => (t.element && (t.element.classes[0] ? "." + t.element.classes[0] : t.element.tag)) || "?";
        const byId = new Map(batch.tweaks.map((t) => [t.id, t]));
        await appendLog(root, [
          ...direct.applied.map((a) => ({ at: batch.createdAt, id: a.id, element: label(byId.get(a.id)), by: "direct", outcome: "applied", props: [...a.props, ...(a.text ? ["text"] : [])], files: a.files })),
          ...direct.remaining.map((t) => ({ at: batch.createdAt, id: t.id, element: label(t), by: "direct", outcome: "sent to Haiku", props: Object.keys(t.changes || {}), reason: t.directSkip })),
        ]);
        if (direct.remaining.length) {
          const pending = await readPending(root);
          pending.batches.push({ ...batch, tweaks: direct.remaining });
          await writePending(root, pending);
        }
        return send(res, 200, { ok: true, id: batch.id, direct: direct.applied.map((a) => a.id), queued: direct.remaining.map((t) => t.id) });
      }
      if (req.method === "DELETE" && url.pathname.startsWith(`${PREFIX}/`)) {
        const id = url.pathname.slice(PREFIX.length + 1);
        const pending = await readPending(root);
        pending.batches = pending.batches.filter((b) => b.id !== id);
        await writePending(root, pending);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "unknown ui-tweaks route" });
    } catch (error) {
      return send(res, 500, { error: String(error && error.message ? error.message : error) });
    }
  };
}

export function overlayScriptTag(root, { liveReload = false } = {}) {
  const attrs = [`src="${PREFIX}/overlay.js"`, `data-root="${root.replace(/"/g, "&quot;")}"`, "defer"];
  if (liveReload) attrs.push('data-live-reload="true"');
  return `<script ${attrs.join(" ")}></script>`;
}
