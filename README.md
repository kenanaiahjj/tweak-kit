# Tweak Kit

Figma-style visual tweaks in your running app, written back to the real source code.

Open your app and click **Tweak**: the studio opens your live app one screen at a time, on a real device size (iPhone Duo to 1080p), with your list of screens saved in `.ui-tweaks/canvas.json` and a Figma-style panel docked on the right. Click any element and drag it to reorder or move it, resize it from its handles, adjust position (absolute/fixed/sticky, offsets, align in parent), margin and padding, size (fixed, hug, fill), auto layout, type, color, gradients, radius, border, shadow, and hover/active/focus states. **⑂ Versions** shows another branch beside it, live and scrolling along, and **📷** copies both side by side to the clipboard for showing what changed. When you're happy, press **Send to Claude**. Most tweaks are written to your CSS and JSX instantly, with no AI involved. The rest are applied by a small Haiku agent in Claude Code, which is checked, logged and undoable.

Select an element and press **Explore** for a board of variations from Claude (guided by your reference images and, when installed, the impeccable design skill): edit a variation's values, see it on the whole screen, ask for more like it, then use one. Pin **comments** to elements for the team (M), revert any earlier apply from History, and get nudged toward your tokens where a value is typed by hand.

**Tokens** opens a design system page built from your CSS: every token (colours, type, spacing, radius, shadows, motion) previewed per theme mode, editable in place and written straight back to your stylesheet, plus the values typed by hand that could use a token.

It has two parts:

| Part | What it is | Install |
| --- | --- | --- |
| **Browser kit** | The overlay panel plus a small dev-server piece that saves tweaks and applies the simple ones | per project, as a dev dependency |
| **Claude Code mod** (`ui-tweaks`) | Haiku for the tweaks that need a model, and status, diff and undo above the Claude Code prompt | once per person |

## Quick start

In your project folder:

```bash
npx github:kenanaiahjj/tweak-kit init
```

It works out what the project is and sets it up:

- **Vite** (React, Vue, Svelte, plain): installs the kit as a dev dependency (npm, pnpm, yarn or bun, whichever the project uses) and adds `uiTweaks()` to your Vite config.
- **Next.js and other dev servers:** installs the kit, adds a `tweaks` script for its sidecar, and prints the one line that loads the panel in development.
- **Plain HTML:** prints the command that serves the folder with the panel.
- **Claude Code:** installs the `ui-tweaks` mod (start a new Claude Code session to load it). Skip with `--no-mod`; skip installing the package with `--no-install`.

Then run your dev server, open the app (Claude Code's browser pane works well), and click **Tweak** (or Alt+T). Keep a Claude Code session open, ideally in the project folder, so anything that needs a model gets applied.

**React 18 and 19** both work: in development the kit records where each element is written, which React 19 no longer does itself. Anything that compiles JSX through Vite gets the same.

**Or don't install anything.** Run the studio on its own and point it at any dev server:

```bash
npx github:kenanaiahjj/tweak-kit studio
```

In Claude Code, `/studio` does it for you: it starts the studio for the session's project (or uses your dev server's own when the kit is installed there) and opens it in Claude's browser pane, or your browser in a terminal; `/studio http://localhost:5173` connects it straight away. From a terminal: open the printed address, paste your app's address (`http://localhost:5173`, `3000`…) and its project folder, or press **Start its dev server** to run the project's `dev` script. The studio sits in front of the dev server, adds the panel to its pages and passes hot reload through, so it works with any framework and leaves the project untouched. Recent projects are one click away. `npx github:kenanaiahjj/tweak-kit studio http://localhost:5173 --root ~/code/app` skips that page.

<details><summary>Setting it up by hand</summary>

```bash
claude plugin marketplace add kenanaiahjj/tweak-kit
claude plugin install ui-tweaks@ui-tweak-kit
npm i -D github:kenanaiahjj/tweak-kit
```

```ts
// vite.config.ts
import uiTweaks from "ui-tweak-kit/vite";
export default defineConfig({ plugins: [uiTweaks(), react()] });
```

Other setups are in the [guide](docs/guide.md#2-hook-up-a-project).
</details>

The repo is public, so nothing else is needed to install either part.

## Credits

The panel's visual language follows [DialKit](https://github.com/joshpuckett/dialkit) by Josh Puckett (MIT).

## Documentation

- **[Guide](docs/guide.md)** covers requirements, installing, hooking up Vite / plain HTML / Next.js / other projects, using the panel, how tweaks get applied, undo, team setup, updating, uninstalling and troubleshooting.

## Repository layout

| Path | What |
| --- | --- |
| `overlay.js` | The in-page panel (vanilla JS, shadow DOM, no dependencies) |
| `server-core.mjs` | Request handler: stores tweaks, applies simple ones, undo, history and log |
| `direct-apply.mjs` | Applies tweaks to CSS/JSX without a model |
| `tokens.mjs`, `system-page.mjs` | The design system page: reads, edits and adopts tokens in your stylesheets |
| `update.mjs` | Checks GitHub for a newer kit on dev-server start and reinstalls it |
| `cli.mjs` | `npx github:kenanaiahjj/tweak-kit init`: sets a project up |
| `studio-server.mjs` | `npx github:kenanaiahjj/tweak-kit studio`: the studio on its own, in front of any dev server |
| `versions.mjs` | Another branch side by side: its worktree and dev server |
| `asks.mjs` | The Ask Claude queue between the panel and the Claude Code mod |
| `vite-plugin.mjs` | Vite plugin (dev server only) |
| `serve.mjs` | `ui-tweaks-serve`: static server for plain HTML, or `--api-only` sidecar for other dev servers |
| `claude-mod/` | The Claude Code mod (`ui-tweaks`) |
| `.claude-plugin/marketplace.json` | Makes this repo installable with `/plugin install` |
| `test/` | `npm test` |
