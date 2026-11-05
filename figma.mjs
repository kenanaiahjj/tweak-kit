// Figma as a handoff source: a file's frames become handoff screens, so a team that designs in Figma gets the
// same canvas, Inspect, search, compare and comments as one that hands off the coded app.
//
// Each frame is two layers. The picture is Figma's own render of the frame (pixel-exact). Over it, invisible,
// sits a box for every layer at its place, carrying the layer's real styles as CSS (fills, strokes, radius,
// shadows, blur, auto-layout, type) and its Figma facts as data-fg-* attributes (name, component and variant,
// style names, variables). Inspect, search and Copy CSS read those boxes as they read a coded screen.
//
// Change detection compares the layers, not the picture: a screen counts as changed when a layer did, and the
// version keeps the list of what changed ("Button: radius 16 → 22", "“Title” text: …").
//
// The token is the person's own Figma personal access token, read from FIGMA_TOKEN or ~/.ui-tweaks/figma-token.
// The kit never prints it or writes it anywhere.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const API = "https://api.figma.com/v1";
const MAX_FRAMES = 60;
const MAX_LAYERS = 4000;
const hash = (t) => createHash("sha1").update(t).digest("hex").slice(0, 16);
export const tokenFile = () => path.join(process.env.UIT_HOME || path.join(os.homedir(), ".ui-tweaks"), "figma-token");

export async function figmaToken() {
  if (process.env.FIGMA_TOKEN && process.env.FIGMA_TOKEN.trim()) return process.env.FIGMA_TOKEN.trim();
  try { return (await fs.readFile(tokenFile(), "utf8")).trim() || null; } catch { return null; }
}

/** A Figma link → { key, nodeId }. Takes /file/, /design/, /proto/ and branch links; node-id 12-34 → "12:34". */
export function parseFigmaUrl(input) {
  let u;
  try { u = new URL(String(input || "").trim()); } catch { return null; }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) return null;
  const m = /^\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/.exec(u.pathname);
  if (!m) return null;
  const node = u.searchParams.get("node-id");
  return { key: m[2] || m[1], nodeId: node ? node.replace(/-/g, ":") : null };
}

const err = (message, status = 400) => Object.assign(new Error(message), { status });

async function api(fetchFn, token, p) {
  let res;
  try { res = await fetchFn(API + p, { headers: { "X-Figma-Token": token } }); } catch (e) { throw err("Couldn't reach Figma: " + e.message, 502); }
  if (res.status === 403) throw err("Figma said no: the token can't read this file (it needs the “File content: read” scope, and access to the file)", 403);
  if (res.status === 404) throw err("Figma has no such file or frame: check the link", 404);
  if (res.status === 429) throw err("Figma is rate-limiting: try again in a minute", 429);
  if (!res.ok) throw err("Figma answered " + res.status, 502);
  return res.json();
}

// ---------- values → CSS ----------
const c255 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
const round = (n) => Math.round(n * 100) / 100;
export function rgba(color, opacity = 1) {
  if (!color) return null;
  const a = round((color.a ?? 1) * opacity);
  return a >= 1 ? `rgb(${c255(color.r)}, ${c255(color.g)}, ${c255(color.b)})` : `rgba(${c255(color.r)}, ${c255(color.g)}, ${c255(color.b)}, ${a})`;
}
const visible = (list) => (Array.isArray(list) ? list.filter((p) => p && p.visible !== false) : []);
function gradient(p) {
  const stops = (p.gradientStops || []).map((s) => `${rgba(s.color, p.opacity ?? 1)} ${round(s.position * 100)}%`).join(", ");
  const [a, b] = p.gradientHandlePositions || [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }];
  if (p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_DIAMOND") return `radial-gradient(${stops})`;
  if (p.type === "GRADIENT_ANGULAR") return `conic-gradient(${stops})`;
  const deg = Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90);
  return `linear-gradient(${deg}deg, ${stops})`;
}

