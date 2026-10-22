// Vite plugin: injects the UI Tweaks overlay in `vite dev` only. Builds are untouched.
import { promises as fs } from "node:fs";
import { announceServer, createTweaksHandler } from "./server-core.mjs";
import { checkForUpdate } from "./update.mjs";

// React 19 no longer keeps where each element was written (fiber._debugSource). The JSX transform
// still hands the dev runtime that location, so in dev the runtime is wrapped to keep it, keyed by
// the element's props object (the same object React keeps on the fiber). Nothing changes in the DOM.
const RUNTIME = "react/jsx-dev-runtime";
const WRAPPED = "\0ui-tweaks:jsx-dev-runtime";
const WRAPPER = `import * as ns from "${RUNTIME}";
const R = ns.jsxDEV ? ns : ns.default;
const where = (globalThis.__uitSources ||= new WeakMap());
export const Fragment = R.Fragment;
export function jsxDEV(type, props, key, isStatic, source, self) {
  const element = R.jsxDEV(type, props, key, isStatic, source, self);
  if (source && element && element.props && typeof element.props === "object") where.set(element.props, source);
  return element;
}
export default { ...R, jsxDEV };
`;

// Some setups (e.g. @vitejs/plugin-react 4) add a Fast Refresh header before the JSX is compiled,
// so every element's line number is off by the header's length. Check the reported positions
// against the original file and shift them back when they're off by one constant amount.
export function fixLineNumbers(code, original) {
  const entries = [...code.matchAll(/lineNumber:\s*(\d+),\s*columnNumber:\s*(\d+)/g)].slice(0, 16);
  if (!entries.length) return null;
  const lines = original.split("\n");
  const fits = (d) => entries.every((m) => {
    const line = lines[Number(m[1]) - d - 1];
    return line !== undefined && line[Number(m[2]) - 1] === "<";
  });
  if (fits(0)) return null;
  for (let d = 1; d <= 120; d++) {
    if (fits(d)) return code.replace(/(lineNumber:\s*)(\d+)/g, (_, p, n) => p + (Number(n) - d));
  }
  return null;
}

export default function uiTweaks(options = {}) {
  return [kitPlugin(options), linesPlugin(options)];
}

function linesPlugin({ sources = true } = {}) {
  return {
    name: "ui-tweaks:jsx-lines",
    apply: "serve",
    enforce: "post",
    async transform(code, id, opts) {
      if (!sources || (opts && opts.ssr) || !/\.[jt]sx(\?|$)/.test(id) || id.includes("/node_modules/") || !code.includes("lineNumber:")) return null;
      const original = await fs.readFile(id.split("?")[0], "utf8").catch(() => null);
      const fixed = original === null ? null : fixLineNumbers(code, original);
      return fixed === null ? null : { code: fixed, map: null };
    },
  };
}

function kitPlugin({ autoUpdate = true, updateCheck = true, sources = true, commit = false } = {}) {
  let root = process.cwd();
  return {
    name: "ui-tweaks",
    apply: "serve",
    enforce: "pre",
    resolveId(id, importer, options) {
      if (!sources || id !== RUNTIME || importer === WRAPPED || (options && options.ssr)) return null;
      return WRAPPED;
    },
    load(id) {
      return id === WRAPPED ? WRAPPER : null;
    },
    config() {
      return { server: { watch: { ignored: ["**/.ui-tweaks/**"] } } };
    },
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(createTweaksHandler({ root, commit }));
      server.httpServer?.once("listening", () => {
        const address = server.httpServer.address();
        if (address && typeof address === "object") void announceServer(root, `http://localhost:${address.port}`);
        if (updateCheck) void checkForUpdate(root, { autoUpdate, log: (m) => server.config.logger.info(m) });
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { src: "/__ui-tweaks/overlay.js", "data-root": root, defer: true },
          injectTo: "body",
        },
      ];
    },
  };
}
