#!/usr/bin/env node
// Static server for plain HTML/CSS projects, with the UI Tweaks overlay injected and live reload.
// Usage: node serve.mjs [folder] [--port 5500] [--commit] [--no-auto-update]
//        node serve.mjs [project] --api-only [--port 5599]   (sidecar for Next.js and other dev servers)
import http from "node:http";
import { promises as fs, watch } from "node:fs";
import path from "node:path";
import { announceServer, createTweaksHandler, overlayScriptTag } from "./server-core.mjs";
import { MIRROR_SCRIPT } from "./versions.mjs";
import { checkForUpdate } from "./update.mjs";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 5500;
const folderArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
const root = path.resolve(folderArg || ".");
const apiOnly = args.includes("--api-only");
// --mirror: another version opened by the studio; its pages only follow the studio, without the panel.
const mirror = args.includes("--mirror");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

let version = Date.now();
if (!args.includes("--api-only")) watch(root, { recursive: true }, (_event, file) => {
  if (file && !file.split(path.sep).some((part) => part === ".ui-tweaks" || part === "node_modules" || part.startsWith(".git"))) {
    version = Date.now();
  }
});

const tweaks = createTweaksHandler({ root, getVersion: () => version, commit: args.includes("--commit") });

const server = http.createServer((req, res) => {
  tweaks(req, res, async () => {
    if (apiOnly) {
      res.statusCode = 404;
      return res.end("UI Tweaks sidecar: only /__ui-tweaks routes are served");
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      let file = path.join(root, pathname);
      if (!file.startsWith(root)) {
        res.statusCode = 403;
        return res.end("Forbidden");
      }
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.isDirectory()) file = path.join(file, "index.html");
      const ext = path.extname(file).toLowerCase();
      let body = await fs.readFile(file);
      if (ext === ".html") {
        const tag = mirror ? `<script>${MIRROR_SCRIPT}</script>` : overlayScriptTag(root, { liveReload: true });
        const html = body.toString("utf8");
        body = html.includes("</body>") ? html.replace("</body>", `${tag}\n</body>`) : html + tag;
      }
      res.setHeader("Content-Type", TYPES[ext] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
});

server.listen(port, () => {
  if (mirror) return console.log(`UI Tweaks: this version on http://localhost:${port}`);
  void announceServer(root, `http://localhost:${port}`);
  void checkForUpdate(root, { autoUpdate: !args.includes("--no-auto-update") });
  if (apiOnly) {
    console.log(`UI Tweaks sidecar on http://localhost:${port} for ${root}`);
    console.log(`Add to your dev page: <script src="http://localhost:${port}/__ui-tweaks/overlay.js" data-api="http://localhost:${port}" data-root="${root}" defer></script>`);
  } else {
    console.log(`UI Tweaks static server: http://localhost:${port}  (serving ${root})`);
  }
});
