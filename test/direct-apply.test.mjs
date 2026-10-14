import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyDirect, collapse, findRule } from "../direct-apply.mjs";

const CSS = `.card { padding: 12px 20px; color: #111 !important; }
.shared, .other { color: red; }
.hero h1 { font-size: 40px; }
@media (max-width: 600px) {
  .card { padding: 8px; }
}
`;
const JSX = `export function App() {
  return (
    <div className="hero">
      <h1>Your identity</h1>
      <div className="card">Go</div>
      <span className="shared">A</span><span className="shared">B</span>
    </div>
  );
}
`;

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/styles.css"), CSS);
  await writeFile(path.join(root, "src/App.tsx"), JSX);
  return root;
}

const rule = (selector, property, extra = {}) => ({ selector, property, file: "src/styles.css", matches: 1, ...extra });
const tweak = (id, changes, extra = {}) => ({ id, element: { classes: [], react: { jsxSource: "src/App.tsx:4" } }, changes, ...extra });

test("a plain value on an owned rule is applied, keeping !important", async () => {
  const root = await project();
  const out = await applyDirect(root, { tweaks: [tweak("t-0", { color: { from: "#111", to: "#222", authoredIn: [rule(".card", "color")] } })] });
  assert.deepEqual(out.applied.map((a) => a.id), ["t-0"]);
  assert.match(out.files[0].after, /\.card \{ padding: 12px 20px; color: #222 !important; \}/);
});

test("longhand edits fold into the authored shorthand", async () => {
  const root = await project();
  const pad = (to) => ({ from: "12px", to, authoredIn: [rule(".card", "padding")] });
  const out = await applyDirect(root, { tweaks: [tweak("t-0", { "padding-top": pad("16px"), "padding-bottom": pad("16px") })] });
  assert.equal(out.applied.length, 1);
  assert.match(out.files[0].after, /\.card \{ padding: 16px 20px;/);
});

test("a rule inside a matching @media block is edited there", async () => {
  const root = await project();
  const out = await applyDirect(root, {
    tweaks: [tweak("t-0", { "padding-left": { from: "8px", to: "4px", authoredIn: [rule(".card", "padding", { conditions: ["(max-width:600px)"] })] } })],
  });
  assert.equal(out.applied.length, 1);
  assert.match(out.files[0].after, /@media \(max-width: 600px\) \{\n  \.card \{ padding: 8px 8px 8px 4px; \}/);
  assert.match(out.files[0].after, /^\.card \{ padding: 12px 20px;/);
});

test("copy changes on the JSX line are applied", async () => {
  const root = await project();
  const out = await applyDirect(root, { tweaks: [tweak("t-0", {}, { text: { from: "Your identity", to: "Your sports identity" } })] });
  assert.equal(out.applied.length, 1);
  assert.match(out.files[0].after, /<h1>Your sports identity<\/h1>/);
});

test("shared selectors, shared classes, notes and states go to Haiku with a reason", async () => {
  const root = await project();
  const out = await applyDirect(root, {
    tweaks: [
      tweak("t-0", { color: { from: "red", to: "blue", authoredIn: [rule(".shared, .other", "color")] } }),
      tweak("t-1", { color: { from: "red", to: "blue", authoredIn: [rule(".shared", "color")] } }),
      tweak("t-2", { color: { from: "#111", to: "#222", authoredIn: [rule(".card", "color")] } }, { note: "make it pop" }),
      tweak("t-3", { color: { from: "#111", to: "#222", state: "hover", authoredIn: [rule(".card", "color")] } }),
      tweak("t-4", { gap: { from: "0px", to: "8px", authoredIn: [] } }),
    ],
  });
  assert.equal(out.applied.length, 0);
  assert.deepEqual(out.remaining.map((t) => t.directSkip), [
    ".shared, .other is a shared selector list",
    ".shared is used 2 times in the source",
    "has a note",
    "changes a hover/active/focus state",
    "not set by any rule yet",
  ]);
  assert.equal(out.files.length, 0);
});

test("helpers", () => {
  assert.equal(collapse(["4px", "4px", "4px", "4px"]), "4px");
  assert.equal(collapse(["4px", "8px", "4px", "8px"]), "4px 8px");
  assert.equal(collapse(["4px", "8px", "2px", "8px"]), "4px 8px 2px");
  assert.ok(findRule(CSS, ".hero  h1").rule);
  assert.match(findRule(CSS, ".nope").error, /0 rules/);
});

test("the original files are untouched until the server writes them", async () => {
  const root = await project();
  await applyDirect(root, { tweaks: [tweak("t-0", { color: { from: "#111", to: "#222", authoredIn: [rule(".card", "color")] } })] });
  assert.equal(await readFile(path.join(root, "src/styles.css"), "utf8"), CSS);
});

test("a tweak is split: simple properties are applied, the rest goes to Haiku", async () => {
  const root = await project();
  await writeFile(path.join(root, "src/styles.css"), CSS.replace(".hero h1 { font-size: 40px; }", ".hero h1 { font-size: 40px; color: var(--ink); }"));
  const out = await applyDirect(root, {
    tweaks: [tweak("t-0", {
      "font-size": { from: "40px", to: "44px", authoredIn: [rule(".hero h1", "font-size")] },
      color: { from: "#111", to: "#5b3df5", authoredIn: [rule(".hero h1", "color", { usesVariable: true })] },
    })],
  });
  assert.deepEqual(out.applied, [{ id: "t-0", props: ["font-size"], text: false, files: ["src/styles.css"] }]);
  assert.deepEqual(Object.keys(out.remaining[0].changes), ["color"]);
  assert.deepEqual(out.remaining[0].directApplied, ["font-size"]);
  assert.match(out.files[0].after, /\.hero h1 \{ font-size: 44px; color: var\(--ink\); \}/);
});

test("a longhand reported by the browser finds the shorthand written in the file", async () => {
  const root = await project();
  const out = await applyDirect(root, { tweaks: [tweak("t-0", { "padding-top": { from: "12px", to: "14px", authoredIn: [rule(".card", "padding-top")] } })] });
  assert.equal(out.applied.length, 1);
  assert.match(out.files[0].after, /\.card \{ padding: 14px 20px 12px;/);
});
