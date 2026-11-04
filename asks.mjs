// "Ask Claude" requests from the panel: the dev server queues them in .ui-tweaks/asks.json, the
// Claude Code mod runs each (a designer agent that edits the code, or one that proposes variations)
// and writes the outcome to .ui-tweaks/asks/<id>.json. Two files, so neither side overwrites the other.
import { promises as fs } from "node:fs";
import path from "node:path";

const KEEP = 30;
const dir = (root) => path.join(root, ".ui-tweaks");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function readAsks(root) {
  return (await readJson(path.join(dir(root), "asks.json"), { asks: [] })).asks || [];
}

export async function addAsk(root, body) {
  const kind = body && body.kind;
  if (!["edit", "variations", "publish", "paper", "paper-pull", "tokens", "concept"].includes(kind)) throw Object.assign(new Error("kind is edit, variations, publish, paper, paper-pull, tokens or concept"), { status: 400 });
  // concept: a new screen for a feature the app doesn't have, designed to look like a reference screen.
  const ref = body.reference || {};
  if (kind === "concept" && (!/^\/__ui-tweaks\/snapshots\/s[a-z0-9]+\.html$/.test(String(ref.snapshot || "")) || !Array.isArray(ref.size) || ref.size.length !== 2)) throw Object.assign(new Error("A concept needs a reference screen with its picture"), { status: 400 });
  // tokens: the project's design tokens into the design tool (push) or its changes back into the CSS (pull).
  if (kind === "tokens" && (!["push", "pull"].includes(body.direction) || body.file !== ".ui-tweaks/paper/tokens.json")) throw Object.assign(new Error("tokens needs a direction and the saved tokens"), { status: 400 });
  // publish: Claude publishes a saved review page (a file in .ui-tweaks/reviews) as a shareable page.
  if (kind === "publish" && !/^\.ui-tweaks\/(reviews\/[a-z0-9-]+|handoff\/export-v[a-z0-9]+)\.html$/.test(String(body.file || ""))) throw Object.assign(new Error("publish needs a review or handoff file"), { status: 400 });
  // paper: Claude places a captured element or screen (a file in .ui-tweaks/paper) in the open Paper file.
  const captured = (f) => /^\.ui-tweaks\/paper\/p[a-z0-9]+\.html$/.test(String(f || ""));
  const files = kind === "paper" && Array.isArray(body.files) ? body.files.filter((f) => f && captured(f.file)).slice(0, 30) : [];
  if (kind === "paper" && (!files.length || files.length !== body.files.length)) throw Object.assign(new Error("paper needs captured files"), { status: 400 });
  // paper-pull: Claude brings what was changed in the design tool back into the source (from the original capture, when there is one).
  if (kind === "paper-pull" && body.file && !captured(body.file)) throw Object.assign(new Error("paper-pull takes a captured file"), { status: 400 });
  const instruction = String((body && body.instruction) || "").trim();
  if (!instruction && kind === "edit") throw Object.assign(new Error("Say what to change"), { status: 400 });
  if (!instruction && kind === "concept") throw Object.assign(new Error("Describe the feature"), { status: 400 });
  const ask = {
    id: `ask${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    kind,
    instruction: instruction.slice(0, 24000), // a layout variation to build carries its markup
    element: body.element || null,
    page: body.page || null,
    context: body.context || null, // for variations: the element's subtree and current styles
    count: Math.min(4, Math.max(1, Number(body.count) || 2)),
    // For variations: style changes only, rebuilt layouts only, either, or the element's missing states.
    ...(kind === "variations" && ["styles", "layout", "states"].includes(body.mode) ? { mode: body.mode } : {}),
    // Variations of the whole screen (nothing was selected), not one element.
    ...(kind === "variations" && body.scope === "screen" ? { scope: "screen" } : {}),
    // Design skills to work from (names; the mod finds them among the installed ones), at most 3.
    ...(Array.isArray(body.skills) && body.skills.length ? { skills: body.skills.filter((n) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(String(n))).slice(0, 3) } : {}),
    ...(kind === "publish" ? { file: body.file, title: String(body.title || "Design review").slice(0, 120) } : {}),
    ...(kind === "paper" ? { files: files.map((f) => ({ file: f.file, title: String(f.title || "Screen").slice(0, 120), width: Math.round(Number(f.width)) || 0, height: Math.round(Number(f.height)) || 0 })), title: String(body.title || "Screen").slice(0, 120), whole: !!body.whole } : {}),
    ...(kind === "paper-pull" ? { ...(body.file ? { file: body.file } : {}), title: String(body.title || "").slice(0, 120) } : {}),
    ...(kind === "tokens" ? { direction: body.direction, file: body.file } : {}),
    ...(kind === "concept" ? { reference: { snapshot: ref.snapshot, url: String(ref.url || "/").slice(0, 500), name: String(ref.name || "").slice(0, 120), size: ref.size.map((n) => Math.max(200, Math.min(3000, Math.round(Number(n) || 0)))) }, ...(body.from ? { from: String(body.from).slice(0, 40) } : {}), ...(body.fromName ? { fromName: String(body.fromName).slice(0, 120) } : {}) } : {}),
    ...(kind === "paper" || kind === "paper-pull" || kind === "tokens" ? { target: body.target === "figma" ? "figma" : "paper" } : {}),
    // Reference images attached in the panel (files the dev server saved in .ui-tweaks/refs).
    ...(Array.isArray(body.refs) && body.refs.length ? { refs: body.refs.filter((r) => /^\.ui-tweaks\/refs\/r[a-z0-9]+\.(png|jpg|webp|gif)$/.test(String(r))).slice(0, 6) } : {}),
    at: Date.now(),
  };
  await fs.mkdir(path.join(dir(root), "asks"), { recursive: true });
  const asks = [...(await readAsks(root)), ask].slice(-KEEP);
  await fs.writeFile(path.join(dir(root), "asks.json"), JSON.stringify({ asks }, null, 2) + "\n");
  return ask;
}

export async function cancelAsk(root, id) {
  const asks = (await readAsks(root)).filter((a) => a.id !== id);
  await fs.writeFile(path.join(dir(root), "asks.json"), JSON.stringify({ asks }, null, 2) + "\n");
  await fs.rm(path.join(dir(root), "asks", `${id}.json`), { force: true });
}

// The panel polls this every second or two: answer from memory until a file changes.
const statusCache = new Map(); // root -> { stamp, value }
// What can change: the request list, and the result files of requests not finished yet
// (a result file is rewritten in place, which a folder's timestamp doesn't show).
async function stampOf(root, cached) {
  const st = (f) => fs.stat(f).then((s) => s.mtimeMs, () => 0);
  const open = cached ? cached.value.filter((a) => a.status !== "done" && a.status !== "failed").map((a) => a.id) : [];
  const parts = [await st(path.join(dir(root), "asks.json")), await st(path.join(dir(root), "asks"))];
  for (const id of open) parts.push(await st(path.join(dir(root), "asks", `${id}.json`)));
  return parts.join("|");
}

/** The recent asks with their outcomes, for the panel: status is waiting, running, done or failed. */
export async function askStatus(root) {
  const cached = statusCache.get(root);
  const stamp = await stampOf(root, cached);
  if (cached && cached.stamp === stamp) return cached.value;
  const value = await readStatus(root);
  statusCache.set(root, { stamp, value });
  return value;
}

async function readStatus(root) {
  const asks = await readAsks(root);
  return Promise.all(
    asks.map(async (a) => {
      const result = await readJson(path.join(dir(root), "asks", `${a.id}.json`), null);
      // A send to a design tool keeps what Pull changes back needs: where, which capture, and its name.
      const design = a.kind === "paper" ? { target: a.target, title: a.title, capture: a.files && a.files[0] && a.files[0].file } : {};
      return { id: a.id, kind: a.kind, instruction: a.instruction, at: a.at, page: a.page && a.page.url, selector: a.element && a.element.selector, ...design, status: (result && result.status) || "waiting", ...(result || {}) };
    }),
  );
}
