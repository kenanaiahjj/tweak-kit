// Shared request handler for the UI Tweaks overlay.
// Serves the overlay script and stores batches of tweaks in <root>/.ui-tweaks/pending.json,
// which the Claude Code "ui-tweaks" mod watches.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_PATH = path.join(KIT_DIR, "overlay.js");
const PREFIX = "/__ui-tweaks";

export function tweaksDir(root) {
  return path.join(root, ".ui-tweaks");
}

async function readPending(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(tweaksDir(root), "pending.json"), "utf8"));
    return Array.isArray(parsed.batches) ? parsed : { version: 1, batches: [] };
  } catch {
    return { version: 1, batches: [] };
  }
}

async function writePending(root, pending) {
  const dir = tweaksDir(root);
  await fs.mkdir(dir, { recursive: true });
  // Keep the folder out of git without touching the project's .gitignore.
  await fs.writeFile(path.join(dir, ".gitignore"), "*\n");
  const file = path.join(dir, "pending.json");
  if (pending.batches.length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.writeFile(file, JSON.stringify(pending, null, 2) + "\n");
}

// Undo history written by the Claude Code mod: history.json lists Haiku's applies,
// each apply's file copies sit in history/slot-N.json.
async function readHistory(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(tweaksDir(root), "history.json"), "utf8")).entries || [];
  } catch {
    return [];
  }
}

/** Restores the files of the newest apply, unless one changed since; same rules as the mod's undo. */
async function undoLastApply(root) {
  const entries = await readHistory(root);
  const last = entries[entries.length - 1];
  if (!last) return { status: 404, body: { error: "There is no Haiku apply to undo." } };
  const saved = JSON.parse(await fs.readFile(path.resolve(root, last.slot), "utf8"));
  if (saved.id !== last.id) return { status: 409, body: { error: "The undo history is out of date." } };
  const changed = [];
  for (const f of saved.files) {
    const now = await fs.readFile(path.resolve(root, f.path), "utf8").catch(() => null);
    if (now !== f.after) changed.push(path.basename(f.path));
  }
  if (changed.length) return { status: 409, body: { error: `${changed.join(", ")} changed after Haiku edited it.`, changed } };
  for (const f of saved.files) await fs.writeFile(path.resolve(root, f.path), f.before);
  await fs.writeFile(path.join(tweaksDir(root), "history.json"), JSON.stringify({ entries: entries.slice(0, -1) }, null, 2) + "\n");
  return { status: 200, body: { ok: true, files: saved.files.map((f) => path.basename(f.path)) } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  // The overlay may be served by a sidecar on another port (Next.js and other dev servers).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * Connect-style middleware. `getVersion` (optional) returns a number that changes when
 * the served files change; the overlay reloads the page when it does (static mode only).
 */
export function createTweaksHandler({ root, getVersion }) {
  return async function handle(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) return next();
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (req.method === "GET" && url.pathname === `${PREFIX}/overlay.js`) {
        return send(res, 200, await fs.readFile(OVERLAY_PATH, "utf8"), "text/javascript");
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/status`) {
        const pending = await readPending(root);
        const last = (await readHistory(root)).slice(-1)[0];
        return send(res, 200, {
          lastApply: last ? { id: last.id, count: last.count, files: last.files.map((f) => path.basename(f)) } : null,
          pendingIds: pending.batches.map((b) => b.id),
          // Per tweak, so the overlay can drop previews one at a time and show Haiku's skip reasons.
          pendingTweaks: pending.batches.flatMap((b) => (b.tweaks || []).map((t, i) => ({ id: t.id || `${b.id}-${i}`, skipped: t.skipped }))),
          version: getVersion ? getVersion() : null,
        });
      }
      if (req.method === "POST" && url.pathname === `${PREFIX}/undo`) {
        const { status, body } = await undoLastApply(root);
        return send(res, status, body);
      }
      if (req.method === "POST" && url.pathname === PREFIX) {
        const batch = JSON.parse(await readBody(req));
        if (!batch || !Array.isArray(batch.tweaks) || batch.tweaks.length === 0) {
          return send(res, 400, { error: "batch.tweaks must be a non-empty array" });
        }
        batch.id = `t${Date.now().toString(36)}`;
        batch.createdAt = new Date().toISOString();
        batch.tweaks.forEach((t, i) => (t.id = `${batch.id}-${i}`));
        const pending = await readPending(root);
        pending.batches.push(batch);
        await writePending(root, pending);
        return send(res, 200, { ok: true, id: batch.id });
      }
      if (req.method === "DELETE" && url.pathname.startsWith(`${PREFIX}/`)) {
        const id = url.pathname.slice(PREFIX.length + 1);
        const pending = await readPending(root);
        pending.batches = pending.batches.filter((b) => b.id !== id);
        await writePending(root, pending);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "unknown ui-tweaks route" });
    } catch (error) {
      return send(res, 500, { error: String(error && error.message ? error.message : error) });
    }
  };
}

export function overlayScriptTag(root, { liveReload = false } = {}) {
  const attrs = [`src="${PREFIX}/overlay.js"`, `data-root="${root.replace(/"/g, "&quot;")}"`, "defer"];
  if (liveReload) attrs.push('data-live-reload="true"');
  return `<script ${attrs.join(" ")}></script>`;
}
