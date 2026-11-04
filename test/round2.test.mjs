import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lanAddress, matchShots, saveShots } from "../server-core.mjs";
import { queueTokens } from "../paper.mjs";
import { addAsk } from "../asks.mjs";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "uit-r2-"));

test("history pictures wait for their apply, then take its id; old ones go", async () => {
  const root = await tmp();
  await assert.rejects(saveShots(root, { before: "<div>", after: "<svg/>" }), /SVG/);
  const at = await saveShots(root, { before: "<svg>b</svg>", after: "<svg>a</svg>" });
  const entries = [{ id: "hold", at: at - 300000 }, { id: "hnew", at: at + 500 }];
  const has = await matchShots(root, entries);
  assert.ok(has.has("hnew"));
  assert.ok(!has.has("hold"));
  const dir = path.join(root, ".ui-tweaks", "history", "shots");
  assert.equal(await fs.readFile(path.join(dir, "hnew-before.svg"), "utf8"), "<svg>b</svg>");
  // The entry is gone from History: its pictures are removed.
  const after = await matchShots(root, [{ id: "hother", at: Date.now() }]);
  assert.ok(!after.has("hnew"));
  assert.deepEqual(await fs.readdir(dir), []);
});

test("tokens: saved with a value per mode and where each is declared, and queued", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(path.join(root, "styles.css"), ":root {\n  --brand: #ff6600;\n  --space-2: 8px;\n  --radius: 12px;\n  --text: #111;\n}\n.dark {\n  --brand: #ff8833;\n  --space-2: 8px;\n  --radius: 12px;\n  --text: #eee;\n}\n");
  const ask = await queueTokens(root, { direction: "push", target: "figma" });
  assert.equal(ask.kind, "tokens");
  assert.equal(ask.direction, "push");
  assert.equal(ask.target, "figma");
  const saved = JSON.parse(await fs.readFile(path.join(root, ask.file), "utf8"));
  const brand = saved.tokens.find((t) => t.name === "--brand");
  assert.equal(Object.keys(brand.values).length, 2);
  assert.match(Object.values(brand.values)[0].at, /^styles\.css:2$/);
  await assert.rejects(addAsk(root, { kind: "tokens", direction: "sideways", file: ".ui-tweaks/paper/tokens.json" }), /direction/);
  await assert.rejects(addAsk(root, { kind: "tokens", direction: "pull", file: "../x.json" }), /direction/);
  const empty = await tmp();
  await assert.rejects(queueTokens(empty, { direction: "push" }), /No design tokens/);
});

test("variations take a states mode", async () => {
  const root = await tmp();
  const ask = await addAsk(root, { kind: "variations", mode: "states", instruction: "" });
  assert.equal(ask.mode, "states");
});

test("lanAddress answers without a port", async () => {
  const out = await lanAddress(0);
  assert.equal(out.reachable, false);
});

test("concept asks need a description and a pictured reference screen", async () => {
  const root = await tmp();
  const reference = { snapshot: "/__ui-tweaks/snapshots/sabc1.html", url: "/?screen=events", name: "Events", size: [393, 852] };
  const ask = await addAsk(root, { kind: "concept", instruction: "An event leaderboard", reference, from: "a7", fromName: "Events" });
  assert.equal(ask.kind, "concept");
  assert.deepEqual(ask.reference.size, [393, 852]);
  assert.equal(ask.from, "a7");
  await assert.rejects(addAsk(root, { kind: "concept", instruction: "", reference }), /Describe/);
  await assert.rejects(addAsk(root, { kind: "concept", instruction: "x", reference: { ...reference, snapshot: "/etc/passwd" } }), /reference screen/);
  await assert.rejects(addAsk(root, { kind: "concept", instruction: "x", reference: { ...reference, size: [1] } }), /reference screen/);
});
