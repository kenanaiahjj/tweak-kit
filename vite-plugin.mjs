// Vite plugin: injects the UI Tweaks overlay in `vite dev` only. Builds are untouched.
import { createTweaksHandler } from "./server-core.mjs";

export default function uiTweaks() {
  let root = process.cwd();
  return {
    name: "ui-tweaks",
    apply: "serve",
    config() {
      return { server: { watch: { ignored: ["**/.ui-tweaks/**"] } } };
    },
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(createTweaksHandler({ root }));
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
