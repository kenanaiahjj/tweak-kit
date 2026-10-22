import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.UIT_STUDIO_RECENTS = path.join(os.tmpdir(), `uit-recents-${process.pid}.json`);
const { addressIn, createStudioServer, normalizeTarget, wrapJsxRuntime } = await import("../studio-server.mjs");

test("reads what people type as the app's address", () => {
  assert.equal(normalizeTarget("5173"), "http://localhost:5173");
  assert.equal(normalizeTarget("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeTarget("http://127.0.0.1:8080/app?x=1"), "http://127.0.0.1:8080");
  assert.equal(normalizeTarget("https://my.test:8443"), "https://my.test:8443");
  assert.equal(normalizeTarget(""), null);
  assert.equal(normalizeTarget("http://"), null);
});

test("finds the address a dev server prints", () => {
  assert.equal(addressIn("  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m"), "http://localhost:5173");
  assert.equal(addressIn("- Local:        http://localhost:3000"), "http://localhost:3000");
  assert.equal(addressIn("Listening on http://0.0.0.0:8080"), "http://localhost:8080");
  assert.equal(addressIn("compiling…"), null);
});

test("wraps Vite's pre-bundled JSX runtime to keep sources", () => {
  const code = "var require_jsx_dev_runtime = () => ({ jsxDEV: (t, p) => ({ props: p }) });\nexport default require_jsx_dev_runtime();\n//# sourceMappingURL=x";
  const out = wrapJsxRuntime(code);
  assert.match(out, /export default __uitRt;/);
  assert.equal(wrapJsxRuntime(out), out); // once only
  assert.equal(wrapJsxRuntime("export { jsxDEV };"), "export { jsxDEV };"); // unknown shape: left alone
});

const listen = (server) => new Promise((r) => server.listen(0, () => r(server.address().port)));

test("proxies the app with the panel added, and passes websockets through", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uit-studio-"));
  const app = http.createServer((req, res) => {
    if (req.url === "/go") { res.writeHead(302, { Location: `http://localhost:${appPort}/there` }); return res.end(); }
    if (req.url === "/data.json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":1}'); }
    res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "script-src 'none'" });
    res.write("<html><body><h1>");
    setTimeout(() => res.end("streamed</h1></body></html>"), 20);
  });
  app.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Host: " + req.headers.host + "\r\n\r\n");
    socket.on("data", (d) => socket.write("echo:" + d));
    socket.on("end", () => socket.end());
  });
  const appPort = await listen(app);
  const { server } = createStudioServer({ target: `http://localhost:${appPort}`, root, port: 0, log: () => {} });
  const port = await listen(server);
  try {
    const page = await fetch(`http://localhost:${port}/`);
    const html = await page.text();
    assert.match(html, /<h1>streamed<\/h1>/);
    assert.match(html, /<script src="\/__ui-tweaks\/overlay\.js"/);
    assert.equal(page.headers.get("content-security-policy"), null);
    assert.equal(await fetch(`http://localhost:${port}/data.json`).then((r) => r.text()), '{"ok":1}');
    const moved = await fetch(`http://localhost:${port}/go`, { redirect: "manual" });
    assert.equal(moved.headers.get("location"), "/there");
    // The kit's own API is served by the studio.
    assert.equal((await fetch(`http://localhost:${port}/__ui-tweaks/canvas`).then((r) => r.json())).canvas.artboards.length > 0, true);
    // Websocket upgrade reaches the app with its own host, and data flows both ways.
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(port, "localhost", () => s.write(`GET /hmr HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
      let got = "";
      s.on("data", (d) => {
        got += d;
        if (got.includes("\r\n\r\n") && !got.includes("echo:")) s.write("ping");
        if (got.includes("echo:ping")) { s.destroy(); resolve(got); }
      });
      s.on("error", reject);
    });
    assert.match(reply, /101 Switching Protocols/);
    assert.match(reply, new RegExp(`X-Seen-Host: localhost:${appPort}`));
  } finally {
    server.closeAllConnections();
    app.closeAllConnections();
    server.close();
    app.close();
  }
});

test("without an app it asks for one", async () => {
  const { server } = createStudioServer({ port: 0, log: () => {} });
  const port = await listen(server);
  try {
    const res = await fetch(`http://localhost:${port}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/__ui-tweaks/connect");
    assert.match(await fetch(`http://localhost:${port}/__ui-tweaks/connect`).then((r) => r.text()), /Open an app in the studio/);
    const bad = await fetch(`http://localhost:${port}/__ui-tweaks/connection`, { method: "POST", body: JSON.stringify({ target: "5173", root: "/no/such/folder" }) });
    assert.equal(bad.status, 400);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
