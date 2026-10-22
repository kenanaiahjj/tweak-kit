// Another version of the app next to the one you're editing: a branch (or any commit) checked out in a
// git worktree outside the project, with its own dev server, so the studio can show both side by side.
// The worktree lives in ~/.cache/ui-tweak-kit, not in the project, so nothing that scans the project
// (Tailwind, TypeScript, Claude's searches) sees a second copy of the code. Your checkout is never touched.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const git = (cwd, args) =>
  new Promise((resolve) => execFile("git", args, { cwd, maxBuffer: 4 << 20 }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || (error && error.message) || "").trim() })));

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs", "vite.config.cts"];
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const CONFIG_NAME = "vite.ui-tweaks-version.config.mjs";
const LOG_LINES = 40;

// In the version's pages: follows the studio's scrolling and navigation, so both sides show the same thing.
// Elements are found by their position in the page (nth child from <body>), which holds while the two
// versions have the same structure; anything that doesn't match is left alone.
export const MIRROR_SCRIPT = `(() => {
  if (window.__uitMirror) return;
  window.__uitMirror = true;
  const find = (path) => { let el = document.body; for (const i of path || []) { el = el && el.children[i]; } return el || null; };
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.uit !== "mirror") return;
    if (m.nav && location.pathname + location.search + location.hash !== m.nav) return location.replace(m.nav);
    if (m.scroll) {
      const el = m.scroll.path ? find(m.scroll.path) : document.scrollingElement;
      if (el) { el.scrollTop = m.scroll.top; el.scrollLeft = m.scroll.left; }
    }
  });
  if (parent !== window) parent.postMessage({ uit: "mirror-ready" }, "*");
})();`;

const runs = new Map(); // root -> Map(ref -> run)
const runsOf = (root) => runs.get(root) || runs.set(root, new Map()).get(root);

/** Branches (local, then remote) with their last commit, and what the project is on now. */
export async function listRefs(root) {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { error: "This project isn't a git repository, so there are no other versions to open." };
  const [head, dirty, refs] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
    git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(refname:short)%09%(objectname:short)%09%(committerdate:relative)%09%(subject)", "refs/heads", "refs/remotes"]),
  ]);
  const list = refs.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [full, name, sha, when, subject] = line.split("\t");
      return { name, sha, when, subject, remote: full.startsWith("refs/remotes/") };
    })
    .filter((r) => !/\/HEAD$/.test(r.name) && r.name !== "origin");
  const headSha = await git(root, ["rev-parse", "--short", "HEAD"]);
  return { current: { name: head.out, sha: headSha.out, dirty: !!dirty.out }, refs: list, running: versionStatus(root) };
}

/** Where a ref's worktree goes: one folder per project and ref, outside the project. */
export function worktreeDir(root, ref) {
  const project = `${path.basename(root)}-${createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 8)}`;
  return path.join(os.homedir(), ".cache", "ui-tweak-kit", "worktrees", project, ref.replace(/[^\w.-]+/g, "_"));
}

/**
 * A Vite config for the version: the project's own config (as that version has it), on its own port and
 * cache, allowed to read the project's node_modules, with the mirror script in its pages.
 */
