import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffLayers, figmaScreens, frameScreen, nodeCss, parseFigmaUrl } from "../figma.mjs";
import { saveHandoff } from "../handoff.mjs";

// No real token is ever read by these tests.
delete process.env.FIGMA_TOKEN;
process.env.UIT_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "uit-home-"));

// A small Figma file: one page, one frame with a title, a button instance (component set variant) and a card.
export function fakeFile({ radius = 16, title = "Events", extra = false } = {}) {
  const box = (x, y, width, height) => ({ x: 1000 + x, y: 2000 + y, width, height });
  const kids = [
    { id: "1:3", name: "Title", type: "TEXT", visible: true, absoluteBoundingBox: box(24, 60, 200, 34), characters: title, fills: [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07, a: 1 } }], styles: { text: "S:h2" }, style: { fontFamily: "Inter", fontWeight: 700, fontSize: 28, lineHeightPx: 34, letterSpacing: -0.4, textAlignHorizontal: "LEFT", textCase: "ORIGINAL" } },
    { id: "1:4", name: "Button", type: "INSTANCE", componentId: "C:primary", absoluteBoundingBox: box(24, 700, 342, 52), fills: [{ type: "SOLID", color: { r: 0.847, g: 1, b: 0.094, a: 1 } }], styles: { fill: "S:brand" }, boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "V:brand" }] }, cornerRadius: radius, layoutMode: "HORIZONTAL", itemSpacing: 8, paddingTop: 14, paddingBottom: 14, paddingLeft: 24, paddingRight: 24, primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER", effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0 }],
      children: [{ id: "1:5", name: "Label", type: "TEXT", absoluteBoundingBox: box(140, 714, 110, 22), characters: "Continue", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }], style: { fontFamily: "Inter", fontWeight: 600, fontSize: 15, lineHeightPx: 22 } }] },
    { id: "1:6", name: "Card", type: "RECTANGLE", absoluteBoundingBox: box(24, 120, 342, 160), fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], strokes: [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9, a: 1 } }], strokeWeight: 1, rectangleCornerRadii: [20, 20, 8, 8] },
    { id: "1:7", name: "Hidden", type: "RECTANGLE", visible: false, absoluteBoundingBox: box(0, 0, 10, 10) },
  ];
  if (extra) kids.push({ id: "1:8", name: "Badge", type: "ELLIPSE", absoluteBoundingBox: box(340, 60, 20, 20), fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }] });
  const frame = { id: "1:2", name: "Home", type: "FRAME", absoluteBoundingBox: box(0, 0, 390, 844), fills: [{ type: "SOLID", color: { r: 0.97, g: 0.97, b: 0.96, a: 1 } }], children: kids };
  return {
    name: "OneQR design", version: "123", lastModified: "2026-11-01T00:00:00Z",
    document: { id: "0:0", type: "DOCUMENT", children: [{ id: "0:1", name: "Page 1", type: "CANVAS", children: [frame, { id: "9:9", name: "Note", type: "TEXT" }] }] },
    node: { document: frame, components: { "C:primary": { name: "Size=Large, Type=Primary", componentSetId: "CS:button" } }, componentSets: { "CS:button": { name: "Button" } }, styles: { "S:h2": { name: "Heading/H2", styleType: "TEXT" }, "S:brand": { name: "Brand/Primary", styleType: "FILL" } } },
  };
}
export function fakeFetch(file, png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) {
  const calls = [];
  const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) });
  const fn = async (url, opts = {}) => {
    calls.push({ url, token: opts.headers && opts.headers["X-Figma-Token"] });
    const u = new URL(url);
    if (u.hostname === "img.figma.test") return json(null);
    if (/\/variables\/local$/.test(u.pathname)) return json({ meta: { variables: { "V:brand": { name: "color/brand" } } } });
    if (/\/images\//.test(u.pathname)) return json({ images: { "1:2": "https://img.figma.test/1-2.png" } });
    if (/\/nodes$/.test(u.pathname)) return json({ nodes: { "1:2": file.node } });
    if (/\/files\/KEY123$/.test(u.pathname)) return json({ name: file.name, version: file.version, lastModified: file.lastModified, document: file.document });
    return json({}, 404);
  };
  fn.calls = calls;
  return fn;
}

test("links: design, file and branch links, node ids", () => {
  assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/KEY123/OneQR?node-id=12-34&t=x"), { key: "KEY123", nodeId: "12:34" });
  assert.deepEqual(parseFigmaUrl("https://figma.com/file/ABC/x"), { key: "ABC", nodeId: null });
  assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/ABC/branch/BR1/x"), { key: "BR1", nodeId: null });
  assert.equal(parseFigmaUrl("https://example.com/design/ABC"), null);
  assert.equal(parseFigmaUrl("not a url"), null);
});