/** One Figma node's own styles as CSS declarations (position and size are added by the caller). */
export function nodeCss(n) {
  const css = {};
  const fills = visible(n.fills);
  if (n.type === "TEXT") {
    const solid = fills.find((f) => f.type === "SOLID");
    if (solid) css.color = rgba(solid.color, solid.opacity ?? 1);
    const s = n.style || {};
    if (s.fontFamily) css["font-family"] = `"${s.fontFamily}"`;
    if (s.fontSize) css["font-size"] = round(s.fontSize) + "px";
    if (s.fontWeight) css["font-weight"] = String(s.fontWeight);
    if (s.italic) css["font-style"] = "italic";
    if (s.lineHeightPx && s.lineHeightUnit !== "INTRINSIC_%") css["line-height"] = round(s.lineHeightPx) + "px";
    if (s.letterSpacing) css["letter-spacing"] = round(s.letterSpacing) + "px";
    const align = { CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" }[s.textAlignHorizontal];
    if (align) css["text-align"] = align;
    const kase = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" }[s.textCase];
    if (kase) css["text-transform"] = kase;
    if (s.textDecoration === "UNDERLINE") css["text-decoration"] = "underline";
    if (s.textDecoration === "STRIKETHROUGH") css["text-decoration"] = "line-through";
  } else if (fills.length) {
    // Top-most paint last in Figma; CSS lists layers top-first.
    const layers = [];
    for (const f of fills.slice().reverse()) {
      if (f.type === "SOLID") { if (!css["background-color"] && !layers.length) css["background-color"] = rgba(f.color, f.opacity ?? 1); else layers.push(`linear-gradient(${rgba(f.color, f.opacity ?? 1)}, ${rgba(f.color, f.opacity ?? 1)})`); }
      else if (f.type && f.type.startsWith("GRADIENT_")) layers.push(gradient(f));
      else if (f.type === "IMAGE") layers.push("url(figma-image)");
    }
    if (layers.length) css["background-image"] = layers.join(", ");
  }
  const strokes = visible(n.strokes).filter((s) => s.type === "SOLID");
  if (strokes.length && n.type !== "TEXT" && n.strokeWeight) {
    const w = n.individualStrokeWeights;
    const color = rgba(strokes[0].color, strokes[0].opacity ?? 1);
    const style = Array.isArray(n.strokeDashes) && n.strokeDashes.length ? "dashed" : "solid";
    if (w && !(w.top === w.right && w.top === w.bottom && w.top === w.left)) {
      for (const side of ["top", "right", "bottom", "left"]) if (w[side]) css[`border-${side}`] = `${round(w[side])}px ${style} ${color}`;
    } else css.border = `${round(n.strokeWeight)}px ${style} ${color}`;
  }
  if (n.type === "ELLIPSE") css["border-radius"] = "50%";
  else if (Array.isArray(n.rectangleCornerRadii) && n.rectangleCornerRadii.some(Boolean)) css["border-radius"] = n.rectangleCornerRadii.map((r) => round(r) + "px").join(" ");
  else if (n.cornerRadius) css["border-radius"] = round(n.cornerRadius) + "px";
  const fx = visible(n.effects);
  const shadows = fx.filter((e) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW").map((e) => `${e.type === "INNER_SHADOW" ? "inset " : ""}${round(e.offset?.x || 0)}px ${round(e.offset?.y || 0)}px ${round(e.radius || 0)}px ${round(e.spread || 0)}px ${rgba(e.color)}`);
  if (shadows.length) css[n.type === "TEXT" ? "text-shadow" : "box-shadow"] = n.type === "TEXT" ? shadows.map((s) => s.replace(/^inset /, "").replace(/ [\d.-]+px (rgba?\()/, " $1")).join(", ") : shadows.join(", ");
  const blur = fx.find((e) => e.type === "LAYER_BLUR"), bgBlur = fx.find((e) => e.type === "BACKGROUND_BLUR");
  if (blur) css.filter = `blur(${round((blur.radius || 0) / 2)}px)`;
  if (bgBlur) css["backdrop-filter"] = `blur(${round((bgBlur.radius || 0) / 2)}px)`;
  if (typeof n.opacity === "number" && n.opacity < 1) css.opacity = String(round(n.opacity));
  if (n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL") {
    css.display = "flex";
    css["flex-direction"] = n.layoutMode === "HORIZONTAL" ? "row" : "column";
    if (n.layoutWrap === "WRAP") css["flex-wrap"] = "wrap";
    if (n.itemSpacing) css.gap = round(n.itemSpacing) + "px";
    const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((v) => round(v || 0) + "px");
    if (pad.some((v) => v !== "0px")) css.padding = pad.join(" ");
    css["justify-content"] = { CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" }[n.primaryAxisAlignItems] || "flex-start";
    css["align-items"] = { CENTER: "center", MAX: "flex-end", BASELINE: "baseline" }[n.counterAxisAlignItems] || "flex-start";
  }
  return css;
}

// ---------- the layer tree ----------
// A layer as compared between versions: what a reviewer would call a change.
function layerFacts(n, box, names) {
  const css = nodeCss(n);
  const f = { id: n.id, name: n.name || n.type, type: n.type, x: round(box.x), y: round(box.y), w: round(box.width), h: round(box.height) };
  if (n.type === "TEXT" && n.characters != null) f.text = String(n.characters).slice(0, 2000);
  for (const k of ["color", "background-color", "background-image", "border", "border-radius", "box-shadow", "opacity", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "gap", "padding"]) if (css[k]) f[k] = css[k];
  if (n.type === "INSTANCE" && n.componentId) f.component = names.component(n.componentId);
  const styles = names.styles(n.styles);
  if (styles) f.styles = styles;
  return { facts: f, css };
}

function namer(doc) {
  const components = doc.components || {}, sets = doc.componentSets || {}, styles = doc.styles || {};
  return {
    component(id) {
      const c = components[id];
      if (!c) return "Component";
      const set = c.componentSetId && sets[c.componentSetId];
      return set ? `${set.name} / ${c.name}` : c.name;
    },
    // { fill: "S:abc" } → "fill Brand/Primary · text Heading/H2"
    styles(map) {
      if (!map) return "";
      return Object.entries(map).map(([kind, id]) => (styles[id] ? `${kind === "fills" ? "fill" : kind === "strokes" ? "stroke" : kind === "effects" ? "effect" : kind} ${styles[id].name}` : "")).filter(Boolean).join(" · ");
    },
  };
}

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A frame node (with its file's components and styles) → { html, layers, size }. `png` is the frame's picture. */
export function frameScreen(frame, doc, png, variables = {}) {
  const names = namer(doc);
  const fb = frame.absoluteBoundingBox || { x: 0, y: 0, width: 390, height: 844 };
  const W = Math.max(1, Math.round(fb.width)), H = Math.max(1, Math.round(fb.height));
  const layers = [];
  const varNames = (bound) => {
    if (!bound) return "";
    const ids = [];
    const walk = (v) => { if (!v) return; if (Array.isArray(v)) v.forEach(walk); else if (v.type === "VARIABLE_ALIAS" && v.id) ids.push(v.id); else if (typeof v === "object") Object.values(v).forEach(walk); };
    walk(bound);
    return [...new Set(ids.map((id) => variables[id]).filter(Boolean))].join(" · ");
  };
  const render = (n, parentBox, parentBorder) => {
    if (!n || n.visible === false || layers.length >= MAX_LAYERS) return "";
    const box = n.absoluteBoundingBox;
    if (!box) return "";
    const rel = { x: box.x - fb.x, y: box.y - fb.y, width: box.width, height: box.height };
    const { facts, css } = layerFacts(n, rel, names);
    const vars = varNames(n.boundVariables);
    if (vars) facts.variables = vars;
    layers.push(facts);
    // Placed in its parent's padding box (CSS measures from inside the border).
    const left = box.x - parentBox.x - parentBorder, top = box.y - parentBox.y - parentBorder;
    const style = { left: round(left) + "px", top: round(top) + "px", width: round(box.width) + "px", height: round(box.height) + "px", ...css };
    const bw = /^([\d.]+)px/.exec(css.border || "");
    const attrs = [`data-fg-id="${escAttr(n.id)}"`, `data-fg-name="${escAttr(facts.name)}"`, `data-fg-type="${escAttr(n.type)}"`];
    if (facts.component) attrs.push(`data-fg-comp="${escAttr(facts.component)}"`);
    if (facts.styles) attrs.push(`data-fg-styles="${escAttr(facts.styles)}"`);
    if (vars) attrs.push(`data-fg-vars="${escAttr(vars)}"`);
    const kids = n.type === "TEXT" ? escText(n.characters || "") : (n.children || []).map((c) => render(c, box, bw ? Number(bw[1]) : 0)).join("");
    return `<div class="fg" ${attrs.join(" ")} style="${escAttr(Object.entries(style).map(([k, v]) => `${k}:${v}`).join(";"))}">${kids}</div>`;
  };
  // The frame's own fill and frame-level styles live on #fg itself (its first layer).
  const body = render(frame, { ...fb, x: fb.x, y: fb.y }, 0);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="fg-frame" content="${escAttr(frame.id)}"><style>html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#fff}.fg-pic{position:absolute;left:0;top:0;width:${W}px;height:${H}px;pointer-events:none;user-select:none}#fg{position:absolute;inset:0;opacity:0}.fg{position:absolute;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word;margin:0}</style></head><body>${png ? `<img class="fg-pic" alt="" src="data:image/png;base64,${png.toString("base64")}">` : ""}<div id="fg">${body}</div></body></html>`;
  return { html, layers, size: [W, H] };
}

// ---------- what changed between two versions of a frame ----------
const LABEL = { text: "text", x: "x", y: "y", w: "width", h: "height", color: "text colour", "background-color": "fill", "background-image": "fill", border: "stroke", "border-radius": "radius", "box-shadow": "shadow", opacity: "opacity", "font-family": "font", "font-size": "font size", "font-weight": "weight", "line-height": "line height", "letter-spacing": "tracking", gap: "gap", padding: "padding", component: "component", styles: "styles", variables: "variables", name: "name" };
const short = (v) => { const s = String(v ?? "none").replace(/\s+/g, " "); return s.length > 48 ? s.slice(0, 45) + "…" : s; };
export function diffLayers(before = [], after = []) {
  const was = new Map(before.map((l) => [l.id, l]));
  const now = new Map(after.map((l) => [l.id, l]));
  const out = [];
  const who = (l) => (l.type === "TEXT" ? `“${short(l.text || l.name)}”` : l.name);
  for (const l of after) {
    const b = was.get(l.id);
    if (!b) { out.push({ id: l.id, kind: "added", what: `Added ${who(l)}` }); continue; }
    const moved = ["x", "y"].some((k) => Math.abs((l[k] || 0) - (b[k] || 0)) >= 1);
    const parts = [];
    for (const k of Object.keys(LABEL)) {
      if (k === "x" || k === "y") continue;
      const v1 = b[k] ?? "", v2 = l[k] ?? "";
      if ((k === "w" || k === "h") ? Math.abs((v1 || 0) - (v2 || 0)) < 1 : v1 === v2) continue;
      parts.push(`${LABEL[k]} ${short(v1 === "" ? "none" : v1)} → ${short(v2 === "" ? "none" : v2)}`);
    }
    if (moved) parts.push(`moved ${Math.round(l.x - b.x)}, ${Math.round(l.y - b.y)}`);
    if (parts.length) out.push({ id: l.id, kind: "changed", what: `${who(b)}: ${parts.join("; ")}` });
  }
  for (const b of before) if (!now.has(b.id)) out.push({ id: b.id, kind: "removed", what: `Removed ${who(b)}` });
  // A frame-wide move of everything (a layer above it moved) reads as noise: keep what changed in itself first.
  return out.sort((a, b) => (a.kind === "changed" ? 0 : 1) - (b.kind === "changed" ? 0 : 1)).slice(0, 60);
}

// ---------- reading a file ----------
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
// The frames a link points at: a frame itself, every frame in a section or page, else the first page's frames.
function framesUnder(node) {
  if (!node) return [];
  if (FRAME_TYPES.has(node.type) && node.type !== "COMPONENT_SET") return [node];
  const out = [];
  for (const c of node.children || []) {
    if (c.visible === false) continue;
    if (c.type === "SECTION") out.push(...framesUnder(c));
    else if (FRAME_TYPES.has(c.type)) out.push(c);
  }
  return out;
}

/**
 * Reads a Figma link into handoff screens: [{ id, name, url, size, x, y, html, sig, layers }], plus the file's
 * name and version. `fetch` and the token can be given (the tests do).
 */
export async function figmaScreens(link, { fetch: fetchFn = globalThis.fetch, token, onProgress = () => {} } = {}) {
  const ref = parseFigmaUrl(link);
  if (!ref) throw err("That isn't a Figma file link (figma.com/design/…)");
  token = token || (await figmaToken());
  if (!token) throw err(`No Figma token yet. Make one in Figma (Settings → Security → Personal access tokens, with “File content: read”), then put it in ${tokenFile()} or the FIGMA_TOKEN environment variable`, 401);
  onProgress("Reading the file…");
  const file = await api(fetchFn, token, `/files/${ref.key}?depth=${ref.nodeId ? 1 : 2}`);
  let scope;
  if (ref.nodeId) {
    const d = await api(fetchFn, token, `/files/${ref.key}/nodes?ids=${encodeURIComponent(ref.nodeId)}&depth=2`);
    scope = d.nodes && d.nodes[ref.nodeId] && d.nodes[ref.nodeId].document;
    if (!scope) throw err("Figma has no such frame: check the link", 404);
  } else scope = (file.document && file.document.children || []).find((p) => framesUnder(p).length) || null;
  const frames = framesUnder(scope).slice(0, MAX_FRAMES);
  if (!frames.length) throw err("No frames there: link a page, a section or a frame");
  // Variables have names only through Figma's variables API (Enterprise); without it, values still come through.
  let variables = {};
  try {
    const v = await api(fetchFn, token, `/files/${ref.key}/variables/local`);
    for (const [id, x] of Object.entries((v.meta && v.meta.variables) || {})) variables[id] = x.name;
  } catch {}
  const screens = [];
  const minX = Math.min(...frames.map((f) => f.absoluteBoundingBox?.x || 0)), minY = Math.min(...frames.map((f) => f.absoluteBoundingBox?.y || 0));
  for (let i = 0; i < frames.length; i += 8) {
    const batch = frames.slice(i, i + 8);
    onProgress(`Reading frames ${i + 1}–${i + batch.length} of ${frames.length}…`);
    const ids = batch.map((f) => f.id).join(",");
    const [full, pics] = await Promise.all([
      api(fetchFn, token, `/files/${ref.key}/nodes?ids=${encodeURIComponent(ids)}`),
      api(fetchFn, token, `/images/${ref.key}?ids=${encodeURIComponent(ids)}&format=png&scale=2&use_absolute_bounds=true`),
    ]);
    for (const f of batch) {
      const n = full.nodes && full.nodes[f.id];
      if (!n || !n.document) continue;
      let png = null;
      const src = pics.images && pics.images[f.id];
      if (src) {
        try { const r = await fetchFn(src); if (r.ok) png = Buffer.from(await r.arrayBuffer()); } catch {}
      }
      const out = frameScreen(n.document, n, png, variables);
      const b = n.document.absoluteBoundingBox || { x: 0, y: 0 };
      screens.push({
        id: "fg-" + f.id.replace(/[^0-9A-Za-z]+/g, "-"),
        name: f.name,
        url: `https://www.figma.com/design/${ref.key}/?node-id=${f.id.replace(/:/g, "-")}`,
        size: out.size,
        x: Math.round(b.x - minX),
        y: Math.round(b.y - minY) + 40,
        html: out.html,
        sig: hash(JSON.stringify(out.layers)),
        layers: out.layers,
      });
    }
  }
  return { screens, file: { key: ref.key, name: file.name || "Figma file", version: file.version || null, lastModified: file.lastModified || null, link: String(link).trim() } };
}