export function versionViteConfig({ userConfig, port, mainRoot }) {
  const load = userConfig ? `import user from "./${userConfig}";\n` : "const user = {};\n";
  return `// Written by the UI tweak kit to run this version next to the one you're editing. Safe to delete.
${load}const MIRROR = ${JSON.stringify(MIRROR_SCRIPT)};
export default async (env) => {
  const c = (typeof user === "function" ? await user(env) : await user) || {};
  const plugins = [c.plugins || []].flat(Infinity).filter((p) => !(p && typeof p.name === "string" && p.name.startsWith("ui-tweaks")));
  const server = c.server || {};
  return {
    ...c,
    cacheDir: "node_modules/.ui-tweaks-version-vite",
    plugins: [...plugins, { name: "ui-tweaks:version-mirror", apply: "serve", transformIndexHtml: () => [{ tag: "script", children: MIRROR, injectTo: "body" }] }],
    server: { ...server, port: ${port}, strictPort: true, open: false, hmr: server.hmr === false ? false : { ...(typeof server.hmr === "object" ? server.hmr : {}), port: undefined },
      fs: { ...(server.fs || {}), allow: [...((server.fs && server.fs.allow) || []), ".", ${JSON.stringify(mainRoot)}] } },
  };
};
`;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const readMaybe = (f) => fs.readFile(f).catch(() => null);
const sameFile = async (a, b) => {
  const [x, y] = await Promise.all([readMaybe(a), readMaybe(b)]);
  return !!x && !!y && x.equals(y);
};

function pmOf(dir) {
  const has = (f) => existsSync(path.join(dir, f));
  return has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
}

function publicRun(run) {
  return { ref: run.ref, sha: run.sha, subject: run.subject, when: run.when, status: run.status, url: run.url, error: run.error, log: run.status === "failed" ? run.log.slice(-12).join("\n") : undefined };
}

export function versionStatus(root) {
  return [...runsOf(root).values()].map(publicRun);
}

function say(run, line) {
  for (const l of String(line).split("\n")) if (l.trim()) run.log.push(l.replace(/\x1b\[[0-9;]*m/g, ""));
  if (run.log.length > LOG_LINES) run.log.splice(0, run.log.length - LOG_LINES);
}

function exec(run, cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => say(run, d));
    p.stderr.on("data", (d) => say(run, d));
    p.on("error", (e) => { say(run, e.message); resolve(false); });
    p.on("close", (code) => resolve(code === 0));
  });
}

/** Opens `ref` (a branch, tag or commit) next to the app; resolves at once, the run reports its progress. */
export async function startVersion(root, ref) {
  ref = String(ref || "").trim();
  if (!ref || ref.startsWith("-")) throw Object.assign(new Error("Pick a branch"), { status: 400 });
  const resolved = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!resolved.ok) throw Object.assign(new Error(`No branch or commit called ${ref}`), { status: 400 });
  const all = runsOf(root);
  const existing = all.get(ref);
  if (existing && existing.status !== "failed" && existing.status !== "stopped") return publicRun(existing);
  if (existing) await stopVersion(root, ref);
  const info = await git(root, ["log", "-1", "--format=%h%x09%cr%x09%s", resolved.out]);
  const [sha, when, subject] = info.out.split("\t");
  const run = { ref, sha, when, subject, status: "preparing", url: null, error: null, log: [], proc: null, dir: worktreeDir(root, ref) };
  all.set(ref, run);
  prepare(root, run, resolved.out).catch((e) => fail(run, e.message));
  return publicRun(run);
}

function fail(run, message) {
  if (run.status === "stopped") return;
  run.status = "failed";
  run.error = message;
  if (run.proc) run.proc.kill();
}

