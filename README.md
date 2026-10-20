# Tweak Kit

Figma-style visual tweaks in your running app, written back to the real source code.

Open your app and click **Tweak**: the studio opens as an infinite canvas of artboards, each your live app at one screen, state and device (iPhone Duo to 1080p), saved in `.ui-tweaks/canvas.json`, with a Figma-style panel docked on the right. Click any element and adjust spacing, size, auto layout, type, color, gradients, radius, border, shadow, and hover/active/focus states. When you're happy, press **Send to Claude**. Most tweaks are written to your CSS and JSX instantly, with no AI involved. The rest are applied by a small Haiku agent in Claude Code, which is checked, logged and undoable.

It has two parts:

| Part | What it is | Install |
| --- | --- | --- |
| **Browser kit** | The overlay panel plus a small dev-server piece that saves tweaks and applies the simple ones | per project, as a dev dependency |
| **Claude Code mod** (`ui-tweaks`) | Haiku for the tweaks that need a model, and status, diff and undo above the Claude Code prompt | once per person |

## Quick start

**1. Install the Claude Code mod** (once). In a terminal:

```bash
claude plugin marketplace add kenanaiahjj/tweak-kit
claude plugin install ui-tweaks@ui-tweak-kit
```

It now loads in every Claude Code session, including the desktop app.

**2. Add the kit to a project:**

```bash
npm i -D github:kenanaiahjj/tweak-kit
```

For a **Vite** project, add it to `vite.config.ts` (other setups are covered in the [guide](docs/guide.md#2-hook-up-a-project)):

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only overlay; skipped if the kit isn't installed.
const uiTweaks = await import("ui-tweak-kit/vite").then((k) => k.default()).catch(() => null);

export default defineConfig({ plugins: [react(), uiTweaks] });
```

**3. Use it.** Run your dev server, open the app (Claude Code's browser pane works well), and click **Tweak** (or Alt+T). The studio opens: click elements in your app, edit them in the panel, and press **Send to Claude**. Keep a Claude Code session open (ideally in the project folder) so anything that needs Haiku gets applied.

The repo is public, so nothing else is needed to install either part.

## Documentation

- **[Guide](docs/guide.md)** covers requirements, installing, hooking up Vite / plain HTML / Next.js / other projects, using the panel, how tweaks get applied, undo, team setup, updating, uninstalling and troubleshooting.

## Repository layout

| Path | What |
| --- | --- |
| `overlay.js` | The in-page panel (vanilla JS, shadow DOM, no dependencies) |
| `server-core.mjs` | Request handler: stores tweaks, applies simple ones, undo, history and log |
| `direct-apply.mjs` | Applies tweaks to CSS/JSX without a model |
| `vite-plugin.mjs` | Vite plugin (dev server only) |
| `serve.mjs` | `ui-tweaks-serve`: static server for plain HTML, or `--api-only` sidecar for other dev servers |
| `claude-mod/` | The Claude Code mod (`ui-tweaks`) |
| `.claude-plugin/marketplace.json` | Makes this repo installable with `/plugin install` |
| `test/` | `npm test` |
