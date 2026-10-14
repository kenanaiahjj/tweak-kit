// Shared request handler for the UI Tweaks overlay.
// Serves the overlay script and stores batches of tweaks in <root>/.ui-tweaks/pending.json,
// which the Claude Code "ui-tweaks" mod watches.
import { promises as fs, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyDirect, sourceFiles } from "./direct-apply.mjs";

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
 * Docked mode: the app in one or more device frames, the overlay's own panel docked on the right.
 * The overlay in the first frame finds #ui-tweaks-root here and moves its panel into it; the others
 * mirror its previews, and whichever frame you click in takes the panel over.
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
  button, select { font: inherit; color: var(--text); }
  .studio { display: flex; height: 100vh; }
  .stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .toolbar { height: 40px; flex: none; display: flex; align-items: center; gap: 2px; padding: 0 6px; background: var(--bar); border-bottom: 1px solid var(--line); min-width: 0; overflow: hidden; }
  .toolbar button, .frame-head button { height: 26px; padding: 0 7px; border: 1px solid transparent; border-radius: 5px; background: transparent; cursor: pointer; flex: none; white-space: nowrap; }
  .toolbar button:hover, .frame-head button:hover { background: #2c2c2c; }
  .toolbar button.on { background: var(--accent); color: #fff; }
  .toolbar button:disabled { opacity: .35; cursor: default; }
  select { height: 26px; min-width: 0; max-width: 200px; padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; background: #2c2c2c; cursor: pointer; flex: 0 1 auto; }
  .sep { width: 1px; height: 16px; background: var(--line); margin: 0 4px; flex: none; }
  .path { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; margin-left: 6px; }
  .note { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); background: #2c2c2c; border: 1px solid var(--line); padding: 7px 12px; border-radius: 7px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .note.show { opacity: 1; }
  .body { flex: 1; min-height: 0; display: flex; }
  .pages { width: 200px; flex: none; border-right: 1px solid var(--line); background: var(--bar); overflow-y: auto; padding: 8px 0; }
  .pages h4 { margin: 10px 12px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); font-weight: 600; }
  .pages button { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 12px; border: 0; background: transparent; text-align: left; cursor: pointer; color: var(--text); }
  .pages button:hover { background: #2c2c2c; }
  .pages button.on { color: var(--accent); }
  .pages button i { width: 6px; height: 6px; border-radius: 3px; background: #7b61ff; flex: none; }
  .pages .src { color: var(--dim); font-size: 10px; margin-left: auto; }
  .pages .empty { padding: 4px 12px; color: var(--dim); }
  .canvas { flex: 1; min-width: 0; min-height: 0; overflow: auto; display: flex; justify-content: safe center; align-items: safe center; gap: 24px; padding: 12px; background: var(--bg); background-image: radial-gradient(#ffffff0d 1px, transparent 1px); background-size: 16px 16px; }
  .canvas.fit { padding: 0; }
  .col { flex: none; display: flex; flex-direction: column; gap: 6px; }
  .frame-head { height: 28px; display: flex; align-items: center; gap: 2px; min-width: 0; overflow: hidden; }
  .frame-head select { flex: 1 1 auto; min-width: 48px; max-width: 170px; }
  .frame-head .dims { color: var(--dim); margin: 0 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; font-variant-numeric: tabular-nums; font-size: 11px; }
  .frame-head button { padding: 0 5px; }
  .wrap { flex: none; overflow: hidden; position: relative; border-radius: 8px; box-shadow: 0 0 0 1px var(--line), 0 12px 40px rgba(0,0,0,.45); }
  .fit .wrap { border-radius: 0; box-shadow: none; }
  .screen { position: absolute; top: 0; left: 0; transform-origin: top left; }
  .screen iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
  .layer { position: absolute; inset: 0; pointer-events: none; }
  .chrome-bar { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 28px; font-weight: 600; font-size: 15px; color: #fff; mix-blend-mode: difference; }
  .island { position: absolute; left: 50%; transform: translateX(-50%); background: #000; }
  .home-bar { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); height: 5px; border-radius: 3px; background: #fff; mix-blend-mode: difference; }
  .fold { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; transform: translateX(-50%); background: linear-gradient(90deg, transparent, rgba(0,0,0,.18), transparent); box-shadow: 0 0 12px rgba(0,0,0,.25); }
  .grid-cols { position: absolute; inset: 0; display: flex; }
  .grid-cols div { flex: 1; background: rgba(242, 72, 34, .1); }
  .baseline { position: absolute; inset: 0; background-image: repeating-linear-gradient(to bottom, rgba(13, 153, 255, .22) 0 1px, transparent 1px 8px); }
  #ui-tweaks-root { width: 280px; flex: none; background: #1e1e1e; border-left: 1px solid var(--line); overflow: hidden; }
  .waiting { padding: 24px 18px; color: var(--dim); line-height: 1.5; text-align: center; }
  @media (max-width: 720px) { #ui-tweaks-root { width: 264px; } .path { display: none; } }
</style>
</head>
<body>
<div class="studio">
  <div class="stage">
    <div class="toolbar">
      <button class="exit" title="Leave docked mode">✕</button>
      <button class="reload" title="Reload every frame">↻</button>
      <button class="pages-toggle" title="Pages">☰</button>
      <span class="sep"></span>
      <button class="fit-btn" title="One frame filling the space">Fit</button>
      <select class="add" title="Add a device"></select>
      <span class="sep"></span>
      <button class="chrome" title="Status bar, notch or Dynamic Island, home indicator">Chrome</button>
      <button class="grid" title="Column grid">Grid</button>
      <button class="base" title="8pt baseline">8pt</button>
      <button class="compare" title="Hold to see the page without your previews (or hold \\ in the app)">Compare</button>
      <button class="shot" title="Snapshot of the devices as a PNG">📷</button>
      <span class="path"></span>
    </div>
    <div class="body">
      <div class="pages" hidden></div>
      <div class="canvas"></div>
    </div>
  </div>
  <div id="ui-tweaks-root"><div class="waiting">Loading your app…<br />The panel docks here once it's up.</div></div>
</div>
<div class="note"></div>
<script>
  // Screen sizes in CSS px (portrait), and what the device draws over the page.
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

  const $ = (s) => document.querySelector(s);
  const canvas = $(".canvas");
  const KEY = "ui-tweaks:studio";
  let path = ${src};
  // frames: [{ device, turned }]; one frame with no device = Fit.
  let view = { frames: [{ device: "", turned: false }], chrome: true, grid: false, base: false, pages: false };
  try { view = { ...view, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch {}
  if (!Array.isArray(view.frames) || !view.frames.length) view.frames = [{ device: "", turned: false }];
  view.frames = view.frames.filter((f, i) => i === 0 || BY_ID[f.device]);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(view)); } catch {} };

  function note(text) {
    const n = $(".note");
    n.textContent = text;
    n.classList.add("show");
    clearTimeout(note.t);
    note.t = setTimeout(() => n.classList.remove("show"), 2600);
  }

  // ---------- frames ----------
  const cols = []; // { col, head, wrap, screen, iframe, layer }
  function makeCol(i) {
    const col = document.createElement("div");
    col.className = "col";
    col.innerHTML = '<div class="frame-head"></div><div class="wrap"><div class="screen"><iframe title="Your app"></iframe><div class="layer"></div></div></div>';
    const c = { col, head: col.querySelector(".frame-head"), wrap: col.querySelector(".wrap"), screen: col.querySelector(".screen"), iframe: col.querySelector("iframe"), layer: col.querySelector(".layer") };
    if (i === 0) c.iframe.dataset.primary = "1";
    c.iframe.src = path;
    c.iframe.addEventListener("load", () => followNavigation(c));
    return c;
  }

  function frameSize(f) {
    const d = BY_ID[f.device];
    if (!d) return null;
    return f.turned ? [d[3], d[2]] : [d[2], d[3]];
  }

  function head(c, f, i) {
    const size = frameSize(f);
    c.head.innerHTML = '<select class="dev">' + options(f.device) + '</select><span class="dims"></span><button class="turn" title="Rotate">⟲</button>' + (i > 0 ? '<button class="remove" title="Remove this device">✕</button>' : "");
    c.head.querySelector(".dims").textContent = size ? size[0] + " × " + size[1] : "";
    c.head.querySelector(".dev").addEventListener("change", (e) => { view.frames[i] = { device: e.target.value, turned: false }; render(); });
    c.head.querySelector(".turn").addEventListener("click", () => { view.frames[i].turned = !view.frames[i].turned; render(); });
    const remove = c.head.querySelector(".remove");
    if (remove) remove.addEventListener("click", () => { view.frames.splice(i, 1); render(); });
  }

  // What a device draws over the page: status bar, notch or island, home indicator, fold.
  function chrome(f, w, h) {
    const d = BY_ID[f.device];
    if (!d || !view.chrome) return "";
    const kind = d[4];
    if (kind === "desktop") return "";
    const turned = f.turned;
    const bar = { island: 54, notch: 47, home: 20, android: 28, tablet: 24, fold: 32 }[kind];
    let html = "";
    if (!turned || kind === "tablet" || kind === "fold") {
      html += '<div class="chrome-bar" style="height:' + bar + 'px;font-size:' + (kind === "home" || kind === "tablet" ? 12 : 15) + 'px"><span>9:41</span><span>●●● ▮</span></div>';
    }
    if (!turned && kind === "island") html += '<div class="island" style="top:11px;width:124px;height:36px;border-radius:18px"></div>';
    if (!turned && kind === "notch") html += '<div class="island" style="top:0;width:162px;height:32px;border-radius:0 0 18px 18px"></div>';
    if (!turned && kind === "android") html += '<div class="island" style="top:10px;width:12px;height:12px;border-radius:6px"></div>';
    if (kind === "fold") html += '<div class="fold" style="' + (turned ? "left:0;right:0;top:50%;bottom:auto;width:auto;height:2px;transform:translateY(-50%)" : "") + '"></div>';
    if (kind !== "home" && kind !== "desktop") html += '<div class="home-bar" style="width:' + (kind === "tablet" ? 300 : 134) + 'px"></div>';
    return html;
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

  function render() {
    save();
    const fit = view.frames.length === 1 && !BY_ID[view.frames[0].device];
    canvas.classList.toggle("fit", fit);
    $(".fit-btn").classList.toggle("on", fit);
    for (const [cls, key] of [[".chrome", "chrome"], [".grid", "grid"], [".base", "base"], [".pages-toggle", "pages"]]) $(cls).classList.toggle("on", !!view[key]);
    $(".pages").hidden = !view.pages;
    $(".add").innerHTML = '<option value="">+ Device</option>' + options("");
    while (cols.length > view.frames.length) cols.pop().col.remove();
    while (cols.length < view.frames.length) {
      const c = makeCol(cols.length);
      cols.push(c);
      canvas.append(c.col);
    }
    view.frames.forEach((f, i) => {
      const c = cols[i];
      c.head.hidden = fit;
      if (!fit) head(c, f, i);
    });
    layout();
  }

  // Every device at its real size, all scaled by one factor so they fit side by side.
  function layout() {
    const fit = view.frames.length === 1 && !BY_ID[view.frames[0].device];
    if (fit) {
      const c = cols[0];
      c.col.style.width = "";
      const w = canvas.clientWidth, h = canvas.clientHeight;
      Object.assign(c.wrap.style, { width: w + "px", height: h + "px" });
      Object.assign(c.screen.style, { width: w + "px", height: h + "px", transform: "" });
      c.layer.innerHTML = overlays(w);
      return;
    }
    const sizes = view.frames.map((f) => frameSize(f) || [canvas.clientWidth, canvas.clientHeight]);
    // Devices scale; the 24px gaps between them and the canvas's 12px padding don't.
    const sumW = sizes.reduce((a, [w]) => a + w, 0);
    const gaps = 24 * (sizes.length - 1);
    const maxH = Math.max(...sizes.map(([, h]) => h));
    const scale = Math.min(1, (canvas.clientWidth - 32 - gaps) / sumW, (canvas.clientHeight - 32 - 34) / maxH);
    sizes.forEach(([w, h], i) => {
      const c = cols[i];
      c.col.style.width = w * scale + "px";
      Object.assign(c.wrap.style, { width: w * scale + "px", height: h * scale + "px" });
      Object.assign(c.screen.style, { width: w + "px", height: h + "px", transform: scale < 1 ? "scale(" + scale + ")" : "" });
      c.layer.innerHTML = overlays(w) + chrome(view.frames[i], w, h);
      const dims = c.head.querySelector(".dims");
      if (dims) dims.textContent = w + " × " + h + (scale < 1 ? " · " + Math.round(scale * 100) + "%" : "");
    });
  }

  // Navigating in one frame takes the others along.
  function followNavigation(c) {
    let loc;
    try { loc = c.iframe.contentWindow.location; } catch { return; }
    const next = loc.pathname + loc.search + loc.hash;
    try { document.title = "UI Tweaks · " + c.iframe.contentDocument.title; } catch {}
    if (next === path) return;
    path = next;
    $(".path").textContent = path;
    history.replaceState(null, "", "?path=" + encodeURIComponent(path));
    for (const other of cols) {
      try {
        const l = other.iframe.contentWindow.location;
        if (other !== c && l.pathname + l.search + l.hash !== path) other.iframe.src = path;
      } catch {}
    }
    loadPages();
  }

  function go(to) {
    path = to;
    $(".path").textContent = to;
    history.replaceState(null, "", "?path=" + encodeURIComponent(to));
    for (const c of cols) c.iframe.src = to;
    loadPages();
  }

  // ---------- pages ----------
  const visited = new Set();
  async function loadPages() {
    visited.add(path);
    if (!view.pages) return;
    const box = $(".pages");
    let data = { routes: [], pending: [] };
    try { data = await fetch("/__ui-tweaks/routes").then((r) => r.json()); } catch {}
    const known = new Set(data.routes.map((r) => r.path));
    const row = (p, src) => '<button data-path="' + p.replace(/"/g, "&quot;") + '" class="' + (p === path ? "on" : "") + '">' + (data.pending.includes(p) ? "<i title='Has pending tweaks'></i>" : "") + "<span>" + p.replace(/</g, "&lt;") + "</span>" + (src ? '<span class="src">' + src + "</span>" : "") + "</button>";
    const extra = [...visited].filter((p) => !known.has(p));
    box.innerHTML = "<h4>Pages</h4>" + (data.routes.length ? data.routes.map((r) => row(r.path, r.source)).join("") : '<div class="empty">No routes found in the project.</div>') +
      (extra.length ? "<h4>Visited</h4>" + extra.map((p) => row(p, "")).join("") : "");
    for (const b of box.querySelectorAll("button[data-path]")) {
      b.addEventListener("click", () => {
        const p = b.dataset.path;
        if (/[\\[:*]/.test(p)) return note("That route needs a value; open it in the app and it shows under Visited.");
        go(p);
      });
    }
  }

  // ---------- toolbar ----------
  $(".fit-btn").addEventListener("click", () => { view.frames = [{ device: "", turned: false }]; render(); });
  $(".add").addEventListener("change", (e) => {
    const id = e.target.value;
    if (!id) return;
    const fit = view.frames.length === 1 && !BY_ID[view.frames[0].device];
    if (fit) view.frames = [{ device: id, turned: false }];
    else view.frames.push({ device: id, turned: false });
    render();
  });
  for (const [cls, key] of [[".chrome", "chrome"], [".grid", "grid"], [".base", "base"]]) $(cls).addEventListener("click", () => { view[key] = !view[key]; render(); });
  $(".pages-toggle").addEventListener("click", () => { view.pages = !view.pages; render(); loadPages(); });
  $(".reload").addEventListener("click", () => cols.forEach((c) => c.iframe.contentWindow.location.reload()));
  $(".exit").addEventListener("click", () => {
    let href = path;
    try { href = cols[0].iframe.contentWindow.location.href; } catch {}
    location.href = href;
  });
  // Compare: held down, every frame shows the page without its previews.
  const compare = (on) => cols.forEach((c) => { try { c.iframe.contentWindow.__uiTweaks.compare(on); } catch {} });
  const cmp = $(".compare");
  cmp.addEventListener("pointerdown", () => { cmp.classList.add("on"); compare(true); });
  for (const ev of ["pointerup", "pointerleave"]) cmp.addEventListener(ev, () => { if (cmp.classList.contains("on")) { cmp.classList.remove("on"); compare(false); } });

  // Snapshot: the browser captures this tab (it asks each time), cropped to the devices.
  $(".shot").addEventListener("click", async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return note("This browser can't capture the page; use Chrome.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" });
    } catch {
      return note("Snapshot cancelled.");
    }
    const hide = (on) => cols.forEach((c) => { try { c.iframe.contentWindow.__uiTweaks.hideOverlay(on); } catch {} });
    hide(true);
    try {
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 250));
      const sx = video.videoWidth / innerWidth, sy = video.videoHeight / innerHeight;
      const boxes = cols.map((c) => c.wrap.getBoundingClientRect());
      const left = Math.min(...boxes.map((b) => b.left)), top = Math.min(...boxes.map((b) => b.top));
      const right = Math.max(...boxes.map((b) => b.right)), bottom = Math.max(...boxes.map((b) => b.bottom));
      const pad = cols.length > 1 ? 16 : 0;
      const out = document.createElement("canvas");
      out.width = Math.round((right - left + pad * 2) * sx);
      out.height = Math.round((bottom - top + pad * 2) * sy);
      const ctx = out.getContext("2d");
      ctx.fillStyle = "#141414";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(video, (left - pad) * sx, (top - pad) * sy, out.width, out.height, 0, 0, out.width, out.height);
      const blob = await new Promise((r) => out.toBlob(r, "image/png"));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "ui-tweaks-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
      a.click();
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); note("Snapshot saved and copied."); } catch { note("Snapshot saved."); }
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      hide(false);
    }
  });

  $(".path").textContent = path;
  new ResizeObserver(layout).observe(canvas);
  render();
  loadPages();
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
