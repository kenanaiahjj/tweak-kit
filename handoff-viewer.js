// Handoff viewer: a read-only canvas of a version's screens. Inspect (measurements, colours, type, spacing,
// distances with Alt), search with ⌘/Ctrl+F, before/after for the screens a version changed, and a link to
// the hosted app (when the version has one) to click through it. The screens are static snapshots.
(async () => {
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, props = {}, ...kids) => { const el = Object.assign(document.createElement(tag), props); for (const k of kids) el.append(k); return el; };
  const root = $("#hf");
  root.innerHTML = '<div class="hf-loading">Loading the handoff…</div>';
  let D;
  try { D = window.__HANDOFF_DATA || (await fetch("/__ui-tweaks/handoff/data", { cache: "no-store" }).then((r) => r.json())); } catch (e) { root.innerHTML = '<div class="hf-loading">Couldn’t load the handoff.</div>'; return; }
  if (!D.versions || !D.versions.length) { root.innerHTML = '<div class="hf-loading">No versions yet: save one from the studio (Handoff).</div>'; return; }

  // ---------- state ----------
  const params = new URLSearchParams(location.hash.slice(1));
  const S = {
    vi: Math.max(0, D.versions.findIndex((v) => v.id === (params.get("v") || D.start))) >= 0 ? D.versions.findIndex((v) => v.id === (params.get("v") || D.start)) : D.versions.length - 1,
    cam: { x: 40, y: 80, z: 0.3 },
    sel: null, // { sid, el }
    hover: null,
    changedOnly: false,
    filter: "",
    outlines: false,
    matches: [], // search hits shown on the canvas
  };
  if (S.vi < 0) S.vi = D.versions.length - 1;
  const version = () => D.versions[S.vi];
  const prevVersion = () => D.versions[S.vi - 1] || null;
  const statusOf = (s) => {
    const p = prevVersion();
    if (!p) return "same";
    const b = p.screens.find((x) => x.id === s.id);
    return !b ? "new" : b.hash === s.hash ? "same" : "changed";
  };
  const screenHtml = (hash) => (D.screens[hash] || "").replace(/<style data-uit-style="([0-9a-f]+)"><\/style>/g, (m, k) => "<style>" + (D.styles[k] || "") + "</style>");
  const toast = (t) => { const el = $(".hf-toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 2200); };
  const copy = (t, what) => { navigator.clipboard.writeText(t).then(() => toast("Copied " + (what || t)), () => toast("Couldn’t copy")); };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  // ---------- layout ----------
  root.innerHTML = `
  <header class="hf-top">
    <div class="hf-title">${esc(D.project || "App")} <span>· Handoff</span></div>
    <span class="hf-sep"></span>
    <select class="hf-version" title="Version"></select>
    <span class="hf-meta"></span>
    <span class="hf-grow"></span>
    <a class="hf-btn hf-app" target="_blank" rel="noopener" hidden title="The app itself, hosted, to click through it">Open the app ↗</a>
    <button class="hf-btn hf-find" title="Search text, colours and elements on every screen">Search <kbd>${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"} F</kbd></button>
    <button class="hf-btn hf-outlines" title="Outline every element on the screens (O)">Outlines</button>
    <button class="hf-btn hf-fit" title="Fit every screen (⇧1)">Fit</button>
    <span class="hf-zoom"></span>
  </header>
  <div class="hf-body">
    <aside class="hf-list">
      <div class="hf-list-head"><input type="search" placeholder="Filter screens" /><label class="hf-check"><input type="checkbox" class="hf-changed" /> Changed in this version</label></div>
      <div class="hf-items"></div>
    </aside>
    <main class="hf-stage"><div class="hf-world"></div></main>
    <aside class="hf-inspect"></aside>
  </div>
  <div class="hf-toast"></div>`;
  const stage = $(".hf-stage"), world = $(".hf-world"), panel = $(".hf-inspect");

  // ---------- versions ----------
  function drawVersions() {
    const sel = $(".hf-version");
    sel.innerHTML = D.versions.map((v, i) => `<option value="${i}">${esc(v.label)}${i === D.versions.length - 1 ? " (latest)" : ""}</option>`).slice().reverse().join("");
    sel.value = String(S.vi);
    const v = version();
    const changed = v.screens.filter((s) => statusOf(s) === "changed").length, added = v.screens.filter((s) => statusOf(s) === "new").length;
    $(".hf-meta").textContent = [when(v.at), v.branch && v.commit ? v.branch + " @ " + v.commit + (v.dirty ? " + changes" : "") : "", prevVersion() ? (changed || added ? [changed && changed + " changed", added && added + " new"].filter(Boolean).join(", ") + " since " + prevVersion().label : "No changes since " + prevVersion().label) : v.screens.length + " screens"].filter(Boolean).join(" · ");
    $(".hf-meta").title = v.note || "";
    const app = $(".hf-app");
    app.hidden = !v.appUrl;
    if (v.appUrl) app.href = v.appUrl;
  }
  $(".hf-version").addEventListener("change", (e) => { S.vi = Number(e.target.value); S.sel = null; S.matches = []; build(); drawVersions(); drawList(); drawPanel(); fit(); syncHash(); });

  // ---------- screen list ----------
  function drawList() {
    const box = $(".hf-items");
    box.innerHTML = "";
    const q = S.filter.toLowerCase();
    // Screens first, then each component's states under its own heading.
    const screens = version().screens;
    const order = [...screens.filter((s) => !s.group), ...screens.filter((s) => s.group)];
    let heading = null;
    for (const s of order) {
      const st = statusOf(s);
      if (S.changedOnly && st === "same") continue;
      if (q && !(s.name || s.url).toLowerCase().includes(q)) continue;
      const g = s.group ? s.group.replace(/^states:/, "") + " · states" : "Screens";
      if (g !== heading) { heading = g; if (s.group || screens.some((x) => x.group)) box.append(h("div", { className: "hf-list-group", textContent: g })); }
      const b = h("button", { className: "hf-item" + (S.sel && S.sel.sid === s.id ? " on" : ""), title: s.url });
      b.append(h("span", { className: "nm", textContent: s.group ? s.state || s.name : s.name || s.url }));
      if (st !== "same") b.append(h("span", { className: "hf-badge " + st, textContent: st === "new" ? "New" : "Changed" }));
      b.addEventListener("click", () => focusScreen(s.id));
      box.append(b);
    }
  }
  $(".hf-list-head input[type=search]").addEventListener("input", (e) => { S.filter = e.target.value; drawList(); });
  $(".hf-changed").addEventListener("change", (e) => { S.changedOnly = e.target.checked; drawList(); build(); });

  // ---------- canvas ----------
  const cards = new Map(); // sid -> { el, frame, marks, doc, s }
  function build() {
    world.innerHTML = "";
    cards.clear();
    for (const s of version().screens) {
      const st = statusOf(s);
      if (S.changedOnly && st === "same") continue;
      const [w, hh] = s.size;
      const el = h("div", { className: "hf-card" + (st === "changed" ? " changed" : "") });
      Object.assign(el.style, { left: s.x + "px", top: s.y + "px" });
      const head = h("div", { className: "hf-card-head" });
      head.append(h("span", { className: "nm", textContent: s.name || s.url }));
      if (s.state) head.append(h("span", { className: "hf-badge state", textContent: s.state, title: (s.stateGroup || "State") + ": " + s.state }));
      head.append(h("span", { className: "sz", textContent: w + "×" + hh }));
      if (st !== "same") head.append(h("span", { className: "hf-badge " + st, textContent: st === "new" ? "New" : "Changed" }));
      if (st === "changed") { const c = h("button", { textContent: "Compare", title: "This screen before and after this version" }); c.addEventListener("click", () => openCompare(s)); head.append(c); }
      const box = h("div", { className: "hf-frame" });
      Object.assign(box.style, { width: w + "px", height: hh + "px" });
      const frame = h("iframe", { title: s.name || "Screen", tabIndex: -1 });
      Object.assign(frame.style, { width: w + "px", height: hh + "px" });
      const marks = h("div", { className: "hf-marks" });
      box.append(frame, marks);
      el.append(head, box);
      world.append(el);
      const card = { el, frame, marks, doc: null, s };
      cards.set(s.id, card);
      frame.addEventListener("load", () => wireDoc(card));
      frame.srcdoc = screenHtml(s.hash);
    }
    applyCam();
  }
  // A screen's document: inspect on hover and click (nothing reaches the page), scroll and zoom pass through.
  function wireDoc(card) {
    const doc = card.frame.contentDocument;
    if (!doc) return;
    card.doc = doc;
    card.tokens = null;
    doc.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
            select(card.s.id, e.target.nodeType === 1 ? e.target : e.target.parentElement);
    }, true);
    doc.addEventListener("submit", (e) => e.preventDefault(), true);
    doc.addEventListener("mousemove", (e) => {
      if (hand) return;
      const t = e.target.nodeType === 1 ? e.target : e.target.parentElement;
      S.alt = e.altKey;
      if (!S.hover || S.hover.el !== t || S.hover.sid !== card.s.id || S.altDrawn !== e.altKey) { S.hover = { sid: card.s.id, el: t }; S.altDrawn = e.altKey; drawMarks(); }
    });
    doc.addEventListener("mouseleave", () => { S.hover = null; drawMarks(); });
    doc.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = card.frame.getBoundingClientRect(), z = r.width / card.frame.offsetWidth;
      onWheel({ ctrlKey: e.ctrlKey, metaKey: e.metaKey, deltaX: e.deltaX, deltaY: e.deltaY, clientX: r.left + e.clientX * z, clientY: r.top + e.clientY * z, preventDefault() {} });
    }, { passive: false });
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("keyup", onKeyUp);
    doc.addEventListener("pointerdown", (e) => { if (hand) { e.preventDefault(); startPan(e, card); } }, true);
    if (S.pending && S.pending.sid === card.s.id) { const el = safeQuery(doc, S.pending.path); S.pending = null; if (el) select(card.s.id, el); }
    if (S.outlines || S.matches.length) drawMarks();
  }

  // ---------- camera ----------
  function applyCam() {
    world.style.transform = `translate(${S.cam.x}px, ${S.cam.y}px) scale(${S.cam.z})`;
    world.style.setProperty("--iz", String(1 / S.cam.z));
    world.classList.toggle("hf-far", S.cam.z < 0.25);
    stage.style.backgroundSize = 24 * S.cam.z + "px " + 24 * S.cam.z + "px";
    stage.style.backgroundPosition = S.cam.x + "px " + S.cam.y + "px";
    $(".hf-zoom").textContent = Math.round(S.cam.z * 100) + "%";
  }
  const shown = () => version().screens.filter((s) => !S.changedOnly || statusOf(s) !== "same");
  function fit(list = shown()) {
    if (!list.length) return;
    const x = Math.min(...list.map((s) => s.x)), y = Math.min(...list.map((s) => s.y)) - 40;
    const w = Math.max(...list.map((s) => s.x + s.size[0])) - x, hh = Math.max(...list.map((s) => s.y + s.size[1])) - y;
    const z = Math.min(1, (stage.clientWidth - 80) / w, (stage.clientHeight - 80) / hh);
    S.cam = { z, x: (stage.clientWidth - w * z) / 2 - x * z, y: (stage.clientHeight - hh * z) / 2 - y * z };
    applyCam();
  }
  function zoomAt(z, mx, my) {
    z = Math.min(4, Math.max(0.05, z));
    S.cam = { x: mx - ((mx - S.cam.x) * z) / S.cam.z, y: my - ((my - S.cam.y) * z) / S.cam.z, z };
    applyCam();
  }
  function onWheel(e) {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(S.cam.z * Math.exp(-Math.max(-25, Math.min(25, e.deltaY)) * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { S.cam.x -= e.deltaX; S.cam.y -= e.deltaY; applyCam(); }
  }
  stage.addEventListener("wheel", onWheel, { passive: false });
  let hand = false;
  function startPan(e, card) {
    const start = { x: e.clientX, y: e.clientY, cx: S.cam.x, cy: S.cam.y };
    // Inside a screen, its own coordinates are scaled: convert to the page's.
    const scale = card ? card.frame.getBoundingClientRect().width / card.frame.offsetWidth : 1;
    const target = card ? card.doc : stage;
    if (!card) stage.setPointerCapture(e.pointerId);
    stage.classList.add("panning");
    const move = (ev) => { S.cam.x = start.cx + (ev.clientX - start.x) * scale; S.cam.y = start.cy + (ev.clientY - start.y) * scale; applyCam(); };
    const up = () => { stage.classList.remove("panning"); target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".hf-card-head button")) return;
    if (e.target === stage || e.target === world || hand) startPan(e, null);
  });
  function focusScreen(sid, el) {
    const s = version().screens.find((x) => x.id === sid);
    if (!s) return;
    const z = Math.max(S.cam.z, Math.min(1, (stage.clientHeight - 100) / s.size[1]));
    S.cam = { z, x: stage.clientWidth / 2 - (s.x + s.size[0] / 2) * z, y: 60 - (s.y - 20) * z };
    if (el) { const r = el.getBoundingClientRect(); S.cam.y = Math.min(S.cam.y, stage.clientHeight / 2 - (s.y + r.top + r.height / 2) * z); }
    applyCam();
    if (!el) { S.sel = { sid, el: null }; drawList(); drawPanel(); drawMarks(); syncHash(); }
  }

  // ---------- marks: hover, selection, distances, outlines, search hits ----------
  function rectIn(card, el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function box(card, r, cls) { const b = h("div", { className: "hf-box " + cls }); Object.assign(b.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" }); card.marks.append(b); return b; }
  function line(card, x, y, w, hh, label, lx, ly) {
    const l = h("div", { className: "hf-line" });
    Object.assign(l.style, { left: x + "px", top: y + "px", width: Math.max(w, 1 / S.cam.z) + "px", height: Math.max(hh, 1 / S.cam.z) + "px" });
    card.marks.append(l);
    if (label) { const d = h("div", { className: "hf-dist", textContent: label }); Object.assign(d.style, { left: lx + "px", top: ly + "px" }); card.marks.append(d); }
  }
  const px = (n) => (Math.round(n * 10) / 10).toString().replace(/\.0$/, "");
  function drawMarks() {
    for (const c of cards.values()) c.marks.innerHTML = "";
    for (const m of S.matches) { const c = cards.get(m.sid); if (c && m.el.isConnected) box(c, rectIn(c, m.el), "match" + (m === S.matchCur ? " cur" : "")); }
    if (S.outlines) for (const c of cards.values()) if (c.doc) for (const el of [...c.doc.body.querySelectorAll("*")].slice(0, 1500)) { const r = rectIn(c, el); if (r.w && r.h) box(c, r, "outline"); }
    const sc = S.sel && S.sel.el && cards.get(S.sel.sid);
    if (sc && S.sel.el.isConnected) {
      const r = rectIn(sc, S.sel.el);
      // Padding, shaded, on the selected element.
      const cs = sc.frame.contentWindow.getComputedStyle(S.sel.el);
      const [pt, pr, pb, pl] = ["Top", "Right", "Bottom", "Left"].map((k) => parseFloat(cs["padding" + k]) || 0);
      if (pt) box(sc, { x: r.x, y: r.y, w: r.w, h: pt }, "pad");
      if (pb) box(sc, { x: r.x, y: r.y + r.h - pb, w: r.w, h: pb }, "pad");
      if (pl) box(sc, { x: r.x, y: r.y + pt, w: pl, h: r.h - pt - pb }, "pad");
      if (pr) box(sc, { x: r.x + r.w - pr, y: r.y + pt, w: pr, h: r.h - pt - pb }, "pad");
      box(sc, r, "sel");
      const tag = h("div", { className: "hf-tag", textContent: px(r.w) + " × " + px(r.h) });
      Object.assign(tag.style, { left: r.x + "px", top: r.y + "px" });
      sc.marks.append(tag);
    }
    const hc = S.hover && cards.get(S.hover.sid);
    if (hc && S.hover.el && S.hover.el !== (S.sel && S.sel.el)) {
      const r = rectIn(hc, S.hover.el);
      box(hc, r, "hover");
      // Alt: distances from the selection to the hovered element (or to its edges, when inside it).
      if (S.alt && sc === hc && S.sel.el) distances(hc, rectIn(hc, S.sel.el), r);
    }
  }
  function distances(c, a, b) {
    const inside = b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h;
    if (inside) {
      const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
      line(c, cx, b.y, 0, a.y - b.y, px(a.y - b.y), cx, (b.y + a.y) / 2);
      line(c, cx, a.y + a.h, 0, b.y + b.h - a.y - a.h, px(b.y + b.h - a.y - a.h), cx, (a.y + a.h + b.y + b.h) / 2);
      line(c, b.x, cy, a.x - b.x, 0, px(a.x - b.x), (b.x + a.x) / 2, cy);
      line(c, a.x + a.w, cy, b.x + b.w - a.x - a.w, 0, px(b.x + b.w - a.x - a.w), (a.x + a.w + b.x + b.w) / 2, cy);
      return;
    }
    const midX = Math.max(a.x, b.x) + (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) / 2;
    const midY = Math.max(a.y, b.y) + (Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) / 2;
    const xOverlap = Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x), yOverlap = Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
    if (b.y >= a.y + a.h) line(c, xOverlap ? midX : a.x + a.w / 2, a.y + a.h, 0, b.y - a.y - a.h, px(b.y - a.y - a.h), xOverlap ? midX : a.x + a.w / 2, (a.y + a.h + b.y) / 2);
    else if (a.y >= b.y + b.h) line(c, xOverlap ? midX : a.x + a.w / 2, b.y + b.h, 0, a.y - b.y - b.h, px(a.y - b.y - b.h), xOverlap ? midX : a.x + a.w / 2, (b.y + b.h + a.y) / 2);
    if (b.x >= a.x + a.w) line(c, a.x + a.w, yOverlap ? midY : a.y + a.h / 2, b.x - a.x - a.w, 0, px(b.x - a.x - a.w), (a.x + a.w + b.x) / 2, yOverlap ? midY : a.y + a.h / 2);
    else if (a.x >= b.x + b.w) line(c, b.x + b.w, yOverlap ? midY : a.y + a.h / 2, a.x - b.x - b.w, 0, px(a.x - b.x - b.w), (b.x + b.w + a.x) / 2, yOverlap ? midY : a.y + a.h / 2);
  }

  // ---------- inspect ----------
  function select(sid, el) {
    S.sel = { sid, el };
    for (const [id, c] of cards) c.el.classList.toggle("on", id === sid);
    drawList();
    drawPanel();
    drawMarks();
    syncHash();
  }
  // The screen's tokens (custom properties on :root and the like), resolved, for naming values.
  function tokensOf(card) {
    if (card.tokens) return card.tokens;
    const doc = card.doc, win = card.frame.contentWindow, map = new Map();
    const names = new Set();
    const walk = (rules) => { for (const r of rules) { if (r.cssRules && !r.selectorText) walk(r.cssRules); else if (r.style && /(^|,)\s*(:root|html|body|:host)\b/.test(r.selectorText || "")) for (const p of r.style) if (p.startsWith("--")) names.add(p); } };
    for (const sh of doc.styleSheets) { try { walk(sh.cssRules); } catch {} }
    const probe = doc.createElement("i");
    doc.body.append(probe);
    const rootCs = win.getComputedStyle(doc.documentElement);
    for (const n of names) {
      const v = rootCs.getPropertyValue(n).trim();
      if (!v) continue;
      probe.style.color = "";
      probe.style.color = v;
      const asColor = probe.style.color ? win.getComputedStyle(probe).color : null;
      const key = asColor || v.replace(/\s+/g, " ");
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(n);
    }
    probe.remove();
    return (card.tokens = map);
  }
  const tokenFor = (card, value) => { const t = tokensOf(card).get(value); return t ? t[0] : ""; };
  const hex = (rgb) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(rgb);
    if (!m) return rgb;
    const hx = (n) => Math.round(Number(n)).toString(16).padStart(2, "0");
    const a = m[4] === undefined ? 1 : Number(m[4]);
    return ("#" + hx(m[1]) + hx(m[2]) + hx(m[3]) + (a < 1 ? hx(a * 255) : "")).toUpperCase();
  };
  const transparent = (c) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
  function luminance(rgb) {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(rgb);
    if (!m) return null;
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(+m[1]) + 0.7152 * ch(+m[2]) + 0.0722 * ch(+m[3]);
  }
  function backgroundOf(win, el) {
    for (let n = el; n; n = n.parentElement) { const c = win.getComputedStyle(n).backgroundColor; if (!transparent(c)) return c; }
    return "rgb(255, 255, 255)";
  }
  function drawPanel() {
    panel.innerHTML = "";
    const c = S.sel && cards.get(S.sel.sid);
    const s = c && c.s;
    if (!c || !S.sel.el) {
      const box = h("div", { className: "hf-empty" });
      if (s) {
        box.innerHTML = "<b></b>";
        box.querySelector("b").textContent = s.name || s.url;
        box.append(document.createTextNode(s.size[0] + "×" + s.size[1] + " · " + s.url));
        panel.append(box);
        const act = h("div", { className: "hf-sec" }, h("div", { className: "hf-actions" }));
        const a = act.firstChild;
        const link = h("button", { textContent: "Copy link to this screen" }); link.addEventListener("click", () => copy(location.href, "the link")); a.append(link);
        if (statusOf(s) === "changed") { const cmp = h("button", { textContent: "Compare with " + prevVersion().label }); cmp.addEventListener("click", () => openCompare(s)); a.append(cmp); }
        panel.append(act);
        statesSection(s);
      } else {
        box.innerHTML = "<b>Inspect</b>Click anything on a screen for its size, spacing, colours and type. Hold <kbd>Alt</kbd> and point at another element for the distance between them. Click a value to copy it.<br><br><kbd>" + (/Mac/.test(navigator.platform) ? "⌘" : "Ctrl") + " F</kbd> searches text, colours and elements on every screen." + (version().appUrl ? " <b style=\"display:inline;margin:0;color:inherit;font-weight:600\">Open the app ↗</b> (top right) is the real thing, to click through." : "");
        panel.append(box);
      }
      return;
    }
    const el = S.sel.el, win = c.frame.contentWindow, cs = win.getComputedStyle(el), r = el.getBoundingClientRect();
    const sec = (title) => { const x = h("div", { className: "hf-sec" }); if (title) x.append(h("h4", { textContent: title })); panel.append(x); return x; };
    const row = (parent, k, v, opts = {}) => {
      if (v === null || v === undefined || v === "") return;
      const rr = h("div", { className: "hf-row", title: "Click to copy" });
      const val = h("span");
      if (opts.swatch) { const sw = h("i", { className: "hf-sw" }); sw.style.background = opts.swatch; val.append(sw); }
      val.append(document.createTextNode(v));
      if (opts.token) val.append(h("span", { className: "hf-tok", textContent: opts.token }));
      if (opts.cls) val.classList.add(opts.cls);
      rr.append(h("span", { textContent: k }), val);
      rr.addEventListener("click", () => copy(opts.copy || v));
      parent.append(rr);
    };
    // What it is.
    const head = sec();
    const name = h("div", { className: "hf-el", textContent: el.tagName.toLowerCase() + (el.classList.length ? "." + [...el.classList].slice(0, 3).join(".") : "") });
    const txt = (el.innerText || "").trim().replace(/\s+/g, " ");
    name.append(h("small", { textContent: (s.name || s.url) + (txt ? " · “" + txt.slice(0, 50) + (txt.length > 50 ? "…" : "") + "”" : "") }));
    head.append(name);
    statesSection(s);
    // Size and place.
    const geo = sec("Layout");
    row(geo, "Size", px(r.width) + " × " + px(r.height));
    row(geo, "Position", "x " + px(r.left) + " · y " + px(r.top), { copy: px(r.left) + ", " + px(r.top) });
    if (/flex|grid/.test(cs.display)) row(geo, "Layout", cs.display + (cs.display.includes("flex") ? " · " + cs.flexDirection : "") + (cs.rowGap !== "normal" ? " · gap " + (cs.rowGap === cs.columnGap ? cs.rowGap : cs.rowGap + " " + cs.columnGap) : ""));
    if (/flex|grid/.test(cs.display)) row(geo, "Align", cs.justifyContent + " · " + cs.alignItems);
    const bm = h("div", { className: "hf-boxmodel" });
    const four = (p) => ["Top", "Right", "Bottom", "Left"].map((k) => px(parseFloat(cs[p + k]) || 0));
    const pad = four("padding"), mar = four("margin");
    bm.innerHTML = "<span></span><div><span></span><i></i></div>";
    bm.firstChild.textContent = "margin " + (mar.every((v) => v === mar[0]) ? mar[0] : mar.join(" "));
    bm.querySelector("div span").textContent = "padding " + (pad.every((v) => v === pad[0]) ? pad[0] : pad.join(" "));
    bm.querySelector("i").textContent = px(r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)) + " × " + px(r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth));
    bm.title = "Click to copy padding";
    bm.style.cursor = "copy";
    bm.addEventListener("click", () => copy("padding: " + pad.map((v) => v + "px").join(" ") + ";", "the padding"));
    geo.append(bm);
    // Type, when it has text of its own.
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || /^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(el.tagName)) {
      const ty = sec("Type");
      row(ty, "Font", cs.fontFamily.split(",")[0].replace(/["']/g, "").trim());
      row(ty, "Size", cs.fontSize + " / " + (cs.lineHeight === "normal" ? "normal" : cs.lineHeight), { token: tokenFor(c, cs.fontSize) });
      row(ty, "Weight", cs.fontWeight + (cs.fontStyle !== "normal" ? " " + cs.fontStyle : ""));
      if (cs.letterSpacing !== "normal") row(ty, "Tracking", cs.letterSpacing);
      row(ty, "Color", hex(cs.color), { swatch: cs.color, token: tokenFor(c, cs.color), copy: hex(cs.color) });
      if (cs.textAlign !== "start") row(ty, "Align", cs.textAlign);
      if (cs.textTransform !== "none") row(ty, "Case", cs.textTransform);
      // Contrast against what's behind it (WCAG AA: 4.5, or 3 for large text).
      const fg = luminance(cs.color), bg = luminance(backgroundOf(win, el));
      if (fg !== null && bg !== null) {
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
        const ok = ratio >= (large ? 3 : 4.5);
        row(ty, "Contrast", ratio.toFixed(2) + ":1 · " + (ok ? (ratio >= (large ? 4.5 : 7) ? "AAA" : "AA") : "fails AA"), { cls: ok ? "hf-ok" : "hf-bad", copy: ratio.toFixed(2) + ":1" });
      }
    }
    // Fill and edges.
    const fill = sec("Appearance");
    if (!transparent(cs.backgroundColor)) row(fill, "Fill", hex(cs.backgroundColor), { swatch: cs.backgroundColor, token: tokenFor(c, cs.backgroundColor), copy: hex(cs.backgroundColor) });
    if (cs.backgroundImage !== "none") row(fill, "Image", cs.backgroundImage.length > 60 ? cs.backgroundImage.slice(0, 57) + "…" : cs.backgroundImage, { copy: cs.backgroundImage });
    if (parseFloat(cs.borderTopWidth) || parseFloat(cs.borderLeftWidth)) row(fill, "Border", cs.borderTopWidth + " " + cs.borderTopStyle + " " + hex(cs.borderTopColor), { swatch: cs.borderTopColor, token: tokenFor(c, cs.borderTopColor) });
    const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
    if (radii.some((v) => parseFloat(v))) row(fill, "Radius", radii.every((v) => v === radii[0]) ? radii[0] : radii.join(" "), { token: tokenFor(c, radii[0]) });
    if (cs.boxShadow !== "none") row(fill, "Shadow", cs.boxShadow.length > 60 ? cs.boxShadow.slice(0, 57) + "…" : cs.boxShadow, { copy: cs.boxShadow });
    if (cs.opacity !== "1") row(fill, "Opacity", cs.opacity);
    if (!fill.querySelector(".hf-row")) fill.remove();
    // QA: hit area for things you tap.
    if (el.matches('a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]') || el.closest("a[href], button")) {
      const t = el.closest("a[href], button, [role=button], [role=link]") || el, tr = t.getBoundingClientRect();
      const qa = sec("QA");
      const ok = tr.width >= 44 && tr.height >= 44, min = tr.width >= 24 && tr.height >= 24;
      row(qa, "Tap target", px(tr.width) + " × " + px(tr.height) + " · " + (ok ? "OK" : min ? "under 44×44" : "under 24×24"), { cls: ok ? "hf-ok" : min ? "hf-warn" : "hf-bad" });
      const label = t.getAttribute("aria-label") || (t.innerText || "").trim() || (t.querySelector("img[alt]") || {}).alt;
      row(qa, "Label", label ? label.slice(0, 40) : "none (screen readers say nothing)", { cls: label ? "" : "hf-bad" });
    }
    // Hand-off.
    const act = sec();
    const a = h("div", { className: "hf-actions" });
    const css = h("button", { textContent: "Copy CSS" });
    css.addEventListener("click", () => {
      const props = ["width", "height", "padding", "margin", "gap", "display", "flex-direction", "justify-content", "align-items", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color", "background-image", "border", "border-radius", "box-shadow", "opacity"];
      const skip = { margin: "0px", gap: "normal", "background-image": "none", "box-shadow": "none", opacity: "1", "background-color": "rgba(0, 0, 0, 0)", border: "0px none" };
      const lines = props.map((p) => [p, cs.getPropertyValue(p)]).filter(([p, v]) => v && !(skip[p] && v.startsWith(skip[p])) && !(p === "border" && /^0px/.test(v)) && !(/flex|justify|align/.test(p) && !/flex|grid/.test(cs.display)));
      copy(lines.map(([p, v]) => "  " + p + ": " + (p.includes("color") ? hex(v) : v) + ";").join("\n").replace(/^/, ".element {\n") + "\n}", "the CSS");
    });
    const link = h("button", { textContent: "Copy link" });
    link.addEventListener("click", () => copy(location.href, "a link to this element"));
    const parent = h("button", { textContent: "Parent" });
    parent.addEventListener("click", () => { if (el.parentElement && el.parentElement !== c.doc.body) select(c.s.id, el.parentElement); });
    a.append(css, link, parent);
    if (statusOf(s) === "changed") { const cmp = h("button", { textContent: "Compare" }); cmp.addEventListener("click", () => openCompare(s)); a.append(cmp); }
    act.append(a);
  }

  // A component's states (a states page's screens): the others, grouped as its switcher groups them.
  function statesSection(s) {
    if (!s.group) return;
    const sibs = version().screens.filter((x) => x.group === s.group);
    const box = h("div", { className: "hf-sec" });
    box.append(h("h4", { textContent: s.group.replace(/^states:/, "") + " · " + sibs.length + " states" }));
    const groups = [...new Set(sibs.map((x) => x.stateGroup || "States"))];
    for (const g of groups) {
      if (groups.length > 1) box.append(h("div", { className: "hf-state-group", textContent: g }));
      const row = h("div", { className: "hf-actions" });
      for (const x of sibs.filter((y) => (y.stateGroup || "States") === g)) {
        const b = h("button", { textContent: x.state || x.name, className: x.id === s.id ? "on" : "" });
        if (statusOf(x) !== "same") b.append(h("span", { className: "hf-dot " + statusOf(x), title: statusOf(x) === "new" ? "New" : "Changed" }));
        b.addEventListener("click", () => focusScreen(x.id));
        row.append(b);
      }
      box.append(row);
    }
    panel.append(box);
  }

  // ---------- deep links ----------
  function pathOf(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n.tagName !== "BODY"; n = n.parentElement) {
      const sib = [...n.parentElement.children].filter((x) => x.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + (sib.length > 1 ? ":nth-of-type(" + (sib.indexOf(n) + 1) + ")" : ""));
    }
    return "body > " + parts.join(" > ");
  }
  const safeQuery = (doc, q) => { try { return doc.querySelector(q); } catch { return null; } };
  function syncHash() {
    const p = new URLSearchParams({ v: version().id });
    if (S.sel) { p.set("s", S.sel.sid); if (S.sel.el) p.set("e", pathOf(S.sel.el)); }
    history.replaceState(null, "", "#" + p.toString());
  }

  // ---------- search (⌘/Ctrl+F) ----------
  let searchKind = "all";
  function openSearch() {
    if ($(".hf-modal.search")) return $(".hf-modal.search input").select();
    const modal = h("div", { className: "hf-modal search" });
    modal.innerHTML = `<div class="hf-search"><div class="hf-search-in"><input placeholder="Text, a colour (#0D99FF, rgb(…), --token) or an element (button, .card)…" /></div><div class="hf-chips"><button data-k="all">All</button><button data-k="text">Text</button><button data-k="color">Colours</button><button data-k="el">Elements</button><span class="hf-grow"></span><span class="hf-count"></span></div><div class="hf-results"></div><div class="hf-search-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> go</span><span><kbd>⇧ Enter</kbd> highlight all on the canvas</span><span><kbd>Esc</kbd> close</span></div></div>`;
    document.body.append(modal);
    const input = $("input", modal), list = $(".hf-results", modal);
    let results = [], cur = 0, timer = null;
    const drawChips = () => { for (const b of modal.querySelectorAll(".hf-chips button")) b.classList.toggle("on", b.dataset.k === searchKind); };
    const run = () => {
      results = search(input.value.trim(), searchKind);
      cur = 0;
      $(".hf-count", modal).textContent = input.value.trim() ? results.length + (results.length >= 300 ? "+" : "") + " found" : "";
      draw();
    };
    const draw = () => {
      list.innerHTML = "";
      let last = null;
      results.slice(0, 300).forEach((m, i) => {
        if (m.sid !== last) { last = m.sid; list.append(h("div", { className: "hf-group", textContent: m.screen })); }
        const b = h("button", { className: "hf-res" + (i === cur ? " cur" : "") });
        const label = h("span");
        label.innerHTML = m.html;
        b.append(label, h("small", { textContent: m.kind }));
        b.addEventListener("click", () => { cur = i; go(); });
        list.append(b);
      });
      const c = list.querySelector(".cur");
      if (c) c.scrollIntoView({ block: "nearest" });
    };
    const go = (all) => {
      if (!results.length) return;
      S.matches = all ? results.slice(0, 300) : [results[cur]];
      S.matchCur = results[cur];
      close();
      const m = results[cur];
      focusScreen(m.sid, m.el);
      select(m.sid, m.el);
      toast(all ? "Highlighted " + Math.min(results.length, 300) + " on the canvas (Esc clears)" : "");
    };
    const close = () => { modal.remove(); };
    for (const b of modal.querySelectorAll(".hf-chips button")) b.addEventListener("click", () => { searchKind = b.dataset.k; drawChips(); run(); input.focus(); });
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 120); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return close();
      if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(results.length - 1, cur + 1); draw(); }
      if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); }
      if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey); }
    });
    modal.addEventListener("pointerdown", (e) => { if (e.target === modal) close(); });
    drawChips();
    input.focus();
  }
  function search(q, kind) {
    const out = [];
    if (!q) return out;
    const ql = q.toLowerCase();
    const mark = (text, i, n) => esc(text.slice(Math.max(0, i - 30), i)) + "<mark>" + esc(text.slice(i, i + n)) + "</mark>" + esc(text.slice(i + n, i + n + 50));
    for (const c of cards.values()) {
      if (!c.doc) continue;
      const doc = c.doc, win = c.frame.contentWindow, screen = c.s.name || c.s.url;
      // Text: every run of text that contains it.
      if (kind === "all" || kind === "text") {
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode()) && out.length < 300) {
          const t = n.textContent.replace(/\s+/g, " ");
          const i = t.toLowerCase().indexOf(ql);
          if (i >= 0 && n.parentElement && n.parentElement.getClientRects().length) out.push({ sid: c.s.id, screen, el: n.parentElement, kind: "text", html: mark(t.trim(), t.trim().toLowerCase().indexOf(ql), q.length) });
        }
      }
      // Colours: a hex, rgb()/hsl() or a --token, matched on text, fill and border colours.
      if ((kind === "all" || kind === "color") && /^(#|rgb|hsl|--|oklch)/i.test(q)) {
        let want = q;
        if (q.startsWith("--")) want = win.getComputedStyle(doc.documentElement).getPropertyValue(q).trim();
        const probe = doc.createElement("i");
        probe.style.color = want;
        doc.body.append(probe);
        const rgb = probe.style.color ? win.getComputedStyle(probe).color : null;
        probe.remove();
        if (rgb) {
          for (const el of doc.body.querySelectorAll("*")) {
            if (out.length >= 300) break;
            if (!el.getClientRects().length) continue;
            const cs = win.getComputedStyle(el);
            const hits = [["text", cs.color, [...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim())], ["fill", cs.backgroundColor, true], ["border", cs.borderTopColor, parseFloat(cs.borderTopWidth) > 0]].filter(([, v, applies]) => applies && v === rgb);
            if (hits.length) out.push({ sid: c.s.id, screen, el, kind: hits.map((x) => x[0]).join(" + "), html: esc(el.tagName.toLowerCase() + (el.classList[0] ? "." + el.classList[0] : "")) + " · " + esc(((el.innerText || "").trim().replace(/\s+/g, " ")).slice(0, 50)) });
          }
        }
      }
      // Elements: a tag, a class or any CSS selector.
      if (kind === "all" || kind === "el") {
        let list = [];
        try { list = [...doc.body.querySelectorAll(q)]; } catch {}
        if (!list.length && /^[\w-]+$/.test(q)) list = [...doc.body.querySelectorAll("*")].filter((el) => [...el.classList].some((k) => k.toLowerCase().includes(ql)));
        for (const el of list) {
          if (out.length >= 300) break;
          if (!el.getClientRects().length || out.some((o) => o.el === el)) continue;
          out.push({ sid: c.s.id, screen, el, kind: "element", html: "<mark>" + esc(el.tagName.toLowerCase() + (el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "")) + "</mark> " + esc(((el.innerText || "").trim().replace(/\s+/g, " ")).slice(0, 50)) });
        }
      }
    }
    return out;
  }

  // ---------- compare: a changed screen before and after ----------
  function openCompare(s) {
    const p = prevVersion();
    const before = p && p.screens.find((x) => x.id === s.id);
    if (!before) return toast("This screen is new in this version");
    const modal = h("div", { className: "hf-compare" });
    modal.innerHTML = `<div class="hf-compare-bar"><b></b><span class="hf-grow"></span><div class="hf-seg"><button data-v="side" class="on">Side by side</button><button data-v="over">Overlay</button></div><input type="range" min="0" max="100" value="50" hidden title="Before ← → After" /><button class="hf-btn c-close">Close (Esc)</button></div><div class="hf-compare-stage"></div>`;
    $("b", modal).textContent = (s.name || s.url) + ": " + p.label + " → " + version().label;
    document.body.append(modal);
    const stg = $(".hf-compare-stage", modal), range = $("input[type=range]", modal);
    const [w, hh] = s.size;
    const frameOf = (hash) => { const f = h("iframe"); f.setAttribute("sandbox", "allow-same-origin"); Object.assign(f.style, { width: w + "px", height: hh + "px" }); f.srcdoc = screenHtml(hash); return f; };
    const draw = (mode) => {
      stg.innerHTML = "";
      range.hidden = mode !== "over";
      const avail = stg.getBoundingClientRect();
      if (mode === "side") {
        const z = Math.min(1, (avail.width - 160) / (w * 2), (avail.height - 100) / hh);
        for (const [label, sc] of [[p.label, before], [version().label, s]]) {
          const col = h("div", { className: "hf-compare-col" });
          col.innerHTML = "<span><b></b></span>";
          col.querySelector("b").textContent = label;
          const fr = h("div", { className: "hf-compare-frame" }, frameOf(sc.hash));
          Object.assign(fr.style, { width: w + "px", height: hh + "px", transform: "scale(" + z + ")", marginBottom: -(1 - z) * hh + "px", marginRight: -(1 - z) * w + "px" });
          col.append(fr);
          stg.append(col);
        }
      } else {
        const z = Math.min(1, (avail.width - 80) / w, (avail.height - 100) / hh);
        const col = h("div", { className: "hf-compare-col" });
        col.innerHTML = "<span>Slide between <b></b> and <b></b></span>";
        col.querySelectorAll("b")[0].textContent = p.label;
        col.querySelectorAll("b")[1].textContent = version().label;
        const fr = h("div", { className: "hf-compare-frame" }, frameOf(before.hash));
        const top = h("div", { className: "top" }, frameOf(s.hash));
        fr.append(top);
        Object.assign(fr.style, { width: w + "px", height: hh + "px", transform: "scale(" + z + ")", marginBottom: -(1 - z) * hh + "px", marginRight: -(1 - z) * w + "px" });
        const set = () => { top.style.opacity = String(range.value / 100); };
        range.oninput = set;
        set();
        col.append(fr);
        stg.append(col);
      }
    };
    for (const b of modal.querySelectorAll(".hf-seg button")) b.addEventListener("click", () => { for (const x of modal.querySelectorAll(".hf-seg button")) x.classList.toggle("on", x === b); draw(b.dataset.v); });
    $(".c-close", modal).addEventListener("click", () => modal.remove());
    draw("side");
  }

  // ---------- keys ----------
  $(".hf-find").addEventListener("click", openSearch);
  $(".hf-fit").addEventListener("click", () => fit());
  $(".hf-outlines").addEventListener("click", () => { S.outlines = !S.outlines; $(".hf-outlines").classList.toggle("on", S.outlines); drawMarks(); });
  function onKey(e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); return openSearch(); }
    if (typing) return;
    if (e.code === "Space" && !e.repeat) { e.preventDefault(); hand = true; stage.classList.add("hand"); }
    if (e.key === "Alt") { S.alt = true; drawMarks(); }
    if (e.key === "Escape") { if ($(".hf-compare")) return $(".hf-compare").remove(); S.matches = []; S.sel = null; for (const c of cards.values()) c.el.classList.remove("on"); drawList(); drawPanel(); drawMarks(); syncHash(); }
    if (e.key.toLowerCase() === "o" && !e.metaKey && !e.ctrlKey) $(".hf-outlines").click();
    if (e.shiftKey && e.code === "Digit1") fit();
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomAt(S.cam.z * 1.25, stage.clientWidth / 2, stage.clientHeight / 2); }
    if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); zoomAt(S.cam.z / 1.25, stage.clientWidth / 2, stage.clientHeight / 2); }
  }
  function onKeyUp(e) {
    if (e.code === "Space") { hand = false; stage.classList.remove("hand"); }
    if (e.key === "Alt") { S.alt = false; drawMarks(); }
  }
  addEventListener("keydown", onKey);
  addEventListener("keyup", onKeyUp);
  addEventListener("resize", () => applyCam());

  // ---------- start ----------
  drawVersions();
  drawList();
  build();
  drawPanel();
  requestAnimationFrame(() => {
    const sid = params.get("s");
    if (sid && cards.has(sid)) {
      focusScreen(sid);
      if (params.get("e")) { S.pending = { sid, path: params.get("e") }; const c = cards.get(sid); if (c.doc && c.doc.readyState === "complete") { const el = safeQuery(c.doc, params.get("e")); if (el) select(sid, el); } }
    } else fit();
  });
})();
