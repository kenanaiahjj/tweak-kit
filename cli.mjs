#!/usr/bin/env node
// npx github:kenanaiahjj/tweak-kit init — sets a project up for the UI tweak kit:
// installs the kit, wires it into the dev server, and installs the Claude Code mod.
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "kenanaiahjj/tweak-kit";
const SPEC = `github:${REPO}`;
const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs", "vite.config.cts"];
const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"];

/** What kind of project `root` is, and which package manager it uses. */
export function detect(root) {
  const has = (f) => existsSync(path.join(root, f));
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
  const vite = VITE_CONFIGS.find(has);
  const next = NEXT_CONFIGS.find(has);
  const kind = vite ? "vite" : next ? "next" : has("package.json") ? "node" : has("index.html") ? "html" : "unknown";
  return { kind, pm, viteConfig: vite || null, nextConfig: next || null, hasPackage: has("package.json") };
}

const addDev = (pm) => ({ npm: `npm i -D ${SPEC}`, pnpm: `pnpm add -D ${SPEC}`, yarn: `yarn add -D ${SPEC}`, bun: `bun add -d ${SPEC}` })[pm];

/**
 * Adds the plugin to a Vite config: an import, and uiTweaks() at the front of `plugins`.
 * Returns { text, changed } or { manual: reason } when the file has a shape it won't guess at.
 */
export function patchViteConfig(text) {
  if (/ui-tweak-kit/.test(text)) return { text, changed: false };
  const cjs = /module\.exports\s*=/.test(text) && !/^\s*import\s/m.test(text);
  if (cjs) return { manual: "a CommonJS config" };
  let out;
  if (/plugins\s*:\s*\[/.test(text)) {
    out = text.replace(/plugins\s*:\s*\[/, (m) => `${m}uiTweaks(), `);
  } else {
    const m = /(defineConfig\(\s*\{|export\s+default\s+\{)/.exec(text);
    if (!m) return { manual: "no defineConfig({ ... }) or export default { ... } to add plugins to" };
    out = text.slice(0, m.index + m[0].length) + "\n  plugins: [uiTweaks()]," + text.slice(m.index + m[0].length);
  }
  const imports = [...out.matchAll(/^import[^;]*?from\s*["'][^"']+["'];?[^\S\n]*$/gm)];
  const line = 'import uiTweaks from "ui-tweak-kit/vite";';
  if (imports.length) {
    const last = imports[imports.length - 1];
    const at = last.index + last[0].length;
    out = out.slice(0, at) + "\n" + line + out.slice(at);
  } else out = line + "\n" + out;
  return { text: out, changed: true };
}

function run(cmd, cwd, quiet = false) {
  const r = spawnSync(cmd, { cwd, shell: true, stdio: quiet ? "pipe" : "inherit", encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}

async function addScript(root, name, command) {
  const file = path.join(root, "package.json");
  const pkg = JSON.parse(await fs.readFile(file, "utf8"));
  pkg.scripts = pkg.scripts || {};
  if (pkg.scripts[name]) return false;
  pkg.scripts[name] = command;
  await fs.writeFile(file, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

function installMod(log) {
  if (!run("claude --version", process.cwd(), true).ok) {
    log("• Claude Code not found on PATH. In Claude Code, run:\n    /plugin marketplace add " + REPO + "\n    /plugin install ui-tweaks@ui-tweak-kit");
    return;
  }
  const added = run(`claude plugin marketplace add ${REPO}`, process.cwd(), true);
  if (!added.ok && !/already/i.test(added.out)) run(`claude plugin marketplace update ui-tweak-kit`, process.cwd(), true);
  const installed = run("claude plugin install ui-tweaks@ui-tweak-kit", process.cwd(), true);
  log(installed.ok || /already/i.test(installed.out) ? "✓ Claude Code mod ui-tweaks installed (start a new Claude Code session to load it)" : `• Couldn't install the Claude Code mod:\n${installed.out.trim()}\n  Install it yourself: claude plugin marketplace add ${REPO} && claude plugin install ui-tweaks@ui-tweak-kit`);
}

export async function init(root, { skipInstall = false, skipMod = false, log = console.log } = {}) {
  const p = detect(root);
  log(`UI tweak kit: ${p.kind === "vite" ? `Vite project (${p.viteConfig})` : p.kind === "next" ? "Next.js project" : p.kind === "html" ? "plain HTML" : p.kind === "node" ? "Node project without Vite" : "unknown project"}, ${p.pm}`);
  if (p.hasPackage && !skipInstall) {
    const cmd = addDev(p.pm);
    log(`→ ${cmd}`);
    if (!run(cmd, root).ok) {
      log("✗ Installing the kit failed; fix the error above and run this again.");
      return { ok: false };
    }
  }
  if (p.kind === "vite") {
    const file = path.join(root, p.viteConfig);
    const patched = patchViteConfig(await fs.readFile(file, "utf8"));
    if (patched.manual) log(`• ${p.viteConfig} is ${patched.manual}: add the plugin yourself:\n    import uiTweaks from "ui-tweak-kit/vite";\n    plugins: [uiTweaks(), ...]`);
    else if (patched.changed) {
      await fs.writeFile(file, patched.text);
      log(`✓ Added uiTweaks() to ${p.viteConfig}`);
    } else log(`✓ ${p.viteConfig} already uses the kit`);
  } else if (p.kind === "next" || p.kind === "node") {
    if (await addScript(root, "tweaks", "ui-tweaks-serve --api-only --port 5199")) log('✓ Added the "tweaks" script (the kit\'s sidecar on port 5199)');
    log(`• Run it next to your dev server (${p.pm} run tweaks), and load the panel in development only, e.g. in app/layout.tsx:\n    {process.env.NODE_ENV === "development" && <script src="http://localhost:5199/__ui-tweaks/overlay.js" data-api="http://localhost:5199" data-root="${root}" defer />}`);
  } else if (p.kind === "html") {
    log(`• Plain HTML: serve it with the kit and open the printed URL:\n    npx -y ${SPEC} serve .`);
  } else {
    log("• Couldn't tell what kind of project this is. See https://github.com/" + REPO + "#readme");
  }
  if (!skipMod) installMod(log);
  log(p.kind === "vite" ? "Done. Start your dev server and press Tweak (bottom right), or Alt+T." : "Done.");
  return { ok: true, ...p };
}

// Run as a command (npx links the bin, so compare real paths), not when imported by the tests.
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(path.resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) {
  const [cmd = "init", ...rest] = process.argv.slice(2);
  if (cmd === "init") {
    init(process.cwd(), { skipInstall: rest.includes("--no-install"), skipMod: rest.includes("--no-mod") }).then((r) => process.exit(r.ok ? 0 : 1));
  } else if (cmd === "serve") {
    process.argv.splice(2, 1);
    await import("./serve.mjs");
  } else {
    console.log("Usage: npx github:" + REPO + " [init] [--no-install] [--no-mod]\n       npx github:" + REPO + " serve [dir]");
  }
}
