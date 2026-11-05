import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportHandoff, handoffData, inlineAssets, readIndex, saveHandoff } from "../handoff.mjs";
import { addAsk } from "../asks.mjs";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "uit-handoff-"));
const page = (body, css = "body{color:red}") => `<!doctype html>\n<html><head><base href="http://localhost:5188/"><style>${css}</style></head><body data-uit-target="">${body}</body></html>`;
const screen = (id, body, extra = {}) => ({ id, name: id.toUpperCase(), url: "/?s=" + id, size: [390, 844], x: 0, y: 0, heading: id, html: page(body), ...extra });

test("versions: screens and styles stored once, changed and new marked against the last version", async () => {
  const root = await tmp();
  await assert.rejects(saveHandoff(root, { screens: [] }), /Nothing/);
  const v1 = await saveHandoff(root, { label: "v1", screens: [screen("a", "<p>A</p>"), screen("b", "<p>B</p>")] });
  assert.equal(v1.version.screens[0].status, "first");
  const v2 = await saveHandoff(root, { label: "v2", screens: [screen("a", "<p>A</p>"), screen("b", "<p>B2</p>"), screen("c", "<p>C</p>")] });
  assert.deepEqual(v2.version.screens.map((s) => s.status), ["same", "changed", "new"]);
  assert.equal(v2.changed, 1);
  assert.equal(v2.added, 1);
  const dir = path.join(root, ".ui-tweaks", "handoff");
  assert.equal((await fs.readdir(path.join(dir, "screens"))).length, 4); // a, b, b2, c
  assert.equal((await fs.readdir(path.join(dir, "styles"))).length, 1); // one stylesheet for all
  const data = await handoffData(root);
  assert.equal(data.versions.length, 2);
  assert.match(Object.values(data.screens)[0], /<style data-uit-style="[0-9a-f]+"><\/style>/);
  assert.equal(Object.values(data.styles)[0], "body{color:red}");
  assert.equal((await readIndex(root)).versions[1].label, "v2");
});

test("export: assets inlined, base dropped, a publishable file", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "public", "img"), { recursive: true });
  await fs.writeFile(path.join(root, "public", "img", "a.png"), Buffer.from([137, 80, 78, 71]));
  const inlined = await inlineAssets(root, '<img src="/img/a.png"><div style="background:url(&quot;/img/a.png&quot;)"></div><img src="https://cdn.x/y.png">', "http://localhost:5188");
  assert.match(inlined, /src="data:image\/png;base64,/);
  assert.match(inlined, /url\(&quot;data:image\/png;base64,/);
  assert.match(inlined, /https:\/\/cdn\.x\/y\.png/);
  await saveHandoff(root, { label: "First", screens: [screen("a", '<img src="/img/a.png">')] });
  const out = await exportHandoff(root, "http://localhost:5188");
  assert.match(out.file, /^\.ui-tweaks\/handoff\/export-v[a-z0-9]+\.html$/);
  const html = await fs.readFile(path.join(root, out.file), "utf8");
  assert.match(html, /window\.__HANDOFF_DATA = /);
  assert.ok(!html.includes("<base"));
  assert.match(html, /data:image\/png;base64/);
  const ask = await addAsk(root, { kind: "publish", file: out.file, title: out.title });
  assert.equal(ask.kind, "publish");
});

test("a version can carry a link to the hosted app (http and https only)", async () => {
  const root = await tmp();
  const ok = await saveHandoff(root, { label: "v1", appUrl: "https://oneqr-git-main.vercel.app", screens: [screen("a", "<p>A</p>")] });
  assert.equal(ok.version.appUrl, "https://oneqr-git-main.vercel.app");
  const bad = await saveHandoff(root, { label: "v2", appUrl: "javascript:alert(1)", screens: [screen("a", "<p>A</p>")] });
  assert.equal(bad.version.appUrl, undefined);
});

test("a component's states keep their group and state name in a version; versions are shared in git", async () => {
  const root = await tmp();
  const out = await saveHandoff(root, { label: "v1", screens: [screen("a", "<p>A</p>"), screen("s1", "<p>Empty</p>", { group: "states:EventList", state: "empty", stateGroup: "Data" })] });
  const st = out.version.screens[1];
  assert.equal(st.group, "states:EventList");
  assert.equal(st.state, "empty");
  assert.equal(st.stateGroup, "Data");
  assert.equal(out.version.screens[0].group, undefined);
  const ignore = await fs.readFile(path.join(root, ".ui-tweaks", ".gitignore"), "utf8");
  assert.match(ignore, /!handoff\/index\.json/);
  assert.match(ignore, /!handoff\/screens\/\*\.html/);
  assert.doesNotMatch(ignore, /export/);
});

test("an Every state request needs the component, and brings the state-machine skill along", async () => {
  const root = await tmp();
  await assert.rejects(addAsk(root, { kind: "states", instruction: "" }), /component/);
  const ask = await addAsk(root, { kind: "states", instruction: "Every state of EventList", element: { selector: ".event-list", react: { jsxSource: "src/main.tsx:10" } } });
  assert.equal(ask.kind, "states");
  const skill = await fs.readFile(path.join(root, ".ui-tweaks", "skills", "state-machine", "SKILL.md"), "utf8");
  assert.match(skill, /name: state-machine/);
  assert.match(await fs.readFile(path.join(root, ".ui-tweaks", "skills", "state-machine", "LICENSE"), "utf8"), /Jakub Krehel/);
});
