import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordHistory, undoApplies } from "../server-core.mjs";

async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uit-history-"));
  await fs.mkdir(path.join(root, ".ui-tweaks"), { recursive: true });
  return root;
}
async function apply(root, file, text, what) {
  const p = path.join(root, file);
  const before = await fs.readFile(p, "utf8").catch(() => "");
  await fs.writeFile(p, text);
  return recordHistory(root, { by: "direct", count: 1, files: [{ path: p, before, after: text }], what });
}

test("reverts back to any apply, newest first", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "a.css"), "a0");
  const first = await apply(root, "a.css", "a1", ".btn color");
  await apply(root, "b.css", "b1", ".card padding");
  await apply(root, "a.css", "a2", ".btn radius");
  const history = JSON.parse(await fs.readFile(path.join(root, ".ui-tweaks/history.json"), "utf8")).entries;
  assert.equal(history[0].what, ".btn color");
  const out = await undoApplies(root, first);
  assert.equal(out.status, 200);
  assert.equal(out.body.undone, 3);
  assert.equal(await fs.readFile(path.join(root, "a.css"), "utf8"), "a0");
  assert.equal(await fs.readFile(path.join(root, "b.css"), "utf8"), "");
});

test("stops at an apply whose file changed since", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "a.css"), "a0");
  const first = await apply(root, "a.css", "a1");
  await apply(root, "b.css", "b1");
  await fs.writeFile(path.join(root, "a.css"), "edited by hand");
  const out = await undoApplies(root, first);
  assert.equal(out.status, 409);
  assert.equal(out.body.undone, 1);
  assert.match(out.body.error, /a\.css changed/);
  assert.equal(await fs.readFile(path.join(root, "a.css"), "utf8"), "edited by hand");
  assert.equal((await undoApplies(root, "nope")).status, 404);
});

test("comments: add, resolve, delete; kept in git", async () => {
  const { changeComments } = await import("../server-core.mjs");
  const root = await project();
  let list = await changeComments(root, "POST", { url: "/home", selector: "main > h1", label: "h1", text: "  Too big on phones  " });
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "Too big on phones");
  assert.equal(list[0].resolved, false);
  list = await changeComments(root, "PATCH", { id: list[0].id, resolved: true });
  assert.equal(list[0].resolved, true);
  await assert.rejects(changeComments(root, "POST", { selector: "x", text: " " }), /needs text/);
  assert.match(await fs.readFile(path.join(root, ".ui-tweaks/.gitignore"), "utf8"), /!comments\.json/);
  list = await changeComments(root, "DELETE", {}, list[0].id);
  assert.equal(list.length, 0);
});
