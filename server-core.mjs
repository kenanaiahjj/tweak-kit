// Shared request handler for the UI Tweaks overlay.
// Serves the overlay script and stores batches of tweaks in <root>/.ui-tweaks/pending.json,
// which the Claude Code "ui-tweaks" mod watches.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyDirect } from "./direct-apply.mjs";

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

const SLOTS = 10;

/** Records an apply for undo, in the same format the Claude Code mod writes. */
export async function recordHistory(root, { by, count, files }) {
  if (!files.length) return null;
  const dir = tweaksDir(root);
  const entries = await readHistory(root);
  const lastSlot = Number((/(\d+)\.json$/.exec(entries.length ? entries[entries.length - 1].slot : "") || [])[1] ?? -1);
  const slot = `.ui-tweaks/history/slot-${(lastSlot + 1) % SLOTS}.json`;
  const at = Date.now();
  const id = `h${at.toString(36)}`;
  await fs.mkdir(path.join(dir, "history"), { recursive: true });
  await fs.writeFile(path.resolve(root, slot), JSON.stringify({ id, files }));
  const next = [...entries.filter((e) => e.slot !== slot), { id, at, by, count, slot, files: files.map((f) => f.path) }].slice(-SLOTS);
  await fs.writeFile(path.join(dir, "history.json"), JSON.stringify({ entries: next }, null, 2) + "\n");
  return id;
}

/** Appends outcomes to .ui-tweaks/log.json (newest last, last 300 kept). */
export async function appendLog(root, items) {
  if (!items.length) return;
  const file = path.join(tweaksDir(root), "log.json");
  let log = [];
  try {
    log = JSON.parse(await fs.readFile(file, "utf8")).entries || [];
  } catch {}
  await fs.writeFile(file, JSON.stringify({ entries: [...log, ...items].slice(-300) }, null, 2) + "\n");
}

/** Restores the files of the newest apply, unless one changed since; same rules as the mod's undo. */
async function undoLastApply(root) {
  const entries = await readHistory(root);
  const last = entries[entries.length - 1];
  if (!last) return { status: 404, body: { error: "There is no apply to undo." } };
  const saved = JSON.parse(await fs.readFile(path.resolve(root, last.slot), "utf8"));
  if (saved.id !== last.id) return { status: 409, body: { error: "The undo history is out of date." } };
  const changed = [];
  for (const f of saved.files) {
    const now = await fs.readFile(path.resolve(root, f.path), "utf8").catch(() => null);
    if (now !== f.after) changed.push(path.basename(f.path));
  }
  if (changed.length) return { status: 409, body: { error: `${changed.join(", ")} changed after the apply.`, changed } };
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

/** Tells the Claude Code mod where this dev server is: <root>/.ui-tweaks/server.json. */
export async function announceServer(root, url) {
  const dir = tweaksDir(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".gitignore"), "*\n");
  await fs.writeFile(path.join(dir, "server.json"), JSON.stringify({ url, pid: process.pid, at: Date.now() }) + "\n");
}

/**
 * Connect-style middleware. `getVersion` (optional) returns a number that changes when
 * the served files change; the overlay reloads the page when it does (static mode only).
 */
export function createTweaksHandler({ root, getVersion }) {
  // The Claude Code pane drives the page through here: the page posts what is selected,
  // the pane polls for it and posts commands, which reach the page over server-sent events.
  const remote = { version: 0, snapshot: null, pages: new Set(), seenAt: 0 };
  const toPages = (data) => {
    for (const page of remote.pages) page.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  return async function handle(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) return next();
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (req.method === "GET" && url.pathname === `${PREFIX}/remote/events`) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
        res.write(": connected\n\n");
        remote.pages.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => {
          clearInterval(ping);
          remote.pages.delete(res);
        });
        return;
      }
      if (req.method === "POST" && url.pathname === `${PREFIX}/remote/state`) {
        remote.snapshot = JSON.parse(await readBody(req));
        remote.version++;
        return send(res, 200, { ok: true, version: remote.version });
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/remote/state`) {
        remote.seenAt = Date.now();
        const since = Number(url.searchParams.get("since") || -1);
        if (since === remote.version) return send(res, 200, { version: remote.version, unchanged: true, pages: remote.pages.size });
        return send(res, 200, { version: remote.version, snapshot: remote.snapshot, pages: remote.pages.size });
      }
      if (req.method === "POST" && url.pathname === `${PREFIX}/remote/command`) {
        remote.seenAt = Date.now();
        if (!remote.pages.size) return send(res, 409, { error: "No page with the overlay is open." });
        toPages(JSON.parse(await readBody(req)));
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/overlay.js`) {
        return send(res, 200, await fs.readFile(OVERLAY_PATH, "utf8"), "text/javascript");
      }
      if (req.method === "GET" && url.pathname === `${PREFIX}/status`) {
        const pending = await readPending(root);
        const last = (await readHistory(root)).slice(-1)[0];
        return send(res, 200, {
          remote: Date.now() - remote.seenAt < 4000,
          lastApply: last ? { id: last.id, by: last.by, count: last.count, files: last.files.map((f) => path.basename(f)) } : null,
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
        // Simple tweaks go straight into the source; the rest wait for Haiku.
        const direct = await applyDirect(root, batch);
        for (const f of direct.files) await fs.writeFile(f.path, f.after);
        await fs.mkdir(tweaksDir(root), { recursive: true });
        await fs.writeFile(path.join(tweaksDir(root), ".gitignore"), "*\n");
        await recordHistory(root, { by: "direct", count: direct.applied.length, files: direct.files });
        const label = (t) => (t.element && (t.element.classes[0] ? "." + t.element.classes[0] : t.element.tag)) || "?";
        const byId = new Map(batch.tweaks.map((t) => [t.id, t]));
        await appendLog(root, [
          ...direct.applied.map((a) => ({ at: batch.createdAt, id: a.id, element: label(byId.get(a.id)), by: "direct", outcome: "applied", props: [...a.props, ...(a.text ? ["text"] : [])], files: a.files })),
          ...direct.remaining.map((t) => ({ at: batch.createdAt, id: t.id, element: label(t), by: "direct", outcome: "sent to Haiku", props: Object.keys(t.changes || {}), reason: t.directSkip })),
        ]);
        if (direct.remaining.length) {
          const pending = await readPending(root);
          pending.batches.push({ ...batch, tweaks: direct.remaining });
          await writePending(root, pending);
        }
        return send(res, 200, { ok: true, id: batch.id, direct: direct.applied.map((a) => a.id), queued: direct.remaining.map((t) => t.id) });
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
