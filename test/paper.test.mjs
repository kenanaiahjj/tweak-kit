import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localizeImages, sendToPaper } from "../paper.mjs";
import { addAsk, readAsks } from "../asks.mjs";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "uit-paper-"));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("localizeImages: app files and data images become paper-asset paths, others stay", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "public", "images"), { recursive: true });
  await fs.writeFile(path.join(root, "public", "images", "a.png"), "x");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "b.svg"), "<svg/>");
  const origin = "http://localhost:5188";
  const html = `<img src="${origin}/images/a.png"><img src="${origin}/src/b.svg"><img src="https://cdn.x/c.png"><img src="${origin}/missing.png"><img src="${origin}/../../etc/passwd"><div style="background-image:url(&quot;${origin}/images/a.png&quot;)"></div><img src="data:image/png;base64,${PNG}">`;
  const out = await localizeImages(root, html, origin, path.join(root, ".ui-tweaks", "paper", "assets"));
  assert.ok(out.includes(`src="paper-asset://${path.join(root, "public", "images", "a.png")}"`));
  assert.ok(out.includes(`src="paper-asset://${path.join(root, "src", "b.svg")}"`));
  assert.ok(out.includes('src="https://cdn.x/c.png"'));
  assert.ok(out.includes(`src="${origin}/missing.png"`));
  assert.ok(!out.includes("passwd\"") || !out.includes("paper-asset:///etc"));
  assert.ok(out.includes(`url(&quot;paper-asset://${path.join(root, "public", "images", "a.png")}&quot;)`));
  const data = /src="paper-asset:\/\/([^"]+\.png)"/g;
  const files = [...out.matchAll(data)].map((m) => m[1]).filter((f) => f.includes(".ui-tweaks"));
  assert.equal(files.length, 1);
  assert.ok((await fs.stat(files[0])).isFile());
});

test("sendToPaper saves each capture and queues one paper ask", async () => {
  const root = await tmp();
  const ask = await sendToPaper(root, { html: '<div style="display:flex">Hi</div>', title: "Card", width: 320.4, height: 200, page: { url: "http://localhost/" } }, "http://localhost");
  assert.equal(ask.kind, "paper");
  assert.equal(ask.target, "paper");
  assert.equal(ask.files.length, 1);
  assert.match(ask.files[0].file, /^\.ui-tweaks\/paper\/p[a-z0-9]+\.html$/);
  assert.equal(ask.files[0].width, 320);
  assert.equal(ask.title, "Card");
  assert.equal(await fs.readFile(path.join(root, ask.files[0].file), "utf8"), '<div style="display:flex">Hi</div>');
  const many = await sendToPaper(root, { screens: [{ html: "<div>A</div>", title: "A" }, { html: "<div>B</div>", title: "B" }, { html: " " }], whole: true, target: "figma" }, "http://localhost");
  assert.equal(many.files.length, 2);
  assert.equal(many.target, "figma");
  assert.equal(many.instruction, "Send 2 screens to Figma");
  assert.equal((await readAsks(root)).length, 2);
  await assert.rejects(sendToPaper(root, { html: "  " }, "http://localhost"), /Nothing to send/);
  await assert.rejects(sendToPaper(root, { screens: Array.from({ length: 31 }, () => ({ html: "<div></div>" })) }, "http://localhost"), /Thirty/);
});

test("paper asks need captured files; pulls take one optionally", async () => {
  const root = await tmp();
  await assert.rejects(addAsk(root, { kind: "paper", files: [{ file: "../x.html" }] }), /captured files/);
  await assert.rejects(addAsk(root, { kind: "paper", files: [{ file: ".ui-tweaks/paper/pabc.html" }, { file: ".ui-tweaks/paper/../../x.html" }] }), /captured files/);
  await assert.rejects(addAsk(root, { kind: "paper" }), /captured files/);
  const pull = await addAsk(root, { kind: "paper-pull", target: "figma", title: "Home", file: ".ui-tweaks/paper/pabc.html" });
  assert.equal(pull.target, "figma");
  assert.equal(pull.file, ".ui-tweaks/paper/pabc.html");
  const bare = await addAsk(root, { kind: "paper-pull" });
  assert.equal(bare.target, "paper");
  assert.equal(bare.file, undefined);
  await assert.rejects(addAsk(root, { kind: "paper-pull", file: "/etc/passwd" }), /captured file/);
});
