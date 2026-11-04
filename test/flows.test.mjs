import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changeFlows } from "../server-core.mjs";

test("flow map: records steps, counts repeats, clears, and stays in git", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uit-flows-"));
  const a = { url: "/?screen=id", heading: "Upload your ID" }, b = { url: "/?screen=id", heading: "Confirm details" };
  let flows = await changeFlows(root, "POST", { from: a, to: b, via: "Continue" });
  assert.equal(flows.length, 1);
  flows = await changeFlows(root, "POST", { from: a, to: b, via: "Continue" });
  assert.equal(flows.length, 1);
  assert.equal(flows[0].count, 2);
  flows = await changeFlows(root, "POST", { from: b, to: a, via: "Go back" });
  assert.equal(flows.length, 2);
  await assert.rejects(changeFlows(root, "POST", { from: a, to: a, via: "x" }), /another screen/);
  const saved = JSON.parse(await fs.readFile(path.join(root, ".ui-tweaks", "flows.json"), "utf8"));
  assert.equal(saved.flows.length, 2);
  assert.match(await fs.readFile(path.join(root, ".ui-tweaks", ".gitignore"), "utf8"), /!flows\.json/);
  assert.deepEqual(await changeFlows(root, "DELETE"), []);
});
