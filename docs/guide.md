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

**Without installing anything: the standalone studio.** If you'd rather not add the kit to a project (or it's someone else's project, or a framework the kit doesn't set up), run the studio on its own:

```bash
npx github:kenanaiahjj/tweak-kit studio [app address] [--root <project folder>] [--port 5600]
```

**From Claude Code: `/studio`.** The ui-tweaks mod's `/studio` command opens the studio for the session's project without a terminal. If the project has the kit installed and its dev server is running, that server's studio opens. Otherwise the mod starts the standalone studio for the session's folder (the project's installed kit, or the latest from GitHub via npx) and opens its start page; `/studio http://localhost:5173` connects it to that dev server and opens the studio straight away. In the desktop app Claude opens it in its browser pane; in a terminal it opens in your browser. The studio started this way runs as long as the Claude Code session.

From a terminal: open `http://localhost:5600`, give it your dev server's address and the project folder, and press **Open studio**; **Start its dev server** runs the project's `dev` script instead and picks up the address it prints. Recent projects are listed for next time (`~/.ui-tweaks/studio.json`), and `/__ui-tweaks/connect` switches to another app.

The studio is a proxy in front of your dev server: pages come through it with the panel added (unless the project already loads it), hot reload's websocket is passed through, and the kit's own routes (`/__ui-tweaks/…`) are answered by the studio, writing to the project folder you gave it. So it works with Vite, Next.js, Remix, Astro, a Rails or Django app, anything that serves HTML. For React apps on Vite it also keeps React 19's element sources, as the Vite plugin does, so exact source lines work. Two things to know: the app runs at the studio's address, so anything tied to its own origin (an OAuth redirect URL, a cookie set for a specific port) may need the app's direct address; and the panel's Content-Security-Policy header is dropped in the proxied pages so the panel can load.

**Installing it in the project.** The quickest way, in the project folder:

```bash
npx github:kenanaiahjj/tweak-kit init
```

It detects Vite, Next.js or plain HTML and the package manager, installs the kit, adds `uiTweaks()` to a Vite config (or a `tweaks` sidecar script elsewhere), and installs the Claude Code mod (`--no-mod` skips that, `--no-install` skips the package). It changes nothing it doesn't recognise: a config it can't safely edit gets printed instructions instead. The rest of this section is the manual setup.

**React versions.** With the Vite plugin, the kit wraps React's development JSX runtime to remember where each element is written (file and line). React 18 did this itself; React 19 no longer does, so without it source-aware features (direct edits to JSX, text edits, moving and inserting, component props) would fall back to Haiku searching. It also corrects line numbers that some setups shift (e.g. `@vitejs/plugin-react` 4 adds a Fast Refresh header before compiling JSX). Nothing is added to your DOM. Turn it off with `uiTweaks({ sources: false })`.

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

### The studio (the default)

**Tweak** opens the studio at `/__ui-tweaks/studio`: one **screen** of your app at a time, at its real size on a real device, with the panel docked on the right. A screen is not a picture: it is your running app, framed at one URL (screen and state) and device. Change the code and it updates.

**Screens**
- **‹ ›** (or ←/→) step through your screens; the dropdown jumps to one. A screen loads the first time you open it and stays loaded, so switching back is instant.
- **＋** adds a copy of the screen in view (then change its URL with **✎**), **✎** renames it or changes its URL, **🗑** removes it (your app isn't touched).
- **☰** lists the app's routes, found in its files: Next.js (app and pages routers), SvelteKit, Nuxt, Remix and React Router (flat routes and `routes.ts`), TanStack Router, Astro, plain HTML, and route paths written in code (React Router, Vue Router and the like), nested ones joined to their parents. Click one to add a screen for it; **Add all** adds every route that isn't a screen yet. A route with parameters (`/users/:id`, `/blog/[slug]`) asks for a value first.
- **✨ Find screens with Claude** is for apps that switch screens without URLs: Claude adds a small development-only `?screen=` / `?fixture=` hook (see the dev hook below) and writes the screens into `canvas.json`, so they appear in the list. It runs through Ask Claude, so keep a Claude Code session with the mod open.
- The device menu and **⟲** (rotate) apply to the screen in view. The **width slider** resizes it live to watch the layout respond; its ticks are your project's breakpoints, and picking a device resets it.
- The screen sits on a canvas you can zoom: a screen bigger than the space (a 1920 × 1080 desktop, say) opens fitted to it, smaller ones at 100%. Pinch or ⌘-scroll zooms around the pointer, scroll or drag the background pans, and **−** / **+** / **Fit** / **1:1** in the toolbar (or ⌘− / ⌘= / ⇧1 / ⇧0) do the same from the keyboard. The app always lays out at the screen's real size; zoom only changes how big it's drawn. Each screen remembers its zoom until you change its size.
- **▦** shows every screen at a glance: a sketch of each one you've opened (drawn from its page, so web fonts and images may be missing), with its size and URL; click one to open it. Scroll or drag to see a device bigger than the space.
- Tweaks belong to the screen they were made on, identified by its path, query and #hash, and only preview there. The panel notes unsent changes on other screens; open a screen to see and send its changes.
- Devices (CSS px): iPhone Duo open (890 × 626) and folded (466 × 678), 18/17/16 Pro Max (440 × 956), Air (420 × 912), 18 Pro · 17 Pro · 17 (402 × 874), 16 · 15 (393 × 852), 17e · 14 · 13 (390 × 844), 16 Plus · 15 Plus (430 × 932), 13 mini (375 × 812), SE (375 × 667); iPad mini, Air 11″, Pro 11″, Pro 13″, classic; Pixel, Galaxy Z Fold 5 folded; Laptop, MacBook Air 13″, 1440 × 900, 1920 × 1080.
- Frames show the app edge to edge (no simulated status bar or notch, so nothing clips the app's header); the iPhone Duo draws its fold line. **Grid** (4/8/12 columns) and **8pt** overlay guides; hold **Compare** (or **\\** in the app) to see the screen without your previews; **📷** copies a picture of it to the clipboard, ready to paste into Slack, a doc or a deck (Shift-click also saves a PNG). Chrome asks which tab to capture each time; pick this one.

**Versions: another branch side by side**
- **⑂ Versions** lists your branches (local, then remote); pick one, or type a commit or tag, to show that version of the app next to the screen you're editing. Each screen has a badge on top saying which version it is: your checkout on the left in blue (**Editing**, noting uncommitted changes), the other branch on the right in amber (**Comparing · view only**), each with its commit, and each frame outlined in its colour.
- The other version runs from its own checkout (a git worktree in `~/.cache/ui-tweak-kit/worktrees`, outside your project), so your files, branch and uncommitted work are never touched, and nothing that scans your project sees a second copy of the code. It reuses your `node_modules` when the lockfile matches (opening takes seconds) and installs that version's dependencies when it doesn't; `.env` files are copied over. Then it starts that version's own dev server on a free port, with your project's Vite config as the branch has it. Vite, Next.js and plain HTML projects work.
- Both sides follow along: the same screen, device and width, and the other side copies your navigation and scrolling (the page, or a scrolling panel in the same place). Next.js projects follow the screen but not the scrolling. Edit on the left as usual; the right side is the other version, live, and only shows.
- The canvas fits both, and zooming and panning move them together. **📷** captures both in one image, side by side on a light background under their labels, and copies it, so a paste shows exactly what changed. It captures at the fitted size, so make the window bigger for a sharper picture.
- **Close the comparison** in the same menu stops the other dev server (the checkout stays, so opening that branch again is quick). The other server also stops with yours, and the studio reopens the comparison when you come back.


**`canvas.json`: your screens are part of your project.** The list lives in `.ui-tweaks/canvas.json`, the one file in `.ui-tweaks/` that git sees, so you can commit and share it:

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

The studio saves it as you change screens, and picks up changes made to it elsewhere within a couple of seconds, so you can ask Claude to "add screens for the empty and error states" and watch them appear. (`x`/`y` are left over from the old canvas view and are ignored.)

**Screens and states: the dev hook.** Apps with URLs (Next.js, React Router) need nothing: an artboard's URL is the route. Apps that switch screens or data in memory need a small **dev-only** hook so each screen can open a screen in a known state; ask Claude to add one. The convention:
- `?screen=<name>` opens a screen.
- `?fixture=<name>` loads a named, made-up data state (new user, verified, error…) **instead of** the saved one, and never writes it back, so screens don't overwrite your real dev data or each other.
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
| Ask Claude | Describe a change and press **Do it** (⌘Enter): a designer agent (Sonnet, in Claude Code) edits the code in the background, following your components and tokens; the result shows here and **Undo apply** reverts it. **3 variations** proposes three looks for the element as style changes: click one to preview it on the page, **Use** turns it into ordinary tweaks to send. Works with nothing selected too ("add a row under Settings"). |
| Arrange | **↑ / ↓** reorder among siblings, **Parent** selects up, **Duplicate** (⌘D) adds a copy, **Remove** deletes the element (Claude writes the JSX on Send) |
| Component · Name | When the element is the root of a React component instance: its string, number and boolean props, editable; Haiku changes them at the usage on Send |
| Tokens on this element | The design tokens behind its styles, with the value in the theme that applies here. Editing one rewrites the token itself, so everything that uses it changes |
| Auto layout | Row or column, a 3×3 alignment pad, Packed or Spread, gap, wrap. **＋ Add** (or **⇧A**) turns any element with children into one; **Remove** puts it back in normal flow |
| In parent layout | For children of flex or grid containers: align-self (Auto, Start, Center, End, Stretch) |
| Size | Width and height, each **Fixed**, **Hug** (fit the content) or **Fill** (take the space, using flex-grow or stretch inside auto layout), min/max width, and content overflow: Visible, Clip or Scroll. Buttons, links and form controls also show their **tap target** size and whether it reaches 44×44 |
| Position | Auto (static), Relative, Absolute, Fixed or Sticky. Absolute and Fixed keep the element where it is, at its current size. When positioned: top/right/bottom/left offsets, z-index, and **Align in parent** (pin left, center, right, top, middle, bottom). It names the ancestor the element is positioned against. |
| Spacing | A box diagram: margin outside, padding inside, size in the middle. Click a side to type (margin takes `auto`); ↑/↓ steps, Shift ×10, Alt applies to all four sides. **Center** sets auto side margins; **Margin 0** and **Pad 0** clear them. |
| Text | Size, weight, line height, letter spacing, color, alignment |
| Fill & border | Background or gradient layers (each color stop has a picker), corner radius, border, opacity |
| Shadow | `box-shadow` as text |
| Apply to | **This element** or **Everywhere**: Everywhere edits the CSS rule itself, so every element and component instance it styles changes (the preview shows them all, and how many); This element gives shared styles an override for just it. Then **All screen widths** or **Only at N px** (a media query), and a **note** for Claude |

- **Drag a field's label** left or right to scrub its value. Hold Shift for steps of 10. ↑/↓ in a field nudges by 1 (Shift: 10).
- **Drag the selected element** on the page to reorder it among its siblings: a blue line shows where it lands. Absolute and fixed elements move instead, snapping their edges and centre to the parent (hold ⌘/Ctrl to place freely, Shift to lock an axis). **⌘-drag** an element in the flow to offset it (`position: relative`) without moving anything else.
- **Drag the handles** on the selection to resize; Shift on a corner keeps the proportions. On an absolute element, the handle on the side it's pinned to moves that side.
- **Drag a row in the layers list** onto a sibling's row to reorder.
- **Spacing handles:** with an element selected, pink handles sit in its padding and between the children of an auto-layout element. Drag one to change that padding or the gap; **Alt** changes all four paddings, **Shift** steps by 8.
- **Snapping:** dragging a positioned element snaps its edges and centre to its parent and its siblings, with a red guide to what it lines up with (hold ⌘/Ctrl to place freely).
- **Multi-select:** **Shift-click** adds or removes elements; panel edits then apply to all of them as one undo step, and Delete or ⌘D act on all. **Matching** (element header, or ⌘K) selects every instance of the same component, or every element with the same tag and classes.
- **⚡ Instant mode** (next to Send): each change is applied to the source about a second after you make it (once you stop dragging or typing), without pressing Send. The setting is remembered.
- **🕘 History** (panel bar): this session's edits newest first, each with **Rewind** to go back to that point (⌘⇧Z brings them back), and what was applied to the source, with who applied it, the files, and **Undo** on the latest; plus recent skip reasons.
- **⌘K** opens the command palette: type to find any action (select parent, duplicate, add auto layout, copy as code, insert, send…), any section or property ("padding-left" jumps to that field), or another screen in the studio. ↑/↓ and Enter run it.
- **⌘⇧Z** (or Ctrl+Y, or ↷ in the bar) redoes what ⌘Z undid: styles, text, moves, removals, inserts and props alike.
- **Colour fields** show the token a colour comes from (e.g. `var(--brand)`), the project's colour tokens as swatches to click (◇ lists them with names), and **⊙** picks a colour from anywhere on screen (Chrome, Edge).
- **CSS / Tailwind / JSX** in the element header copy its styles as a CSS block or Tailwind classes, or its JSX exactly as written in the source.
- **Keys:** ⌘↑/⌘↓ reorder, ⌘D duplicates, Delete removes, Enter selects the first child, Shift+Enter the parent, Tab / Shift+Tab the next or previous sibling, ⇧A adds or removes auto layout.
- **＋ Insert** (panel bar) lists basic elements (frame, text, button, image) and the React components on the page. Pick one, then click where it goes: over a container's empty space it goes inside, over an element it goes beside it; hold **Shift** to place it between the repeated items around the pointer (cards, rows). It previews at once; Haiku writes the JSX on Send.
- **Resizing** from the handles snaps to **Fill** (the space available) and **Hug** (the content's own size) as you pass them, and switches a Fill element to a fixed size properly (its flex-grow off).
- **Performance:** the overlay does nothing while the panel is closed or the tab is in the background; style lookups are cached per stylesheet change. `__uiTweaks.stats()` in the console shows the time its per-frame drawing and periodic checks take.
- **Section titles** fold their section; the panel remembers which.
- Reordering and removing are previews on the page until you Send; Haiku then edits the JSX, and the page reloads once it's applied. Items from one `.map()` are reordered in the data when it's written out in the source; otherwise Haiku skips them and says why.
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

**Code** (in the panel's footer) shows, before you send, the diff a Send would write directly, and which tweaks are left for Haiku and why. It writes nothing.

**Checked against the preview.** When a sent tweak has landed, the panel drops its preview and reads the element's computed style from the page the source now produces. If it doesn't match what the preview showed (a rule that wins, a token that resolves differently, a selector that missed), a **source differs** row appears with the two values. **Re-apply** puts the preview back as a draft with a note, so Haiku finds the rule that wins.

**One commit per Send (optional).** With `uiTweaks({ commit: true })` (or `serve.mjs --commit`), what a Send writes directly is committed as `UI tweak: .card padding-top`. Only files that had no uncommitted changes are committed, so your work in progress is never swept in; otherwise the files are written and left uncommitted, and the toast says why. Haiku's edits and **Undo apply** are not committed.

### Design system page

**Tokens** in the studio toolbar, or **◧** in the panel, opens `/__ui-tweaks/system`: every design token (CSS custom property) your stylesheets declare, laid out for designers.

- **Sections:** colours, font families, type scale, weights, line heights, spacing, radius, shadows, motion, z-index and anything else, each previewed with the real value (a swatch, a type sample, a bar, a rounded box, a shadow card, a moving dot).
- **Modes:** any selector that declares four or more tokens is a mode (`:root`, `.dark`, `[data-theme=…]`, a theme class); switch between them at the top. Colour cards show the other modes as small squares, and a value a mode doesn't set says where it comes from.
- **Edit in place:** change a value and press Enter, or click a swatch to pick a colour (an oklch token stays oklch). The edit is written to the declaration in your stylesheet, your app updates through hot reload, and **Undo** in the toast (or **Undo apply** in the panel) puts the file back.
- **Uses:** each token shows how often `var(--name)` appears in your source; unused ones are marked.
- **Hand-written values:** colours, spacing, radii and font sizes typed straight into the CSS, most used first. **Use --token** swaps every one for the matching token (◐ marks a token that changes between modes, and asks first); **Make token** adds a new token to the base mode and uses it everywhere.
- Custom properties set on a single component's selector are listed as **Local tokens**.

### Commands in Claude Code

| Command | Does |
| --- | --- |
| `/apply-tweaks` | Applies waiting tweaks with Haiku (normally automatic) |
| `/apply-tweaks claude` | Sends waiting tweaks, e.g. ones Haiku skipped, to the main model |
| `/apply-tweaks undo` | Undoes the last apply |
| `/apply-tweaks asks` | Runs waiting Ask Claude requests |
| `/studio [app address]` | Opens the studio for this project, in Claude's browser pane (desktop) or your browser |

## How tweaks get applied

Each tweak is split per property, and every property goes the cheapest route that's safe:

1. **Directly, with no model** (instant, done by your dev server):
   - **In-place edit:** the value sits on a CSS rule only this element uses (one selector, one match on the page, and its classes appear once in the source). The rule is edited in place, including inside its `@media` block, and shorthands like `padding: 10px 16px` are rewritten correctly.
   - **Override:** the value sits on a shared rule, or no rule sets it yet. The element's JSX gets a class of its own, such as `primary-button--t3f2a`, and a more specific rule for it goes right after the shared one, so the other elements keep their look. Later tweaks on the same element reuse that class and rule.
   - **Copy edit:** the text change is found on the element's JSX line and replaced.
   - **Width scope:** "At 430px and below" (or "From 768px up") is written as an `@media` rule for a breakpoint the project already uses, in the direction it already writes them (desktop-first `max-width` or mobile-first `min-width`, read from its stylesheets; Tailwind's defaults when there are none). The rule inside that block is edited in place, or the block is created right after the base rule. Shared rules, another `@media` rule that wins at that width, and a block that sits above the base rule go to Haiku.
   - **Tailwind:** when no hand-written rule in a source stylesheet sets the value, the tweak becomes a utility class on the element: `pt-2` becomes `pt-5`, a new colour becomes `text-[#111]`, hover becomes `hover:bg-[#000]`, a width scope becomes `max-[430px]:`. Same-property utilities at the same variant are replaced; broader ones (`p-4` beside a new `pt-5`) stay, because Tailwind orders the more specific one last. `font-size` is always an arbitrary value (`text-lg` would also change line-height). Works on `className="…"` literals and the first string of `cn()` / `clsx()` / `twMerge()`; other className expressions and components go to Haiku.
2. **Haiku** (seconds, in the background, started by the mod):
   - notes
   - hover/active/focus states (except in Tailwind projects, where they become `hover:` utilities)
   - "only at N px" tweaks the project has no breakpoint for
   - values set through a React `style` prop
   - shared rules in plain HTML projects
   - anything the direct path couldn't place
3. **The main model** only if you ask, with **Send to Claude** in the band or `/apply-tweaks claude`. That's for tweaks Haiku skipped.

**You can always see who wrote what.** The band in Claude Code and the panel tag every apply: **direct · no AI** (written by the kit, no model involved), **Haiku agent**, **Claude**, or **tokens · no AI** for a design system edit. While an agent is working, the band says so and the panel shows a spinning **Applying N tweaks · Haiku agent** row until it's done; the same tags are on every entry in History.

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

When the dev server starts, the kit compares the commit pinned in your lockfile with `main` on GitHub. If you're behind, it reinstalls itself from GitHub (npm, pnpm, yarn or bun, whichever lockfile the project has; this edits `package.json` and the lockfile) and the panel says **Tweak Kit updated**: restart the dev server to use it. It reads the repo's public commits feed, so it isn't subject to GitHub's API rate limit, and it stays quiet offline, in CI, and in a git checkout of the kit.

To be told instead of updated, turn `autoUpdate` off in `vite.config.ts`; then the terminal prints the update command and the panel shows **Tweak Kit: N updates** with the latest changes and a **Copy command** button:

```ts
uiTweaks({ autoUpdate: false })
```

With `serve.mjs`, pass `--no-auto-update`. Set `updateCheck: false` (or the `UI_TWEAKS_NO_UPDATE_CHECK` environment variable) to turn the check off entirely.

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
npm test                                  # unit tests, plus a Chrome smoke test of the panel (skipped without Chrome; set CHROME_PATH)
claude plugin test claude-mod             # the mod's tests
claude plugin validate .                  # the marketplace and the mod
```

- To use your working copy everywhere, point `CLAUDE_CODE_PLUGIN_DIRS` (in the `env` block of `~/.claude/settings.json`) at `<clone>/claude-mod` instead of installing from the marketplace.
- Point projects at your clone with `npm i -D <path-to-clone>`.
- Bump `version` in `claude-mod/.claude-plugin/plugin.json` when you change the mod, so `claude plugin update` picks it up.
