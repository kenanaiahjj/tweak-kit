// Opens the real panel in Chrome against a tiny static project and checks what it renders.
// Skipped when playwright-core or a Chrome binary isn't available (set CHROME_PATH to point at one).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p));
let chromium = null;
try {
  ({ chromium } = await import("playwright-core"));
} catch {}
const skip = !chromium || !CHROME ? "needs playwright-core and a Chrome binary" : false;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

async function withPage(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "uitk-smoke-"));
  await writeFile(path.join(root, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="s.css"><h1 class="title">Hi</h1><p class="note">Note</p><button class="tiny" style="width:30px;height:20px">x</button><button class="big" style="width:60px;height:48px">y</button>');
  await writeFile(path.join(root, "s.css"), ".title { font-size: 28px; }\n.note { color: #555; }\n@media (max-width: 430px) { .title { font-size: 22px; } }\n");
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(KIT, "serve.mjs"), root, "--port", String(port)], { env: { ...process.env, UI_TWEAKS_NO_UPDATE_CHECK: "1" }, stdio: "ignore" });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://localhost:${port}/`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => !!window.__uiTweaks);
    await fn(page, root);
  } finally {
    await browser.close();
    server.kill();
  }
}

// The panel lives in a shadow root; its text is what the user reads.
const panelText = (page) => page.evaluate(() => [...document.querySelectorAll("*")].map((e) => e.shadowRoot).filter(Boolean).map((r) => r.textContent).join(" "));
const section = (page, title) => page.evaluate((t) => {
  for (const root of [...document.querySelectorAll("*")].map((e) => e.shadowRoot).filter(Boolean)) {
    const h = [...root.querySelectorAll("h4")].find((x) => x.textContent.includes(t));
    if (h) return h.parentElement.innerText;
  }
  return null;
}, title);

test("the Apply to section shows its toggles and no stray text", { skip }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => { window.__uiTweaks.open(); window.__uiTweaks.select(".note"); });
    await page.waitForTimeout(600);
    const text = await section(page, "Apply to");
    assert.ok(text, "Apply to section rendered");
    assert.doesNotMatch(text, /null|undefined|\[object/);
    assert.match(text, /This element/);
    assert.match(text, /Everywhere/);
    assert.match(text, /All screen widths/);
  });
});

test("the width scope reads the project's own breakpoint", { skip }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => { window.__uiTweaks.open(); window.__uiTweaks.select(".note"); });
    await page.waitForTimeout(900);
    assert.match(await section(page, "Apply to"), /At 430px and below/);
  });
});

test("Code shows the diff a Send would write, without writing it", { skip }, async () => {
  await withPage(async (page, root) => {
    await page.evaluate(() => { window.__uiTweaks.open(); window.__uiTweaks.setStyle(".note", "color", "#111111"); });
    await page.evaluate(() => window.__uiTweaks.previewCode());
    await page.waitForTimeout(300);
    const text = await panelText(page);
    assert.match(text, /1 written directly/);
    assert.match(text, /\.note \{ color: #111111; \}/);
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(path.join(root, "s.css"), "utf8"), /color: #555/); // still the old value
  });
});

test("a source write that differs from the preview is flagged", { skip }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.__uiTweaks.open();
      window.__uiTweaks.verifyApplied([{ el: document.querySelector(".title"), selector: ".title", label: ".title", prop: "font-size", expected: "99px" }]);
    });
    await page.waitForFunction(() => [...document.querySelectorAll("*")].some((e) => e.shadowRoot && /source differs/.test(e.shadowRoot.textContent)), null, { timeout: 8000 });
  });
});

test("small controls get a tap-target warning, big ones a check, text none", { skip }, async () => {
  await withPage(async (page) => {
    const sizeSection = async (selector) => {
      await page.evaluate((sel) => { window.__uiTweaks.open(); window.__uiTweaks.select(sel); }, selector);
      await page.waitForTimeout(500);
      return section(page, "Size");
    };
    assert.match(await sizeSection(".tiny"), /Tap target\s+30×20\s+44×44 ✗/);
    assert.match(await sizeSection(".big"), /Tap target\s+60×48\s+44×44 ✓/);
    assert.doesNotMatch(await sizeSection(".note"), /Tap target/);
  });
});
