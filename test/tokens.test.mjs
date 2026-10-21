import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { adoptToken, createToken, declarationsIn, scanTokens, setToken } from "../tokens.mjs";

const CSS = `/* tokens */
:root {
  --brand: #bbf246;
  --ink: oklch(18% 0.02 140);
  --radius-md: 12px;
  --shadow-soft: 0 12px 30px rgba(0, 0, 0, 0.08);
  --gap: 8px;
}
.dark {
  --brand: #9ad12a;
  --ink: white;
  --radius-md: 14px;
  --gap: 10px;
}
.card { --card-pad: 4px; color: var(--ink); padding: 12px; border-radius: 12px; background: #BBF246; }
.chip { background: #bbf246; padding: 12px 8px; }
@media (max-width: 600px) {
  .card { padding: 8px; color: #333; }
}
`;

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-tok-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/app.css"), CSS);
  await writeFile(path.join(root, "src/App.tsx"), `export const A = () => <div style={{ color: "var(--brand)" }} />;\n`);
  return root;
}

test("declarations carry their selector context and line, comments ignored", () => {
  const d = declarationsIn(CSS);
  const pad = d.filter((x) => x.prop === "padding");
  assert.deepEqual(pad.map((x) => [x.context, x.line]), [[[".card"], 15], [[".chip"], 16], [["@media (max-width: 600px)", ".card"], 18]]);
  assert.equal(CSS.slice(pad[0].valueStart, pad[0].valueEnd), "12px");
});

test("modes, categories, uses and hand-written values", async () => {
  const r = await scanTokens(await project());
  assert.deepEqual(r.modes.map((m) => [m.key, m.label]), [[":root", "Base"], [".dark", "Dark · .dark"]]);
  const cat = Object.fromEntries(r.tokens.map((t) => [t.name, t.category]));
  assert.deepEqual(cat, { "--brand": "color", "--ink": "color", "--radius-md": "radius", "--shadow-soft": "shadow", "--gap": "spacing" });
  assert.equal(r.tokens.find((t) => t.name === "--brand").uses, 1); // the style prop in App.tsx
  assert.equal(r.tokens.find((t) => t.name === "--ink").uses, 1);
  assert.deepEqual(r.local.map((t) => [t.name, t.scope]), [["--card-pad", ".card"]]);
  const brand = r.raw.color.find((e) => e.value.toLowerCase() === "#bbf246");
  assert.equal(brand.count, 2);
  assert.equal(brand.token, "--brand");
  assert.equal(brand.themed, true); // --brand is #9ad12a in .dark
  assert.equal(r.raw.radius.find((e) => e.value === "12px").token, "--radius-md");
  assert.equal(r.raw.spacing.find((e) => e.value === "12px").token, undefined); // a radius isn't spacing
});

test("setToken edits one declaration and refuses a stale one", async () => {
  const root = await project();
  const f = await setToken(root, { name: "--brand", file: "src/app.css", line: 10, from: "#9ad12a", to: "#88c020" });
  assert.match(f.after, /\.dark \{\n  --brand: #88c020;/);
  assert.match(f.after, /:root \{\n  --brand: #bbf246;/);
  await assert.rejects(setToken(root, { name: "--brand", file: "src/app.css", line: 10, from: "#9ad12a", to: "red" }), /changed/);
  await assert.rejects(setToken(root, { name: "--brand", file: "../x.css", line: 10, from: "#9ad12a", to: "red" }), /Not a stylesheet/);
});

test("adoptToken swaps hand-written values, but not inside token declarations", async () => {
  const root = await project();
  const out = await adoptToken(root, { value: "#bbf246", token: "--brand" });
  assert.equal(out.count, 2);
  const text = await readFile(path.join(root, "src/app.css"), "utf8");
  assert.match(text, /--brand: #bbf246;/);
  assert.match(text, /background: var\(--brand\); \}\n\.chip \{ background: var\(--brand\);/);
});

test("createToken adds to the mode's block and uses it", async () => {
  const root = await project();
  const out = await createToken(root, { name: "--text-dim", value: "#333", mode: ":root" });
  assert.equal(out.count, 1);
  assert.equal(out.files.length, 1);
  const text = await readFile(path.join(root, "src/app.css"), "utf8");
  assert.match(text, /  --gap: 8px;\n  --text-dim: #333;\n\}/);
  assert.match(text, /\.card \{ padding: 8px; color: var\(--text-dim\); \}/);
  assert.equal(out.files[0].before, CSS);
  await assert.rejects(createToken(root, { name: "--gap", value: "1px", mode: ":root" }), /already exists/);
});

test("adopting inside nested rules keeps the file intact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-nest-"));
  await writeFile(path.join(root, "a.css"), `:root { --red: #ff0000; }\n.a { color: #ff0000; &:hover { color: #ff0000; } background: #ff0000; }\n`);
  const out = await adoptToken(root, { value: "#ff0000", token: "--red" });
  assert.equal(out.count, 3);
  assert.equal(await readFile(path.join(root, "a.css"), "utf8"), `:root { --red: #ff0000; }\n.a { color: var(--red); &:hover { color: var(--red); } background: var(--red); }\n`);
});

test("adopting a length only touches declarations of its kind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-kind-"));
  await writeFile(path.join(root, "a.css"), `.a { padding: 14px; font-size: 14px; border-radius: 14px; margin: -14px 114px; }\n`);
  const out = await adoptToken(root, { value: "14px", token: "--space", kind: "spacing" });
  assert.equal(out.count, 1);
  assert.equal(await readFile(path.join(root, "a.css"), "utf8"), `.a { padding: var(--space); font-size: 14px; border-radius: 14px; margin: -14px 114px; }\n`);
});

test("a ; inside url() or quotes doesn't split a declaration", async () => {
  const css = `:root { --icon: url("data:image/svg+xml;utf8,<svg/>"); --after: 1px; }\n.b { content: "a;b"; color: red; }\n`;
  const d = declarationsIn(css);
  assert.deepEqual(d.map((x) => [x.prop, x.value]), [["--icon", 'url("data:image/svg+xml;utf8,<svg/>")'], ["--after", "1px"], ["content", '"a;b"'], ["color", "red"]]);
  const root = await mkdtemp(path.join(tmpdir(), "uitk-url-"));
  await writeFile(path.join(root, "a.css"), css);
  const f = await setToken(root, { name: "--icon", file: "a.css", line: 1, from: 'url("data:image/svg+xml;utf8,<svg/>")', to: "none" });
  assert.match(f.after, /^:root \{ --icon: none; --after: 1px; \}/);
});
