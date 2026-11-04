// The handoff viewer: a read-only canvas of a version's screens with Inspect, search (⌘/Ctrl+F),
// before/after for screens that changed, and a link to the hosted app when the version has one. The page's script and
// styles live in handoff-viewer.js / .css; with `embedded` the data is inside the page (a shareable export),
// without it the viewer reads it from the dev server.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const read = (f) => readFileSync(here(f), "utf8");
// JSON inside a <script>: nothing in it may close the tag or open a comment.
const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function handoffPage({ embedded = null } = {}) {
  const title = embedded ? `${embedded.project} · Handoff` : "Handoff";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title.replace(/</g, "&lt;")}</title>
<style>${read("handoff-viewer.css")}</style>
</head>
<body>
<div id="hf"></div>
${embedded ? `<script>window.__HANDOFF_DATA = ${safeJson(embedded)};</script>` : ""}
<script>${read("handoff-viewer.js").replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`;
}
