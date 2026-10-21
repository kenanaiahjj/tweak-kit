import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitFiles, filesAreClean } from "../git.mjs";
import { createTweaksHandler } from "../server-core.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-git-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "s.css"), ".note { color: #555; }\n.other { color: red; }\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

const batch = () => ({
  tweaks: [{ element: { classes: ["note"], tag: "p" }, changes: { color: { prop: "color", from: "#555", to: "#111", authoredIn: [{ selector: ".note", property: "color", file: "s.css", matches: 1 }] } } }],
});

// Calls the Send route the way the overlay does.
async function send(root, commit) {
  const handle = createTweaksHandler({ root, commit });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(batch()))]), { method: "POST", url: "/__ui-tweaks" });
  let status = 0, body = "";
  const res = { setHeader() {}, set statusCode(s) { status = s; }, end: (b) => (body = b) };
  await handle(req, res, () => assert.fail("not handled"));
  return { status, body: JSON.parse(body) };
}

test("filesAreClean: tracked and unmodified is clean, modified is not, outside git is not", async () => {
  const root = await repo();
  assert.deepEqual(await filesAreClean(root, [path.join(root, "s.css")]), { ok: true });
  await writeFile(path.join(root, "s.css"), "changed\n");
  assert.equal((await filesAreClean(root, [path.join(root, "s.css")])).ok, false);
  const plain = await mkdtemp(path.join(tmpdir(), "uitk-nogit-"));
  assert.match((await filesAreClean(plain, [path.join(plain, "a.css")])).reason, /not a git repository/);
});

test("commitFiles commits only the given files", async () => {
  const root = await repo();
  await writeFile(path.join(root, "s.css"), "a\n");
  await writeFile(path.join(root, "other.css"), "b\n");
  git(root, "add", "other.css"); // staged, but not ours
  const out = await commitFiles(root, [path.join(root, "s.css")], "UI tweak: test");
  assert.equal(out.ok, true);
  assert.equal(git(root, "log", "-1", "--format=%s"), "UI tweak: test");
  assert.equal(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "s.css");
  assert.match(git(root, "status", "--porcelain"), /A  other\.css/); // still staged, uncommitted
});

test("Send with commit on: one commit for the files it wrote", async () => {
  const root = await repo();
  const { body } = await send(root, true);
  assert.equal(body.commit.ok, true);
  assert.match(git(root, "log", "-1", "--format=%s"), /^UI tweak: \.note color/);
  assert.match(await readFile(path.join(root, "s.css"), "utf8"), /\.note \{ color: #111; \}/);
  assert.equal(git(root, "status", "--porcelain", "--", "s.css"), "");
});

test("Send with commit on, but the file already had uncommitted edits: written, not committed", async () => {
  const root = await repo();
  await writeFile(path.join(root, "s.css"), ".note { color: #555; }\n.other { color: blue; }\n"); // the user's work in progress
  const { body } = await send(root, true);
  assert.equal(body.commit.ok, false);
  assert.match(body.commit.reason, /uncommitted/);
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1");
  assert.match(await readFile(path.join(root, "s.css"), "utf8"), /\.note \{ color: #111; \}/);
});

test("Send without commit never touches git", async () => {
  const root = await repo();
  const { body } = await send(root, false);
  assert.equal(body.commit, null);
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1");
});
