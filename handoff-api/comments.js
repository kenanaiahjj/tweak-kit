// Comments on a shared handoff, deployed with it (api/comments.js on the handoff's Vercel project). Each
// comment is its own blob (comments/<id>.json, never rewritten); resolving one adds resolved/<id>, reopening
// removes it, so nothing depends on a cached copy being fresh. Anyone with the handoff's link can comment.
import { del, list, put } from "@vercel/blob";

const json = (res, code, body) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
const clip = (v, n) => String(v ?? "").slice(0, n);
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 20000) break; }
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (req.method === "GET") {
      const [{ blobs }, { blobs: done }] = await Promise.all([list({ prefix: "comments/", limit: 1000 }), list({ prefix: "resolved/", limit: 1000 })]);
      const resolved = new Set(done.map((b) => b.pathname.slice("resolved/".length)));
      const items = await Promise.all(blobs.map(async (b) => { try { return await (await fetch(b.url)).json(); } catch { return null; } }));
      return json(res, 200, { comments: items.filter(Boolean).map((c) => ({ ...c, resolved: resolved.has(c.id) })).sort((a, b) => a.at - b.at) });
    }
    const body = await readBody(req);
    if (req.method === "POST") {
      const text = clip(body.text, 2000).trim();
      if (!text) return json(res, 400, { error: "Write a comment" });
      const c = {
        id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        text,
        author: clip(body.author, 60).trim() || "Someone",
        version: clip(body.version, 40),
        screen: clip(body.screen, 40),
        screenName: clip(body.screenName, 120),
        path: clip(body.path, 1000),
        label: clip(body.label, 120),
        x: Math.round(Number(body.x) || 0),
        y: Math.round(Number(body.y) || 0),
        at: Date.now(),
      };
      await put(`comments/${c.id}.json`, JSON.stringify(c), { access: "public", contentType: "application/json", addRandomSuffix: false });
      return json(res, 200, { comment: { ...c, resolved: false } });
    }
    if (req.method === "PATCH") {
      const id = /^c[a-z0-9]{4,20}$/.test(String(body.id || "")) ? body.id : null;
      if (!id) return json(res, 400, { error: "No such comment" });
      if (body.resolved) await put(`resolved/${id}`, "1", { access: "public", contentType: "text/plain", addRandomSuffix: false, allowOverwrite: true });
      else { const { blobs } = await list({ prefix: `resolved/${id}` }); if (blobs.length) await del(blobs.map((b) => b.url)); }
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: "Not allowed" });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
}
