import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRefs, startVersion, stopVersion, versionStatus, versionViteConfig, worktreeDir } from "../versions.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uit-versions-"));
  git(root, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(root, "index.html"), "<html><body><h1>main</h1></body></html>");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  git(root, "checkout", "-qb", "experiment");
  await fs.writeFile(path.join(root, "index.html"), "<html><body><h1>experiment</h1></body></html>");
  git(root, "commit", "-qam", "try something");
  git(root, "checkout", "-q", "main");
  return root;
}

test("the worktree goes outside the project, one folder per ref", () => {
  const dir = worktreeDir("/work/app", "feature/new nav");
  assert.ok(!dir.startsWith("/work/app"));
  assert.match(dir, /app-[0-9a-f]{8}[/\\]feature_new_nav$/);
  assert.notEqual(worktreeDir("/a/app", "x"), worktreeDir("/b/app", "x"));
});

test("the version's Vite config wraps the project's own", () => {
  const text = versionViteConfig({ userConfig: "vite.config.ts", port: 6123, mainRoot: "/work/app" });
  assert.match(text, /import user from "\.\/vite\.config\.ts"/);
  assert.match(text, /port: 6123, strictPort: true/);
  assert.match(text, /"\/work\/app"/); // may read the shared node_modules
  assert.match(text, /startsWith\("ui-tweaks"\)/); // no panel in the other version
  assert.match(text, /__uitMirror/);
  assert.match(versionViteConfig({ userConfig: null, port: 1, mainRoot: "/x" }), /const user = \{\}/);
});

test("lists branches with the current one", async () => {
  const root = await repo();
  const info = await listRefs(root);
  assert.equal(info.current.name, "main");
  assert.equal(info.current.dirty, false);
  assert.deepEqual(info.refs.map((r) => r.name).sort(), ["experiment", "main"]);
  assert.equal(info.refs.find((r) => r.name === "experiment").subject, "try something");
  await fs.writeFile(path.join(root, "index.html"), "changed");
  assert.equal((await listRefs(root)).current.dirty, true);
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "uit-nogit-"));
  assert.match((await listRefs(plain)).error, /isn't a git repository/);
});

test("refuses refs that don't exist or look like options", async () => {
  const root = await repo();
  await assert.rejects(startVersion(root, "nope"), /No branch or commit called nope/);
  await assert.rejects(startVersion(root, "--help"), /Pick a branch/);
});

test("opens another branch of a plain HTML project on its own server", { timeout: 30000 }, async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, "index.html"), "<html><body><h1>main, edited</h1></body></html>");
  try {
    const first = await startVersion(root, "experiment");
    assert.equal(first.ref, "experiment");
    let run;
    for (let i = 0; i < 60; i++) {
      run = versionStatus(root)[0];
      if (run.status === "ready" || run.status === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(run.status, "ready", run.error);
    const html = await fetch(run.url).then((r) => r.text());
    assert.match(html, /<h1>experiment<\/h1>/);
    assert.match(html, /__uitMirror/);
    assert.doesNotMatch(html, /overlay\.js/);
    // Your checkout is untouched.
    assert.match(await fs.readFile(path.join(root, "index.html"), "utf8"), /main, edited/);
    assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
  } finally {
    await stopVersion(root, "experiment");
    assert.equal(versionStatus(root).length, 0);
    git(root, "worktree", "remove", "--force", worktreeDir(root, "experiment"));
  }
});
