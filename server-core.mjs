// Shared request handler for the UI Tweaks overlay.
// Serves the overlay script and stores batches of tweaks in <root>/.ui-tweaks/pending.json,
// which the Claude Code "ui-tweaks" mod watches.
import { updateStatus } from "./update.mjs";
import { adoptToken, createToken, scanTokens, setToken } from "./tokens.mjs";
import { systemPage } from "./system-page.mjs";
import { addAsk, askStatus, cancelAsk } from "./asks.mjs";
import { promises as fs, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyDirect, sourceFiles } from "./direct-apply.mjs";
import { unifiedDiff } from "./diff.mjs";

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
  .pages { width: 200px; flex: none; border-right: 1px solid var(--line); background: var(--bar); overflow-y: auto; padding: 8px 0; }
  .pages h4 { margin: 10px 12px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); font-weight: 600; }
  .pages button { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 12px; border: 0; background: transparent; text-align: left; cursor: pointer; }
  .pages button:hover { background: #2c2c2c; }
  .pages button i { width: 6px; height: 6px; border-radius: 3px; background: #7b61ff; flex: none; }
  .pages .src { color: var(--dim); font-size: 10px; margin-left: auto; }
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
  #ui-tweaks-root { width: 280px; flex: none; background: #1e1e1e; border-left: 1px solid var(--line); overflow: hidden; }
  .waiting { padding: 24px 18px; color: var(--dim); line-height: 1.5; text-align: center; }
  @media (max-width: 720px) { #ui-tweaks-root { width: 264px; } .minimap { display: none; } }
</style>
</head>
<body>
<div class="studio">
  <div class="stage">
    <div class="toolbar">
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
        <span class="sep"></span>
        <select class="focus-device" title="Device"></select>
        <button class="focus-turn" title="Rotate">⟲</button>
        <span class="zoom focus-zoom"></span>
      </span>
      <span class="sep"></span>
      <button class="grid" title="Column grid">Grid</button>
      <button class="base" title="8pt baseline">8pt</button>
      <button class="compare" title="Hold to see every artboard without your previews (or hold \\ in the app)">Compare</button>
      <button class="shot" title="Snapshot of the selected artboard as a PNG">📷</button>
      <span class="sep"></span>
      <a class="tb" href="/__ui-tweaks/system" title="Design system: every token in your CSS, editable">Tokens</a>
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
  let focusPan = { x: 0, y: 0, id: null };
  function layoutFocus() {
    const a = canvas.artboards.find((x) => x.id === focusedId());
    if (!a) return;
    const [w, h] = size(a);
    const vw = viewport.clientWidth, vh = viewport.clientHeight, pad = 24;
    const clamp = (v, size, room) => (size + pad * 2 <= room ? (room - size) / 2 : Math.min(pad, Math.max(room - size - pad, v)));
    if (focusPan.id !== a.id + ":" + w + "x" + h) focusPan = { x: (vw - w) / 2, y: pad, id: a.id + ":" + w + "x" + h };
    focusPan.x = clamp(focusPan.x, w, vw);
    focusPan.y = clamp(focusPan.y, h, vh);
    world.style.transform = "translate(" + focusPan.x + "px," + focusPan.y + "px) translate(" + -a.x + "px," + -a.y + "px)";
    world.style.setProperty("--iz", "1");
    $(".focus-zoom").textContent = w + "×" + h + " · 100%";
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
      if (e.ctrlKey || e.metaKey) return;
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
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomAt(cam.z * 1.25, ...center()); }
    if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); zoomAt(cam.z / 1.25, ...center()); }
    if (e.shiftKey && e.code === "Digit1") fitTo(canvas.artboards);
    if (e.shiftKey && e.code === "Digit0") zoomAt(1, ...center());
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
    return a.turned ? [d[3], d[2]] : [d[2], d[3]];
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
    if (view.grid) {
      const [n, margin, gutter] = w < 600 ? [4, 16, 16] : w < 1024 ? [8, 24, 24] : [12, 32, 24];
      html += '<div class="grid-cols" style="padding:0 ' + margin + "px;gap:" + gutter + 'px">' + "<div></div>".repeat(n) + "</div>";
    }
    if (view.base) html += '<div class="baseline"></div>';
    return html;
  }

  function makeFrame(a, isPrimary) {
    const el = document.createElement("div");
    el.className = "ab";
    el.innerHTML = '<div class="ab-head"></div><div class="ab-frame"><iframe title="Artboard"></iframe><div class="ab-layer"></div></div>';
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
    for (const [cls, key] of [[".grid", "grid"], [".base", "base"], [".pages-toggle", "pages"]]) $(cls).classList.toggle("on", !!view[key]);
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
  async function loadPages() {
    if (!view.pages) return;
    const box = $(".pages");
    let data = { routes: [], pending: [] };
    try { data = await fetch("/__ui-tweaks/routes").then((r) => r.json()); } catch {}
    box.innerHTML = "<h4>Add a screen for</h4>" + (data.routes.length ? data.routes.map((r) => '<button data-path="' + esc(r.path) + '">' + (data.pending.includes(r.path) ? "<i title='Has pending tweaks'></i>" : "") + "<span>" + esc(r.path) + '</span><span class="src">' + esc(r.source) + "</span></button>").join("") : '<div class="pages-empty">No routes found.</div>');
    for (const b of box.querySelectorAll("button[data-path]")) b.addEventListener("click", () => {
      const p = b.dataset.path;
      if (/[\\[:*]/.test(p)) return note("That route needs a value: add it, then fill it in with ✎.");
      const a = addArtboard({ url: p, name: p === "/" ? "Home" : p });
      setMode("focus", a.id);
    });
  }

  // ---------- toolbar ----------
  const current = () => canvas.artboards.find((x) => x.id === focusedId());
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
  for (const [cls, key] of [[".grid", "grid"], [".base", "base"]]) $(cls).addEventListener("click", () => { view[key] = !view[key]; render(); });
  $(".pages-toggle").addEventListener("click", () => { view.pages = !view.pages; render(); loadPages(); });
  $(".reload").addEventListener("click", () => frames.forEach((f) => f.iframe.contentWindow.location.reload()));
  $(".exit").addEventListener("click", () => {
    const a = canvas.artboards.find((x) => x.id === focusedId()) || canvas.artboards[0];
    location.href = a ? a.url : ${src};
  });
  const compare = (on) => frames.forEach((f) => { try { f.iframe.contentWindow.__uiTweaks.compare(on); } catch {} });
  const cmp = $(".compare");
  cmp.addEventListener("pointerdown", () => { cmp.classList.add("on"); compare(true); });
  for (const ev of ["pointerup", "pointerleave"]) cmp.addEventListener(ev, () => { if (cmp.classList.contains("on")) { cmp.classList.remove("on"); compare(false); } });

  // Snapshot: the browser captures this tab (it asks each time), cropped to the selected artboard.
  $(".shot").addEventListener("click", async () => {
    const a = canvas.artboards.find((x) => x.id === focusedId()) || canvas.artboards[0];
    const f = a && frames.get(a.id);
    if (!f) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return note("This browser can't capture the page; use Chrome.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" });
    } catch { return note("Snapshot cancelled."); }
    const hide = (on) => frames.forEach((x) => { try { x.iframe.contentWindow.__uiTweaks.hideOverlay(on); } catch {} });
    hide(true);
    try {
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 250));
      const sx = video.videoWidth / innerWidth, sy = video.videoHeight / innerHeight;
      const box = f.frame.getBoundingClientRect();
      const out = document.createElement("canvas");
      out.width = Math.round(box.width * sx);
      out.height = Math.round(box.height * sy);
      out.getContext("2d").drawImage(video, box.left * sx, box.top * sy, out.width, out.height, 0, 0, out.width, out.height);
      const blob = await new Promise((r) => out.toBlob(r, "image/png"));
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = (a.name || "artboard").replace(/[^\\w-]+/g, "-") + ".png";
      link.click();
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); note("Snapshot saved and copied."); } catch { note("Snapshot saved."); }
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      hide(false);
    }
  });

  new ResizeObserver(() => { drawMinimap(); if (isFocus()) { render(); applyCam(); } }).observe(viewport);
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
  const routes = new Map(); // path -> source
  const add = (p, source) => {
    const clean = ("/" + p).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
    if (!routes.has(clean)) routes.set(clean, source);
  };
  for (const file of await sourceFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const next = /^(?:src\/)?app\/(.*?)\/?page\.(?:tsx|jsx|ts|js|mdx)$/.exec(rel) || /^(?:src\/)?app\/()page\.(?:tsx|jsx|ts|js|mdx)$/.exec(rel);
    if (next) {
      add(next[1].split("/").filter((seg) => !/^\(.*\)$/.test(seg) && !seg.startsWith("@")).join("/"), "app");
      continue;
    }
    const pages = /^(?:src\/)?pages\/(.*)\.(?:tsx|jsx|ts|js)$/.exec(rel);
    if (pages && !/(^|\/)(_app|_document|_error)$/.test(pages[1]) && !pages[1].startsWith("api/")) {
      add(pages[1].replace(/(^|\/)index$/, ""), "pages");
      continue;
    }
    if (rel.endsWith(".html") && !rel.startsWith(".")) {
      add(rel === "index.html" ? "" : rel.replace(/(^|\/)index\.html$/, "$1"), "html");
      continue;
    }
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const m of text.matchAll(/\bpath\s*[:=]\s*\{?\s*["'`](\/[^"'`\s]*)["'`]/g)) add(m[1], "router");
  }
  if (!routes.size) add("", "");
  const pending = (await readPending(root)).batches.map((b) => b.page && b.page.path).filter(Boolean);
  return {
    routes: [...routes].map(([p, source]) => ({ path: p, source })).sort((a, b) => a.path.localeCompare(b.path)),
    pending: [...new Set(pending)],
  };
}

/**
 * Tells the Claude Code mod where this dev server is: <root>/.ui-tweaks/server.json, and a registry
 * entry in ~/.ui-tweaks/servers/ for sessions started in another folder. The entry goes when we exit
 * cleanly; the mod checks a server answers before using it, so a stale entry is harmless.
 */
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
export function createTweaksHandler({ root, getVersion }) {
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
        return send(res, 200, { ok: true, id: batch.id, direct: direct.applied.map((a) => a.id), queued: direct.remaining.map((t) => t.id) });
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
