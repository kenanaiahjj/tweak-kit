// Shared request handler for the UI Tweaks overlay.
// Serves the overlay script and stores batches of tweaks in <root>/.ui-tweaks/pending.json,
// which the Claude Code "ui-tweaks" mod watches.
import { updateStatus } from "./update.mjs";
import { adoptToken, createToken, scanTokens, setToken } from "./tokens.mjs";
import { systemPage } from "./system-page.mjs";
import { addAsk, askStatus, cancelAsk } from "./asks.mjs";
import { jsxAt, toTailwind } from "./code.mjs";
import { findRoutes as findAppRoutes } from "./routes.mjs";
import { listRefs, startVersion, stopVersion, versionStatus } from "./versions.mjs";
import { promises as fs, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyDirect, sourceFiles } from "./direct-apply.mjs";
import { unifiedDiff } from "./diff.mjs";
import { scanBreakpoints, scopeFor } from "./breakpoints.mjs";
import { commitFiles, filesAreClean } from "./git.mjs";

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_PATH = path.join(KIT_DIR, "overlay.js");
const PREFIX = "/__ui-tweaks";

export function tweaksDir(root) {
  return path.join(root, ".ui-tweaks");
}

// .ui-tweaks/ stays out of git, except the canvas layout, which is part of the project.
const GITIGNORE = "*\n!.gitignore\n!canvas.json\n";

// ---------- the canvas ----------
// .ui-tweaks/canvas.json: the studio's artboards (a screen + state + device each), notes and arrows.
// The studio writes it as you arrange things; Claude can write it too, and the studio picks that up.
const DEFAULT_CANVAS = { version: 1, artboards: [{ id: "a1", name: "Home", device: "i16", url: "/", x: 0, y: 0 }], notes: [], arrows: [] };

export async function readCanvas(root) {
  const file = path.join(tweaksDir(root), "canvas.json");
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    const canvas = JSON.parse(text);
    if (!Array.isArray(canvas.artboards)) throw new Error("no artboards");
    return { canvas: { notes: [], arrows: [], ...canvas }, version: stat.mtimeMs };
  } catch {
    return { canvas: DEFAULT_CANVAS, version: 0 };
  }
}

