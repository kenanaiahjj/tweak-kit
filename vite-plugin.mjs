// Vite plugin: injects the UI Tweaks overlay in `vite dev` only. Builds are untouched.
import { announceServer, createTweaksHandler } from "./server-core.mjs";
import { checkForUpdate } from "./update.mjs";

export default function uiTweaks({ autoUpdate = false, updateCheck = true } = {}) {
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
