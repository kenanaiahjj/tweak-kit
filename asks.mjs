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
  if (kind !== "edit" && kind !== "variations") throw Object.assign(new Error("kind is edit or variations"), { status: 400 });
  const instruction = String((body && body.instruction) || "").trim();
  if (!instruction && kind === "edit") throw Object.assign(new Error("Say what to change"), { status: 400 });
  const ask = {
    id: `ask${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    kind,
    instruction: instruction.slice(0, 4000),
    element: body.element || null,
    page: body.page || null,
    context: body.context || null, // for variations: the element's subtree and current styles
    count: Math.min(4, Math.max(2, Number(body.count) || 3)),
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

/** The recent asks with their outcomes, for the panel: status is waiting, running, done or failed. */
export async function askStatus(root) {
  const asks = await readAsks(root);
  return Promise.all(
    asks.map(async (a) => {
      const result = await readJson(path.join(dir(root), "asks", `${a.id}.json`), null);
      return { id: a.id, kind: a.kind, instruction: a.instruction, at: a.at, page: a.page && a.page.url, selector: a.element && a.element.selector, status: (result && result.status) || "waiting", ...(result || {}) };
    }),
  );
}
