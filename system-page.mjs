// The design system page: every token the project's CSS declares, previewed per mode,
// editable in place (edits are written to the stylesheet), plus the values written by hand.
export function systemPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Design system</title>
<style>
  :root { --bg: #141414; --bar: #1e1e1e; --card: #1c1c1c; --line: #2c2c2c; --text: #e6e6e6; --dim: #9a9a9a; --accent: #0d99ff; --ok: #14ae5c; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 12px/1.45 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  button, input, select { font: inherit; color: var(--text); }
  a { color: inherit; }
  .top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 16px; background: var(--bar); border-bottom: 1px solid var(--line); }
  .top h1 { font-size: 13px; margin: 0; font-weight: 600; white-space: nowrap; }
  .top .proj { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .top .grow { flex: 1; }
  .top input[type=search] { width: 200px; max-width: 30vw; height: 28px; padding: 0 10px; background: #2c2c2c; border: 1px solid transparent; border-radius: 6px; outline: none; }
  .top input[type=search]:focus { border-color: var(--accent); }
  .btn { height: 28px; padding: 0 10px; border: 1px solid var(--line); background: transparent; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; white-space: nowrap; }
  .btn:hover { background: #2a2a2a; }
  .modes { display: flex; gap: 2px; background: #2c2c2c; padding: 2px; border-radius: 6px; max-width: 46vw; overflow-x: auto; }
  .modes button { border: 0; background: transparent; color: var(--dim); height: 24px; padding: 0 9px; border-radius: 4px; cursor: pointer; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .modes button.on { background: #444; color: var(--text); }
  .layout { display: grid; grid-template-columns: 170px minmax(0, 1fr); }
  nav { position: sticky; top: 48px; align-self: start; height: calc(100vh - 48px); overflow-y: auto; padding: 14px 8px; border-right: 1px solid var(--line); }
  nav a { display: flex; justify-content: space-between; padding: 5px 10px; border-radius: 5px; text-decoration: none; color: var(--dim); }
  nav a:hover { background: #222; color: var(--text); }
  nav a span { color: #666; }
  main { padding: 20px 24px 80px; min-width: 0; }
  section { margin-bottom: 36px; scroll-margin-top: 60px; }
  section > h2 { font-size: 14px; margin: 0 0 4px; font-weight: 600; }
  section > p.sub { margin: 0 0 14px; color: var(--dim); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; min-width: 0; }
  .swatch { position: relative; height: 84px; background-image: linear-gradient(45deg,#2a2a2a 25%,transparent 25%,transparent 75%,#2a2a2a 75%), linear-gradient(45deg,#2a2a2a 25%,transparent 25%,transparent 75%,#2a2a2a 75%); background-size: 12px 12px; background-position: 0 0, 6px 6px; background-color: #3a3a3a; cursor: pointer; }
  .swatch i { position: absolute; inset: 0; }
  .swatch input { position: absolute; opacity: 0; width: 100%; height: 100%; cursor: pointer; }
  .swatch .modes-strip { position: absolute; right: 6px; bottom: 6px; display: flex; gap: 3px; }
  .swatch .modes-strip b { width: 14px; height: 14px; border-radius: 4px; border: 1px solid rgba(255,255,255,.35); }
  .meta { padding: 8px 10px 10px; }
  .name { font-weight: 600; font-family: ui-monospace, Menlo, monospace; font-size: 11px; cursor: copy; word-break: break-all; }
  .name:hover { color: var(--accent); }
  .val { margin-top: 4px; width: 100%; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 2px 4px; margin-left: -4px; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: var(--dim); text-overflow: ellipsis; }
  .val:hover { border-color: var(--line); }
  .val:focus { outline: none; border-color: var(--accent); color: var(--text); background: #111; }
  .info { display: flex; justify-content: space-between; gap: 6px; margin-top: 4px; color: #777; font-size: 10.5px; }
  .info .src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inherited { color: #b58cff; }
  .rows { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .row { display: grid; grid-template-columns: minmax(140px, 220px) minmax(0, 1fr) 160px 60px; gap: 14px; align-items: center; padding: 10px 14px; background: var(--card); border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .row .val { margin: 0; }
  .bar { height: 14px; background: var(--accent); border-radius: 3px; opacity: .85; max-width: 100%; }
  .radius-box { width: 64px; height: 64px; border: 2px solid var(--accent); background: rgba(13,153,255,.12); }
  .shadow-stage { padding: 26px; background: #e9ece8; display: grid; place-items: center; }
  .shadow-card { width: 100%; height: 64px; border-radius: 10px; background: #fff; }
  .type-sample { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .motion-track { position: relative; height: 18px; background: #222; border-radius: 9px; }
  .motion-dot { position: absolute; left: 3px; top: 3px; width: 12px; height: 12px; border-radius: 6px; background: var(--accent); }
  .row:hover .motion-dot { transform: translateX(calc(100% * 12)); }
  .uses { color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }
  .uses.zero { color: #f2a24a; }
  .tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
  .tabs button { border: 1px solid var(--line); background: transparent; border-radius: 14px; height: 26px; padding: 0 12px; cursor: pointer; color: var(--dim); }
  .tabs button.on { background: #2c2c2c; color: var(--text); }
  .raw-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) 70px minmax(0, 220px); gap: 12px; align-items: center; padding: 8px 14px; background: var(--card); border-bottom: 1px solid var(--line); }
  .raw-row:last-child { border-bottom: 0; }
  .raw-chip { width: 26px; height: 26px; border-radius: 6px; border: 1px solid rgba(255,255,255,.2); }
  .raw-len { font-size: 10px; color: var(--dim); text-align: center; }
  .raw-val { font-family: ui-monospace, Menlo, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .raw-val small { display: block; color: #777; font-family: inherit; }
  .act { justify-self: end; height: 24px; padding: 0 9px; border: 1px solid var(--line); background: transparent; border-radius: 5px; cursor: pointer; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .act.use { border-color: rgba(13,153,255,.5); color: #7cc4ff; }
  .act:hover { background: #2a2a2a; }
  .empty { color: var(--dim); padding: 14px; background: var(--card); border: 1px dashed var(--line); border-radius: 10px; }
  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; background: #2c2c2c; border: 1px solid var(--line); padding: 8px 12px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 10; }
  .toast.show { opacity: 1; pointer-events: auto; }
  .toast button { border: 0; background: transparent; color: var(--accent); cursor: pointer; font-weight: 600; }
  .loading { padding: 60px; color: var(--dim); text-align: center; }
  @media (max-width: 760px) {
    .layout { grid-template-columns: 1fr; }
    nav { display: none; }
    main { padding: 16px; }
    .row { grid-template-columns: minmax(0, 1fr) 60px; }
    .row > :nth-child(2), .row > :nth-child(3) { grid-column: 1 / -1; }
    .top input[type=search] { display: none; }
    .raw-row { grid-template-columns: 34px minmax(0, 1fr) auto; }
    .raw-row .raw-where { display: none; }
  }
</style>
</head>
<body>
<div class="top">
  <h1>Design system</h1>
  <span class="proj"></span>
  <div class="modes"></div>
  <span class="grow"></span>
  <input type="search" placeholder="Filter tokens" />
  <button class="btn rescan" title="Read the stylesheets again">Rescan</button>
  <a class="btn" href="/__ui-tweaks/studio">Canvas</a>
</div>
<div class="layout">
  <nav></nav>
  <main><div class="loading">Reading your stylesheets…</div></main>
</div>
<div class="toast"><span></span><button hidden>Undo</button></div>
<script>
(() => {
  const API = "/__ui-tweaks";
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, props = {}, ...kids) => {
    const el = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
    return el;
  };
  let data = null, mode = null, filter = "", rawTab = "color";
  try { mode = localStorage.getItem("ui-tweaks:system-mode"); } catch {}

  function toast(text, undo) {
    const t = $(".toast");
    t.querySelector("span").textContent = text;
    const b = t.querySelector("button");
    b.hidden = !undo;
    b.onclick = undo ? async () => { t.classList.remove("show"); await undoLast(); } : null;
    t.classList.add("show");
    const hide = () => { clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), undo ? 12000 : 3000); };
    t.onmouseenter = () => clearTimeout(toast.t);
    t.onmouseleave = hide;
    hide();
  }

  async function load() {
    const res = await fetch(API + "/tokens", { cache: "no-store" });
    data = await res.json();
    if (!data.modes.some((m) => m.key === mode)) mode = data.modes[0] && data.modes[0].key;
    render();
  }

  // The value a token has in the chosen mode, and where it's declared (the base mode when this one doesn't set it).
  function valueIn(t, key) {
    if (t.values[key]) return { ...t.values[key], key, own: true };
    const base = data.modes[0] && t.values[data.modes[0].key];
    if (base) return { ...base, key: data.modes[0].key, own: false };
    const any = Object.entries(t.values)[0];
    return { ...any[1], key: any[0], own: false };
  }

  // Every token of the base mode, then the chosen mode on top, so previews resolve var() chains like the app does.
  function envStyle(key) {
    const out = [];
    for (const t of data.tokens) {
      const v = valueIn(t, key);
      out.push(t.name + ":" + v.value);
    }
    return out.join(";");
  }

  async function save(t, v, to) {
    if (to.trim() === v.value.trim()) return;
    const res = await fetch(API + "/tokens", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: t.name, file: v.file, line: v.line, from: v.value, to }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toast("Not saved: " + (body.error || res.statusText));
    toast(t.name + " → " + to.trim() + " in " + v.file.split("/").pop(), true);
    await load();
  }

  async function undoLast() {
    const res = await fetch(API + "/undo", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    toast(res.ok ? "Undone: " + body.files.join(", ") + " restored" : "Not undone: " + body.error);
    await load();
  }

  // Colour picker values keep the token's own notation (oklch stays oklch).
  function toHex(color) {
    const c = document.createElement("canvas").getContext("2d");
    c.fillStyle = "#000"; c.fillStyle = color;
    const probe = document.createElement("canvas"); probe.width = probe.height = 1;
    const x = probe.getContext("2d"); x.fillStyle = color; x.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = x.getImageData(0, 0, 1, 1).data;
    return { hex: "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join(""), a: a / 255 };
  }
  function oklch(hex, alpha) {
    const lin = (u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const C = Math.hypot(A, B);
    let H = (Math.atan2(B, A) * 180) / Math.PI;
    if (H < 0) H += 360;
    const f = (n, d) => +n.toFixed(d);
    return "oklch(" + f(L * 100, 1) + "% " + f(C, 3) + " " + f(C < 0.002 ? 0 : H, 1) + (alpha < 1 ? " / " + f(alpha, 2) : "") + ")";
  }
  function inNotation(original, hex, alpha) {
    const o = original.trim().toLowerCase();
    if (o.startsWith("oklch")) return oklch(hex, alpha);
    if (o.startsWith("rgb")) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return alpha < 1 ? "rgba(" + r + ", " + g + ", " + b + ", " + +alpha.toFixed(2) + ")" : "rgb(" + r + ", " + g + ", " + b + ")";
    }
    return alpha < 1 ? hex + Math.round(alpha * 255).toString(16).padStart(2, "0") : hex;
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(() => toast("Copied " + text), () => toast(text));
  }

  function valueInput(t, v) {
    const input = h("input", { className: "val", value: v.value, title: "Edit and press Enter to write it to " + v.file + ":" + v.line, spellcheck: false });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = v.value; input.blur(); }
    });
    input.addEventListener("change", () => save(t, v, input.value));
    return input;
  }

  function info(t, v) {
    const src = h("span", { className: "src", textContent: v.own ? v.file + ":" + v.line : "from " + labelOf(v.key) });
    if (!v.own) src.classList.add("inherited");
    return h("div", { className: "info" }, src, h("span", { className: "uses" + (t.uses ? "" : " zero"), textContent: t.uses ? t.uses + " uses" : "unused", title: "var(" + t.name + ") in your source" }));
  }

  const labelOf = (key) => (data.modes.find((m) => m.key === key) || { label: key }).label;
  const matches = (t) => !filter || t.name.toLowerCase().includes(filter) || Object.values(t.values).some((v) => v.value.toLowerCase().includes(filter));

  function colorCard(t) {
    const v = valueIn(t, mode);
    const fill = h("i", { style: "background:var(" + t.name + ")" });
    const picker = h("input", { type: "color", title: "Pick a colour (keeps " + (v.value.trim().split("(")[0] || "hex") + ")" });
    const swatch = h("div", { className: "swatch" }, fill, picker);
    picker.addEventListener("pointerdown", () => {
      const { hex } = toHex(getComputedStyle(fill).backgroundColor);
      picker.value = hex;
    });
    picker.addEventListener("change", () => {
      const { a } = toHex(getComputedStyle(fill).backgroundColor);
      save(t, v, inNotation(v.value, picker.value, a));
    });
    const defined = data.modes.filter((m) => t.values[m.key]);
    if (defined.length > 1) {
      const strip = h("div", { className: "modes-strip" });
      for (const m of defined) strip.append(h("b", { style: envStyle(m.key) + ";background:var(" + t.name + ")", title: m.label + ": " + t.values[m.key].value }));
      swatch.append(strip);
    }
    return h("div", { className: "card" }, swatch, h("div", { className: "meta" }, nameEl(t), valueInput(t, v), info(t, v)));
  }

  function nameEl(t) {
    const n = h("div", { className: "name", textContent: t.name, title: "Copy var(" + t.name + ")" });
    n.addEventListener("click", () => copy("var(" + t.name + ")"));
    return n;
  }

  function row(t, preview) {
    const v = valueIn(t, mode);
    return h("div", { className: "row" },
      h("div", {}, nameEl(t), h("div", { className: "info" }, info(t, v).firstChild)),
      preview,
      valueInput(t, v),
      h("span", { className: "uses" + (t.uses ? "" : " zero"), textContent: t.uses ? t.uses + "×" : "unused" }));
  }

  const SECTIONS = [
    ["color", "Colors", "Click a swatch to pick a colour, or edit the value. Small squares show the other modes."],
    ["font", "Font families", ""],
    ["type", "Type scale", ""],
    ["weight", "Font weights", ""],
    ["leading", "Line heights", ""],
    ["spacing", "Spacing and sizes", ""],
    ["radius", "Corner radius", ""],
    ["shadow", "Shadows and effects", ""],
    ["motion", "Motion", "Hover a row to play it."],
    ["z", "Layers (z-index)", ""],
    ["other", "Other", ""],
  ];

  function previewFor(cat, t) {
    const v = "var(" + t.name + ")";
    if (cat === "font") return h("div", { className: "type-sample", style: "font-family:" + v + ";font-size:20px", textContent: "Aa Bb Cc 0123 — The quick brown fox" });
    if (cat === "type") return h("div", { className: "type-sample", style: "font-size:" + v + ";line-height:1.2", textContent: "The quick brown fox" });
    if (cat === "weight") return h("div", { className: "type-sample", style: "font-weight:" + v + ";font-size:18px", textContent: "The quick brown fox" });
    if (cat === "leading") return h("div", { style: "line-height:" + v + ";font-size:12px;color:var(--dim)", textContent: "Line height preview. Line height preview. Line height preview." });
    if (cat === "spacing") return h("div", { className: "bar", style: "width:" + v });
    if (cat === "radius") return h("div", { className: "radius-box", style: "border-radius:" + v });
    if (cat === "shadow") return h("div", { className: "shadow-stage" }, h("div", { className: "shadow-card", style: "box-shadow:" + v }));
    if (cat === "motion") {
      const val = valueIn(t, mode).value;
      const prop = /cubic-bezier|ease|linear|steps/.test(val) ? "transition-timing-function:" + v + ";transition-duration:600ms" : "transition-duration:" + v + ";transition-timing-function:ease";
      return h("div", { className: "motion-track" }, h("div", { className: "motion-dot", style: "transition-property:transform;" + prop }));
    }
    return h("div", { style: "color:var(--dim);font-family:ui-monospace,Menlo,monospace;font-size:11px", textContent: valueIn(t, mode).value });
  }

  function rawSection() {
    const kinds = [["color", "Colors"], ["spacing", "Spacing"], ["radius", "Radius"], ["type", "Font sizes"]];
    const tabs = h("div", { className: "tabs" });
    for (const [k, label] of kinds) {
      const b = h("button", { textContent: label + " · " + data.raw[k].length });
      if (k === rawTab) b.classList.add("on");
      b.addEventListener("click", () => { rawTab = k; render(); });
      tabs.append(b);
    }
    const list = data.raw[rawTab].filter((e) => !filter || e.value.toLowerCase().includes(filter));
    const rows = h("div", { className: "rows" });
    for (const e of list) {
      const chip = rawTab === "color" ? h("div", { className: "raw-chip", style: "background:" + e.value }) : h("div", { className: "raw-len", textContent: rawTab === "radius" ? "◜" : "↔" });
      const act = e.token
        ? h("button", { className: "act use", textContent: "Use " + e.token + (e.themed ? " ◐" : ""), title: "Replace all " + e.count + " with var(" + e.token + ") in your stylesheets" + (e.themed ? ". This token changes between modes, so these places will follow the theme." : "") })
        : h("button", { className: "act", textContent: "Make token", title: "Add a token for this value to the base mode, then use it in all " + e.count + " places" });
      act.addEventListener("click", () => {
        if (!e.token) return makeToken(e.value);
        if (e.themed && !confirm(e.token + " has a different value in other modes. Using it here makes these " + e.count + " places follow the theme. Continue?")) return;
        adopt(e.value, e.token);
      });
      rows.append(h("div", { className: "raw-row" },
        chip,
        h("div", { className: "raw-val", title: e.at.join("\\n") }, e.value, h("small", { textContent: e.count + " uses · " + e.at[0] })),
        h("span", { className: "raw-where uses", textContent: e.count + "×" }),
        act));
    }
    return h("section", { id: "raw" },
      h("h2", { textContent: "Hand-written values" }),
      h("p", { className: "sub", textContent: "Values typed straight into your CSS instead of using a token, most used first. Swap them for the matching token, or turn one into a token." }),
      tabs,
      list.length ? rows : h("div", { className: "empty", textContent: "None." }));
  }

  async function adopt(value, token) {
    const res = await fetch(API + "/tokens/adopt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value, token }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toast("Not changed: " + (body.error || res.statusText));
    toast("Replaced " + body.count + "× " + value + " with var(" + token + ")", true);
    await load();
  }

  async function makeToken(value) {
    const guess = rawTab === "color" ? "--color-" : rawTab === "radius" ? "--radius-" : rawTab === "type" ? "--text-" : "--space-";
    const name = prompt("Name for the new token (it's added to " + (data.modes[0] ? data.modes[0].label : "the base mode") + " and used everywhere " + value + " is)", guess);
    if (!name) return;
    const res = await fetch(API + "/tokens/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), value, mode: data.modes[0] && data.modes[0].key }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toast("Not created: " + (body.error || res.statusText));
    toast("Added " + name.trim() + " and used it in " + body.count + " places", true);
    await load();
  }

  function render() {
    $(".proj").textContent = data.project + " · " + data.files.length + " stylesheet" + (data.files.length === 1 ? "" : "s");
    const modes = $(".modes");
    modes.innerHTML = "";
    modes.hidden = data.modes.length < 2;
    for (const m of data.modes) {
      const b = h("button", { textContent: m.label, title: m.key });
      if (m.key === mode) b.classList.add("on");
      b.addEventListener("click", () => { mode = m.key; try { localStorage.setItem("ui-tweaks:system-mode", mode); } catch {} render(); });
      modes.append(b);
    }
    const main = $("main"), nav = $("nav");
    const y = scrollY;
    main.innerHTML = "";
    nav.innerHTML = "";
    const env = h("div", { style: envStyle(mode) });
    main.append(env);
    if (!data.tokens.length) env.append(h("div", { className: "empty", textContent: "No tokens yet: this project's CSS declares no custom properties (--name: value). Turn a hand-written value below into one with Make token." }));
    for (const [cat, title, sub] of SECTIONS) {
      const list = data.tokens.filter((t) => t.category === cat && matches(t));
      if (!list.length) continue;
      nav.append(h("a", { href: "#" + cat }, title, h("span", { textContent: list.length })));
      const body = cat === "color" ? h("div", { className: "grid" }, ...list.map(colorCard)) : h("div", { className: "rows" }, ...list.map((t) => row(t, previewFor(cat, t))));
      env.append(h("section", { id: cat }, h("h2", { textContent: title }), sub ? h("p", { className: "sub", textContent: sub }) : null, body));
    }
    const local = data.local.filter((t) => !filter || t.name.includes(filter));
    if (local.length) {
      nav.append(h("a", { href: "#local" }, "Local tokens", h("span", { textContent: local.length })));
      const rows = h("div", { className: "rows" });
      for (const t of local) rows.append(h("div", { className: "row" }, h("div", {}, h("div", { className: "name", textContent: t.name }), h("div", { className: "info" }, h("span", { className: "src", textContent: t.file + ":" + t.line }))), h("div", { className: "raw-val", textContent: t.scope }), h("div", { className: "raw-val", textContent: t.value }), h("span", { className: "uses", textContent: t.uses + "×" })));
      env.append(h("section", { id: "local" }, h("h2", { textContent: "Local tokens" }), h("p", { className: "sub", textContent: "Custom properties set on a single component's selector." }), rows));
    }
    nav.append(h("a", { href: "#raw" }, "Hand-written", h("span", { textContent: data.raw.color.length + data.raw.spacing.length + data.raw.radius.length + data.raw.type.length })));
    env.append(rawSection());
    scrollTo(0, y);
  }

  $("input[type=search]").addEventListener("input", (e) => { filter = e.target.value.trim().toLowerCase(); render(); });
  $(".rescan").addEventListener("click", () => load().then(() => toast("Rescanned")));
  // Pick up edits made elsewhere (the panel, Claude) when the page regains focus.
  addEventListener("focus", () => load());
  load().catch((e) => ($("main").innerHTML = '<div class="loading">Couldn\\'t read the tokens: ' + e.message + "</div>"));
})();
</script>
</body>
</html>`;
}
