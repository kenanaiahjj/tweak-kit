// Canvas copies: "Duplicate" on a screen makes a real copy of the app to explore a design in. Each copy is a
// git worktree on its own branch (tweak/<name>), outside the project like the versions, with your uncommitted
// work carried over, and its own dev server running the kit, so it can be tweaked by hand or by prompt without
// touching your checkout. Apply commits what changed in it to its branch and puts the copy away; Delete drops
// it and its branch. The list lives in .ui-tweaks/copies.json (this machine's, not shared).
import { execFile } from "node:child_process";
import { constants, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, git, provide, serve, sharedRuns, worktreeDir } from "./versions.mjs";

const KIT = fileURLToPath(new URL("./vite-plugin.mjs", import.meta.url));
const MAX_RUNNING = 3;
const CONFIG_NAME = "vite.ui-tweaks-version.config.mjs";
const file = (root) => path.join(root, ".ui-tweaks", "copies.json");
const runs = sharedRuns.copies; // root -> Map(id -> run), kept across Vite reloading the kit
const runsOf = (root) => runs.get(root) || runs.set(root, new Map()).get(root);
const oops = (message, status = 400) => Object.assign(new Error(message), { status });

export async function readCopies(root) {
  try {
    return (JSON.parse(await fs.readFile(file(root), "utf8")).copies || []).filter((c) => c && c.id && c.dir);
  } catch {
    return [];
  }
}
async function writeCopies(root, copies) {
  await fs.mkdir(path.dirname(file(root)), { recursive: true });
  await fs.writeFile(file(root), JSON.stringify({ copies }, null, 2) + "\n");
}
// One change at a time to the list (two Duplicates, or a move during an Apply).
let chain = Promise.resolve();
const change = (root, fn) => (chain = chain.then(async () => { const copies = await readCopies(root); const out = await fn(copies); await writeCopies(root, copies); return out; }));

export const slugify = (name) => String(name || "copy").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "copy";

// Files that are the copy's machinery, not its design: never committed by Apply.
export const isMachinery = (p) => p === CONFIG_NAME || p === "node_modules" || p.startsWith("node_modules/") || p.startsWith(".ui-tweaks/") || /^\.env(\..+)?$/.test(p);

/** A run's public face, with the copy's record (url is its dev server's address, once it's up). */
function publicCopy(copy, run) {
  return { ...copy, status: run ? run.status : "stopped", url: run ? run.url : null, error: run ? run.error : null, log: run && run.status === "failed" ? run.log.slice(-12).join("\n") : undefined };
}

/** Every copy with its server's state and how many files it has changed so far. */
export async function listCopies(root) {
  const copies = await readCopies(root);
  const all = runsOf(root);
  return Promise.all(copies.map(async (c) => {
    const changed = existsSync(c.dir) ? (await changedPaths(c, await status(c.dir))).length : 0;
    return { ...publicCopy(c, all.get(c.id)), changed, missing: !existsSync(c.dir) };
  }));
}

