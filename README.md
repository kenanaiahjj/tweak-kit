# UI Tweak Kit

Figma-style visual tweaks in the browser, applied to the real source by Claude Code.

1. A dev-only overlay (`overlay.js`) adds a **Tweak** button to your page (Alt+T). Click an element and adjust its spacing, size, auto layout, type, color, radius, border, opacity or shadow. Drag a field's label to scrub its value (Shift for ×10). Double-click text to edit the copy. Changes preview live.
2. **Send to Claude** writes the batch to `<project>/.ui-tweaks/pending.json`. That folder ignores itself in git. Each tweak records the element's JSX source line (React dev builds), the CSS rules that set each property (file, selector, media query), the before and after values, and the viewport width.
3. The Claude Code mod (`claude-mod/`) shows a band above the prompt, "UI tweaks: N changes … [Apply with Claude]", and adds `/apply-tweaks`. Claude edits the CSS, Tailwind classes or JSX, then deletes the file. The overlay sees that and drops its previews.

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
