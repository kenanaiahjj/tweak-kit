import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detect, patchViteConfig } from "../cli.mjs";

const REACT_TS = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
`;

test("patches the create-vite config: import after the others, plugin first", () => {
  const { text, changed } = patchViteConfig(REACT_TS);
  assert.equal(changed, true);
  assert.equal(text, `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import uiTweaks from "ui-tweak-kit/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [uiTweaks(), react()],
})
`);
  assert.equal(patchViteConfig(text).changed, false); // idempotent
});

test("adds a plugins list when there is none; leaves CommonJS and odd shapes to a person", () => {
  const out = patchViteConfig(`import { defineConfig } from "vite";\nexport default defineConfig({ server: { port: 3000 } });\n`);
  assert.match(out.text, /defineConfig\(\{\n  plugins: \[uiTweaks\(\)\], server/);
  assert.match(out.text, /^import \{ defineConfig \} from "vite";\nimport uiTweaks from "ui-tweak-kit\/vite";/);
  assert.equal(patchViteConfig(`module.exports = { plugins: [] }`).manual, "a CommonJS config");
  assert.ok(patchViteConfig(`import x from "y";\nexport default makeConfig();`).manual);
  assert.equal(patchViteConfig(`import k from "../ui-tweak-kit/vite-plugin.mjs";`).changed, false);
});

test("detects the project and its package manager", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-cli-"));
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "");
  await writeFile(path.join(root, "vite.config.ts"), REACT_TS);
  assert.deepEqual(detect(root), { kind: "vite", pm: "pnpm", viteConfig: "vite.config.ts", nextConfig: null, hasPackage: true });
});

import { fixLineNumbers } from "../vite-plugin.mjs";

test("JSX line numbers shifted by a prepended header are put back; correct ones are left alone", () => {
  const original = "function A() {\n  return (\n    <div>\n      <b>x</b>\n    </div>\n  );\n}\n";
  const src = (l, c) => `{ fileName: "/a.tsx", lineNumber: ${l}, columnNumber: ${c} }`;
  const shifted = `jsxDEV("div", {}, void 0, true, ${src(22, 5)}); jsxDEV("b", {}, void 0, false, ${src(23, 7)});`;
  assert.equal(fixLineNumbers(shifted, original), `jsxDEV("div", {}, void 0, true, ${src(3, 5)}); jsxDEV("b", {}, void 0, false, ${src(4, 7)});`);
  assert.equal(fixLineNumbers(`x(${src(3, 5)})`, original), null);
});
