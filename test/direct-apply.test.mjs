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
      tweak("t-3", { gap: { from: "0px", to: "8px", authoredIn: [] } }, { element: { classes: [], react: { jsxSource: "src/Nowhere.tsx:4" } } }),
    ],
  });
  assert.equal(out.applied.length, 0);
  assert.deepEqual(out.remaining.map((t) => t.directSkip), [
    "has a note",
    "changes a hover/active/focus state",
    "set by the element's style prop",
    "not set by any rule yet; no JSX tag at the JSX line",
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

test("moves and removals go to Haiku; their CSS changes still apply directly", async () => {
  const root = await project();
  const out = await applyDirect(root, {
    tweaks: [
      tweak("t-0", { color: { from: "#111", to: "#222", authoredIn: [rule(".card", "color")] } }, { move: { fromIndex: 1, toIndex: 0, where: "before" } }),
      tweak("t-1", {}, { remove: true }),
    ],
  });
  assert.deepEqual(out.applied.map((a) => a.id), ["t-0"]);
  assert.deepEqual(out.remaining.map((t) => [t.id, t.directSkip, !!t.move, !!t.remove]), [["t-0", "moving JSX needs Haiku", true, false], ["t-1", "removing JSX needs Haiku", false, true]]);
  assert.deepEqual(out.remaining[0].directApplied, ["color"]);
});

test("Everywhere edits a shared rule in place instead of overriding one element", async () => {
  const root = await project();
  const out = await applyDirect(root, { tweaks: [tweak("t-0", { color: { from: "red", to: "blue", authoredIn: [rule(".shared, .other", "color", { matches: 3 })] } }, { reach: "all" })] });
  assert.deepEqual(out.applied.map((a) => a.id), ["t-0"]);
  assert.match(out.files[0].after, /\.shared, \.other \{ color: blue; \}/);
  assert.equal(out.files.length, 1); // no class added to the JSX
});

// ---------- width-scoped tweaks ----------

import { planMediaEdits } from "../direct-apply.mjs";

const scoped = (query = "(max-width: 430px)") => ({ kind: "viewport", width: 375, query });

test("a width-scoped tweak creates an @media block right after the base rule", async () => {
  const root = await project();
  const out = await applyDirect(root, { tweaks: [tweak("t-0", { "font-size": { prop: "font-size", from: "40px", to: "28px", authoredIn: [rule(".hero h1", "font-size")] } }, { scope: scoped() })] });
  assert.equal(out.remaining.length, 0);
  const after = out.files[0].after;
  assert.match(after, /\.hero h1 \{ font-size: 40px; \}\n\n@media \(max-width: 430px\) \{\n  \.hero h1 \{\n    font-size: 28px;\n  \}\n\}/);
});

test("a width-scoped tweak edits the rule already inside that @media block", async () => {
  const root = await project();
  const out = await applyDirect(root, {
    tweaks: [tweak("t-0", { padding: { prop: "padding-top", from: "8px", to: "6px", authoredIn: [rule(".card", "padding-top", { conditions: ["(max-width: 600px)"], part: ".card" })] } }, { scope: scoped("(max-width: 600px)") })],
  });
  assert.equal(out.remaining.length, 0);
  assert.match(out.files[0].after, /@media \(max-width: 600px\) \{\n {2}\.card \{ padding: 6px; \}/);
  assert.equal(out.files[0].after.match(/@media/g).length, 1); // no second block
});

test("a width-scoped tweak on a shared rule is left for Haiku, with the reason", async () => {
  const root = await project();
  const out = await applyDirect(root, { tweaks: [tweak("t-0", { color: { prop: "color", from: "red", to: "blue", authoredIn: [rule(".shared", "color", { matches: 2 })] } }, { scope: scoped() })] });
  assert.equal(out.applied.length, 0);
  assert.match(out.remaining[0].directSkip, /matches 2 elements/);
});

test("a width scope without a query still goes to Haiku", async () => {
  const root = await project();
  const out = await applyDirect(root, { tweaks: [tweak("t-0", { color: { prop: "color", from: "#111", to: "#222", authoredIn: [rule(".card", "color")] } }, { scope: { kind: "viewport", width: 375 } })] });
  assert.equal(out.applied.length, 0);
  assert.match(out.remaining[0].directSkip, /one screen width/);
});

test("planMediaEdits adds a declaration to an existing rule in the block, after the base rule", () => {
  const css = ".a { color: red; }\n@media (max-width: 500px) {\n  .a {\n    color: blue;\n  }\n}\n";
  const { edits } = planMediaEdits(css, { selector: ".a", query: "(max-width: 500px)", items: [{ prop: "margin", value: "0" }] });
  const out = edits.reduce((t, e) => t.slice(0, e.start) + e.value + t.slice(e.end), css);
  assert.equal(out, ".a { color: red; }\n@media (max-width: 500px) {\n  .a {\n    color: blue;\n    margin: 0;\n  }\n}\n");
});

test("planMediaEdits won't add to a block that sits above the base rule", () => {
  const css = "@media (max-width: 500px) {\n  .a { color: blue; }\n}\n.a { color: red; }\n";
  assert.match(planMediaEdits(css, { selector: ".a", query: "(max-width: 500px)", items: [{ prop: "margin", value: "0" }] }).error, /comes before/);
  // but editing a value the block already has is safe
  assert.ok(planMediaEdits(css, { selector: ".a", query: "(max-width: 500px)", items: [{ prop: "color", value: "green" }] }).edits);
});

// ---------- Tailwind ----------

import { planClassEdit } from "../direct-apply.mjs";

async function twProject(jsx) {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-twp-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { tailwindcss: "^3.4.0" } }));
  await writeFile(path.join(root, "src/index.css"), "@tailwind base;\n@tailwind utilities;\n");
  await writeFile(path.join(root, "src/App.tsx"), jsx);
  return root;
}
const twTweak = (changes, extra = {}) => ({ id: "t-0", element: { classes: ["pt-2"], react: { jsxSource: "src/App.tsx:2" } }, changes, ...extra });
const gen = (selector, property) => ({ selector, property, file: "src/index.css", matches: 1 }); // a generated utility: not in the source css

