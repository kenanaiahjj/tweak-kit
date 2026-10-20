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
- **Haiku access** on your Claude account, for the tweaks that need a model.
- **Chrome or another regular browser** if you want to pop the panel out into its own window. Claude Code's built-in browser blocks pop-ups; the panel works there, just not popped out.

## 1. Install the Claude Code mod

Once per person. In a terminal (`/plugin` isn't available in the desktop app's Code tab):

```bash
claude plugin marketplace add kenanaiahjj/tweak-kit
claude plugin install ui-tweaks@ui-tweak-kit
```

`ui-tweak-kit` is the marketplace's name and `ui-tweaks` the plugin; the install defaults to user scope, so it loads in every project. If you added the marketplace earlier from `lmfventures/tweak-kit`, remove it first with `claude plugin marketplace remove ui-tweak-kit`.

From then on it loads in every Claude Code session, including ones the desktop app starts. Check it with:

```bash
claude plugin list
```

It does nothing in a project until tweaks arrive there, so it's safe to leave on.

## 2. Hook up a project

Install the kit as a dev dependency:

```bash
npm i -D github:kenanaiahjj/tweak-kit
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

### The studio canvas (the default)

**Tweak** opens the studio at `/__ui-tweaks/studio`: an infinite canvas of **artboards** on the left, the panel docked on the right. An artboard is not a picture of a screen: it is your running app, framed at one **screen**, **state** and **device**. Change the code and every artboard showing it updates.

**Canvas and Focus.** The toolbar switches between **▦ Canvas** (every artboard, ⇧C) and **▢ Focus** (⇧F): one screen alone, on its device, at actual size (100%). In Focus, **‹ ›** (or ←/→) step through the artboards, the device menu and **⟲** apply to the screen in view, and you scroll or drag to see a device bigger than the space. Double-click an artboard's size label to focus it. Switching back returns the canvas exactly as you left it; the other artboards keep running, so switching is instant.

**Moving around**
- Two-finger scroll pans; pinch, or ⌘/Ctrl + scroll, zooms at the pointer (also over an artboard).
- Drag the empty canvas, hold **Space**, or turn on **✋** to pan. **−** / **+**, **Fit** (⇧1) and **1:1** (⇧0) set the zoom; the **minimap** (bottom right) jumps anywhere.

**Artboards**
- **+ Artboard** adds one (a copy of the selected artboard's screen, on the device you pick). **☰** lists the app's routes; click one to add an artboard for it.
- Drag an artboard by its label to move it (snaps to 8px). On hover or when selected, its label shows the **device** menu, **⟲** rotate, **⧉** duplicate and **✕** remove (or press Delete). Double-click the **name** to rename it, or the **URL** to change which screen and state it shows.
- Click into an artboard to tweak there; the panel follows. A tweak previews in **every** artboard showing that code.
- Devices (CSS px): iPhone Duo open (890 × 626) and folded (466 × 678), 18/17/16 Pro Max (440 × 956), Air (420 × 912), 18 Pro · 17 Pro · 17 (402 × 874), 16 · 15 (393 × 852), 17e · 14 · 13 (390 × 844), 16 Plus · 15 Plus (430 × 932), 13 mini (375 × 812), SE (375 × 667); iPad mini, Air 11″, Pro 11″, Pro 13″, classic; Pixel, Galaxy Z Fold 5 folded; Laptop, MacBook Air 13″, 1440 × 900, 1920 × 1080.
- Frames show the app edge to edge (no simulated status bar or notch, so nothing clips the app's header); the iPhone Duo draws its fold line. **Grid** (4/8/12 columns) and **8pt** overlay guides; hold **Compare** (or **\\** in the app) to see every artboard without your previews; **📷** saves a PNG of the selected artboard (the browser asks to capture the tab; Chrome).

**`canvas.json`: the canvas is part of your project.** The layout lives in `.ui-tweaks/canvas.json`, the one file in `.ui-tweaks/` that git sees, so you can commit and share it:

```json
{
  "artboards": [
    { "id": "a1", "name": "Welcome", "device": "i16", "url": "/?fixture=new", "x": 0, "y": 0 },
    { "id": "a7", "name": "Wallet · verified", "device": "i16", "url": "/?fixture=verified", "x": 960, "y": 1000 }
  ],
  "notes": [],
  "arrows": []
}
```

The studio saves it as you arrange things, and picks up changes made to it elsewhere within a couple of seconds, so you can ask Claude to "add artboards for the empty and error states" and watch them appear.

**Screens and states: the dev hook.** Apps with URLs (Next.js, React Router) need nothing: an artboard's URL is the route. Apps that switch screens or data in memory need a small **dev-only** hook so each artboard can open a screen in a known state; ask Claude to add one. The convention:
- `?screen=<name>` opens a screen.
- `?fixture=<name>` loads a named, made-up data state (new user, verified, error…) **instead of** the saved one, and never writes it back, so artboards don't overwrite your real dev data or each other.
- Both are ignored outside development.

Example (OneQR): `src/dev-fixtures.ts` defines the fixtures `new`, `unverified`, `pending`, `verified`, `rejected` and `family`; `main.tsx` reads them in `loadState()` and skips saving while one is active.

With the `--api-only` sidecar (Next.js and others, a different origin), **Tweak** opens the panel on the page instead of the studio.

Everything below works the same in the studio or on the page.

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
| Position | Auto (static), Relative, Absolute, Fixed or Sticky. Absolute and Fixed keep the element where it is, at its current size. When positioned: top/right/bottom/left offsets, z-index, and **Align in parent** (pin left, center, right, top, middle, bottom). It names the ancestor the element is positioned against. |
| Spacing | A box diagram: margin outside, padding inside, size in the middle. Click a side to type (margin takes `auto`); ↑/↓ steps, Shift ×10, Alt applies to all four sides. **Center** sets auto side margins; **Margin 0** and **Pad 0** clear them. |
| Text | Size, weight, line height, letter spacing, color, alignment |
| Fill & border | Background or gradient layers (each color stop has a picker), corner radius, border, opacity |
| Shadow | `box-shadow` as text |
| Apply to | **All screen widths** or **Only at N px** (becomes a media query), plus a **note** for Claude |

- **Drag a field's label** left or right to scrub its value. Hold Shift for steps of 10. ↑/↓ in a field nudges by 1 (Shift: 10).
- **Arrow keys on the page** move the selected element (Shift: 10px): positioned elements by their offsets, others by their top/left margin.
- **Double-click text** to edit the copy. Enter saves, Esc cancels.
- **◇** next to a color field lists your `:root` color variables. Number fields suggest your length variables as you type.
- A **⚠ warning** appears when a value can't show, for example width on an inline element or a background color under a gradient.
- **↶** or **⌘Z / Ctrl+Z** undoes your last edit (a whole drag counts as one step).
- **Measure:** with an element selected, hold **Alt** and point at another to see the distances between them in red.
- **Contrast** under the text color shows the ratio to the background behind it and whether it passes AA and AAA (large text needs less). Over a gradient it reports the lowest ratio across the gradient's colors; it can't measure over images or video.
- **Copy style / Paste style** (or **⌘⌥C** / **⌘⌥V**) copy an element's type, fill, border, radius, shadow and padding onto another; one undo takes a paste back.
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

1. Each person installs the mod once ([step 1](#1-install-the-claude-code-mod)).
2. Commit the dev dependency and the config change for each project ([step 2](#2-hook-up-a-project)). Teammates get the overlay on their next `npm install`.

Because the Vite snippet catches a failed import, the project still runs for anyone who hasn't installed the kit, just without the overlay.

## Updating

```bash
# The Claude Code mod (then /reload-plugins in open sessions, or restart them)
claude plugin marketplace update ui-tweak-kit
claude plugin update ui-tweaks@ui-tweak-kit

