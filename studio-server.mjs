// The studio on its own: point it at any running dev server and a project folder, and it works without
// installing anything in the project. It sits in front of the dev server (a reverse proxy, websockets and
// hot reload included), adds the panel to the app's pages, and serves the studio and the kit's API itself,
// so everything is one origin. Usage:
//   npx github:kenanaiahjj/tweak-kit studio [http://localhost:5173] [--root <project folder>] [--port 5600]
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { existsSync, promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { announceServer, createTweaksHandler, overlayScriptTag } from "./server-core.mjs";
import { fixLineNumbers } from "./vite-plugin.mjs";

const PREFIX = "/__ui-tweaks";
// Recent projects; UIT_STUDIO_RECENTS points it elsewhere (the tests do).
const RECENTS = process.env.UIT_STUDIO_RECENTS || path.join(os.homedir(), ".ui-tweaks", "studio.json");
const KEEP = 12;

async function readRecents() {
  try {
    return JSON.parse(await fs.readFile(RECENTS, "utf8")).recent || [];
  } catch {
    return [];
  }
}
async function remember(entry) {
  const recent = [entry, ...(await readRecents()).filter((r) => r.root !== entry.root)].slice(0, KEEP);
  await fs.mkdir(path.dirname(RECENTS), { recursive: true });
  await fs.writeFile(RECENTS, JSON.stringify({ recent }, null, 2) + "\n");
}

/** Normalises what someone typed as the app's address: "5173", "localhost:3000", "http://127.0.0.1:8080/app". */
export function normalizeTarget(input) {
  let t = String(input || "").trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) t = "localhost:" + t;
  if (!/^https?:\/\//i.test(t)) t = "http://" + t;
  try {
    const u = new URL(t);
    return u.origin;
  } catch {
    return null;
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** The local address a dev server prints when it's up ("Local: http://localhost:5173/", "ready on http://localhost:3000"). */
export function addressIn(text) {
  const m = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?/i.exec(String(text).replace(ANSI, ""));
  return m ? m[0].replace("0.0.0.0", "localhost") : null;
}

/** Adds the panel to an HTML page (unless the project already loads it). Pages may stream: the tag goes at the end. */
export function injectTag(root) {
  return overlayScriptTag(root);
}

// React 19 dropped where each element was written; the Vite plugin wraps the JSX runtime to keep it.
// Here the same is done to the runtime Vite pre-bundles (a CommonJS module object its importers read
// jsxDEV from), so the panel finds exact source lines without anything installed in the project.
const RUNTIME_PATH = /\/\.vite\/deps\/react_jsx-dev-runtime\.js$/;
export function wrapJsxRuntime(code) {
  const m = /export default (require_\w+)\(\);/.exec(code);
  if (!m || code.includes("__uitSources")) return code;
  return code.replace(m[0], `const __uitRt = ${m[1]}();
const __uitWhere = (globalThis.__uitSources ||= new WeakMap());
const __uitJsx = __uitRt && __uitRt.jsxDEV;
if (typeof __uitJsx === "function") {
  try {
    __uitRt.jsxDEV = function jsxDEV(type, props, key, isStatic, source, self) {
      const element = __uitJsx(type, props, key, isStatic, source, self);
      if (source && element && element.props && typeof element.props === "object") __uitWhere.set(element.props, source);
      return element;
    };
  } catch {}
}
export default __uitRt;`);
}

// Headers a page from the dev server shouldn't keep once it's served from the studio's address.
const DROP = ["content-security-policy", "content-security-policy-report-only", "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"];

export function createStudioServer({ target = null, root = null, port = 5600, log = console.log } = {}) {
  const state = { target, root, handler: null, dev: null, devLog: [], starting: false };
  // Connections to the dev server are reused (pages load dozens of modules); closed with the studio.
  const agents = { "http:": new http.Agent({ keepAlive: true }), "https:": new https.Agent({ keepAlive: true, rejectUnauthorized: false }) };
  const setProject = async (nextTarget, nextRoot) => {
    state.target = nextTarget;
    if (nextRoot !== state.root || !state.handler) {
      state.root = nextRoot;
      state.handler = nextRoot ? createTweaksHandler({ root: nextRoot }) : null;
    }
    if (state.root) {
      void announceServer(state.root, `http://localhost:${port}`);
      void remember({ target: state.target, root: state.root, name: path.basename(state.root), at: Date.now() });
    }
  };
  if (root) void setProject(target, root);

  function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 100000) reject(new Error("too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  async function reachable(origin) {
    try {
      const r = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(2500) });
      return r.status > 0;
    } catch {
      return false;
    }
  }

  // Starts the project's own dev script and takes the address it prints.
  function startDev(rootDir) {
    if (state.dev) state.dev.kill();
    const has = (f) => existsSync(path.join(rootDir, f));
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
    state.devLog = [];
    state.starting = true;
    const proc = spawn(pm, ["run", "dev"], { cwd: rootDir, env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    state.dev = proc;
    const take = (d) => {
      const text = String(d);
      for (const l of text.split("\n")) if (l.trim()) state.devLog.push(l.replace(ANSI, ""));
      state.devLog = state.devLog.slice(-30);
      const found = state.starting && addressIn(text);
      if (found) {
        state.starting = false;
        void setProject(found, rootDir);
        log(`Dev server up at ${found}`);
      }
    };
    proc.stdout.on("data", take);
    proc.stderr.on("data", take);
    proc.on("exit", (code) => {
      if (state.dev === proc) state.dev = null;
      if (state.starting) state.devLog.push(`The dev script stopped (exit ${code}).`);
      state.starting = false;
    });
  }

  async function connectApi(req, res) {
    if (req.method === "GET") {
      const has = (f) => state.root && existsSync(path.join(state.root, f));
      let scripts = {};
      try { if (has("package.json")) scripts = JSON.parse(await fs.readFile(path.join(state.root, "package.json"), "utf8")).scripts || {}; } catch {}
      return json(res, 200, { target: state.target, root: state.root, up: state.target ? await reachable(state.target) : false, starting: state.starting, devRunning: !!state.dev, devLog: state.devLog.slice(-12), hasDev: !!scripts.dev, recent: await readRecents(), home: os.homedir() });
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const rootDir = body.root ? path.resolve(String(body.root).replace(/^~(?=$|\/)/, os.homedir())) : null;
    if (!rootDir || !existsSync(rootDir) || !statSync(rootDir).isDirectory()) return json(res, 400, { error: "That project folder doesn't exist." });
    if (body.start) {
      await setProject(null, rootDir);
      startDev(rootDir);
      return json(res, 200, { ok: true, starting: true });
    }
    // Only the folder (Claude Code's /studio without an address): the connect page asks for the rest.
    if (!body.target) {
      await setProject(state.root === rootDir ? state.target : null, rootDir);
      return json(res, 200, { ok: true, up: state.target ? await reachable(state.target) : false, target: state.target });
    }
    const t = normalizeTarget(body.target);
    if (!t) return json(res, 400, { error: "Give the address your dev server prints, e.g. http://localhost:5173" });
    const self = normalizeTarget(`localhost:${port}`);
    if (t === self || t === `http://127.0.0.1:${port}`) return json(res, 400, { error: "That's the studio's own address; give your app's dev server instead." });
    await setProject(t, rootDir);
    return json(res, 200, { ok: true, up: await reachable(t) });
  }

  function proxy(req, res) {
    const t = new URL(state.target);
    const lib = t.protocol === "https:" ? https : http;
    const self = `http://${req.headers.host}`;
    const headers = { ...req.headers, host: t.host, "accept-encoding": "identity" };
    // Always fetch the JSX runtime fresh, so a copy cached before it was wrapped isn't reused.
    // (the project's JSX modules too: they're rewritten to import it, so a cached original won't do).
    const p = req.url.split("?")[0];
    if (RUNTIME_PATH.test(p) || (/\.[jt]sx$/.test(p) && !p.includes("/node_modules/"))) { delete headers["if-none-match"]; delete headers["if-modified-since"]; }
    if (headers.origin) headers.origin = t.origin;
    if (headers.referer) headers.referer = headers.referer.replace(self, t.origin);
    const out = lib.request({ protocol: t.protocol, hostname: t.hostname, port: t.port, method: req.method, path: req.url, headers, agent: agents[t.protocol] }, (pres) => {
      const h = {};
      for (const [k, v] of Object.entries(pres.headers)) if (!DROP.includes(k)) h[k] = v;
      if (typeof h.location === "string" && h.location.startsWith(t.origin)) h.location = h.location.slice(t.origin.length) || "/";
      const html = /text\/html/i.test(String(pres.headers["content-type"] || "")) && req.method !== "HEAD" && pres.statusCode !== 304;
      // JavaScript that needs a touch: the JSX runtime (sources), and the project's own JSX modules
      // (line numbers some setups shift). Small modules, so they're read whole.
      const pathname = req.url.split("?")[0];
      const js = pres.statusCode === 200 && /javascript/i.test(String(pres.headers["content-type"] || ""));
      const runtime = js && RUNTIME_PATH.test(pathname);
      const ownJsx = js && state.root && /\.[jt]sx$/.test(pathname) && !pathname.includes("/node_modules/");
      if (runtime || ownJsx) {
        const chunks = [];
        pres.on("data", (c) => chunks.push(c));
        pres.on("end", async () => {
          let code = Buffer.concat(chunks).toString("utf8");
          if (runtime) code = wrapJsxRuntime(code);
          else {
            // Import the wrapped runtime under its own URL, so a copy the browser cached unwrapped is never used.
            code = code.replace(/(react_jsx-dev-runtime\.js\?)(v=)/g, "$1uit=1&$2");
            const file = path.join(state.root, decodeURIComponent(pathname));
            const original = file.startsWith(state.root + path.sep) ? await fs.readFile(file, "utf8").catch(() => null) : null;
            const fixed = original && code.includes("lineNumber:") ? fixLineNumbers(code, original) : null;
            if (fixed) code = fixed;
          }
          res.writeHead(pres.statusCode, runtime ? { ...h, "cache-control": "no-cache" } : h);
          res.end(code);
        });
        pres.on("error", () => res.end());
        return;
      }
      res.writeHead(pres.statusCode || 502, h);
      if (!html) return pres.pipe(res);
      // Stream the page through and add the panel at the end, unless the project's own setup loads it.
      let seen = false, tail = "";
      pres.on("data", (chunk) => {
        const text = tail + chunk.toString("latin1");
        if (!seen && text.includes(`${PREFIX}/overlay.js`)) seen = true;
        tail = text.slice(-64);
        res.write(chunk);
      });
      pres.on("end", () => res.end(seen ? "" : injectTag(state.root)));
      pres.on("error", () => res.end());
    });
    out.on("error", () => {
      if (res.headersSent) return res.end();
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      res.end(unreachablePage(state.target));
    });
    req.pipe(out);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (process.env.UIT_DEBUG && req.headers["sec-fetch-dest"] && req.headers["sec-fetch-dest"] !== "script" && req.headers["sec-fetch-dest"] !== "empty") log(`[doc] ${req.headers["sec-fetch-dest"]} ${req.url} from ${req.headers.referer || "-"}`);
      if (url.pathname === `${PREFIX}/connect`) return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }), res.end(connectPage());
      if (url.pathname === `${PREFIX}/connection`) return await connectApi(req, res);
      if (!state.root || !state.target) {
        if (url.pathname.startsWith(PREFIX) && state.handler) return state.handler(req, res, () => { res.statusCode = 404; res.end(); });
        res.writeHead(302, { Location: `${PREFIX}/connect` });
        return res.end();
      }
      if (url.pathname.startsWith(PREFIX)) return state.handler(req, res, () => proxy(req, res));
      return proxy(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(error && error.message));
    }
  });

  // Websockets (hot reload): pass the upgrade straight through to the dev server.
  server.on("upgrade", (req, socket, head) => {
    if (!state.target) return socket.destroy();
    const t = new URL(state.target);
    const secure = t.protocol === "https:";
    const portNum = Number(t.port) || (secure ? 443 : 80);
    const upstream = secure ? tls.connect({ host: t.hostname, port: portNum, servername: t.hostname, rejectUnauthorized: false }) : net.connect(portNum, t.hostname);
    upstream.once(secure ? "secureConnect" : "connect", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i], lk = k.toLowerCase();
        const v = lk === "host" ? t.host : lk === "origin" ? t.origin : req.rawHeaders[i + 1];
        lines.push(`${k}: ${v}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => { socket.destroy(); upstream.destroy(); };
    // Either side going away ends both (or the other connection stays open forever).
    for (const end of [upstream, socket]) { end.on("error", close); end.on("close", close); }
  });

  const sockets = new Set(); // websocket tunnels, which the server no longer tracks once upgraded
  server.on("upgrade", (req, socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("close", () => { for (const a of Object.values(agents)) a.destroy(); for (const s of sockets) s.destroy(); });
  const stop = () => { if (state.dev) state.dev.kill(); };
  process.once("exit", stop);
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(sig, () => { stop(); if (!process.listenerCount(sig)) process.exit(code); });
  return { server, state };
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function unreachablePage(target) {
  return `<!doctype html><meta charset="utf-8"><title>Can't reach the app</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#171717;color:rgba(255,255,255,.7);font:500 13px/1.5 system-ui,-apple-system,sans-serif;text-align:center}b{color:#fff}a{display:inline-block;margin-top:14px;padding:8px 14px;border-radius:8px;background:#fff;color:#212121;text-decoration:none;font-weight:600}</style>
<div><b>Nothing is answering at ${esc(target)}</b><br>Start your dev server, then reload. Or point the studio somewhere else.<br><a href="${PREFIX}/connect" target="_top">Change the app</a></div>`;
}

// The first page: which app (its dev server's address) and which project folder (where the code is).
function connectPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>UI Tweaks Studio</title>
<style>
  :root { --bg: #171717; --card: #212121; --fill: rgba(255,255,255,.05); --hover: rgba(255,255,255,.1); --active: rgba(255,255,255,.12);
    --line: rgba(255,255,255,.08); --text: rgba(255,255,255,.95); --label: rgba(255,255,255,.7); --dim: rgba(255,255,255,.5);
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 500 13px/1.45 system-ui, -apple-system, "SF Pro Display", "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; padding: 24px 16px; }
  .card { width: min(440px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.5); }
  .head { padding: 16px 16px 12px; border-bottom: 1px solid var(--line); }
  .head h1 { margin: 0; font-size: 15px; font-weight: 600; color: #fff; letter-spacing: -.01em; }
  .head p { margin: 4px 0 0; color: var(--dim); font-size: 12.5px; }
  .sec { padding: 12px 16px 16px; border-bottom: 1px solid var(--line); }
  .sec:last-child { border-bottom: 0; }
  .sec h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--label); }
  .field { display: flex; align-items: center; height: 36px; border-radius: 8px; background: var(--fill); margin-top: 6px; transition: background .15s, box-shadow .15s; }
  .field:hover { background: var(--hover); }
  .field:focus-within { background: var(--active); box-shadow: inset 0 0 0 1px rgba(255,255,255,.15); }
  .field label { width: 74px; flex: none; padding-left: 12px; font-size: 12px; color: var(--label); }
  .field input { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; color: var(--text); font: 500 12.5px var(--mono); padding: 0 12px 0 0; outline: none; }
  .field input::placeholder { color: rgba(255,255,255,.3); }
  .hint { margin-top: 8px; color: var(--dim); font-size: 12px; }
  .row { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
  button { font: inherit; border: 0; border-radius: 8px; height: 36px; padding: 0 14px; cursor: pointer; background: var(--fill); color: rgba(255,255,255,.6); transition: background .15s, color .15s; flex: 1 1 0; }
  button:hover { background: var(--hover); color: var(--text); }
  button.primary { background: #fff; color: #212121; font-weight: 600; flex-basis: 100%; }
  button.primary:hover { background: #e2e2e2; }
  button:disabled { opacity: .5; cursor: default; }
  .recent { display: grid; gap: 4px; }
  .recent button { display: flex; align-items: center; gap: 8px; height: 40px; text-align: left; color: var(--label); }
  .recent button b { color: var(--text); font-weight: 600; }
  .recent button span { margin-left: auto; font: 11px var(--mono); color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .status { margin-top: 10px; font-size: 12px; color: var(--dim); white-space: pre-wrap; }
  .status.err { color: #ef9a9a; }
  .log { margin-top: 8px; max-height: 140px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,.25); font: 11px/1.5 var(--mono); color: var(--dim); white-space: pre-wrap; }
  .log:empty { display: none; }
</style></head>
<body>
<div class="card">
  <div class="head"><h1>Open an app in the studio</h1><p>Any dev server, any framework. Nothing gets installed in the project.</p></div>
  <div class="sec">
    <h4>App</h4>
    <div class="field"><label for="target">Address</label><input id="target" placeholder="http://localhost:5173" autocomplete="off" spellcheck="false" /></div>
    <div class="field"><label for="root">Folder</label><input id="root" placeholder="~/code/my-app" autocomplete="off" spellcheck="false" /></div>
    <div class="hint">The address your dev server prints, and the project folder where its code lives (the panel writes your tweaks there).</div>
    <div class="row"><button class="start" title="Runs the project's dev script and uses the address it prints">Start its dev server</button><button class="primary go">Open studio</button></div>
    <div class="status"></div>
    <div class="log"></div>
  </div>
  <div class="sec recent-sec" hidden><h4>Recent</h4><div class="recent"></div></div>
</div>
<script>
  const $ = (s) => document.querySelector(s);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const status = (text, err) => { $(".status").textContent = text || ""; $(".status").classList.toggle("err", !!err); };
  let info = {};
  const tilde = (p) => (info.home && p && p.startsWith(info.home) ? "~" + p.slice(info.home.length) : p || "");
  async function load() {
    info = await fetch("${PREFIX}/connection", { cache: "no-store" }).then((r) => r.json());
    if (!$("#target").value && info.target) $("#target").value = info.target;
    if (!$("#root").value && info.root) $("#root").value = tilde(info.root);
    const list = info.recent || [];
    $(".recent-sec").hidden = !list.length;
    $(".recent").innerHTML = list.map((r, i) => '<button data-i="' + i + '"><b>' + esc(r.name) + "</b><span>" + esc(r.target || "") + " · " + esc(tilde(r.root)) + "</span></button>").join("");
    for (const b of document.querySelectorAll(".recent button")) b.onclick = () => { const r = list[b.dataset.i]; $("#target").value = r.target || ""; $("#root").value = tilde(r.root); open(); };
  }
  async function post(body) {
    const res = await fetch("${PREFIX}/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Couldn't connect");
    return data;
  }
  async function open() {
    status("Connecting…");
    try {
      const r = await post({ target: $("#target").value, root: $("#root").value });
      if (!r.up) return status("Nothing answers at that address yet. Start the dev server (or press “Start its dev server”), then open again.", true);
      location.href = "${PREFIX}/studio";
    } catch (e) { status(e.message, true); }
  }
  async function start() {
    if (!$("#root").value.trim()) return status("Give the project folder first.", true);
    try { await post({ root: $("#root").value, start: true }); } catch (e) { return status(e.message, true); }
    status("Starting the dev server…");
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 500));
      await load();
      $(".log").textContent = (info.devLog || []).join("\\n");
      if (info.target && info.up) { $("#target").value = info.target; status("Up at " + info.target + ". Opening…"); return void (location.href = "${PREFIX}/studio"); }
      if (!info.starting && !info.devRunning) return status("The dev script stopped; see its output below.", true);
      if (!info.starting && info.target) status("Waiting for " + info.target + "…");
    }
    status("The dev server didn't come up within two minutes.", true);
  }
  $(".go").onclick = open;
  $(".start").onclick = start;
  for (const i of document.querySelectorAll("input")) i.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  load();
</script>
</body></html>`;
}

/** The `studio` command: [url] [--root dir] [--port n]. */
export async function runStudio(argv) {
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number(flag("--port")) || 5600;
  const rootArg = flag("--root");
  const urlArg = argv.find((a, i) => !a.startsWith("--") && !["--port", "--root"].includes(argv[i - 1]));
  const target = normalizeTarget(urlArg);
  const root = rootArg ? path.resolve(rootArg) : target ? process.cwd() : null;
  const { server } = createStudioServer({ target, root, port });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, resolve); });
  const where = target && root ? `${PREFIX}/studio` : `${PREFIX}/connect`;
  console.log(`UI Tweaks studio: http://localhost:${port}${where}`);
  if (target) console.log(`  app ${target}, project ${root}`);
  else console.log("  open it and give your dev server's address and the project folder");
  return server;
}