test("Tailwind: a padding tweak rewrites the utility in className", async () => {
  const root = await twProject('export const A = () => (\n  <div\n    className="flex pt-2 text-sm">x</div>\n);\n');
  const out = await applyDirect(root, { tweaks: [twTweak({ "padding-top": { prop: "padding-top", from: "8px", to: "20px", authoredIn: [gen(".pt-2", "padding-top")] } })] });
  assert.equal(out.remaining.length, 0);
  assert.match(out.files[0].after, /className="flex text-sm pt-5"/);
});

test("Tailwind: a hover tweak adds a hover: utility; unsupported props stay for Haiku", async () => {
  const root = await twProject('export const A = () => (\n  <div className="btn">x</div>\n);\n');
  const out = await applyDirect(root, {
    tweaks: [twTweak({
      "background-color:hover": { prop: "background-color", state: "hover", from: "#fff", to: "#000", authoredIn: [] },
      "backdrop-filter": { prop: "backdrop-filter", from: "none", to: "blur(4px)", authoredIn: [] },
    }, { element: { classes: ["btn"], react: { jsxSource: "src/App.tsx:2" } } })],
  });
  assert.match(out.files[0].after, /className="btn hover:bg-\[#000\]"/);
  assert.deepEqual(Object.keys(out.remaining[0].changes), ["backdrop-filter"]);
  assert.match(out.remaining[0].directSkip, /no Tailwind class for backdrop-filter/);
});

test("Tailwind: a hand-written rule in a source stylesheet keeps the normal CSS path", async () => {
  const root = await twProject('export const A = () => (\n  <div className="card">x</div>\n);\n');
  await writeFile(path.join(root, "src/index.css"), "@tailwind base;\n.card { padding-top: 8px; }\n");
  const out = await applyDirect(root, { tweaks: [twTweak({ "padding-top": { prop: "padding-top", from: "8px", to: "20px", authoredIn: [gen(".card", "padding-top")] } }, { element: { classes: ["card"], react: { jsxSource: "src/App.tsx:2" } } })] });
  assert.match(out.files[0].after, /\.card \{ padding-top: 20px; \}/);
  assert.equal(out.files.length, 1);
});

test("Tailwind: a width-scoped tweak gets a max-[…] variant", async () => {
  const root = await twProject('export const A = () => (\n  <div className="pt-2">x</div>\n);\n');
  const out = await applyDirect(root, { tweaks: [twTweak({ "padding-top": { prop: "padding-top", from: "8px", to: "12px", authoredIn: [gen(".pt-2", "padding-top")] } }, { scope: { kind: "viewport", width: 375, query: "(max-width: 430px)" }, element: { classes: ["pt-2"], react: { jsxSource: "src/App.tsx:2" } } })] });
  assert.match(out.files[0].after, /className="pt-2 max-\[430px\]:pt-3"/);
});

test("planClassEdit edits cn()'s first string and leaves other expressions to a model", () => {
  const cn = 'const A = () => <div className={cn("p-2 flex", open && "block")}>x</div>;\n';
  const { edits } = planClassEdit(cn, 1, (c) => [...c, "gap-4"]);
  assert.equal(edits.reduce((t, e) => t.slice(0, e.start) + e.value + t.slice(e.end), cn), 'const A = () => <div className={cn("p-2 flex gap-4", open && "block")}>x</div>;\n');
  assert.match(planClassEdit("const A = () => <div className={`a ${b}`}>x</div>;\n", 1, (c) => c).error, /expression/);
  assert.match(planClassEdit("const A = () => <Button className=\"a\">x</Button>;\n", 1, (c) => c).error, /component/);
});

test("a value no rule sets yet, on an element without classes, goes to the stylesheet the component imports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-fresh-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/styles.css"), ".hero { color: red; }\n");
  await writeFile(path.join(root, "src/main.tsx"), `import "./styles.css";\nexport function App() {\n  return (\n    <p>Create one verified QR</p>\n  );\n}\n`);
  const out = await applyDirect(root, {
    tweaks: [{ id: "t-0", element: { tag: "p", classes: [], react: { jsxSource: "src/main.tsx:4" } }, changes: { height: { prop: "height", from: "34px", to: "49px", authoredIn: [] }, "flex-shrink": { prop: "flex-shrink", from: "1", to: "0", authoredIn: [] } } }],
  });
  assert.equal(out.remaining.length, 0, out.remaining[0] && out.remaining[0].directSkip);
  const after = (f) => out.files.find((x) => x.path.endsWith(f)).after;
  assert.equal(out.files.length, 2); // the JSX and the stylesheet, nothing else
  const cls = /<p className="([\w-]+)">/.exec(after("main.tsx"))[1];
  const css = after("styles.css");
  assert.match(css, new RegExp(`\\.${cls} \\{\\n  height: 49px;\\n  flex-shrink: 0;\\n\\}`));
  assert.match(css, /^\.hero \{ color: red; \}/);
});
