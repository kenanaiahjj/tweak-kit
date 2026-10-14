import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyDirect, collapse, findRule } from "../direct-apply.mjs";
import { findRoutes } from "../server-core.mjs";

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

test("notes, states, style props and unplaceable values go to Haiku with a reason", async () => {
  const root = await project();
  const out = await applyDirect(root, {
    tweaks: [
      tweak("t-0", { color: { from: "#111", to: "#222", authoredIn: [rule(".card", "color")] } }, { note: "make it pop" }),
      tweak("t-1", { color: { from: "#111", to: "#222", state: "hover", authoredIn: [rule(".card", "color")] } }),
      tweak("t-2", { "margin-bottom": { from: "0px", to: "8px", inlineBefore: "18px", authoredIn: [] } }),
      tweak("t-3", { gap: { from: "0px", to: "8px", authoredIn: [] } }),
    ],
  });
  assert.equal(out.applied.length, 0);
  assert.deepEqual(out.remaining.map((t) => t.directSkip), [
    "has a note",
    "changes a hover/active/focus state",
    "set by the element's style prop",
    "not set by any rule yet",
  ]);
  assert.equal(out.files.length, 0);
});

test("a shared rule becomes an override: a class on the element and a more specific rule after the shared one", async () => {
  const root = await project();
  const el = { classes: ["shared"], selector: "span.shared:nth-of-type(1)", react: { jsxSource: "src/App.tsx:6" } };
  const out = await applyDirect(root, {
    tweaks: [
      { id: "t-0", element: el, changes: { color: { from: "red", to: "blue", authoredIn: [rule(".shared, .other", "color", { part: ".shared", matches: 3 })] } } },
    ],
  });
  assert.deepEqual(out.applied.map((a) => a.id), ["t-0"]);
  const cls = out.files.find((f) => f.path.endsWith("App.tsx")).after.match(/className="shared (shared--t[0-9a-z]{4})"/)[1];
  // Only the first span gets the class.
  assert.match(out.files.find((f) => f.path.endsWith("App.tsx")).after, new RegExp(`<span className="shared ${cls}">A</span><span className="shared">B</span>`));
  assert.match(out.files.find((f) => f.path.endsWith("styles.css")).after, new RegExp(`\\.shared, \\.other \\{ color: red; \\}\\n\\n\\.shared\\.${cls} \\{\\n  color: blue;\\n\\}`));
});

test("a second tweak on the same element reuses its override class and rule", async () => {
  const root = await project();
  await writeFile(path.join(root, "src/styles.css"), CSS.replace(".shared, .other { color: red; }", ".shared, .other { color: red; }\n\n.shared.shared--tab12 {\n  color: blue;\n}"));
  await writeFile(path.join(root, "src/App.tsx"), JSX.replace('<span className="shared">A', '<span className="shared shared--tab12">A'));
  const el = { classes: ["shared", "shared--tab12"], react: { jsxSource: "src/App.tsx:6" } };
  const out = await applyDirect(root, {
    tweaks: [{ id: "t-0", element: el, changes: {
      color: { from: "blue", to: "green", authoredIn: [rule(".shared, .other", "color", { part: ".shared", matches: 3 })] },
      "padding-top": { from: "0px", to: "4px", authoredIn: [] },
    } }],
  });
  assert.equal(out.applied.length, 1);
  assert.equal(out.files.length, 1); // the class is already on the element
  assert.match(out.files[0].after, /\.shared\.shared--tab12 \{\n  color: green;\n  padding-top: 4px;\n\}/);
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

test("a tweak is split: values Haiku must do stay queued, the rest is applied", async () => {
  const root = await project();
  await writeFile(path.join(root, "src/styles.css"), CSS.replace(".hero h1 { font-size: 40px; }", ".hero h1 { font-size: 40px; color: var(--ink); }"));
  const out = await applyDirect(root, {
    tweaks: [tweak("t-0", {
      "font-size": { from: "40px", to: "44px", authoredIn: [rule(".hero h1", "font-size")] },
      color: { from: "#111", to: "#5b3df5", authoredIn: [rule(".hero h1", "color", { usesVariable: true })] },
      "background-color": { from: "#fff", to: "#000", state: "hover", authoredIn: [] },
    })],
  });
  // font-size in place; the token color as an override on the h1 alone; the hover state for Haiku.
  assert.deepEqual(out.applied.map((a) => a.props), [["font-size", "color"]]);
  assert.deepEqual(Object.keys(out.remaining[0].changes), ["background-color"]);
  assert.deepEqual(out.remaining[0].directApplied, ["font-size", "color"]);
  const css = out.files.find((f) => f.path.endsWith("styles.css")).after;
  assert.match(css, /\.hero h1 \{ font-size: 44px; color: var\(--ink\); \}\n\n\.hero h1\.[a-z0-9]+--t[0-9a-z]{4} \{\n  color: #5b3df5;\n\}/);
  assert.match(out.files.find((f) => f.path.endsWith("App.tsx")).after, /<h1 className="[a-z0-9]+--t[0-9a-z]{4}">Your identity<\/h1>/);
});

test("routes for the studio's pages list: Next app/ and pages/, router paths, HTML files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-routes-"));
  for (const [file, text] of [
    ["app/page.tsx", "export default 1"],
    ["app/(shop)/cart/page.tsx", "export default 1"],
    ["app/blog/[slug]/page.tsx", "export default 1"],
    ["pages/about.tsx", "export default 1"],
    ["pages/_app.tsx", "export default 1"],
    ["pages/api/hello.ts", "export default 1"],
    ["src/router.tsx", 'const r = [{ path: "/settings" }, { path: "/users/:id" }]; <Route path="/help" />'],
    ["docs/index.html", "<html></html>"],
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const { routes } = await findRoutes(root);
  assert.deepEqual(routes.map((r) => r.path), ["/", "/about", "/blog/[slug]", "/cart", "/docs", "/help", "/settings", "/users/:id"]);
});