export async function writeCanvas(root, canvas) {
  if (!canvas || !Array.isArray(canvas.artboards)) throw new Error("canvas.artboards must be an array");
  const dir = tweaksDir(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".gitignore"), GITIGNORE);
  const file = path.join(dir, "canvas.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, ...canvas }, null, 2) + "\n");
  return (await fs.stat(file)).mtimeMs;
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
  await fs.writeFile(path.join(dir, ".gitignore"), GITIGNORE);
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
 * The studio: an infinite canvas of artboards (each a live frame of the app at one screen, state and
 * device, kept in .ui-tweaks/canvas.json) with the overlay's own panel docked on the right.
 * The overlay in the first artboard docks its panel here; clicking in any artboard moves it there.
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
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 12px/1.4 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
  button, select, input { font: inherit; color: var(--text); }
  .studio { display: flex; height: 100vh; }
  .stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .toolbar { height: 40px; flex: none; display: flex; align-items: center; gap: 2px; padding: 0 6px; background: var(--bar); border-bottom: 1px solid var(--line); min-width: 0; overflow: hidden; }
  .toolbar button { height: 26px; padding: 0 7px; border: 1px solid transparent; border-radius: 5px; background: transparent; cursor: pointer; flex: none; white-space: nowrap; }
  .toolbar button:hover, .toolbar a.tb:hover { background: #2c2c2c; }
  .toolbar a.tb { height: 26px; padding: 0 7px; border-radius: 5px; display: inline-flex; align-items: center; flex: none; white-space: nowrap; text-decoration: none; color: var(--text); }
  .toolbar button.on { background: var(--accent); color: #fff; }
  .toolbar select { height: 26px; min-width: 0; max-width: 170px; padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; background: #2c2c2c; cursor: pointer; flex: 0 1 auto; }
  .sep { width: 1px; height: 16px; background: var(--line); margin: 0 4px; flex: none; }
  .zoom { min-width: 44px; text-align: center; color: var(--dim); font-variant-numeric: tabular-nums; }
  .modes { display: flex; gap: 2px; background: #2c2c2c; border-radius: 6px; padding: 2px; flex: none; }
  .modes button { height: 22px; }
  .canvas-tools, .focus-tools { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .canvas-tools[hidden], .focus-tools[hidden] { display: none; }
  .focus-name { font-weight: 600; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; }
  .viewport.focus .dots, .viewport.focus .minimap { display: none; }
  .viewport.focus .ab-head { display: none; }
  .ab.hidden { display: none; }
  .note { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); background: #2c2c2c; border: 1px solid var(--line); padding: 7px 12px; border-radius: 7px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 10; }
  .note.show { opacity: 1; }
  .body { flex: 1; min-height: 0; display: flex; }
  .width-slider { width: 120px; accent-color: var(--accent); flex: none; }
  .overview-pop { position: fixed; top: 44px; left: 12px; right: 300px; max-height: 72vh; overflow: auto; z-index: 20; background: var(--bar); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 16px 48px rgba(0,0,0,.5); padding: 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .overview-pop[hidden] { display: none; }
  .ov-card { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; cursor: pointer; background: #1b1b1b; text-align: left; padding: 0; color: var(--text); }
  .ov-card:hover, .ov-card.on { border-color: var(--accent); }
  .ov-card .ov-shot { height: 190px; background: #111; display: grid; place-items: center; overflow: hidden; color: #555; font-size: 11px; }
  .ov-card .ov-shot img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .ov-card .ov-meta { padding: 6px 8px; font-size: 11px; }
  .ov-card .ov-meta span { display: block; color: var(--dim); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pages { width: 200px; flex: none; border-right: 1px solid var(--line); background: var(--bar); overflow-y: auto; padding: 8px 0; }
  .pages h4 { margin: 10px 12px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); font-weight: 600; }
  .pages button { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 12px; border: 0; background: transparent; text-align: left; cursor: pointer; }
  .pages button:hover { background: #2c2c2c; }
  .pages button i { width: 6px; height: 6px; border-radius: 3px; background: #7b61ff; flex: none; }
  .pages .src { color: var(--dim); font-size: 10px; margin-left: auto; }
  .pages .src + .src { margin-left: 6px; }
  .pages button[data-params] span:first-of-type { color: var(--dim); }
  .pages-actions { display: grid; gap: 6px; padding: 4px 12px 8px; }
  .pages-actions button { justify-content: center; height: 30px; border-radius: 8px; background: rgba(255,255,255,.06); font-size: 12px; font-weight: 500; }
  .pages-actions button:hover { background: rgba(255,255,255,.1); }
  .pages-actions button:disabled { opacity: .45; cursor: default; }
  .pages .pages-empty { padding: 4px 12px; color: var(--dim); }
  .viewport { position: relative; flex: 1; min-width: 0; overflow: hidden; background: var(--bg); cursor: default; }
  .viewport.panning, .viewport.hand { cursor: grab; }
  .viewport.panning { cursor: grabbing; }
  .dots { position: absolute; inset: 0; pointer-events: none; background-image: radial-gradient(#ffffff12 1px, transparent 1px); }
  .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .shield { position: absolute; inset: 0; z-index: 5; display: none; }
  .viewport.hand .shield, .viewport.panning .shield { display: block; }
  .ab { position: absolute; }
  .ab-head { position: absolute; left: 0; bottom: 100%; display: flex; align-items: center; gap: 4px; height: calc(30px * var(--iz)); font-size: calc(12px * var(--iz)); white-space: nowrap; color: var(--dim); cursor: grab; user-select: none; max-width: 100%; padding-bottom: calc(4px * var(--iz)); }
  .ab.selected .ab-head { color: var(--accent); }
  .ab-head .name { color: var(--text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; flex: 0 0 auto; max-width: 75%; }
  .ab.selected .ab-head .name { color: var(--accent); }
  .ab-head .url { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
  .ab-head > span:nth-child(3) { flex: none; }
  .ab-head { overflow: hidden; }
  .ab-head .tools { display: none; gap: 2px; margin-left: 4px; flex: 0 1 auto; min-width: 0; }
  .ab:hover .ab-head .tools, .ab.selected .ab-head .tools { display: flex; }
  /* With the tools showing, the URL and size step aside so nothing spills onto the next artboard. */
  .ab:hover .ab-head .url, .ab.selected .ab-head .url, .ab:hover .ab-head > span:nth-child(3), .ab.selected .ab-head > span:nth-child(3) { display: none; }
  .ab-head button, .ab-head select { height: 1.9em; padding: 0 .45em; border: 1px solid var(--line); border-radius: .4em; background: #2c2c2c; cursor: pointer; font-size: 1em; }
  .ab-head select { max-width: 13em; }
  .ab-head input { font-size: 1em; height: 1.8em; background: #2c2c2c; border: 1px solid var(--accent); border-radius: .3em; padding: 0 .4em; color: var(--text); }
  .ab-frame { position: relative; overflow: hidden; border-radius: 10px; background: #fff; box-shadow: 0 0 0 1px var(--line), 0 12px 40px rgba(0,0,0,.45); }
  .ab.selected .ab-frame { box-shadow: 0 0 0 calc(2px * var(--iz)) var(--accent), 0 12px 40px rgba(0,0,0,.45); }
  .ab-frame iframe { display: block; width: 100%; height: 100%; border: 0; }
  .ab-layer { position: absolute; inset: 0; pointer-events: none; }
  .fold { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; transform: translateX(-50%); background: linear-gradient(90deg, transparent, rgba(0,0,0,.18), transparent); box-shadow: 0 0 12px rgba(0,0,0,.25); }
  .grid-cols { position: absolute; inset: 0; display: flex; }
  .grid-cols div { flex: 1; background: rgba(242, 72, 34, .1); }
  .baseline { position: absolute; inset: 0; background-image: repeating-linear-gradient(to bottom, rgba(13, 153, 255, .22) 0 1px, transparent 1px 8px); }
  .minimap { position: absolute; right: 12px; bottom: 12px; width: 180px; height: 120px; background: rgba(30,30,30,.92); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; z-index: 6; cursor: pointer; }
  .minimap div { position: absolute; }
  .minimap .mini-ab { background: #3a3a3a; border-radius: 1px; }
  .minimap .mini-ab.selected { background: var(--accent); }
  .minimap .mini-view { border: 1px solid var(--accent); background: rgba(13,153,255,.08); }
  #ui-tweaks-root { width: 336px; flex: none; background: #212121; border-left: 1px solid var(--line); overflow: hidden; }
  /* Another version side by side: a second frame to the right, each with its label above. */
  .vs-label { display: none; position: absolute; left: 0; right: 0; bottom: 100%; padding-bottom: calc(8px * var(--iz)); font-size: calc(13px * var(--iz)); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dim); }
  .vs-label b { color: var(--text); font-weight: 600; }
  .viewport.versus .vs-label { display: block; }
  .vs-ab .ab-frame { background: #fff; }
  .vs-wait { position: absolute; inset: 0; display: grid; place-items: center; background: #1b1b1b; color: var(--dim); font-size: calc(14px * var(--iz)); text-align: center; padding: 24px; white-space: pre-wrap; }
  .vs-wait[hidden] { display: none; }
  .vs-pop { position: fixed; top: 44px; right: 348px; width: 340px; max-height: 70vh; display: flex; flex-direction: column; z-index: 20; background: var(--bar); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 16px 48px rgba(0,0,0,.5); overflow: hidden; }
  .vs-pop[hidden] { display: none; }
  .vs-pop .vs-now { padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--dim); }
  .vs-pop .vs-now b { color: var(--text); }
  .vs-pop .vs-now button { margin-top: 8px; width: 100%; height: 28px; border-radius: 7px; border: 0; background: rgba(255,255,255,.08); cursor: pointer; }
  .vs-pop input { margin: 8px 12px; height: 28px; border-radius: 7px; border: 1px solid var(--line); background: #1b1b1b; color: var(--text); padding: 0 8px; }
  .vs-pop .vs-list { overflow-y: auto; padding-bottom: 6px; }
  .vs-pop h4 { margin: 8px 12px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); font-weight: 600; }
  .vs-pop .vs-ref { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 6px 12px; cursor: pointer; }
  .vs-pop .vs-ref:hover, .vs-pop .vs-ref.on { background: #2c2c2c; }
  .vs-pop .vs-ref span { display: block; color: var(--dim); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vs-pop .vs-err { padding: 10px 12px; color: #ff8a80; white-space: pre-wrap; font-size: 11px; }
  .vs-toggle.on { color: var(--accent); }
  .guides-pop { position: fixed; z-index: 20; width: 260px; padding: 10px; background: #212121; border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.5); }
  .guides-pop[hidden] { display: none; }
  .guides-pop h4 { margin: 2px 2px 6px; font-size: 13px; font-weight: 600; color: var(--label); }
  .guides-pop h4 + .gd-row { margin-bottom: 10px; }
  .gd-row { display: flex; gap: 0; padding: 2px; border-radius: 8px; background: rgba(255,255,255,.05); }
  .gd-opt { flex: 1; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--label); font: 500 12px system-ui, -apple-system, sans-serif; cursor: pointer; transition: background .15s, color .15s; }
  .gd-opt:hover { color: var(--text); }
  .gd-opt.on { background: rgba(255,255,255,.14); color: #fff; }
  .gd-hint { margin: 2px 2px 0; color: var(--dim); font-size: 11.5px; line-height: 1.45; }
  .toolbar .guides-toggle.on { background: rgba(13,153,255,.16); color: #6cb8ff; }
  .vs-modes { display: inline-flex; gap: 0; padding: 2px; border-radius: 8px; background: rgba(255,255,255,.05); flex: none; }
  .vs-modes[hidden], .vs-mirror[hidden] { display: none; }
  .toolbar .vs-modes button { height: 26px; padding: 0 10px; border-radius: 6px; }
  .toolbar .vs-modes button.on { background: rgba(255,255,255,.12); color: #fff; }
  .waiting { padding: 24px 18px; color: var(--dim); line-height: 1.5; text-align: center; }
  @media (max-width: 720px) { #ui-tweaks-root { width: 300px; } .minimap { display: none; } }
  /* ---------- DialKit skin ----------
     The studio's chrome in the panel's language (after DialKit): #212121 surfaces, quiet 5% white fills,
     8px corners, 13px medium labels at 70% white, monospace values, semibold sentence-case titles,
     a soft pill for what's on, and one white primary action. Later rules override the ones above. */
  :root {
    --bg: #171717; --bar: #212121; --line: rgba(255,255,255,.08); --text: rgba(255,255,255,.95); --dim: rgba(255,255,255,.5);
    --label: rgba(255,255,255,.7); --fill: rgba(255,255,255,.05); --hover: rgba(255,255,255,.1); --active: rgba(255,255,255,.12);
    --radius: 8px; --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  html, body { font: 500 12.5px/1.4 system-ui, -apple-system, "SF Pro Display", "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .toolbar { height: auto; min-height: 48px; flex-wrap: wrap; align-content: center; gap: 6px 0; padding: 8px 10px; overflow: visible; background: var(--bar); border-bottom: 1px solid var(--line); }
  .tb-group { display: flex; align-items: center; gap: 2px; flex: none; max-width: 100%; }
  .tb-group:first-child { flex: 0 1 auto; min-width: 0; }
  .tb-group .focus-pick { min-width: 72px; flex: 0 1 auto; }
  .tb-group .focus-tools { min-width: 0; }
  .tb-group + .tb-group { margin-left: 10px; } /* spacing, not divider lines: a wrapped row would start with one */
  .tb-group.tb-end { margin-left: auto; }
  .tb-group[hidden] { display: none; }
  .focus-tools { min-width: auto; }
  .toolbar button, .toolbar a.tb { height: 30px; padding: 0 9px; border: 0; border-radius: var(--radius); color: var(--label); font-weight: 500; transition: background .15s, color .15s; }
  .toolbar button:hover, .toolbar a.tb:hover { background: var(--hover); color: var(--text); }
  .toolbar button.on, .vs-toggle.on { background: var(--active); color: #fff; }
  .toolbar select { height: 30px; border: 0; border-radius: var(--radius); background: var(--fill); color: var(--label); padding: 0 8px; transition: background .15s; }
  .toolbar select:hover { background: var(--hover); color: var(--text); }
  .sep { height: 18px; background: var(--line); margin: 0 4px; }
  .zoom, .focus-zoom { font-family: var(--mono); font-size: 11.5px; color: var(--dim); padding: 0 4px; white-space: nowrap; flex: none; }
  /* Width slider, DialKit style: a slim track filled up to the thumb, breakpoints as ticks on the track. */
  .ws { position: relative; display: flex; align-items: center; width: 140px; height: 30px; margin: 0 6px; flex: none; }
  .ws .width-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 20px; margin: 0; background: transparent; cursor: pointer; accent-color: #fff; }
  .ws .width-slider:focus { outline: none; }
  .ws .width-slider::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(rgba(255,255,255,.7), rgba(255,255,255,.7)) 0 / var(--p, 50%) 100% no-repeat, rgba(255,255,255,.12); }
  .ws .width-slider::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255,255,255,.12); }
  .ws .width-slider::-moz-range-progress { height: 4px; border-radius: 2px; background: rgba(255,255,255,.7); }
  .ws .width-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4px; border-radius: 50%; background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0,0,0,.5); transition: transform .12s; }
  .ws .width-slider::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0,0,0,.5); }
  .ws .width-slider:hover::-webkit-slider-thumb, .ws .width-slider:active::-webkit-slider-thumb { transform: scale(1.15); }
  .ws-ticks { position: absolute; left: 6px; right: 6px; top: 50%; height: 0; pointer-events: none; }
  .ws-ticks i { position: absolute; top: -4px; width: 2px; height: 8px; margin-left: -1px; border-radius: 1px; background: rgba(255,255,255,.35); }
  .ab-frame { border-radius: 12px; box-shadow: 0 0 0 1px var(--line), 0 16px 48px rgba(0,0,0,.5); }
  .ab.selected .ab-frame { box-shadow: 0 0 0 1px var(--line), 0 16px 48px rgba(0,0,0,.5); }
  /* Comparing: a badge per screen saying which version it is, in that side's colour (yours blue,
     the other amber), with its role and commit; the frame gets a matching outline. */
  .vs-label { --vs: #6cb8ff; --vs-bg: rgba(13,153,255,.16); display: none; align-items: center; gap: calc(8px * var(--iz)); padding-bottom: calc(12px * var(--iz)); font: 500 calc(12px * var(--iz))/1.3 var(--mono); color: var(--dim); }
  .vs-ab .vs-label { --vs: #ffc46b; --vs-bg: rgba(255,196,107,.16); }
  .viewport.versus .vs-label { display: flex; }
  .vs-label .vs-branch { display: inline-flex; align-items: center; gap: .5em; flex: none; max-width: 60%; padding: .35em .8em; border-radius: 999px; background: var(--vs-bg); color: var(--vs); font: 600 calc(15px * var(--iz))/1.2 system-ui, -apple-system, sans-serif; letter-spacing: -.01em; }
  .vs-label .vs-branch span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vs-label .vs-branch::before { content: ""; width: .55em; height: .55em; border-radius: 50%; background: var(--vs); flex: none; }
  .vs-label .vs-role { flex: none; padding: .25em .6em; border-radius: 6px; background: rgba(255,255,255,.06); color: var(--label); font: 500 calc(11.5px * var(--iz))/1.2 system-ui, -apple-system, sans-serif; }
  .vs-label .vs-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .viewport.versus .ab .ab-frame { box-shadow: 0 0 0 calc(2px * var(--iz)) rgba(13,153,255,.55), 0 16px 48px rgba(0,0,0,.5); }
  .viewport.versus .vs-ab .ab-frame { box-shadow: 0 0 0 calc(2px * var(--iz)) rgba(255,196,107,.55), 0 16px 48px rgba(0,0,0,.5); }
  .note { background: #2a2a2a; border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.4); font-size: 13px; padding: 9px 14px; }

  /* Routes sidebar */
  .pages { width: 240px; padding: 12px; background: var(--bar); border-right: 1px solid var(--line); scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.12) transparent; }
  .pages-actions { display: grid; gap: 6px; padding: 0 0 12px; border-bottom: 1px solid var(--line); }
  .pages-actions button { height: 32px; border-radius: var(--radius); background: var(--fill); color: var(--label); font-size: 12.5px; font-weight: 500; justify-content: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background .15s, color .15s; }
  .pages-actions button:hover { background: var(--hover); color: var(--text); }
  .pages-actions button.primary { background: #fff; color: #212121; font-weight: 600; }
  .pages-actions button.primary:hover { background: color-mix(in srgb, #fff 88%, #212121); color: #212121; }
  .pages-actions button:disabled, .pages-actions button.primary:disabled { background: var(--fill); color: var(--dim); opacity: 1; }
  .pages h4 { display: flex; align-items: baseline; gap: 6px; margin: 14px 0 8px; font-size: 13px; font-weight: 600; color: var(--label); text-transform: none; letter-spacing: -.01em; }
  .pages h4 span { font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--dim); }
  .pages .pg-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .pages button.pg-route { height: 32px; padding: 0 10px; border-radius: var(--radius); background: var(--fill); color: var(--label); gap: 8px; transition: background .15s, color .15s; }
  .pages button.pg-route:hover { background: var(--hover); color: var(--text); }
  .pages button.pg-route .path { font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .pages button.pg-route[data-params] .path { color: var(--dim); }
  .pages button.pg-route .src { margin-left: auto; flex: none; font-size: 11px; color: var(--dim); }
  .pages button.pg-route .src + .src { margin-left: 0; }
  .pages button.pg-route.have { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
  .pages button.pg-route .tick { color: #8ee6a8; font-size: 11px; }
  .pages button.pg-route i { width: 6px; height: 6px; border-radius: 3px; background: #a78bfa; flex: none; }
  .pages .pages-empty { padding: 4px 2px; color: var(--dim); font-size: 12px; line-height: 1.5; }
  .pages button.pg-screen .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 12.5px; }
  .pages button.pg-screen .src { font-family: var(--mono); max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pages button.pg-screen.on { background: var(--active); color: #fff; }
  .pages .pg-last { font-size: 11.5px; line-height: 1.45; color: var(--dim); padding: 2px 2px 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .pages .pg-last.err { color: #ef9a9a; }

  /* Popovers */
  .overview-pop, .vs-pop { background: #212121; border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.5); }
  .ov-card { border: 0; border-radius: 10px; background: var(--fill); }
  .ov-card:hover, .ov-card.on { border: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,.25); }
  .ov-card .ov-meta { font-size: 12.5px; color: var(--text); padding: 8px 10px; }
  .ov-card .ov-meta span { font-family: var(--mono); font-size: 11px; }
  .vs-pop { width: min(340px, calc(100vw - 24px)); padding: 6px; }
  .vs-pop .vs-now { padding: 10px; border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--label); line-height: 1.5; }
  .vs-pop .vs-now b { color: #fff; font-weight: 600; }
  .vs-pop .vs-now button { margin-top: 10px; height: 32px; border-radius: var(--radius); background: var(--fill); color: var(--label); font-weight: 500; transition: background .15s, color .15s; }
  .vs-pop .vs-now button:hover { background: var(--hover); color: var(--text); }
  .vs-pop input { margin: 8px 4px; height: 32px; border: 0; border-radius: var(--radius); background: var(--fill); color: var(--text); padding: 0 10px; font-size: 12.5px; outline: none; }
  .vs-pop input:focus { background: var(--active); box-shadow: inset 0 0 0 1px rgba(255,255,255,.15); }
  .vs-pop input::placeholder { color: rgba(255,255,255,.35); }
  .vs-pop .vs-list { padding: 0 4px 4px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; overflow-x: hidden; }
  .vs-pop h4 { margin: 10px 6px 6px; font-size: 13px; font-weight: 600; color: var(--label); text-transform: none; letter-spacing: -.01em; }
  .vs-pop .vs-ref { padding: 7px 10px; border-radius: var(--radius); color: var(--text); font-size: 12.5px; font-weight: 500; transition: background .15s; }
  .vs-pop .vs-ref:hover { background: var(--hover); }
  .vs-pop .vs-ref.on { background: var(--active); }
  .vs-pop .vs-ref span { margin-top: 2px; font-family: var(--mono); font-size: 11px; font-weight: 400; color: var(--dim); }
  .vs-pop .vs-err { margin: 6px 4px; padding: 10px; border-radius: var(--radius); background: rgba(239,119,119,.1); color: #ef9a9a; font-family: var(--mono); font-size: 11px; }
  .vs-wait { background: #1c1c1c; color: var(--dim); font-size: calc(14px * var(--iz)); }
  #ui-tweaks-root { background: #212121; border-left: 1px solid var(--line); }
  .waiting { color: var(--dim); font-size: 13px; }
</style>
</head>
<body>
<div class="studio">
  <div class="stage">
    <div class="toolbar">
      <!-- Groups never break apart; on a narrow window the later ones wrap onto a second row. -->
      <span class="tb-group">
        <button class="exit" title="Leave the studio">✕</button>
        <button class="reload" title="Reload every artboard">↻</button>
        <span class="sep"></span>
        <span class="focus-tools">
          <button class="prev" title="Previous screen (←)">‹</button>
          <select class="focus-pick" title="Screen"></select>
          <button class="next" title="Next screen (→)">›</button>
          <button class="scr-add" title="New screen: a copy of this one (then edit its URL)">＋</button>
          <button class="scr-edit" title="Rename this screen or change its URL">✎</button>
          <button class="scr-del" title="Remove this screen">🗑</button>
          <button class="pages-toggle" title="Routes: add a screen for a page of your app">☰</button>
          <button class="overview" title="All screens at a glance">▦</button>
        </span>
      </span>
      <span class="tb-group focus-tools">
        <select class="focus-device" title="Device"></select>
        <button class="focus-turn" title="Rotate">⟲</button>
        <span class="ws"><input type="range" class="width-slider" min="280" max="1920" step="1" title="Width: drag to watch the layout respond (ticks are your breakpoints); pick a device to reset" /><span class="ws-ticks"></span></span>
      </span>
      <span class="tb-group focus-tools">
        <button class="fz-out" title="Zoom out (⌘−)">−</button>
        <span class="zoom focus-zoom" title="Pinch or ⌘-scroll to zoom; scroll or drag to pan"></span>
        <button class="fz-in" title="Zoom in (⌘+)">+</button>
        <button class="fz-fit" title="Fit the screen (⇧1)">Fit</button>
        <button class="fz-100" title="Actual size (⇧0)">1:1</button>
      </span>
      <span class="tb-group">
        <button class="guides-toggle" title="Layout guides over the screen: columns and a baseline grid">Guides</button>
        <button class="shot" title="Copy a picture of the screen to the clipboard (both versions when comparing). Shift-click also saves a PNG">📷</button>
      </span>
      <span class="tb-group">
        <button class="vs-toggle" title="Compare with another branch or commit, side by side">⑂ Versions</button>
        <span class="vs-modes" hidden><button data-mode="inspect" title="Click elements to tweak them">Inspect</button><button data-mode="interact" title="Use both apps: clicks go to the app, not the panel">Interact</button></span>
        <button class="vs-mirror" hidden title="Repeat your clicks and typing on the other version, so both walk through the same flow">⇆ Mirror clicks</button>
      </span>
      <span class="tb-group tb-end">
        <a class="tb" href="/__ui-tweaks/system" title="Design system: every token in your CSS, editable">Tokens</a>
      </span>
    </div>
    <div class="body">
      <div class="pages" hidden></div>
      <div class="viewport">
        <div class="dots"></div>
        <div class="world"></div>
        <div class="shield"></div>
      </div>
    </div>
  </div>
  <div id="ui-tweaks-root"><div class="waiting">Loading your app…<br />The panel docks here once it's up.</div></div>
</div>
<div class="note"></div>
<div class="overview-pop" hidden></div>
<div class="guides-pop" hidden></div>
<div class="vs-pop" hidden></div>
<script>
  // Screen sizes in CSS px (portrait), and what each device draws over the page.
  const DEVICES = [
    ["iPhone", [
      ["duo-open", "iPhone Duo, open", 890, 626, "fold"],
      ["duo-folded", "iPhone Duo, folded", 466, 678, "island"],
      ["pro-max", "iPhone 18 / 17 / 16 Pro Max", 440, 956, "island"],
      ["air", "iPhone Air", 420, 912, "island"],
      ["pro", "iPhone 18 Pro · 17 Pro · 17", 402, 874, "island"],
      ["i16", "iPhone 16 · 15", 393, 852, "island"],
      ["i14", "iPhone 17e · 14 · 13", 390, 844, "notch"],
      ["plus", "iPhone 16 Plus · 15 Plus", 430, 932, "island"],
      ["mini", "iPhone 13 mini", 375, 812, "notch"],
      ["se", "iPhone SE", 375, 667, "home"],
    ]],
    ["iPad", [
      ["ipad-mini", "iPad mini", 744, 1133, "tablet"],
      ["ipad-air", "iPad Air 11″", 820, 1180, "tablet"],
      ["ipad-pro-11", "iPad Pro 11″", 834, 1210, "tablet"],
      ["ipad-pro-13", "iPad Pro 13″", 1032, 1376, "tablet"],
      ["ipad-classic", "iPad (classic)", 768, 1024, "tablet"],
    ]],
    ["Android", [
      ["pixel", "Pixel", 412, 915, "android"],
      ["zfold-folded", "Galaxy Z Fold 5, folded", 344, 882, "android"],
    ]],
    ["Desktop", [
      ["laptop", "Laptop", 1280, 800, "desktop"],
      ["mba-13", "MacBook Air 13″", 1470, 956, "desktop"],
      ["desktop-1440", "Desktop 1440", 1440, 900, "desktop"],
      ["desktop-1080", "Desktop 1080p", 1920, 1080, "desktop"],
    ]],
  ];
  const BY_ID = Object.fromEntries(DEVICES.flatMap(([, list]) => list.map((d) => [d[0], d])));
  const options = (selected) =>
    DEVICES.map(([group, list]) => '<optgroup label="' + group + '">' + list.map(([id, name, w, h]) =>
      '<option value="' + id + '"' + (id === selected ? " selected" : "") + ">" + name + "  " + w + "×" + h + "</option>").join("") + "</optgroup>").join("");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const $ = (s) => document.querySelector(s);
  const viewport = $(".viewport"), world = $(".world");
  const VIEW_KEY = "ui-tweaks:studio-view";
  let view = { grid: false, base: false, pages: false, cam: null, mode: "focus", focus: null };
  try { view = { ...view, ...JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") }; } catch {}
  view.mode = "focus"; // one screen at a time, at its real size (the canvas view is gone)
  const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {} };

  function note(text) {
    const n = $(".note");
    n.textContent = text;
    n.classList.add("show");
    clearTimeout(note.t);
    note.t = setTimeout(() => n.classList.remove("show"), 2600);
  }

  // ---------- the canvas file ----------
  let canvas = { artboards: [], notes: [], arrows: [] };
  let version = -1, saving = null, dirty = false;
  function save() {
    dirty = true;
    clearTimeout(saving);
    saving = setTimeout(async () => {
      try {
        const res = await fetch("/__ui-tweaks/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(canvas) });
        version = (await res.json()).version;
      } catch {}
      dirty = false;
    }, 300);
  }
  // Claude (or you, in an editor) can change canvas.json: pick that up.
  setInterval(async () => {
    if (dirty) return;
    try {
      const data = await fetch("/__ui-tweaks/canvas", { cache: "no-store" }).then((r) => r.json());
      if (data.version !== version && !dirty) {
        version = data.version;
        canvas = data.canvas;
        render();
      }
    } catch {}
  }, 1500);

  // ---------- camera ----------
  let cam = view.cam || { x: 60, y: 80, z: 0.5 };
  function applyCam() {
    if (isFocus()) return layoutFocus();
    world.style.transform = "translate(" + cam.x + "px," + cam.y + "px) scale(" + cam.z + ")";
    world.style.setProperty("--iz", String(1 / cam.z));
    const dots = $(".dots");
    const step = 24 * cam.z;
    dots.style.backgroundSize = step + "px " + step + "px";
    dots.style.backgroundPosition = cam.x + "px " + cam.y + "px";
    $(".zoom").textContent = Math.round(cam.z * 100) + "%";
    view.cam = cam;
    saveView();
    drawMinimap();
  }
  // Focus: one artboard alone, at actual size (100%) on its device. Centered when it fits; scroll or drag
  // to see the rest when it doesn't. The canvas camera is kept for when you switch back.
  // One screen on a canvas of its own: it opens at 100% when it fits and scaled to fit when it doesn't
  // (a 1920×1080 desktop on a laptop), and you can zoom (pinch, ⌘-scroll, − + Fit 1:1) and pan around it.
  // Each screen keeps its zoom until you change its size.
  let focusPan = { x: 0, y: 0, id: null };
  const focusZoom = new Map(); // artboard id -> { z, size }
  const fitZoom = (w, h) => Math.min(1, (viewport.clientWidth - 48) / w, (viewport.clientHeight - (versusOn() ? 110 : 48)) / h);
  // With another version open, the canvas holds both screens and the gap between them.
  const VS_GAP = 64;
  const spanW = (w) => (versusOn() ? w * 2 + VS_GAP : w);
  function zoomOf(a) {
    const [w, h] = size(a);
    const key = w + "x" + h + (versusOn() ? ":vs" : "");
    let z = focusZoom.get(a.id);
    if (!z || z.size !== key) focusZoom.set(a.id, (z = { z: Math.max(0.05, fitZoom(spanW(w), h)), size: key, auto: true }));
    return z.z;
  }
  function layoutFocus() {
    const a = canvas.artboards.find((x) => x.id === focusedId());
    if (!a) return;
    const [w, h] = size(a);
    const z = zoomOf(a);
    placeVersus(a);
    const sw = spanW(w) * z, sh = h * z;
    const vw = viewport.clientWidth, vh = viewport.clientHeight, pad = versusOn() ? 60 : 24;
    const clamp = (v, size, room) => (size + pad * 2 <= room ? (room - size) / 2 : Math.min(pad, Math.max(room - size - pad, v)));
    const id = a.id + ":" + w + "x" + h + (versusOn() ? ":vs" : "");
    if (focusPan.id !== id) focusPan = { x: (vw - sw) / 2, y: sh + pad * 2 <= vh ? (vh - sh) / 2 : pad, id };
    focusPan.x = clamp(focusPan.x, sw, vw);
    focusPan.y = clamp(focusPan.y, sh, vh);
    world.style.transform = "translate(" + focusPan.x + "px," + focusPan.y + "px) scale(" + z + ") translate(" + -a.x + "px," + -a.y + "px)";
    world.style.setProperty("--iz", String(1 / z));
    $(".focus-zoom").textContent = w + "×" + h + " · " + Math.round(z * 100) + "%";
  }
  // Zoom the shown screen keeping the point under (mx, my) in place.
  function zoomFocus(z, mx = viewport.clientWidth / 2, my = viewport.clientHeight / 2) {
    const a = canvas.artboards.find((x) => x.id === focusedId());
    if (!a) return;
    const cur = zoomOf(a);
    z = Math.min(4, Math.max(0.05, z));
    focusPan.x = mx - ((mx - focusPan.x) * z) / cur;
    focusPan.y = my - ((my - focusPan.y) * z) / cur;
    focusZoom.set(a.id, { ...focusZoom.get(a.id), z, auto: false });
    layoutFocus();
  }
  function fitFocus() {
    const a = canvas.artboards.find((x) => x.id === focusedId());
    if (!a) return;
    focusZoom.delete(a.id);
    focusPan.id = null;
    layoutFocus();
  }

  function setMode(mode, id) {
    view.mode = mode;
    if (id) view.focus = id;
    if (mode === "focus" && !canvas.artboards.some((a) => a.id === view.focus)) view.focus = focusedId();
    saveView();
    render();
    applyCam();
    dockShown();
  }
  // The panel belongs to the screen on show (once its app has loaded).
  function dockShown(tries = 0) {
    const f = frames.get(focusedId());
    if (!f) return;
    try {
      const t = f.iframe.contentWindow.__uiTweaks;
      if (t && f.iframe.contentDocument.readyState !== "loading") return t.attachPopup(window);
    } catch {}
    if (tries < 40) setTimeout(() => f === frames.get(focusedId()) && dockShown(tries + 1), 150);
  }
  function step(dir) {
    const list = canvas.artboards;
    const i = list.findIndex((a) => a.id === focusedId());
    view.focus = list[(i + dir + list.length) % list.length].id;
    select(view.focus);
    saveView();
    render();
    applyCam();
    dockShown();
  }

  function zoomAt(z, mx, my) {
    z = Math.min(4, Math.max(0.05, z));
    cam = { x: mx - ((mx - cam.x) * z) / cam.z, y: my - ((my - cam.y) * z) / cam.z, z };
    applyCam();
  }
  const center = () => [viewport.clientWidth / 2, viewport.clientHeight / 2];

  function bounds(list = canvas.artboards) {
    if (!list.length) return { x: 0, y: 0, w: 400, h: 400 };
    const rects = list.map((a) => { const [w, h] = size(a); return { x: a.x, y: a.y - 40, w, h: h + 40 }; });
    const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  }
  function fitTo(list) {
    const b = bounds(list);
    const z = Math.min(1, (viewport.clientWidth - 80) / b.w, (viewport.clientHeight - 80) / b.h);
    cam = { z, x: (viewport.clientWidth - b.w * z) / 2 - b.x * z, y: (viewport.clientHeight - b.h * z) / 2 - b.y * z };
    applyCam();
  }

  // Trackpad: two fingers pan, pinch (or ⌘/Ctrl + scroll) zooms at the pointer.
  function onWheel(e) {
    e.preventDefault();
    if (isFocus()) {
      if (e.ctrlKey || e.metaKey) {
        const r = viewport.getBoundingClientRect();
        const a = canvas.artboards.find((x) => x.id === focusedId());
        // Trackpads send small deltas, mouse wheels big ones: cap a step so one notch is a gentle zoom.
        return a && zoomFocus(zoomOf(a) * Math.exp(-Math.max(-25, Math.min(25, e.deltaY)) * 0.01), e.clientX - r.left, e.clientY - r.top);
      }
      focusPan.x -= e.deltaX;
      focusPan.y -= e.deltaY;
      return layoutFocus();
    }
    if (e.ctrlKey || e.metaKey) {
      const r = viewport.getBoundingClientRect();
      zoomAt(cam.z * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    } else {
      cam = { ...cam, x: cam.x - e.deltaX, y: cam.y - e.deltaY };
      applyCam();
    }
  }
  viewport.addEventListener("wheel", onWheel, { passive: false });

  // Drag the empty canvas (or anything, while Space or ✋ is on) to pan.
  let hand = false;
  function setHand(on) {
    hand = on;
    viewport.classList.toggle("hand", on || false);
  }
  viewport.addEventListener("pointerdown", (e) => {
    const onEmpty = e.target === viewport || e.target === world || e.target.classList.contains("shield") || e.target.classList.contains("dots");
    if (!onEmpty) return;
    if (!hand && !false && !isFocus()) select(null);
    const start = { x: e.clientX, y: e.clientY, cx: isFocus() ? focusPan.x : cam.x, cy: isFocus() ? focusPan.y : cam.y };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("panning");
    const move = (ev) => {
      if (isFocus()) {
        focusPan.x = start.cx + ev.clientX - start.x;
        focusPan.y = start.cy + ev.clientY - start.y;
        return layoutFocus();
      }
      cam = { ...cam, x: start.cx + ev.clientX - start.x, y: start.cy + ev.clientY - start.y };
      applyCam();
    };
    const up = () => { viewport.classList.remove("panning"); viewport.removeEventListener("pointermove", move); viewport.removeEventListener("pointerup", up); };
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerup", up);
  });
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.code === "Space" && !e.repeat) { e.preventDefault(); setHand(true); }
    const shown = canvas.artboards.find((x) => x.id === focusedId());
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); shown && zoomFocus(zoomOf(shown) * 1.25); }
    if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); shown && zoomFocus(zoomOf(shown) / 1.25); }
    if (e.shiftKey && e.code === "Digit1") fitFocus();
    if (e.shiftKey && e.code === "Digit0") zoomFocus(1);
    if (isFocus() && e.key === "ArrowLeft") step(-1);
    if (isFocus() && e.key === "ArrowRight") step(1);
    if (!isFocus() && (e.key === "Backspace" || e.key === "Delete") && selected) removeArtboard(selected);
  });
  addEventListener("keyup", (e) => { if (e.code === "Space") setHand(false); });
  // The app's frames forward pinch-zoom and Space to the canvas (the overlay calls these).
  window.__studio = {
    wheel(e, frame) {
      const r = viewport.getBoundingClientRect(), f = frame.getBoundingClientRect();
      const scale = f.width / frame.offsetWidth;
      onWheel({ preventDefault() {}, ctrlKey: e.ctrlKey, metaKey: e.metaKey, deltaX: e.deltaX, deltaY: e.deltaY, clientX: f.left + e.clientX * scale, clientY: f.top + e.clientY * scale });
      void r;
    },
    hand: setHand,
    // The command palette lists and opens screens.
    screens() {
      return canvas.artboards.map((a) => ({ id: a.id, name: a.name || a.url, shown: a.id === focusedId() }));
    },
    show(id) {
      select(id);
      setMode("focus", id);
    },
    // A frame's overlay asks this when it loads (also after a reload): the screen on show holds the panel.
    isShown(frame) {
      const f = frames.get(focusedId());
      return !!f && f.iframe === frame;
    },
    focus(frame) {
      const a = canvas.artboards.find((x) => frames.get(x.id) && frames.get(x.id).iframe === frame);
      if (a && selected !== a.id) select(a.id, false);
    },
  };

  // ---------- artboards ----------
  const frames = new Map(); // id -> { el, head, frame, iframe, layer, url }
  let selected = null;
  function size(a) {
    const d = BY_ID[a.device] || BY_ID.i16;
    const [w, h] = a.turned ? [d[3], d[2]] : [d[2], d[3]];
    return a.w ? [a.w, h] : [w, h]; // the width slider overrides the device's width
  }
  const isFocus = () => view.mode === "focus";
  const focusedId = () => (canvas.artboards.some((a) => a.id === view.focus) ? view.focus : (canvas.artboards.find((a) => a.id === selected) || canvas.artboards[0] || {}).id);
  const newId = () => "a" + Math.random().toString(36).slice(2, 8);

  // Only the Duo's fold is drawn; simulated status bars and notches clip the app's own header.
  function fold(a) {
    const d = BY_ID[a.device];
    if (!d || d[4] !== "fold") return "";
    return '<div class="fold" style="' + (a.turned ? "left:0;right:0;top:50%;bottom:auto;width:auto;height:2px;transform:translateY(-50%)" : "") + '"></div>';
  }
  function overlays(w) {
    let html = "";
    const g = guides();
    if (g.cols) {
      // Auto: 4 columns on phones, 8 on tablets, 12 on desktops, with margins and gutters to match.
      const [auto, margin, gutter] = w < 600 ? [4, 16, 16] : w < 1024 ? [8, 24, 24] : [12, 32, 24];
      const n = g.cols === "auto" ? auto : g.cols;
      html += '<div class="grid-cols" style="padding:0 ' + margin + "px;gap:" + gutter + 'px">' + "<div></div>".repeat(n) + "</div>";
    }
    if (g.base) html += '<div class="baseline" style="background-size:100% ' + g.base + 'px;background-image:repeating-linear-gradient(to bottom, rgba(13,153,255,.22) 0 1px, transparent 1px ' + g.base + 'px)"></div>';
    return html;
  }

  function makeFrame(a, isPrimary) {
    const el = document.createElement("div");
    el.className = "ab";
    el.innerHTML = '<div class="ab-head"></div><div class="vs-label"></div><div class="ab-frame"><iframe title="Artboard"></iframe><div class="ab-layer"></div></div>';
    const f = { el, head: el.querySelector(".ab-head"), frame: el.querySelector(".ab-frame"), iframe: el.querySelector("iframe"), layer: el.querySelector(".ab-layer"), url: null };
    if (isPrimary) f.iframe.dataset.primary = "1";
    world.append(el);
    return f;
  }

  function head(a, f) {
    const [w, h] = size(a);
    f.head.innerHTML = '<span class="name" title="Double-click to rename">' + esc(a.name || "Artboard") + '</span><span class="url" title="Double-click to change the screen (URL)">' + esc(a.url) + "</span><span>" + w + "×" + h + '</span><span class="tools"><select class="dev" title="Device">' + options(a.device) + '</select><button class="turn" title="Rotate">⟲</button><button class="dup" title="Duplicate">⧉</button><button class="del" title="Remove">✕</button></span>';
    const edit = (cls, key) => f.head.querySelector(cls).addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.value = a[key] || "";
      input.size = Math.max(8, input.value.length);
      e.target.replaceWith(input);
      input.focus();
      input.select();
      const done = (keep) => {
        if (keep && input.value.trim()) {
          a[key] = key === "url" && !input.value.trim().startsWith("/") ? "/" + input.value.trim() : input.value.trim();
          save();
        }
        render();
      };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") done(true); if (ev.key === "Escape") done(false); ev.stopPropagation(); });
      input.addEventListener("blur", () => done(true));
    });
    edit(".name", "name");
    edit(".url", "url");
    f.head.querySelector("span:nth-child(3)").title = "Double-click to focus this screen";
    f.head.querySelector("span:nth-child(3)").addEventListener("dblclick", (e) => { e.stopPropagation(); setMode("focus", a.id); });
    f.head.querySelector(".dev").addEventListener("change", (e) => { a.device = e.target.value; a.turned = false; save(); render(); });
    f.head.querySelector(".turn").addEventListener("click", () => { a.turned = !a.turned; save(); render(); });
    f.head.querySelector(".dup").addEventListener("click", () => duplicate(a));
    f.head.querySelector(".del").addEventListener("click", () => removeArtboard(a.id));
    for (const c of f.head.querySelectorAll("select, button")) c.addEventListener("pointerdown", (e) => e.stopPropagation());
    // Drag the header to move the artboard (snaps to 8px).
    f.head.onpointerdown = (e) => {
      if (e.target.tagName === "INPUT") return;
      select(a.id);
      const start = { x: e.clientX, y: e.clientY, ax: a.x, ay: a.y };
      f.head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        a.x = Math.round((start.ax + (ev.clientX - start.x) / cam.z) / 8) * 8;
        a.y = Math.round((start.ay + (ev.clientY - start.y) / cam.z) / 8) * 8;
        f.el.style.left = a.x + "px";
        f.el.style.top = a.y + "px";
        drawMinimap();
      };
      const up = () => { f.head.removeEventListener("pointermove", move); f.head.removeEventListener("pointerup", up); save(); };
      f.head.addEventListener("pointermove", move);
      f.head.addEventListener("pointerup", up);
    };
  }

  function render() {
    // Drop frames whose artboard is gone; keep the rest running (no reload).
    const ids = new Set(canvas.artboards.map((a) => a.id));
    for (const [id, f] of frames) if (!ids.has(id)) { f.el.remove(); frames.delete(id); }
    const shown = focusedId();
    canvas.artboards.forEach((a, i) => {
      if (!a.id) a.id = newId();
      let f = frames.get(a.id);
      // The screen on show first holds the panel.
      if (!f) { f = makeFrame(a, a.id === shown && ![...frames.values()].some((x) => x.iframe.dataset.primary)); frames.set(a.id, f); }
      const [w, h] = size(a);
      Object.assign(f.el.style, { left: a.x + "px", top: a.y + "px" });
      Object.assign(f.frame.style, { width: w + "px", height: h + "px" });
      f.el.classList.toggle("selected", a.id === selected);
      // A screen loads the first time it's shown, then stays loaded so switching back is instant.
      if (a.id === shown) f.seen = true;
      if (f.seen && f.url !== a.url) { f.url = a.url; f.iframe.src = a.url; }
      f.layer.innerHTML = overlays(w) + fold(a);
      head(a, f);
    });
    const focus = isFocus(), fid = focusedId();
    for (const [id, f] of frames) f.el.classList.toggle("hidden", focus && id !== fid);
    viewport.classList.toggle("focus", focus);
    const a = canvas.artboards.find((x) => x.id === fid);
    $(".focus-pick").innerHTML = canvas.artboards.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === fid ? " selected" : "") + ">" + esc(x.name || x.url) + "</option>").join("");
    $(".focus-pick").title = a ? a.url : "";
    $(".focus-device").innerHTML = options(a && a.device);
    if (a) { $(".width-slider").value = String(size(a)[0]); fillSlider(); }
    $(".pages-toggle").classList.toggle("on", !!view.pages);
    drawGuidesButton();
    $(".pages").hidden = !view.pages;
    saveView();
    drawMinimap();
    dockPanel();
  }

  // If the frame that held the panel went away, let the first artboard take it.
  function dockPanel() {
    const root = document.getElementById("ui-tweaks-root");
    if (root.querySelector(".panel")) return;
    const first = frames.get(focusedId());
    try { first && first.iframe.contentWindow.__uiTweaks && first.iframe.contentWindow.__uiTweaks.attachPopup(window); } catch {}
  }

  function select(id, focus = false) {
    selected = id;
    for (const [aid, f] of frames) f.el.classList.toggle("selected", aid === id);
    drawMinimap();
    if (focus && id) fitTo(canvas.artboards.filter((a) => a.id === id));
  }

  function place(w) {
    // To the right of everything, top-aligned with the first artboard.
    const b = canvas.artboards.length ? bounds() : { x: 0, y: 40, w: -80 };
    return { x: Math.round((b.x + b.w + 80) / 8) * 8, y: canvas.artboards.length ? canvas.artboards[0].y : 0 };
  }
  function addArtboard(partial) {
    const base = canvas.artboards.find((a) => a.id === selected) || canvas.artboards[canvas.artboards.length - 1];
    const a = { id: newId(), name: partial.name || "Artboard", device: partial.device || (base && base.device) || "i16", url: partial.url || (base && base.url) || "/", ...place() };
    canvas.artboards.push(a);
    save();
    render();
    select(a.id);
    return a;
  }
  function duplicate(a) {
    const [w] = size(a);
    const copy = { ...a, id: newId(), name: a.name + " copy", x: a.x + w + 80 };
    canvas.artboards.push(copy);
    save();
    render();
    select(copy.id);
  }
  function removeArtboard(id) {
    if (canvas.artboards.length <= 1) return note("Keep at least one artboard.");
    canvas.artboards = canvas.artboards.filter((a) => a.id !== id);
    if (selected === id) selected = null;
    save();
    render();
  }

  function drawMinimap() {}

  // ---------- pages ----------
  // The app's routes, with ways to add them as screens. Routes with parameters ask for values.
  const FIND_SCREENS = "Find the screens of this app and set them up for the UI tweak kit's studio. " +
    "1) Find every distinct screen, and the states worth designing for each (empty, loading, error, signed out, a long list…). " +
    "2) If screens or states can't be reached by URL, add a small development-only hook: ?screen=<name> opens a screen, and ?fixture=<name> loads a named, made-up data state instead of the saved one and never writes it back; both are ignored outside development (e.g. behind import.meta.env.DEV). Keep it to one small new file plus the few lines where the app picks its first screen and loads its state, and don't change what users see. " +
    '3) Write .ui-tweaks/canvas.json as {"version":1,"artboards":[{"id":"a1","name":"Home","device":"i16","url":"/","x":0,"y":0}, …],"notes":[],"arrows":[]}: one artboard per screen or state, named like "Wallet · verified", keeping the artboards already there.';
  const fillParams = (p) => {
    let cancelled = false;
    const out = p.replace(/\\[\\.\\.\\.(\\w+)\\]|\\[\\[\\.\\.\\.(\\w+)\\]\\]|\\[(\\w+)\\]|:(\\w+)\\??|\\$(\\w+)|\\*/g, (m, a, b, c, d, e) => {
      if (cancelled) return m;
      const v = prompt("Value for " + (a || b || c || d || e || "the rest of the path") + " in " + p, "");
      if (v === null) cancelled = true;
      return v === null ? m : v.replace(/^\\/+/, "");
    });
    return cancelled ? null : out;
  };
  async function loadPages() {
    if (!view.pages) return;
    const box = $(".pages");
    let data = { routes: [], pending: [] }, asks = [];
    try {
      [data, { asks = [] }] = await Promise.all([fetch("/__ui-tweaks/routes").then((r) => r.json()), fetch("/__ui-tweaks/status", { cache: "no-store" }).then((r) => r.json())]);
    } catch {}
    // The latest Find screens request: running ones block another, a finished one shows what it did.
    const find = asks.filter((a) => (a.instruction || "").startsWith(FIND_SCREENS.slice(0, 40))).sort((x, y) => (y.at || 0) - (x.at || 0))[0];
    const finding = find && (find.status === "waiting" || find.status === "running");
    clearTimeout(loadPages.t);
    if (finding) loadPages.t = setTimeout(loadPages, 2000);
    const fid = focusedId();
    const screens = canvas.artboards;
    const have = new Set(canvas.artboards.map((a) => (a.url || "/").split(/[?#]/)[0]));
    const fresh = data.routes.filter((r) => !r.params && !have.has(r.path));
    const needValues = data.routes.filter((r) => r.params).length;
    box.innerHTML = '<div class="pages-actions"><button class="pg-all primary"' + (fresh.length ? "" : " disabled") + ">" + (fresh.length ? "Add all " + fresh.length + " routes" : "All routes added") + '</button><button class="pg-find"' + (finding ? " disabled" : "") + ' title="For apps that switch screens without URLs: Claude adds a dev-only ?screen= / ?fixture= hook and adds every screen and state to the Screens list (needs the ui-tweaks mod in an open Claude Code session)">' + (finding ? (find.status === "running" ? "Claude is finding screens…" : "Waiting for Claude Code…") : "Find screens with Claude") + "</button>" +
      // A run that changed nothing but says why (older ones were filed as failed) reads as its summary.
      (find && !finding ? (() => { const bad = find.status === "failed" && !(find.summary && !find.needs); return '<div class="pg-last' + (bad ? " err" : "") + '" title="' + esc(find.summary || find.error || "") + '">' + esc("Last run: " + (bad ? find.needs || find.error || "didn't finish" : find.summary || "done")) + "</div>"; })() : "") + "</div>" +
      // Every screen in canvas.json: the app's routes, plus the screens and states reached by ?screen= / ?fixture=.
      "<h4>Screens <span>" + screens.length + "</span></h4>" +
      '<div class="pg-list">' + screens.map((a) => '<button class="pg-route pg-screen' + (a.id === fid ? " on" : "") + '" data-screen="' + esc(a.id) + '" title="' + esc(a.url) + '"><span class="name">' + esc(a.name || a.url) + '</span><span class="src">' + esc((a.url || "/").replace(/^\\/\\??/, "") || "/") + "</span></button>").join("") + "</div>" +
      "<h4>Routes <span>" + data.routes.length + "</span></h4>" +
      (data.routes.length === 1 && screens.length > 1 ? '<div class="pages-empty">One URL: this app switches screens without changing the path, so they\\'re listed under Screens.</div>' : "") +
      (data.routes.length ? '<div class="pg-list">' + data.routes.map((r) => '<button class="pg-route' + (have.has(r.path) ? " have" : "") + '" data-path="' + esc(r.path) + '"' + (r.params ? ' data-params="1" title="Has a parameter: click to give it a value"' : have.has(r.path) ? ' title="Already a screen: click to add another"' : "") + ">" + (data.pending.includes(r.path) ? "<i title='Has pending tweaks'></i>" : "") + '<span class="path">' + esc(r.path) + "</span>" + (have.has(r.path) ? '<span class="src tick">✓</span>' : "") + '<span class="src">' + (r.params ? "needs value" : esc(r.source)) + "</span></button>").join("") + "</div>" : '<div class="pages-empty">No routes found. If the app switches screens without URLs, use Find screens.</div>');
    for (const b of box.querySelectorAll("button[data-screen]")) b.addEventListener("click", () => { select(b.dataset.screen); setMode("focus", b.dataset.screen); loadPages(); });
    for (const b of box.querySelectorAll("button[data-path]")) b.addEventListener("click", () => {
      const p = b.dataset.params ? fillParams(b.dataset.path) : b.dataset.path;
      if (!p) return;
      const a = addArtboard({ url: p, name: p === "/" ? "Home" : p });
      setMode("focus", a.id);
      loadPages();
    });
    box.querySelector(".pg-all").addEventListener("click", () => {
      for (const r of fresh) addArtboard({ url: r.path, name: r.path === "/" ? "Home" : r.path });
      note("Added " + fresh.length + " screen" + (fresh.length === 1 ? "" : "s") + (needValues ? "; routes with parameters need a value: click them" : ""));
      loadPages();
    });
    box.querySelector(".pg-find").addEventListener("click", async () => {
      try {
        const res = await fetch("/__ui-tweaks/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "edit", instruction: FIND_SCREENS, page: { url: "/", path: "/" } }) });
        if (!res.ok) throw new Error((await res.json()).error);
        note("Claude is finding the screens; they'll appear under Screens as it adds them (keep a Claude Code session with the ui-tweaks mod open).");
        loadPages();
      } catch (e) {
        note("Couldn't ask Claude: " + e.message);
      }
    });
  }

  // ---------- toolbar ----------
  const current = () => canvas.artboards.find((x) => x.id === focusedId());

  // Width slider: resize the screen live; ticks mark the project's breakpoints.
  const slider = $(".width-slider");
  // The track's fill up to the thumb (WebKit has no progress part of its own).
  function fillSlider() {
    const el = $(".width-slider");
    el.style.setProperty("--p", ((el.value - el.min) / (el.max - el.min)) * 100 + "%");
  }
  let saveTimer = 0;
  slider.addEventListener("input", () => {
    fillSlider();
    const a = current();
    if (!a) return;
    a.w = Number(slider.value);
    render();
    applyCam();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  });
  fetch("/__ui-tweaks/breakpoints").then((r) => r.json()).then((b) => {
    const px = [...new Set([...(b.max || []), ...(b.min || [])].map((x) => x.px))].sort((x, y) => x - y);
    const [lo, hi] = [Number(slider.min), Number(slider.max)];
    $(".ws-ticks").innerHTML = px.filter((v) => v > lo && v < hi).map((v) => '<i style="left:' + ((v - lo) / (hi - lo)) * 100 + '%" title="' + v + 'px"></i>').join("");
    if (px.length) slider.title += " · breakpoints: " + px.join(", ") + "px";
  }).catch(() => {});

  // Screens at a glance: a sketch of each screen that has been opened, drawn from its page.
  const sketches = new Map(); // artboard id -> { at, url }
  function sketch(f, w, h) {
    try {
      const d = f.iframe.contentDocument;
      if (!d || !d.body) return null;
      const xml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const css = [...d.querySelectorAll("style")].map((s) => s.textContent).join("\\n");
      const body = d.body.cloneNode(true);
      body.querySelectorAll("script, ui-tweaks-overlay, iframe, video, canvas").forEach((n) => n.remove());
      const html = d.documentElement;
      const attrs = ["class", "style", "data-theme"].map((k) => html.getAttribute(k) ? " " + k + '="' + xml(html.getAttribute(k)).replace(/"/g, "&quot;") + '"' : "").join("");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject width="100%" height="100%"><html xmlns="http://www.w3.org/1999/xhtml"' + attrs + "><head><style>" + xml(css) + "</style></head>" + new XMLSerializer().serializeToString(body) + "</html></foreignObject></svg>";
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    } catch {
      return null;
    }
  }
  function drawOverview() {
    const pop = $(".overview-pop");
    pop.innerHTML = "";
    for (const a of canvas.artboards) {
      const f = frames.get(a.id);
      const [w, h] = size(a);
      const card = document.createElement("button");
      card.className = "ov-card" + (a.id === focusedId() ? " on" : "");
      const shot = document.createElement("div");
      shot.className = "ov-shot";
      let s = sketches.get(a.id);
      if (f && f.seen && (!s || Date.now() - s.at > 8000)) {
        const url = sketch(f, w, h);
        if (url) sketches.set(a.id, (s = { at: Date.now(), url }));
      }
      if (s) shot.innerHTML = '<img alt="" src="' + s.url + '">';
      else shot.textContent = "Open it once to see it here";
      card.innerHTML = "";
      card.append(shot);
      const meta = document.createElement("div");
      meta.className = "ov-meta";
      meta.innerHTML = esc(a.name || a.url) + "<span>" + w + "×" + h + " · " + esc(a.url) + "</span>";
      card.append(meta);
      card.addEventListener("click", () => {
        pop.hidden = true;
        select(a.id);
        setMode("focus", a.id);
      });
      pop.append(card);
    }
  }
  $(".fz-out").addEventListener("click", () => { const a = current(); a && zoomFocus(zoomOf(a) / 1.25); });
  $(".fz-in").addEventListener("click", () => { const a = current(); a && zoomFocus(zoomOf(a) * 1.25); });
  $(".fz-fit").addEventListener("click", fitFocus);
  $(".fz-100").addEventListener("click", () => zoomFocus(1));
  $(".overview").addEventListener("click", () => {
    const pop = $(".overview-pop");
    pop.hidden = !pop.hidden;
    if (!pop.hidden) drawOverview();
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") $(".overview-pop").hidden = true; });
  $(".focus-pick").addEventListener("change", (e) => { select(e.target.value); setMode("focus", e.target.value); });
  $(".scr-add").addEventListener("click", () => {
    const a = current();
    const copy = addArtboard({ name: a ? a.name + " copy" : "Screen", url: a && a.url, device: a && a.device });
    setMode("focus", copy.id);
  });
  $(".scr-edit").addEventListener("click", () => {
    const a = current();
    if (!a) return;
    const name = prompt("Screen name", a.name || "");
    if (name === null) return;
    const url = prompt("Screen URL (path, query and #hash of your app, e.g. /?screen=settings)", a.url || "/");
    if (url === null) return;
    a.name = name.trim() || a.name;
    a.url = url.trim() ? (url.trim().startsWith("/") ? url.trim() : "/" + url.trim()) : a.url;
    save();
    render();
  });
  $(".scr-del").addEventListener("click", () => {
    const a = current();
    if (!a || !confirm('Remove the screen "' + (a.name || a.url) + '"? (Your app is not changed.)')) return;
    removeArtboard(a.id);
    setMode("focus", focusedId());
  });
  $(".prev").addEventListener("click", () => step(-1));
  $(".next").addEventListener("click", () => step(1));
  $(".focus-device").addEventListener("change", (e) => {
    const a = canvas.artboards.find((x) => x.id === focusedId());
    if (!a) return;
    a.device = e.target.value;
    a.turned = false;
    delete a.w;
    save();
    render();
    applyCam();
  });
  $(".focus-turn").addEventListener("click", () => {
    const a = canvas.artboards.find((x) => x.id === focusedId());
    if (!a) return;
    a.turned = !a.turned;
    save();
    render();
    applyCam();
  });
  // Guides: columns (auto by width, or 4/8/12) and a baseline grid (4 or 8px), picked from a small menu.
  function guides() {
    // Older saved views had on/off flags: grid meant auto columns, base meant an 8px baseline.
    const cols = view.gridCols !== undefined ? view.gridCols : view.grid ? "auto" : 0;
    const base = view.baseStep !== undefined ? view.baseStep : view.base ? 8 : 0;
    return { cols, base };
  }
  function drawGuidesButton() {
    const g = guides();
    const parts = [g.cols ? (g.cols === "auto" ? "cols" : g.cols + " col") : "", g.base ? g.base + "px" : ""].filter(Boolean);
    const b = $(".guides-toggle");
    b.textContent = parts.length ? "Guides · " + parts.join(" · ") : "Guides";
    b.classList.toggle("on", parts.length > 0);
  }
  function drawGuides() {
    const g = guides();
    const opt = (key, value, label, hint) => '<button class="gd-opt' + (g[key] === value ? " on" : "") + '" data-key="' + key + '" data-value="' + value + '" title="' + hint + '">' + label + "</button>";
    $(".guides-pop").innerHTML =
      '<h4>Columns</h4><div class="gd-row">' + opt("cols", 0, "Off", "No column guides") + opt("cols", "auto", "Auto", "4 on phones, 8 on tablets, 12 on desktops") + opt("cols", 4, "4", "4 columns") + opt("cols", 8, "8", "8 columns") + opt("cols", 12, "12", "12 columns") + "</div>" +
      '<h4>Baseline</h4><div class="gd-row">' + opt("base", 0, "Off", "No baseline grid") + opt("base", 4, "4px", "A line every 4px") + opt("base", 8, "8px", "A line every 8px: check spacing and type sit on an 8-point rhythm") + "</div>" +
      '<p class="gd-hint">Columns show the layout grid; the baseline draws a line every 4 or 8px to check vertical rhythm.</p>';
    for (const b of document.querySelectorAll(".gd-opt")) b.addEventListener("click", () => {
      const v = b.dataset.value === "auto" ? "auto" : Number(b.dataset.value);
      if (b.dataset.key === "cols") view.gridCols = v;
      else view.baseStep = v;
      render();
      drawGuides();
    });
  }
  $(".guides-toggle").addEventListener("click", (e) => {
    const pop = $(".guides-pop");
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      const r = e.currentTarget.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 268)) + "px";
      pop.style.top = r.bottom + 6 + "px";
      drawGuides();
    }
  });
  addEventListener("pointerdown", (e) => { const pop = $(".guides-pop"); if (!pop.hidden && !e.target.closest(".guides-pop, .guides-toggle")) pop.hidden = true; });
  addEventListener("keydown", (e) => { if (e.key === "Escape") $(".guides-pop").hidden = true; });
  $(".pages-toggle").addEventListener("click", () => { view.pages = !view.pages; render(); loadPages(); });
  $(".reload").addEventListener("click", () => frames.forEach((f) => f.iframe.contentWindow.location.reload()));
  $(".exit").addEventListener("click", () => {
    const a = canvas.artboards.find((x) => x.id === focusedId()) || canvas.artboards[0];
    location.href = a ? a.url : ${src};
  });


  // Snapshot: the browser captures this tab (Chrome asks which tab each time), cropped to the screen, or to
  // both screens when another version is open, laid side by side with their labels. It goes to the clipboard,
  // ready to paste; Shift-click also saves a PNG (and so does a browser that won't allow the copy).
  $(".shot").addEventListener("click", async (e) => {
    const a = current();
    const f = a && frames.get(a.id);
    if (!f) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return note("This browser can't capture the page; use Chrome.");
    const download = e.shiftKey;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" });
    } catch { return note("Snapshot cancelled."); }
    const hide = (on) => frames.forEach((x) => { try { x.iframe.contentWindow.__uiTweaks.hideOverlay(on); } catch {} });
    // Fit the screen(s) in view for the capture, then put the zoom back.
    const kept = { zoom: focusZoom.get(a.id), pan: { ...focusPan } };
    fitFocus();
    hide(true);
    try {
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 300));
      const sx = video.videoWidth / innerWidth, sy = video.videoHeight / innerHeight;
      // Each side's badge colours, on the light card: yours blue, the other amber.
      const shots = [{ box: f.frame.getBoundingClientRect(), label: versusOn() ? labelParts("here") : null, ink: "#1d4ed8", tint: "#dbeafe" }];
      if (versusOn()) shots.push({ box: vs.frame.getBoundingClientRect(), label: labelParts("there"), ink: "#b45309", tint: "#fef3c7" });
      const crops = shots.map((s) => ({ ...s, w: Math.round(s.box.width * sx), h: Math.round(s.box.height * sy) }));
      const out = document.createElement("canvas");
      const ctx = out.getContext("2d");
      if (crops.length === 1) {
        out.width = crops[0].w;
        out.height = crops[0].h;
        ctx.drawImage(video, crops[0].box.left * sx, crops[0].box.top * sy, crops[0].w, crops[0].h, 0, 0, crops[0].w, crops[0].h);
      } else {
        // Side by side on a light card: each screen under its label (version, commit, when).
        const u = Math.max(1, crops[0].w / 600), pad = Math.round(32 * u), gap = Math.round(32 * u), lh = Math.round(64 * u);
        out.width = pad * 2 + crops.reduce((n, c) => n + c.w, 0) + gap * (crops.length - 1);
        out.height = pad * 2 + lh + Math.max(...crops.map((c) => c.h));
        ctx.fillStyle = "#f4f4f5";
        ctx.fillRect(0, 0, out.width, out.height);
        let x = pad;
        for (const c of crops) {
          // The branch as a pill with a dot, then its commit underneath.
          ctx.font = "600 " + Math.round(16 * u) + "px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
          const ph = Math.round(30 * u), px = Math.round(12 * u), dot = Math.round(4 * u);
          const pw = Math.min(c.w, Math.ceil(ctx.measureText(c.label[0]).width) + px * 2 + dot * 2 + Math.round(8 * u));
          ctx.fillStyle = c.tint;
          ctx.beginPath();
          ctx.roundRect(x, pad, pw, ph, ph / 2);
          ctx.fill();
          ctx.fillStyle = c.ink;
          ctx.beginPath();
          ctx.arc(x + px + dot, pad + ph / 2, dot, 0, Math.PI * 2);
          ctx.fill();
          ctx.textBaseline = "middle";
          ctx.fillText(c.label[0], x + px + dot * 2 + Math.round(8 * u), pad + ph / 2 + 1, pw - px * 2 - dot * 2 - Math.round(8 * u));
          ctx.fillStyle = "#71717a";
          ctx.font = Math.round(13 * u) + "px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
          ctx.fillText(c.label[1], x, pad + ph + Math.round(16 * u), c.w);
          ctx.textBaseline = "alphabetic";
          ctx.drawImage(video, c.box.left * sx, c.box.top * sy, c.w, c.h, x, pad + lh, c.w, c.h);
          ctx.strokeStyle = c.ink;
          ctx.lineWidth = Math.max(1, u);
          ctx.strokeRect(x - 0.5, pad + lh - 0.5, c.w + 1, c.h + 1);
          x += c.w + gap;
        }
      }
      const blob = await new Promise((r) => out.toBlob(r, "image/png"));
      const name = (a.name || "screen").replace(/[^\\w-]+/g, "-") + (versusOn() ? "-vs-" + versus.ref.replace(/[^\\w-]+/g, "-") : "") + ".png";
      const save = () => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.click();
      };
      let copied = false;
      try {
        window.focus();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copied = true;
      } catch {}
      if (download || !copied) save();
      note(copied ? (download ? "Copied to the clipboard and saved." : "Copied to the clipboard, ready to paste.") : "Couldn't copy (the browser refused), so it's saved as a PNG instead.");
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      hide(false);
      if (kept.zoom) focusZoom.set(a.id, kept.zoom);
      focusPan = kept.pan;
      layoutFocus();
    }
  });

  // ---------- another version, side by side ----------
  // A branch or commit runs from its own checkout on its own dev server (see versions.mjs); its frame sits
  // to the right of the screen you're editing, the same size, and follows its scrolling and navigation.
  let versus = null; // { ref, status, url, sha, subject, when, error }
  let refsInfo = null;
  const versusOn = () => !!(versus && view.versus);
  const vs = (() => {
    const el = document.createElement("div");
    el.className = "ab vs-ab hidden";
    el.innerHTML = '<div class="vs-label"></div><div class="ab-frame"><iframe title="Other version"></iframe><div class="ab-layer"></div><div class="vs-wait"></div></div>';
    return { el, label: el.querySelector(".vs-label"), frame: el.querySelector(".ab-frame"), iframe: el.querySelector("iframe"), layer: el.querySelector(".ab-layer"), wait: el.querySelector(".vs-wait"), src: null };
  })();
  world.append(vs.el);
  const STEPS = { preparing: "Getting ready…", "checking out": "Checking out", updating: "Updating the checkout of", installing: "Installing the dependencies of", starting: "Starting the dev server for" };
  function labelParts(side) {
    const cur = (refsInfo && refsInfo.current) || {};
    if (side === "here") return [(cur.name || "This version") + (cur.dirty ? " (with your changes)" : ""), [cur.sha, cur.dirty ? "uncommitted changes" : "last commit"].filter(Boolean).join(" · ")];
    return [versus.ref === cur.name ? versus.ref + " (last commit)" : versus.ref, [versus.sha, versus.when, versus.subject].filter(Boolean).join(" · ")];
  }
  // The branch badge, what that side is for, and its commit.
  function labelHtml(side) {
    const cur = (refsInfo && refsInfo.current) || {};
    // The branch you're on, opened again, is its last commit: say so, or the two look like the same thing.
    const sameBranch = versus.ref === cur.name;
    const name = side === "here" ? cur.name || "This version" : sameBranch ? versus.ref + " · last commit" : versus.ref;
    const role = side === "here" ? (cur.dirty ? "Editing · with your uncommitted changes" : "Editing") : sameBranch ? "Committed · without your changes" : "Comparing · view only";
    const meta = side === "here" ? [cur.sha, cur.dirty ? "uncommitted changes" : "last commit"].filter(Boolean).join(" · ") : [versus.sha, versus.when, versus.subject].filter(Boolean).join(" · ");
    return '<span class="vs-branch" title="' + esc(name) + '"><span>' + esc(name) + '</span></span><span class="vs-role">' + esc(role) + '</span><span class="vs-meta" title="' + esc(meta) + '">' + esc(meta) + "</span>";
  }
  function placeVersus(a) {
    const on = versusOn();
    viewport.classList.toggle("versus", on);
    vs.el.classList.toggle("hidden", !on);
    $(".vs-toggle").classList.toggle("on", on);
    $(".vs-toggle").textContent = on ? "⑂ " + versus.ref : "⑂ Versions";
    if (drawModes.on !== on) {
      drawModes.on = on;
      drawModes();
      const ff = frames.get(a.id);
      if (ff) applyMode(ff); // leaving the comparison turns picking back on
    }
    const f = frames.get(a.id);
    if (!on) return;
    const [w, h] = size(a);
    Object.assign(vs.el.style, { left: a.x + w + VS_GAP + "px", top: a.y + "px" });
    Object.assign(vs.frame.style, { width: w + "px", height: h + "px" });
    // Runs a few times a second while comparing: only touch the DOM when something changed.
    const put = (el, html) => { if (el && el.__html !== html) { el.__html = html; el.innerHTML = html; } };
    put(vs.layer, overlays(w));
    if (f) put(f.el.querySelector(".vs-label"), labelHtml("here"));
    put(vs.label, labelHtml("there"));
    const ready = versus.status === "ready" && versus.url;
    vs.wait.hidden = !!ready;
    if (!ready) vs.wait.textContent = versus.status === "failed" ? "Couldn't open " + versus.ref + ":\\n" + (versus.error || "") : (STEPS[versus.status] || "Opening") + " " + versus.ref + "…";
    const want = ready ? versus.url + pathOf(f) : null;
    if (want && vs.src !== want) {
      // A new version or screen loads; after that the frame follows by message instead of reloading.
      if (!vs.src || !vs.src.startsWith(versus.url)) { vs.src = want; vs.iframe.src = want; }
      else { vs.src = want; mirror({ nav: want.slice(versus.url.length) }); }
    }
  }
  // Where the screen you're editing is now (it may have moved in-app since it loaded).
  function pathOf(f) {
    try { const l = f.iframe.contentWindow.location; if (l.origin === location.origin) return l.pathname + l.search + l.hash; } catch {}
    const a = current();
    return a ? a.url : "/";
  }
  function mirror(msg) {
    if (!versusOn() || versus.status !== "ready" || !vs.iframe.contentWindow) return;
    try { vs.iframe.contentWindow.postMessage({ uit: "mirror", ...msg }, versus.url); } catch {}
  }
  // Scrolling in the screen you're editing: the page, or the element that scrolled (by position from <body>).
  function scrollMsg(doc, target) {
    if (!target || target === doc || target === doc.documentElement || target === doc.scrollingElement) {
      const se = doc.scrollingElement || doc.documentElement;
      return { path: null, top: se.scrollTop, left: se.scrollLeft };
    }
    const path = [];
    for (let el = target; el && el !== doc.body; el = el.parentElement) {
      if (!el.parentElement) return null;
      path.unshift(Array.prototype.indexOf.call(el.parentElement.children, el));
    }
    return { path, top: target.scrollTop, left: target.scrollLeft };
  }
  const followed = new WeakSet();
  function follow(f) {
    let win;
    try { win = f.iframe.contentWindow; if (!win || followed.has(win.document)) return; followed.add(win.document); } catch { return; }
    let queued = null;
    win.addEventListener("scroll", (e) => {
      if (!versusOn() || frames.get(focusedId()) !== f) return;
      queued = e.target;
      requestAnimationFrame(() => { if (queued) { const m = scrollMsg(win.document, queued); queued = null; if (m) mirror({ scroll: m }); } });
    }, { capture: true, passive: true });
    // Interact mode: clicks and entries in your screen are repeated on the other version.
    const mirroring = () => versusOn() && view.vsMode === "interact" && view.vsMirror !== false && frames.get(focusedId()) === f;
    const describe = (el) => {
      const m = scrollMsg(win.document, el);
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
      return m && m.path ? { path: m.path, tag: el.tagName, text } : null;
    };
    win.addEventListener("click", (e) => {
      if (!mirroring() || !e.isTrusted || !(e.target instanceof win.Element)) return;
      const el = e.target.closest("button, a, [role=button], [role=tab], [role=link], label, summary, input, select, textarea, [onclick], [tabindex]") || e.target;
      const d = describe(el);
      if (d) mirror({ click: d });
    }, true);
    win.addEventListener("input", (e) => {
      const el = e.target;
      if (!mirroring() || !e.isTrusted || !el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.type === "checkbox" || el.type === "radio" || el.type === "file") return;
      const d = describe(el);
      if (d) mirror({ input: { ...d, text: "", value: el.value } });
    }, true);
    applyMode(f);
  }
  // Inspect: clicking picks elements to tweak. Interact: picking is off, so you can use the app.
  function applyMode(f) {
    try { f.iframe.contentWindow.__uiTweaks.setPicking(!(versusOn() && view.vsMode === "interact")); } catch {}
  }
  function setVsMode(mode) {
    view.vsMode = mode;
    saveView();
    const f = frames.get(focusedId());
    if (f) applyMode(f);
    drawModes();
  }
  function drawModes() {
    const on = versusOn();
    $(".vs-modes").hidden = !on;
    $(".vs-mirror").hidden = !on || view.vsMode !== "interact";
    for (const b of document.querySelectorAll(".vs-modes button")) b.classList.toggle("on", b.dataset.mode === (view.vsMode || "inspect"));
    $(".vs-mirror").classList.toggle("on", view.vsMirror !== false);
  }
  for (const b of document.querySelectorAll(".vs-modes button")) b.addEventListener("click", () => setVsMode(b.dataset.mode));
  $(".vs-mirror").addEventListener("click", () => { view.vsMirror = view.vsMirror === false; saveView(); drawModes(); note(view.vsMirror ? "Clicks and typing repeat on the other version" : "Each side on its own: click through them separately"); });
  addEventListener("message", (e) => {
    if (versus && e.origin === versus.url && e.data && e.data.uit === "mirror-miss") note("Not on " + versus.ref + ": “" + e.data.what + "”. Click it there yourself.");
    if (!versus || !versus.url || e.origin !== versus.url || !e.data || e.data.uit !== "mirror-ready") return;
    const f = frames.get(focusedId());
    try { const se = f.iframe.contentWindow.document.scrollingElement; mirror({ scroll: { path: null, top: se.scrollTop, left: se.scrollLeft } }); } catch {}
  });
  // While comparing: catch in-app navigation and newly loaded pages in the screen you're editing.
  setInterval(() => {
    if (!versusOn()) return;
    const f = frames.get(focusedId());
    if (!f) return;
    follow(f);
    if (versus.status === "ready") { const a = current(); if (a) placeVersus(a); }
  }, 400);

  async function pollVersus() {
    clearTimeout(pollVersus.t);
    if (!view.versus) return;
    try {
      const data = await fetch("/__ui-tweaks/versions", { cache: "no-store" }).then((r) => r.json());
      const run = (data.running || []).find((r) => r.ref === view.versus);
      if (!run) {
        // The dev server restarted (the versions stop with it): open it again.
        if (!versus || versus.status !== "failed") return openVersion(view.versus);
      } else versus = run;
    } catch {}
    layoutFocus();
    if (versus && versus.status !== "ready" && versus.status !== "failed") pollVersus.t = setTimeout(pollVersus, 700);
    else if (versus && versus.status === "ready") pollVersus.t = setTimeout(pollVersus, 5000);
    if (!$(".vs-pop").hidden) drawVersions();
  }
  async function openVersion(ref) {
    const was = versusOn();
    view.versus = ref;
    saveView();
    vs.src = null;
    vs.iframe.src = "about:blank";
    try {
      const res = await fetch("/__ui-tweaks/versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref }) });
      const data = await res.json();
      versus = res.ok ? data : { ref, status: "failed", error: data.error };
    } catch (err) { versus = { ref, status: "failed", error: String(err) }; }
    if (!refsInfo) loadRefs();
    if (!was) { focusPan.id = null; }
    layoutFocus();
    pollVersus();
  }
  async function closeVersion() {
    const ref = view.versus;
    view.versus = null;
    versus = null;
    saveView();
    vs.src = null;
    vs.iframe.src = "about:blank";
    focusPan.id = null;
    layoutFocus();
    $(".vs-pop").hidden = true;
    if (ref) fetch("/__ui-tweaks/versions?ref=" + encodeURIComponent(ref), { method: "DELETE" }).catch(() => {});
  }
  async function loadRefs() {
    try { refsInfo = await fetch("/__ui-tweaks/versions?refs", { cache: "no-store" }).then((r) => r.json()); } catch { refsInfo = { error: "Couldn't list the branches." }; }
    if (!$(".vs-pop").hidden) drawVersions();
    if (versusOn()) layoutFocus();
  }
  function drawVersions() {
    const pop = $(".vs-pop");
    const q = (pop.querySelector("input") || {}).value || "";
    let html = '<div class="vs-now">';
    if (versusOn()) {
      html += "Showing <b>" + esc(versus.ref) + "</b> next to " + esc(labelParts("here")[0]) + (versus.status === "ready" ? "" : " · " + esc(versus.status)) + '<button class="vs-close">Close the comparison</button>';
    } else {
      html += "Pick a branch to show it beside this screen. It opens from its own checkout, so yours isn't touched.";
    }
    html += "</div>";
    if (versus && versus.status === "failed") html += '<div class="vs-err">' + esc(versus.error || "") + (versus.log ? "\\n\\n" + esc(versus.log) : "") + "</div>";
    if (!refsInfo) html += '<div class="vs-now">Loading branches…</div>';
    else if (refsInfo.error) html += '<div class="vs-err">' + esc(refsInfo.error) + "</div>";
    else {
      const match = (r) => !q || r.name.toLowerCase().includes(q.toLowerCase());
      const item = (r) => '<button class="vs-ref' + (versus && versus.ref === r.name ? " on" : "") + '" data-ref="' + esc(r.name) + '">' + esc(r.name) + (r.name === refsInfo.current.name ? (refsInfo.current.dirty ? " (last commit, without your changes)" : " (this checkout)") : "") + "<span>" + esc([r.sha, r.when, r.subject].join(" · ")) + "</span></button>";
      const local = refsInfo.refs.filter((r) => !r.remote && match(r)), remote = refsInfo.refs.filter((r) => r.remote && match(r));
      html += '<input placeholder="Find a branch, or type a commit / tag" value="' + esc(q) + '" /><div class="vs-list">';
      if (local.length) html += "<h4>Branches</h4>" + local.map(item).join("");
      if (remote.length) html += "<h4>Remote</h4>" + remote.map(item).join("");
      if (!local.length && !remote.length) html += '<div class="vs-now">No branch matches; press Enter to open “' + esc(q) + "” as a commit or tag.</div>";
      html += "</div>";
    }
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest(".vs-pop");
    pop.innerHTML = html;
    const input = pop.querySelector("input");
    if (input) {
      if (focused) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      input.addEventListener("input", drawVersions);
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") pop.hidden = true;
        if (e.key === "Enter" && input.value.trim()) { const first = pop.querySelector(".vs-ref"); openVersion(first ? first.dataset.ref : input.value.trim()); pop.hidden = true; }
      });
    }
    for (const b of pop.querySelectorAll(".vs-ref")) b.addEventListener("click", () => { openVersion(b.dataset.ref); pop.hidden = true; });
    const close = pop.querySelector(".vs-close");
    if (close) close.addEventListener("click", closeVersion);
  }
  $(".vs-toggle").addEventListener("click", () => {
    const pop = $(".vs-pop");
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { drawVersions(); loadRefs(); const i = pop.querySelector("input"); if (i) i.focus(); }
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") $(".vs-pop").hidden = true; });
  addEventListener("pointerdown", (e) => { const pop = $(".vs-pop"); if (!pop.hidden && !e.target.closest(".vs-pop, .vs-toggle")) pop.hidden = true; });
  if (view.versus) { loadRefs(); pollVersus(); }

  new ResizeObserver(() => {
    // Screens still at their automatic fit refit to the new space.
    for (const [id, z] of focusZoom) if (z.auto) focusZoom.delete(id);
    focusPan.id = null;
    drawMinimap();
    if (isFocus()) { render(); applyCam(); }
  }).observe(viewport);
  (async () => {
    try {
      const data = await fetch("/__ui-tweaks/canvas", { cache: "no-store" }).then((r) => r.json());
      canvas = data.canvas;
      version = data.version;
    } catch {}
    // Opened from a page that isn't on the canvas yet: add it.
    if (${src} !== "/" && !canvas.artboards.some((a) => a.url === ${src})) canvas.artboards.push({ id: newId(), name: ${src}, device: (canvas.artboards[0] || {}).device || "i16", url: ${src}, ...place() });
    render();
    if (!view.cam) fitTo(canvas.artboards);
    else applyCam();
    loadPages();
  })();
</script>
</body>
</html>`;
}

/**
 * The app's pages, for the studio's sidebar: Next.js app/ and pages/ routes, router `path` definitions
 * in the source, and HTML files. Dynamic segments ([id], :id) are kept as written.
 */
export async function findRoutes(root) {
  const routes = await findAppRoutes(root);
  const pending = (await readPending(root)).batches.map((b) => b.page && b.page.path).filter(Boolean);
  return { routes, pending: [...new Set(pending)] };
}

/**
 * Tells the Claude Code mod where this dev server is: <root>/.ui-tweaks/server.json, and a registry
 * entry in ~/.ui-tweaks/servers/ for sessions started in another folder. The entry goes when we exit
 * cleanly; the mod checks a server answers before using it, so a stale entry is harmless.
 */
// What the Claude Code mod is applying right now ({ by: "haiku" | "claude", count, startedAt }), or null.
// A run that's been going for over ten minutes is taken as left over from a session that went away.
async function readRunning(root) {
  try {
    const r = JSON.parse(await fs.readFile(path.join(tweaksDir(root), "running.json"), "utf8"));
    return r && r.by && Date.now() - (r.startedAt || 0) < 10 * 60 * 1000 ? r : null;
  } catch {
    return null;
  }
}

export async function announceServer(root, url) {
  const dir = tweaksDir(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".gitignore"), GITIGNORE);
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
export function createTweaksHandler({ root, getVersion, commit = false }) {
  return async function handle(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) return next();
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (req.method === "GET" && url.pathname === `${PREFIX}/canvas`) {
        return send(res, 200, await readCanvas(root));
      }
      if (req.method === "PUT" && url.pathname === `${PREFIX}/canvas`) {
        const version = await writeCanvas(root, JSON.parse(await readBody(req)));
        return send(res, 200, { ok: true, version });
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/system`) {
        return send(res, 200, systemPage(), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/tokens`) {
        return send(res, 200, { project: path.basename(root), ...(await scanTokens(root)) });
      }
      // Token edits from the design system page: written straight to the stylesheet, undoable like an apply.
      if ((req.method === "PUT" && url.pathname === `${PREFIX}/tokens`) || (req.method === "POST" && /^\/__ui-tweaks\/tokens\/(adopt|create)$/.test(url.pathname))) {
        const body = JSON.parse(await readBody(req));
        try {
          const action = req.method === "PUT" ? "set" : url.pathname.split("/").pop();
          const out = action === "set" ? { files: [await setToken(root, body)], count: 1 } : action === "adopt" ? await adoptToken(root, body) : await createToken(root, body);
          if (!out.files.length) return send(res, 200, { ok: true, count: 0, files: [] });
          await recordHistory(root, { by: "tokens", count: out.count, files: out.files });
          const what = action === "set" ? `${body.name}: ${body.from} → ${body.to}` : action === "adopt" ? `${body.value} → var(${body.token}) ×${out.count}` : `new ${body.name}: ${body.value}, used ×${out.count}`;
          await appendLog(root, [{ at: Date.now(), id: `tok-${Date.now().toString(36)}`, element: "design system", by: "tokens", outcome: "applied", props: [what], files: out.files.map((f) => path.relative(root, f.path)) }]);
          return send(res, 200, { ok: true, count: out.count, files: out.files.map((f) => path.relative(root, f.path)) });
        } catch (error) {
          return send(res, error.status || 500, { error: error.message });
        }
      }
      // The panel's History view: undoable applies (newest last) and recent outcomes from the log.
      if (req.method === "GET" && url.pathname === `${PREFIX}/history`) {
        let log = [];
        try {
          log = (JSON.parse(await fs.readFile(path.join(tweaksDir(root), "log.json"), "utf8")).entries || []).slice(-40);
        } catch {}
        return send(res, 200, { entries: (await readHistory(root)).map((e) => ({ id: e.id, at: e.at, by: e.by, count: e.count, files: e.files.map((f) => path.relative(root, f)) })), log });
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/breakpoints`) {
        const summary = await scanBreakpoints(root);
        const width = Number(url.searchParams.get("width"));
        return send(res, 200, { ...summary, scope: width > 0 ? scopeFor(summary, width) : null });
      }
      // Other versions of the app (a branch or commit) for the studio's side-by-side view.
      if (url.pathname === `${PREFIX}/versions`) {
        if (req.method === "GET") return send(res, 200, url.searchParams.has("refs") ? await listRefs(root) : { running: versionStatus(root) });
        const ref = req.method === "DELETE" ? url.searchParams.get("ref") : JSON.parse(await readBody(req)).ref;
        try {
          if (req.method === "DELETE") return send(res, 200, { ok: true, stopped: await stopVersion(root, ref) });
          if (req.method === "POST") return send(res, 200, await startVersion(root, ref));
        } catch (error) {
          return send(res, error.status || 500, { error: error.message });
        }
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/routes`) {
        return send(res, 200, await findRoutes(root));
      }
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
          update: updateStatus(),
          asks: await askStatus(root),
          running: await readRunning(root),
        });
      }
      if (req.method === "POST" && url.pathname === `${PREFIX}/undo`) {
        const { status, body } = await undoLastApply(root);
        return send(res, status, body);
      }
      // Dry run of a Send: what would be written directly (as diffs) and what is left for Haiku. Writes nothing.
      if (req.method === "POST" && url.pathname === `${PREFIX}/preview`) {
        const batch = JSON.parse(await readBody(req));
        if (!batch || !Array.isArray(batch.tweaks) || batch.tweaks.length === 0) return send(res, 400, { error: "batch.tweaks must be a non-empty array" });
        batch.tweaks.forEach((t, i) => (t.id = `preview-${i}`));
        const direct = await applyDirect(root, batch);
        return send(res, 200, {
          files: direct.files.map((f) => ({ path: path.relative(root, f.path), diff: unifiedDiff(path.relative(root, f.path), f.before, f.after) })),
          direct: direct.applied.map((a) => ({ id: a.id, props: a.props, text: a.text })),
          queued: direct.remaining.map((t) => ({ id: t.id, reason: t.directSkip })),
        });
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
        // Committing is opt-in, and only for files that were clean before this write.
        const clean = commit && direct.files.length ? await filesAreClean(root, direct.files.map((f) => f.path)) : null;
        for (const f of direct.files) await fs.writeFile(f.path, f.after);
        await fs.mkdir(tweaksDir(root), { recursive: true });
        await fs.writeFile(path.join(tweaksDir(root), ".gitignore"), GITIGNORE);
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
        let committed = null;
        if (clean) {
          const what = direct.applied.map((a) => `${label(byId.get(a.id))} ${[...a.props, ...(a.text ? ["text"] : [])].join(", ")}`).join("; ");
          const message = `UI tweak: ${what.length > 68 ? what.slice(0, 67) + "…" : what}`;
          committed = clean.ok ? await commitFiles(root, direct.files.map((f) => f.path), message) : { ok: false, reason: clean.reason };
        }
        return send(res, 200, { ok: true, id: batch.id, direct: direct.applied.map((a) => a.id), queued: direct.remaining.map((t) => t.id), commit: committed });
      }
      // "Copy as code": an element's JSX as written, and styles as Tailwind classes.
      if (req.method === "GET" && url.pathname === `${PREFIX}/jsx`) {
        const code = await jsxAt(root, url.searchParams.get("loc"));
        return send(res, code === null ? 404 : 200, code === null ? { error: "No JSX found at that line" } : { code });
      }
      if (req.method === "POST" && url.pathname === `${PREFIX}/tailwind`) {
        return send(res, 200, toTailwind(JSON.parse(await readBody(req)).styles));
      }
      if (req.method === "POST" && url.pathname === `${PREFIX}/ask`) {
        try {
          return send(res, 200, { ok: true, ask: await addAsk(root, JSON.parse(await readBody(req))) });
        } catch (error) {
          return send(res, error.status || 500, { error: error.message });
        }
      }
      if (req.method === "DELETE" && url.pathname.startsWith(`${PREFIX}/ask/`)) {
        await cancelAsk(root, url.pathname.slice(`${PREFIX}/ask/`.length));
        return send(res, 200, { ok: true });
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
