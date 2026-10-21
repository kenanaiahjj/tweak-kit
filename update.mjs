// Update check: compares the installed kit (the commit pinned in the project's lockfile)
// with main on GitHub, and optionally reinstalls it. Skipped for a git checkout of the kit.
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "kenanaiahjj/tweak-kit";
const SPEC = `github:${REPO}`;
const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCKS = [
  ["package-lock.json", `npm i -D ${SPEC}`],
  ["pnpm-lock.yaml", `pnpm add -D ${SPEC}`],
  ["yarn.lock", `yarn add -D ${SPEC}`],
  ["bun.lock", `bun add -d ${SPEC}`],
  ["bun.lockb", `bun add -d ${SPEC}`],
];

// What the overlay shows. null until a check finds something worth saying.
let update = null;
export const updateStatus = () => update;

async function findLock(root) {
  for (let dir = root, i = 0; i < 5; i++, dir = path.dirname(dir)) {
    for (const [file, command] of LOCKS) {
      const p = path.join(dir, file);
      if (existsSync(p)) return { path: p, dir, command };
    }
    if (path.dirname(dir) === dir) break;
  }
  return null;
}

// The commit the lockfile pins, and which repo it came from.
async function installedCommit(lock) {
  if (lock.path.endsWith(".lockb")) return null;
  const text = await fs.readFile(lock.path, "utf8");
  // Some lockfiles (bun) pin a short commit id.
  const m = /([\w.-]+\/tweak-kit)(?:\.git)?(?:#|\/tar\.gz\/|\/)([0-9a-f]{7,40})\b/.exec(text);
  return m ? { repo: m[1].split("/").slice(-2).join("/"), sha: m[2] } : null;
}

const unescape = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// The nearest directory (from the project up) whose package.json lists the kit.
async function packageListingKit(root) {
  for (let dir = root, i = 0; i < 5; i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
      if (["dependencies", "devDependencies", "optionalDependencies"].some((k) => pkg[k] && pkg[k]["ui-tweak-kit"])) return dir;
    } catch {}
    if (path.dirname(dir) === dir) break;
  }
  return null;
}

function run(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim().split("\n").slice(-5).join("\n") }));
    child.on("error", (e) => resolve({ ok: false, out: e.message }));
  });
}

/**
 * Checks once per dev-server start. `log` prints to the terminal.
 * autoUpdate: reinstall from GitHub when behind (the dev server still needs a restart).
 */
export async function checkForUpdate(root, { autoUpdate = true, log = console.log } = {}) {
  if (process.env.CI || process.env.UI_TWEAKS_NO_UPDATE_CHECK) return;
  if (existsSync(path.join(KIT_DIR, ".git"))) return; // a working copy of the kit: you're the source
  try {
    const lock = await findLock(root);
    const installed = lock && (await installedCommit(lock));
    if (!lock || !installed) return;
    const command = lock.command;
    if (installed.repo.toLowerCase() !== REPO.toLowerCase()) {
      update = { behind: null, moved: true, command };
      log(`[ui-tweaks] The kit moved to ${REPO}. Reinstall it from there:\n  ${command}`);
      return;
    }
    // The commits feed has no API rate limit (the REST API allows 60 calls an hour per IP).
    const res = await fetch(`https://github.com/${REPO}/commits/main.atom`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const feed = await res.text();
    const commits = [...feed.matchAll(/Grit::Commit\/([0-9a-f]{40})<\/id>[\s\S]*?<title>\s*([\s\S]*?)\s*<\/title>/g)].map((m) => ({ sha: m[1], title: unescape(m[2]) }));
    const same = (c) => c.sha.startsWith(installed.sha);
    if (!commits.length || same(commits[0])) return;
    const at = commits.findIndex(same);
    const behind = at === -1 ? `${commits.length}+` : at;
    const latest = commits.slice(0, Math.min(3, at === -1 ? 3 : at)).map((c) => c.title);
    update = { behind, latest, command };
    // In a workspace the lockfile sits above the app; installing there would add the kit to the wrong package.
    const owner = await packageListingKit(root);
    if (owner && owner !== lock.dir) {
      update.command = `cd ${path.relative(root, owner) || "."} && ${command}`;
      log(`[ui-tweaks] ${behind} update${behind === 1 ? "" : "s"} available. This looks like a workspace; update from the app's package with your package manager (${command}).`);
      return;
    }
    if (!autoUpdate) {
      log(`[ui-tweaks] ${behind} update${behind === 1 ? "" : "s"} available. Update with:\n  ${command}\nthen restart the dev server.`);
      return;
    }
    update = { ...update, installing: true };
    log(`[ui-tweaks] ${behind} update${behind === 1 ? "" : "s"} available; installing (${command})…`);
    const result = await run(command, lock.dir);
    update = { ...update, installing: false, installed: result.ok, error: result.ok ? undefined : result.out };
    log(result.ok ? "[ui-tweaks] Updated. Restart the dev server to use the new version." : `[ui-tweaks] Update failed:\n${result.out}`);
  } catch {
    // Offline or rate limited: try again next start.
  }
}