# The browser kit, in each project
npm i -D github:kenanaiahjj/tweak-kit
```

Restart the dev server after updating the kit.

### Update check

When the dev server starts, the kit compares the commit pinned in your lockfile with `main` on GitHub. If you're behind, it reinstalls itself from GitHub (with npm, pnpm, yarn or bun, whichever lockfile the project has) and the panel says **Tweak Kit updated**. Restart the dev server to use it. This edits `package.json` and the lockfile; commit them or not as you like. It reads the repo's public commits feed, so it isn't subject to GitHub's API rate limit, and it stays quiet offline, in CI, and in a git checkout of the kit.

To be told instead of updated, turn `autoUpdate` off in `vite.config.ts`:

```ts
uiTweaks({ autoUpdate: false })
```

Then the terminal prints the update command and the panel shows **Tweak Kit: N updates** with the latest changes and a **Copy command** button. With `serve.mjs`, pass `--no-auto-update`. Set `updateCheck: false` (or the `UI_TWEAKS_NO_UPDATE_CHECK` environment variable) to turn the check off entirely.

For the Claude Code mod, turn on auto-update for the `ui-tweak-kit` marketplace in `/plugin` → Marketplaces, if your Claude Code version offers it; otherwise use the commands above.

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
git clone https://github.com/kenanaiahjj/tweak-kit.git
cd tweak-kit
npm test                                  # direct-apply tests
claude plugin test claude-mod             # the mod's tests
claude plugin validate .                  # the marketplace and the mod
```

- To use your working copy everywhere, point `CLAUDE_CODE_PLUGIN_DIRS` (in the `env` block of `~/.claude/settings.json`) at `<clone>/claude-mod` instead of installing from the marketplace.
- Point projects at your clone with `npm i -D <path-to-clone>`.
- Bump `version` in `claude-mod/.claude-plugin/plugin.json` when you change the mod, so `claude plugin update` picks it up.