test("styles: fills, strokes, radius, shadows, auto-layout and type become CSS", () => {
  const f = fakeFile();
  const [title, button, card] = f.node.document.children;
  const t = nodeCss(title);
  assert.equal(t.color, "rgb(18, 18, 18)");
  assert.equal(t["font-size"], "28px");
  assert.equal(t["font-weight"], "700");
  assert.equal(t["letter-spacing"], "-0.4px");
  const b = nodeCss(button);
  assert.equal(b["background-color"], "rgb(216, 255, 24)");
  assert.equal(b["border-radius"], "16px");
  assert.equal(b.display, "flex");
  assert.equal(b.padding, "14px 24px 14px 24px");
  assert.equal(b.gap, "8px");
  assert.equal(b["justify-content"], "center");
  assert.equal(b["box-shadow"], "0px 4px 12px 0px rgba(0, 0, 0, 0.2)");
  const c = nodeCss(card);
  assert.equal(c.border, "1px solid rgb(230, 230, 230)");
  assert.equal(c["border-radius"], "20px 20px 8px 8px");
});

test("a frame: its picture plus a box per visible layer, with Figma names", () => {
  const f = fakeFile();
  const out = frameScreen(f.node.document, f.node, Buffer.from("PNG"), { "V:brand": "color/brand" });
  assert.deepEqual(out.size, [390, 844]);
  assert.match(out.html, /^<!doctype html>/);
  assert.match(out.html, /class="fg-pic"[^>]*src="data:image\/png;base64,/);
  assert.match(out.html, /data-fg-comp="Button \/ Size=Large, Type=Primary"/);
  assert.match(out.html, /data-fg-styles="fill Brand\/Primary"/);
  assert.match(out.html, /data-fg-vars="color\/brand"/);
  assert.match(out.html, /data-fg-styles="text Heading\/H2"[^>]*>Events</);
  assert.doesNotMatch(out.html, /Hidden/);
  // The label sits inside the button, placed relative to it.
  assert.match(out.html, /data-fg-name="Label"[^>]*style="left:116px;top:14px/);
  assert.equal(out.layers.length, 5);
});

test("changes: what changed, layer by layer", () => {
  const a = frameScreen(fakeFile().node.document, fakeFile().node, null).layers;
  const b = frameScreen(fakeFile({ radius: 22, title: "Your events", extra: true }).node.document, fakeFile({ extra: true }).node, null).layers;
  const d = diffLayers(a, b);
  assert.ok(d.some((x) => x.kind === "changed" && /radius 16px → 22px/.test(x.what)), JSON.stringify(d));
  assert.ok(d.some((x) => x.kind === "changed" && /text Events → Your events/.test(x.what)));
  assert.ok(d.some((x) => x.kind === "added" && x.what === "Added Badge"));
  assert.deepEqual(diffLayers(a, a), []);
});

test("a Figma link → handoff versions: the same layers keep their screen, a change is listed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uit-figma-"));
  await assert.rejects(figmaScreens("https://www.figma.com/design/KEY123/x", { fetch: fakeFetch(fakeFile()), token: "" }).catch((e) => { throw e; }), /token|Figma/);
  const f1 = fakeFetch(fakeFile());
  const r1 = await figmaScreens("https://www.figma.com/design/KEY123/x", { fetch: f1, token: "t0k" });
  assert.equal(r1.screens.length, 1);
  assert.equal(r1.screens[0].id, "fg-1-2");
  assert.equal(r1.file.name, "OneQR design");
  assert.ok(f1.calls.filter((c) => c.url.startsWith("https://api.figma.com")).every((c) => c.token === "t0k"));
  assert.ok(f1.calls.filter((c) => !c.url.startsWith("https://api.figma.com")).every((c) => !c.token), "the token only goes to Figma's API");
  const v1 = await saveHandoff(root, { label: "D1", screens: r1.screens, source: { type: "figma", ...r1.file } });
  assert.equal(v1.version.source.type, "figma");
  // The same file again, its picture a little different: still the same screen.
  const r2 = await figmaScreens("https://www.figma.com/design/KEY123/x", { fetch: fakeFetch(fakeFile(), Buffer.from("other png bytes")), token: "t0k" });
  const v2 = await saveHandoff(root, { label: "D2", screens: r2.screens, source: { type: "figma", ...r2.file } });
  assert.equal(v2.version.screens[0].status, "same");
  assert.equal(v2.version.screens[0].hash, v1.version.screens[0].hash);
  // A coded-app version in between doesn't count as the one before.
  await saveHandoff(root, { label: "App", screens: [{ id: "home", name: "Home", url: "/", size: [390, 844], html: "<!doctype html><p>x</p>" }] });
  const r3 = await figmaScreens("https://www.figma.com/design/KEY123/x", { fetch: fakeFetch(fakeFile({ radius: 22 })), token: "t0k" });
  const v3 = await saveHandoff(root, { label: "D3", screens: r3.screens, source: { type: "figma", ...r3.file } });
  assert.equal(v3.version.screens[0].status, "changed");
  assert.match(v3.version.screens[0].changes[0].what, /Button: radius 16px → 22px/);
});
