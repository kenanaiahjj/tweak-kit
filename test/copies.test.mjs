import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCopy, changedPaths, createCopy, deleteCopy, isMachinery, listCopies, moveCopy, readCopies, slugify } from "../copies.mjs";
import { addAsk } from "../asks.mjs";
import { versionViteConfig } from "../versions.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A project with a commit, uncommitted edits to a tracked file, and an untracked file.
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uit-copies-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@t");
  await fs.writeFile(path.join(root, "app.css"), "body { color: red; }\n");
  await fs.writeFile(path.join(root, "index.html"), "<h1>Hi</h1>\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  await fs.writeFile(path.join(root, "app.css"), "body { color: blue; }\n"); // uncommitted
  await fs.writeFile(path.join(root, "notes.md"), "draft\n"); // untracked
  return root;
}
// Made (the dev server then fails: it isn't a Vite project, which is fine here).
async function made(root, copy) {
  for (let i = 0; i < 100; i++) {
    const c = (await readCopies(root)).find((x) => x.id === copy.id);
    if (c && c.base) return c;
    await sleep(100);
  }
  throw new Error("copy never finished");
}
const cleanup = async (root) => {
  for (const c of await readCopies(root)) await deleteCopy(root, c.id);
  await fs.rm(root, { recursive: true, force: true });
};

test("names make branch-safe slugs; the copy's machinery is never committed", () => {
  assert.equal(slugify("Home · QR card copy!"), "home-qr-card-copy");
  assert.equal(slugify(""), "copy");
  for (const p of ["vite.ui-tweaks-version.config.mjs", "node_modules", "node_modules/x/y.js", ".ui-tweaks/canvas.json", ".env.local"]) assert.ok(isMachinery(p), p);
  assert.ok(!isMachinery("src/App.tsx"));
});

test("a copy's Vite config runs the kit, sending its asks to the project", () => {
  const text = versionViteConfig({ userConfig: "vite.config.ts", port: 7001, mainRoot: "/work/app", kit: "/kit/vite-plugin.mjs" });
  assert.match(text, /import kitPlugin from "\/kit\/vite-plugin\.mjs"/);
  assert.match(text, /copyOf: "\/work\/app"/);
  assert.doesNotMatch(text, /ui-tweaks:version-mirror/);
});

test("untracked files the copy didn't touch aren't changes; renames count their new path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uit-cp-"));
  await fs.writeFile(path.join(dir, "kept.md"), "x");
  const st = await fs.stat(path.join(dir, "kept.md"));
  const copy = { dir, untracked: { "kept.md": [st.size, Math.round(st.mtimeMs)] } };
  const porcelain = [" M src/a.css", "?? kept.md", "?? new.md", "R  src/new.tsx", "src/old.tsx", "?? node_modules", ""].join("\0");
  assert.deepEqual(await changedPaths(copy, porcelain), ["src/a.css", "new.md", "src/new.tsx"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("Duplicate: a worktree on tweak/<name> with your uncommitted work; Apply commits only what the copy changed", async () => {
  const root = await repo();
  try {
    const started = await createCopy(root, { name: "Home copy", url: "/home", device: "i16", from: "a1", x: 400, y: 0 });
    assert.equal(started.branch, "tweak/home-copy");
    assert.equal(started.path, "/home");
    const copy = await made(root, started);
    assert.ok(!copy.dir.startsWith(root));
    // Your uncommitted edit is the branch's first commit; the untracked file is copied, untracked.
    assert.equal(await fs.readFile(path.join(copy.dir, "app.css"), "utf8"), "body { color: blue; }\n");
    assert.equal(await fs.readFile(path.join(copy.dir, "notes.md"), "utf8"), "draft\n");
    assert.equal(git(copy.dir, "log", "-1", "--format=%s").trim(), "Canvas copy: start from your uncommitted changes");
    assert.ok(copy.carried);
    // The project's checkout is as it was.
    assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
    assert.match(git(root, "status", "--porcelain"), /M app\.css/);

    const [listed] = await listCopies(root);
    assert.equal(listed.changed, 0);
    await moveCopy(root, copy.id, { x: 800, y: 64 });
    assert.equal((await readCopies(root))[0].x, 800);

    // An ask from the copy runs in the copy; an unknown folder is refused.
    const ask = await addAsk(root, { kind: "edit", instruction: "bigger title", dir: copy.dir });
    assert.equal(ask.dir, copy.dir);
    assert.equal(ask.branch, "tweak/home-copy");
    await assert.rejects(addAsk(root, { kind: "edit", instruction: "x", dir: "/tmp/elsewhere" }), /gone/);

    await assert.rejects(applyCopy(root, copy.id), /Nothing has changed/);
    await fs.writeFile(path.join(copy.dir, "index.html"), "<h1>Hello</h1>\n");
    await fs.writeFile(path.join(copy.dir, "vite.ui-tweaks-version.config.mjs"), "// machinery");
    assert.equal((await listCopies(root))[0].changed, 1);
    const out = await applyCopy(root, copy.id, { message: "Bigger hello" });
    assert.deepEqual(out.files, ["index.html"]);
    assert.equal(out.branch, "tweak/home-copy");
    // The branch: your work, then the design. The copy is put away; the branch stays.
    assert.equal(git(root, "log", "-2", "--format=%s", "tweak/home-copy").trim(), "Bigger hello\nCanvas copy: start from your uncommitted changes");
    assert.deepEqual(git(root, "show", "--name-only", "--format=", "tweak/home-copy").trim().split("\n"), ["index.html"]);
    assert.ok(!existsSync(copy.dir));
    assert.deepEqual(await readCopies(root), []);
    assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
  } finally {
    await cleanup(root);
  }
});

test("Delete drops the copy, its folder and its branch", async () => {
  const root = await repo();
  try {
    const copy = await made(root, await createCopy(root, { name: "Throwaway" }));
    assert.match(git(root, "branch", "--list", "tweak/throwaway"), /tweak\/throwaway/);
    // A second copy with the same name gets its own branch.
    const second = await made(root, await createCopy(root, { name: "Throwaway" }));
    assert.equal(second.branch, "tweak/throwaway-2");
    await deleteCopy(root, copy.id);
    assert.ok(!existsSync(copy.dir));
    assert.equal(git(root, "branch", "--list", "tweak/throwaway").trim(), "");
    assert.equal((await readCopies(root)).length, 1);
  } finally {
    await cleanup(root);
  }
});
