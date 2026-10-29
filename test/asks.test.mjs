import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addAsk, askStatus, cancelAsk } from "../asks.mjs";

test("asks: queued, then running and done as the mod rewrites the result file in place", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-ask-"));
  await mkdir(path.join(root, ".ui-tweaks"));
  const a = await addAsk(root, { kind: "edit", instruction: "Add a pill", element: { selector: ".card" }, page: { url: "/" } });
  assert.equal((await askStatus(root))[0].status, "waiting");
  const file = path.join(root, ".ui-tweaks", "asks", `${a.id}.json`);
  await writeFile(file, JSON.stringify({ status: "running" }));
  assert.equal((await askStatus(root))[0].status, "running");
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(file, JSON.stringify({ status: "done", files: ["App.tsx"] }));
  const s = (await askStatus(root))[0];
  assert.equal(s.status, "done");
  assert.deepEqual(s.files, ["App.tsx"]);
  await cancelAsk(root, a.id);
  assert.equal((await askStatus(root)).length, 0);
  await assert.rejects(addAsk(root, { kind: "edit", instruction: " " }), /Say what to change/);
  await assert.rejects(addAsk(root, { kind: "nope" }), /kind/);
});

test("asks: variations carry styles-only or layout-only, nothing else", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-ask-"));
  assert.equal((await addAsk(root, { kind: "variations", mode: "layout" })).mode, "layout");
  assert.equal((await addAsk(root, { kind: "variations", mode: "weird" })).mode, undefined);
  assert.equal((await addAsk(root, { kind: "edit", instruction: "x", mode: "layout" })).mode, undefined);
});