async function prepare(root, run, commit) {
  const dir = run.dir;
  // The checkout: a detached worktree at the commit (works for the branch you're on, too).
  if (existsSync(path.join(dir, ".git"))) {
    run.status = "updating";
    await git(dir, ["reset", "--hard", "--quiet"]);
    const co = await git(dir, ["checkout", "--detach", "--force", commit]);
    if (!co.ok) return fail(run, `Couldn't check out ${run.ref}: ${co.err}`);
  } else {
    run.status = "checking out";
    await git(root, ["worktree", "prune"]);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.rm(dir, { recursive: true, force: true });
    const add = await git(root, ["worktree", "add", "--detach", "--force", dir, commit]);
    if (!add.ok) return fail(run, `Couldn't check out ${run.ref}: ${add.err}`);
  }
  if (run.status === "stopped") return;
  // Untracked settings the app needs to start (.env.local and friends), copied from your checkout.
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (/^\.env(\..+)?$/.test(name) && !existsSync(path.join(dir, name))) await fs.copyFile(path.join(root, name), path.join(dir, name)).catch(() => {});
  }
  // Dependencies: reuse the project's node_modules when the lockfile matches, install otherwise.
  const lock = LOCKFILES.find((f) => existsSync(path.join(dir, f)));
  const reuse = existsSync(path.join(root, "node_modules")) && (lock ? await sameFile(path.join(dir, lock), path.join(root, lock)) : await sameFile(path.join(dir, "package.json"), path.join(root, "package.json")));
  const nm = path.join(dir, "node_modules");
  const linked = await fs.readlink(nm).catch(() => null);
  if (reuse) {
    if (!linked) {
      await fs.rm(nm, { recursive: true, force: true });
      await fs.symlink(path.join(root, "node_modules"), nm, "junction");
    }
  } else if (existsSync(path.join(dir, "package.json"))) {
    if (linked) await fs.rm(nm, { force: true });
    run.status = "installing";
    const pm = pmOf(dir);
    say(run, `${pm} install (this version's dependencies differ from yours)`);
    if (!(await exec(run, pm, ["install"], dir))) return fail(run, `${pm} install failed in the ${run.ref} checkout`);
  }
  if (run.status === "stopped") return;
  await serve(root, run);
}

async function serve(root, run) {
  const dir = run.dir;
  const port = await freePort();
  run.status = "starting";
  const userConfig = VITE_CONFIGS.find((f) => existsSync(path.join(dir, f)));
  const viteBin = path.join(dir, "node_modules", "vite", "bin", "vite.js");
  let cmd, args;
  if (existsSync(viteBin)) {
    await fs.writeFile(path.join(dir, CONFIG_NAME), versionViteConfig({ userConfig, port, mainRoot: root }));
    [cmd, args] = [process.execPath, [viteBin, "--config", CONFIG_NAME, "--port", String(port), "--strictPort"]];
  } else if (existsSync(path.join(dir, "node_modules", "next"))) {
    [cmd, args] = [process.execPath, [path.join(dir, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(port)]];
  } else if (existsSync(path.join(dir, "index.html")) || !existsSync(path.join(dir, "package.json"))) {
    // Plain HTML: the kit's own static server, with only the mirror script in the pages.
    [cmd, args] = [process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "serve.mjs"), dir, "--port", String(port), "--mirror"]];
  } else {
    return fail(run, "Only Vite, Next.js and plain HTML projects can open another version for now.");
  }
  say(run, `starting ${run.ref} on port ${port}`);
  stopWithParent();
  const proc = spawn(cmd, args, { cwd: dir, env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  run.proc = proc;
  proc.stdout.on("data", (d) => say(run, d));
  proc.stderr.on("data", (d) => say(run, d));
  proc.on("exit", (code) => {
    run.proc = null;
    if (run.status !== "stopped") fail(run, `The ${run.ref} dev server stopped (exit ${code}).`);
  });
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && run.proc === proc) {
    const up = await fetch(url, { redirect: "manual" }).then(() => true, () => false);
    if (up) {
      run.url = url;
      run.status = "ready";
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (run.proc === proc) fail(run, `The ${run.ref} dev server didn't start within two minutes.`);
}

/** Stops a version's dev server. The worktree stays, so opening it again is quick. */
export async function stopVersion(root, ref) {
  const run = runsOf(root).get(ref);
  if (!run) return;
  run.status = "stopped";
  if (run.proc) run.proc.kill();
  runsOf(root).delete(ref);
}

// The versions' dev servers go when this one does. Set up with the first version, so a dev server that
// never opens one is left exactly as it was; a signal only exits here if nothing else was listening for it.
let watching = false;
function stopWithParent() {
  if (watching) return;
  watching = true;
  const stopAll = () => { for (const m of runs.values()) for (const run of m.values()) if (run.proc) run.proc.kill(); };
  process.once("exit", stopAll);
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.once(sig, () => { stopAll(); if (!process.listenerCount(sig)) process.exit(code); });
}
