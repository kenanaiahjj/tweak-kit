// Optional: one commit per Send for what was written directly (uiTweaks({ commit: true }), serve.mjs --commit).
// Only files that were clean before the write are committed, so a tweak never sweeps up work in progress.
import { execFile } from "node:child_process";
import path from "node:path";

const git = (cwd, args) =>
  new Promise((resolve) => execFile("git", args, { cwd, maxBuffer: 1 << 20 }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr || (error && error.message) || "").trim() })));

/** { ok: true } when `files` (absolute paths) are tracked and unmodified, else { ok: false, reason }. */
export async function filesAreClean(root, files) {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out !== "true") return { ok: false, reason: "not a git repository" };
  const rel = files.map((f) => path.relative(root, f));
  const status = await git(root, ["status", "--porcelain", "--", ...rel]);
  if (!status.ok) return { ok: false, reason: status.err };
  if (status.out) return { ok: false, reason: "a file it changes already had uncommitted changes" };
  return { ok: true };
}

/** Commits exactly `files` (absolute paths) with `message`: { ok, sha } or { ok: false, reason }. */
export async function commitFiles(root, files, message) {
  const rel = files.map((f) => path.relative(root, f));
  const add = await git(root, ["add", "--", ...rel]);
  if (!add.ok) return { ok: false, reason: add.err };
  const commit = await git(root, ["commit", "-m", message, "--", ...rel]);
  if (!commit.ok) return { ok: false, reason: commit.err || commit.out };
  const sha = await git(root, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, sha: sha.out };
}