/** Makes a copy of the project as it is now (uncommitted work included) and starts its dev server. */
export async function createCopy(root, { name, url, device, from, x, y } = {}) {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) throw oops("Copies need the project to be a git repository.");
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (!head.ok) throw oops("Copies need at least one commit in the project.");
  name = String(name || "Copy").trim().slice(0, 80) || "Copy";
  let slug = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i ? `${slug}-${i + 1}` : slug;
    const taken = (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/tweak/${candidate}`])).ok || (await readCopies(root)).some((c) => c.slug === candidate);
    if (!taken) { slug = candidate; break; }
  }
  const copy = {
    id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name,
    slug,
    branch: `tweak/${slug}`,
    dir: worktreeDir(root, `copy-${slug}`),
    path: typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url.slice(0, 500) : "/", // the screen it copies
    device: String(device || "").slice(0, 40) || null,
    from: from ? String(from).slice(0, 40) : null,
    x: Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0,
    y: Number.isFinite(Number(y)) ? Math.round(Number(y)) : 0,
    startedFrom: head.out,
    at: Date.now(),
  };
  await change(root, (copies) => { copies.push(copy); });
  const run = newRun(root, copy, "copying");
  make(root, copy, run).catch((e) => fail(run, e.message));
  return publicCopy(copy, run);
}

function newRun(root, copy, status) {
  const run = { ref: copy.name, status, url: null, error: null, log: [], proc: null, dir: copy.dir, at: Date.now() };
  runsOf(root).set(copy.id, run);
  return run;
}

async function make(root, copy, run) {
  await git(root, ["worktree", "prune"]);
  await fs.mkdir(path.dirname(copy.dir), { recursive: true });
  await fs.rm(copy.dir, { recursive: true, force: true });
  const add = await git(root, ["worktree", "add", "-b", copy.branch, copy.dir, copy.startedFrom]);
  if (!add.ok) return fail(run, `Couldn't make the copy: ${add.err}`);
  // Your uncommitted work comes along: changes to tracked files as the branch's first commit, so Apply's
  // commit holds only what was explored in the copy; untracked files copied as they are (cloned where the
  // disk can), remembered so Apply only commits the ones the copy changed.
  const diff = await gitRaw(root, ["diff", "HEAD", "--binary"]);
  if (diff.length) {
    const patch = path.join(os.tmpdir(), `ui-tweaks-${copy.id}.patch`);
    await fs.writeFile(patch, diff);
    const applied = await git(copy.dir, ["apply", "--binary", "--whitespace=nowarn", patch]);
    await fs.rm(patch, { force: true });
    if (!applied.ok) return fail(run, `Couldn't carry your uncommitted changes into the copy: ${applied.err}`);
    await git(copy.dir, ["add", "-A"]);
    const done = await commit(copy.dir, "Canvas copy: start from your uncommitted changes");
    if (!done.ok) return fail(run, `Couldn't commit your uncommitted changes in the copy: ${done.err}`);
    copy.carried = true;
  }
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).out.split("\0").filter((p) => p && !isMachinery(p));
  const seen = {};
  for (const rel of untracked) {
    const to = path.join(copy.dir, rel);
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(path.join(root, rel), to, constants.COPYFILE_FICLONE);
      const st = await fs.stat(to);
      seen[rel] = [st.size, Math.round(st.mtimeMs)];
    } catch {}
  }
  copy.untracked = seen;
  copy.base = (await git(copy.dir, ["rev-parse", "HEAD"])).out;
  await change(root, (copies) => { const c = copies.find((x) => x.id === copy.id); if (c) Object.assign(c, { carried: !!copy.carried, untracked: seen, base: copy.base }); });
  if (run.status === "stopped") return;
  await boot(root, copy, run);
}

async function boot(root, copy, run) {
  run.status = "preparing";
  if (!(await provide(root, run))) return;
  if (run.status === "stopped") return;
  await serve(root, run, { kit: KIT });
}

// Stdout as bytes, untrimmed (a patch's trailing newline matters).
function gitRaw(cwd, args) {
  return new Promise((resolve) => execFile("git", args, { cwd, maxBuffer: 256 << 20, encoding: "buffer" }, (error, stdout) => resolve(error ? Buffer.alloc(0) : stdout)));
}

// Untrimmed: the first entry's status can start with a space.
const status = async (dir) => (await gitRaw(dir, ["status", "--porcelain", "-z", "--untracked-files=all"])).toString("utf8");

// A commit by whoever the repository says you are, or the kit when it says nobody; hooks skipped (it's a scratch branch).
async function commit(dir, message) {
  const r = await git(dir, ["commit", "--no-verify", "-m", message]);
  if (r.ok || !/identity|user\.(name|email)/i.test(r.err)) return r;
  return git(dir, ["-c", "user.name=UI Tweak Kit", "-c", "user.email=ui-tweak-kit@localhost", "commit", "--no-verify", "-m", message]);
}

