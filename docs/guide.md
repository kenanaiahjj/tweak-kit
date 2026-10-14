# Tweak Kit guide

- [Requirements](#requirements)
- [1. Install the Claude Code mod](#1-install-the-claude-code-mod)
- [2. Hook up a project](#2-hook-up-a-project)
- [3. Use it](#3-use-it)
- [How tweaks get applied](#how-tweaks-get-applied)
- [Undo](#undo)
- [Files it creates](#files-it-creates)
- [Setting it up for a team](#setting-it-up-for-a-team)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)
- [Working on the kit itself](#working-on-the-kit-itself)

## Requirements

- **Claude Code 2.1.275 or later**, for the mod (it uses Claude Code's plugin hooks).
- **Node 18 or later** in the project. Plain-HTML live reload on Linux needs Node 20+.
- **Read access to `lmfventures/tweak-kit`** (it's a private repo), and git set up to reach GitHub over HTTPS or SSH.
- **Haiku access** on your Claude account, for the tweaks that need a model.
- **Chrome or another regular browser** if you want to pop the panel out into its own window. Claude Code's built-in browser blocks pop-ups; the panel works there, just not popped out.

## 1. Install the Claude Code mod

Once per person. In a terminal (`/plugin` isn't available in the desktop app's Code tab):

```
claude
/plugin install ui-tweaks --marketplace lmfventures/tweak-kit
```

1. Answer `y` to add the `lmfventures/tweak-kit` marketplace.
2. Choose **user scope** so it loads in every project.

From then on it loads in every Claude Code session, including ones the desktop app starts. Check it with:

```bash
claude plugin list
```

It does nothing in a project until tweaks arrive there, so it's safe to leave on.

## 2. Hook up a project

Install the kit as a dev dependency:

```bash
npm i -D github:lmfventures/tweak-kit
```

The package is named `ui-tweak-kit`. It only runs in development; production builds never include it. Then pick your setup.

### Vite (React, Vue, Svelte, plain)

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only overlay; skipped if the kit isn't installed.
const uiTweaks = await import("ui-tweak-kit/vite").then((k) => k.default()).catch(() => null);

export default defineConfig({
  plugins: [react(), uiTweaks],
});
```

The `.catch(() => null)` keeps the config working for anyone who hasn't installed the kit. The plugin:
- injects the overlay into `index.html` during `vite dev` only
- adds the `/__ui-tweaks` endpoints to the dev server
- tells Vite not to watch `.ui-tweaks/`

### Plain HTML / CSS

Serve the site folder through the kit's static server. It injects the overlay and reloads the page when files change:

```bash
npx ui-tweaks-serve path/to/site --port 5500
```

Then open http://localhost:5500.

### Next.js, or any other dev server

Run the kit as a sidecar next to your dev server, from the project root:

```bash
npx ui-tweaks-serve . --api-only --port 5599
```

Then load the overlay from it in development only. For the Next.js App Router:

```tsx
// app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {process.env.NODE_ENV === "development" && (
          <script
            src="http://localhost:5599/__ui-tweaks/overlay.js"
            data-api="http://localhost:5599"
            data-root={process.cwd()}
            defer
          />
        )}
      </body>
    </html>
  );
}
```

The same script tag works for any other dev server:
- `data-api` is where the sidecar listens.
- `data-root` is the project's absolute path, used to turn file paths into project-relative ones.

React 19 (and so Next 15+) no longer exposes JSX line numbers in development. On those projects, copy changes and shared-rule overrides need the JSX line, so they go to Haiku instead of being applied directly. Edits to rules only one element uses are still applied directly.

### Keep `.ui-tweaks/` out of git

Nothing to do: the kit writes a `.gitignore` containing `*` inside `.ui-tweaks/`, so the folder ignores itself.

## 3. Use it

1. Start your dev server and open the app. Claude Code's built-in browser pane is a good place for it.
2. Open a Claude Code session **in the project folder**. The mod watches the folder the session is in.
3. Click **Tweak** (bottom right of the page), or press **Alt+T**.

### Docked mode (the default)

**Tweak** opens the studio at `/__ui-tweaks/studio`: your app in a frame on the left, the panel docked on the right, so nothing covers the page.

- **Device presets** in the toolbar: **Fit** (the space available), **390** (iPhone 14/15, 390 × 844), **768** (iPad portrait, 768 × 1024), **1280** (laptop, 1280 × 800). The app gets that exact screen size, so breakpoints and full-height layouts behave as on the device. A device bigger than the space is scaled down to fit (the toolbar shows the scale), and the studio remembers your choice.
- **↻** reloads the app; **✕** (or **⇱** in the panel) leaves the studio and returns to the plain page.
- Navigating inside the app keeps you in the studio; the toolbar shows the app's current path.

Docked mode needs the studio and the app on one origin: it works with the Vite plugin and `ui-tweaks-serve`. With the `--api-only` sidecar (Next.js and others), **Tweak** opens the panel on the page instead.

Everything below works the same docked or on the page.

### Selecting

- **Click** an element on the page, or pick it in the **layers list** at the top of the panel. The list shows the element in context, so you can reach a button next to a heading. Hovering a row outlines it on the page.
- **V** turns picking off, so you can use the page normally (to get to another screen, for example). Press V again to resume.
- **Esc** deselects, then closes.

### Editing

| Section | Controls |
| --- | --- |
| Default / Hover / Active / Focus | Which state you're editing. The page shows that state while the element is selected. |
| Auto layout | Direction, alignment, gap (flex/grid containers) |
| Size | Width, height, min/max width |
| Spacing | Padding and margin (one field when all sides match, or ⊞ for each side) |
| Text | Size, weight, line height, letter spacing, color, alignment |
| Fill & border | Background or gradient layers (each color stop has a picker), corner radius, border, opacity |
| Shadow | `box-shadow` as text |
| Apply to | **All screen widths** or **Only at N px** (becomes a media query), plus a **note** for Claude |

- **Drag a field's label** left or right to scrub its value. Hold Shift for steps of 10. ↑/↓ in a field nudges by 1 (Shift: 10).
- **Double-click text** to edit the copy. Enter saves, Esc cancels.
- **◇** next to a color field lists your `:root` color variables. Number fields suggest your length variables as you type.
- A **⚠ warning** appears when a value can't show, for example width on an inline element or a background color under a gradient.
- **↶** or **⌘Z / Ctrl+Z** undoes your last edit (a whole drag counts as one step).
- **⧉** (on the page) docks the panel into the studio; Shift-click it to pop the panel into its own window instead (needs a browser that allows pop-ups).

Edits are previews until you send them, and they survive page reloads.

### Sending

Press **Send to Claude**. The toast tells you what happened, e.g. "Applied 3 directly · Haiku is doing the other 1…". Directly applied tweaks appear in your source straight away, and your dev server reloads them. Above the Claude Code prompt, a band shows progress and then the result:

> ◆ Applied 3 UI tweaks: styles.css +4 −1  main.tsx +1 −1   [Diff] [Undo] [Dismiss]

**Diff** opens a pane with the exact changes.

### Commands in Claude Code

| Command | Does |
| --- | --- |
| `/apply-tweaks` | Applies waiting tweaks with Haiku (normally automatic) |
| `/apply-tweaks claude` | Sends waiting tweaks, e.g. ones Haiku skipped, to the main model |
| `/apply-tweaks undo` | Undoes the last apply |

## How tweaks get applied

Each tweak is split per property, and every property goes the cheapest route that's safe:

1. **Directly, with no model** (instant, done by your dev server):
   - **In-place edit:** the value sits on a CSS rule only this element uses (one selector, one match on the page, and its classes appear once in the source). The rule is edited in place, including inside its `@media` block, and shorthands like `padding: 10px 16px` are rewritten correctly.
   - **Override:** the value sits on a shared rule, or no rule sets it yet. The element's JSX gets a class of its own, such as `primary-button--t3f2a`, and a more specific rule for it goes right after the shared one, so the other elements keep their look. Later tweaks on the same element reuse that class and rule.
   - **Copy edit:** the text change is found on the element's JSX line and replaced.
2. **Haiku** (seconds, in the background, started by the mod):
   - notes
   - hover/active/focus states
   - "only at N px" tweaks
   - values set through a React `style` prop
   - shared rules in plain HTML projects
   - anything the direct path couldn't place
3. **The main model** only if you ask, with **Send to Claude** in the band or `/apply-tweaks claude`. That's for tweaks Haiku skipped.

Haiku's report isn't taken on trust. After it finishes, each tweak it reported as applied is checked against the files it edited: the new value (or text) has to appear there. Tweaks it skipped, or that fail the check, stay queued with the reason, and you get a notification.

With several Claude Code sessions open in one project, a lock makes sure only one applies tweaks at a time.

An override applies to every element that JSX line renders. For a button rendered in a list, all of them change. If you meant just one, add a note; that sends the tweak to Haiku.

## Undo

- **Undo apply** in the panel, **Undo** in the band, or `/apply-tweaks undo` restores the files the last apply changed. Repeat to go further back (the last 10 applies are kept).
- A file that has changed since the apply isn't overwritten. You're told which file, and can undo by hand or ask Claude.
- This covers direct and Haiku applies. Changes made by the main model are in your normal git history instead.

## Files it creates

All inside `<project>/.ui-tweaks/`, which ignores itself in git:

| File | What |
| --- | --- |
| `pending.json` | Tweaks waiting for Haiku or Claude |
| `log.json` | What happened to each tweak and why (last 300) |
| `history.json`, `history/slot-N.json` | Undo history: file copies for the last 10 applies |
| `lock.json` | Which session is applying right now |
| `server.json` | The dev server's address (also registered in `~/.ui-tweaks/servers/`), so the mod finds the project even when its session started in another folder |

## Setting it up for a team

1. Give teammates read access to `lmfventures/tweak-kit`.
2. Each person installs the mod once ([step 1](#1-install-the-claude-code-mod)).
3. Commit the dev dependency and the config change for each project ([step 2](#2-hook-up-a-project)). Teammates get the overlay on their next `npm install`.

Because the Vite snippet catches a failed import, someone without repo access can still run the project, just without the overlay.

## Updating

```bash
# The Claude Code mod (then /reload-plugins in open sessions, or restart them)
claude plugin marketplace update ui-tweak-kit
claude plugin update ui-tweaks@ui-tweak-kit

# The browser kit, in each project
npm i -D github:lmfventures/tweak-kit
```

Restart the dev server after updating the kit.

## Uninstalling

```bash
claude plugin uninstall ui-tweaks@ui-tweak-kit
claude plugin marketplace remove ui-tweak-kit
```

In each project:

```bash
npm rm ui-tweak-kit
rm -rf .ui-tweaks
```

Then remove the `uiTweaks` lines from `vite.config.ts`, or the script tag from your layout.

## Troubleshooting

**No Tweak button.**
- It's development only. Check the dev server is running through Vite with the plugin, or through `ui-tweaks-serve`.
- With Vite, check the import works: `node -e "import('ui-tweak-kit/vite').then(() => console.log('ok'))"`.

**"Couldn't reach the tweaks server".** The page can't reach `/__ui-tweaks`. With the sidecar, check it's running and `data-api` points to it. Use **Copy** in the panel to grab the tweaks as JSON meanwhile.

**Nothing happens after Send (no band, no Haiku).**
- The mod only sees tweaks in the folder its Claude Code session was started in.
- Check the mod is installed with `claude plugin list`.
- Directly applied tweaks don't need the mod at all. Check `.ui-tweaks/log.json`.

**"Another Claude Code session is applying tweaks".** Another session in the same project holds the lock. It's released when that apply ends, or after 10 minutes.

**A tweak was skipped.** The band and `.ui-tweaks/log.json` say why. Fix the cause (e.g. edit the gradient layers instead of a hidden background color), or press **Send to Claude** in the band.

**Pop-out says it was blocked.** Allow pop-ups for the page, or use docked mode (plain **Tweak**), which needs no pop-up.

**The panel can't scroll.** Some apps cancel wheel events. The panel handles its own scrolling; docked mode avoids the problem entirely.

**Undo refused.** The file changed after the apply (you, Claude or another tool edited it). Undo by hand with the **Diff** pane as a guide, or use git.

## Working on the kit itself

```bash
git clone https://github.com/lmfventures/tweak-kit.git
cd tweak-kit
npm test                                  # direct-apply tests
claude plugin test claude-mod             # the mod's tests
claude plugin validate .                  # the marketplace and the mod
```

- To use your working copy everywhere, point `CLAUDE_CODE_PLUGIN_DIRS` (in the `env` block of `~/.claude/settings.json`) at `<clone>/claude-mod` instead of installing from the marketplace.
- Point projects at your clone with `npm i -D <path-to-clone>`.
- Bump `version` in `claude-mod/.claude-plugin/plugin.json` when you change the mod, so `claude plugin update` picks it up.
