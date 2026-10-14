# UI Tweak Kit

Figma-style visual tweaks in the browser, applied to the real source by Claude Code.

1. A dev-only overlay (`overlay.js`) adds a **Tweak** button to your page (Alt+T). Click an element, or pick it in the layers list, and adjust its spacing, size, auto layout, type, color, gradient fill, radius, border, opacity or shadow. Drag a field's label to scrub its value (Shift for ×10), double-click text to edit the copy, and ↶ / ⌘Z undoes. Changes preview live.
   - **States:** switch to Hover, Active or Focus to edit that state. The page shows it while the element is selected.
   - **Screen width:** "Only at N px" makes a tweak apply around that width only, as a media query.
   - **Design tokens:** ◇ next to a color field lists the `:root` color variables, and number fields suggest length variables.
   - **Warnings:** the panel tells you when a value can't show, e.g. width on an inline element or a color under a gradient.
2. **Send to Claude** applies the tweaks:
   - **Directly, with no model,** when it's simple: one value on a CSS rule only this element uses (one selector, one match on the page, its classes used once in the source), or a copy change on the element's JSX line. This is instant, and shorthands like `padding` are rewritten in place.
   - **The rest goes to Haiku,** which the Claude Code mod (`claude-mod/`) starts in the background. Haiku's report isn't trusted: each tweak it says it applied is checked against the files it edited, and anything it skipped or that fails the check stays queued with a reason. **Send to Claude** in the band (or `/apply-tweaks claude`) hands those to the main model.
3. Every apply can be undone, whether from **Undo apply** in the panel, **Undo** in the band, or `/apply-tweaks undo`. Each changed file is restored unless it has changed since. The band shows the files with +/− line counts and a **Diff** view. `.ui-tweaks/log.json` records what happened to each tweak and why.

## Install

**The Claude Code mod** (once per person, in a terminal session):

```
/plugin install ui-tweaks --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then pick the user scope. It loads in every session after that, the desktop app included. (Working on the kit itself? Point `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` at `claude-mod/` instead.)

**The browser kit** (once per project):

```bash
npm i -D github:<owner>/<repo>
```

## Hooking up a project

**Vite (React, Vue, plain):** add the plugin. It runs only in `vite dev`:

```ts
// vite.config.ts
// Dev-only; skipped when the kit isn't installed.
const uiTweaks = await import("ui-tweak-kit/vite").then((k) => k.default()).catch(() => null);
export default defineConfig({ plugins: [react(), uiTweaks] });
```

**Plain HTML/CSS:** serve the folder through the kit's static server. It injects the overlay and live-reloads the page:

```bash
npx ui-tweaks-serve path/to/site --port 5500
```

**Next.js or any other dev server:** run the sidecar, then add its script tag in dev:

```bash
npx ui-tweaks-serve . --api-only --port 5599
```

```tsx
// app/layout.tsx, inside <body>
{process.env.NODE_ENV === "development" && (
  <script src="http://localhost:5599/__ui-tweaks/overlay.js" data-api="http://localhost:5599" data-root={process.cwd()} defer />
)}
```

React 19 (Next 15+) no longer exposes JSX source lines. There, Claude maps elements by class names, component names and the matched CSS rules.

## The mod

`claude-mod/` is a Claude Code plugin. To load it in every session, add its folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Shortcuts

| Key | Does |
| --- | --- |
| Alt+T | open/close the panel |
| ⧉ in the panel bar | pop the panel into its own window (needs a browser that allows pop-ups, e.g. Chrome; Claude's built-in browser blocks them). It reconnects after page reloads; ⇲ Dock or closing the window puts it back. |
| V | toggle picking (off = use the page normally) |
| Esc | deselect, then close |
| ↑/↓ in a field | ±1 (Shift ±10) |
| double-click text | edit copy |