/** Paths the copy changed since it was made (from `git status --porcelain -z`): tracked changes, and untracked files that are new or edited. */
export async function changedPaths(copy, porcelain) {
  const out = [];
  const parts = String(porcelain || "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const p = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // the original path follows a rename
    if (isMachinery(p)) continue;
    if (code === "??") {
      const was = copy.untracked && copy.untracked[p];
      if (was) {
        const st = await fs.stat(path.join(copy.dir, p)).catch(() => null);
        if (st && st.size === was[0] && Math.round(st.mtimeMs) === was[1]) continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** Starts a copy's dev server again (after a restart, or when it was stopped to make room). */
export async function startCopy(root, id) {
  const copy = (await readCopies(root)).find((c) => c.id === id);
  if (!copy) throw oops("That copy is gone", 404);
  if (!existsSync(copy.dir)) throw oops("This copy's folder is gone; delete it from the canvas.");
  const all = runsOf(root);
  const existing = all.get(id);
  if (existing && existing.status !== "failed" && existing.status !== "stopped") { existing.at = Date.now(); return publicCopy(copy, existing); }
  // A few at a time: each is a dev server. The one used longest ago makes room.
  const running = [...all.entries()].filter(([, r]) => r.proc).sort((a, b) => a[1].at - b[1].at);
  while (running.length >= MAX_RUNNING) stopCopy(root, running.shift()[0]);
  const run = newRun(root, copy, "preparing");
  boot(root, copy, run).catch((e) => fail(run, e.message));
  return publicCopy(copy, run);
}

export function stopCopy(root, id) {
  const run = runsOf(root).get(id);
  if (!run) return false;
  run.status = "stopped";
  if (run.proc) run.proc.kill();
  runsOf(root).delete(id);
  return true;
}

/** Where a copy sits on the canvas, and its name. */
export async function moveCopy(root, id, { x, y, name } = {}) {
  return change(root, (copies) => {
    const c = copies.find((x) => x.id === id);
    if (!c) throw oops("That copy is gone", 404);
    if (Number.isFinite(Number(x))) c.x = Math.round(Number(x));
    if (Number.isFinite(Number(y))) c.y = Math.round(Number(y));
    if (typeof name === "string" && name.trim()) c.name = name.trim().slice(0, 80);
    return c;
  });
}

async function putAway(root, copy) {
  stopCopy(root, copy.id);
  if (existsSync(copy.dir)) {
    const removed = await git(root, ["worktree", "remove", "--force", copy.dir]);
    if (!removed.ok) await fs.rm(copy.dir, { recursive: true, force: true });
  }
  await git(root, ["worktree", "prune"]);
  await change(root, (copies) => { const i = copies.findIndex((c) => c.id === copy.id); if (i >= 0) copies.splice(i, 1); });
}

/**
 * Apply: commits what the copy changed to its branch (tweak/<name>), then puts the copy away. Your checkout
 * isn't touched; the branch is there to review, merge or open a pull request from.
 */
export async function applyCopy(root, id, { message } = {}) {
  const copy = (await readCopies(root)).find((c) => c.id === id);
  if (!copy) throw oops("That copy is gone", 404);
  if (!existsSync(copy.dir)) throw oops("This copy's folder is gone; delete it from the canvas.");
  const paths = await changedPaths(copy, await status(copy.dir));
  if (!paths.length) throw oops("Nothing has changed in this copy yet.");
  const added = await git(copy.dir, ["add", "-A", "--", ...paths]);
  if (!added.ok) throw oops(`Couldn't stage the copy's changes: ${added.err}`, 500);
  const done = await commit(copy.dir, String(message || "").trim().slice(0, 200) || `Design: ${copy.name} (from the canvas)`);
  if (!done.ok) throw oops(`Couldn't commit the copy's changes: ${done.err}`, 500);
  const sha = (await git(copy.dir, ["rev-parse", "--short", "HEAD"])).out;
  await putAway(root, copy);
  return { ok: true, branch: copy.branch, sha, files: paths, carried: !!copy.carried };
}

/** Delete: the copy, its folder and its branch, with whatever was explored in it. */
export async function deleteCopy(root, id) {
  const copy = (await readCopies(root)).find((c) => c.id === id);
  if (!copy) return { ok: true };
  await putAway(root, copy);
  await git(root, ["branch", "-D", copy.branch]);
  return { ok: true };
}

/** For a copy's own dev server: which copy it is, from the project's list. */
export async function copyAt(mainRoot, dir) {
  return (await readCopies(mainRoot)).find((c) => path.resolve(c.dir) === path.resolve(dir)) || null;
}
