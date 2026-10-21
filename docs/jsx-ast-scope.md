# Scope: JSX AST edits

Status: scoped, not built. This is the plan for replacing the text-window JSX editing in `direct-apply.mjs` with parser-based edits.

## Why

Haiku is available (the kit is a Claude Code mod, so it is online), so the model is not the problem. The problems are speed (seconds per Send instead of instant), cost, and trust: a model rewrite can touch lines it shouldn't, and today's checks only confirm "the value appears somewhere in the file".

Today JSX is edited by scanning text near a line number:

| Edit | Where | Weakness |
| --- | --- | --- |
| Add override class | `planClassAdd` | Scans for `<`, `>` with a hand-rolled quote/brace counter. Bails on any `className={expr}`, on components, and on tags that start on a different line than `jsxSource` says. |
| Copy change | `planTextEdit` | Looks for the old string in the next 20 lines; refuses if it appears twice or isn't a plain literal. |
| Move / remove / insert / component props | not direct | Always `tweak.move`, `remove`, `insert`, `props` -> Haiku. |
| Inline `style={{}}` values | not direct | `c.inlineBefore` -> Haiku. |

## What the AST layer covers

One module, `jsx-edit.mjs`, with pure functions `(text, locator, op) -> { edits } | { error }`, returning the same `{start, end, value}` edits `applyEdits` already consumes, so it slots into `applyDirect` without changing its flow.

| Op | Behaviour | Replaces |
| --- | --- | --- |
| `addClass` | `className="a"`, `className={"a"}`, template literals, and `clsx(...)`/`cn(...)`/`classNames(...)` calls (append a string argument). Other expressions: error, Haiku. | `planClassAdd` |
| `setText` | Replace one `JSXText` or string-literal child; error if the element's text is dynamic (`{t("x")}`, `{name}`). | `planTextEdit` |
| `setStyleProp` | Edit/add a key in a literal `style={{...}}`; error on spread or non-literal. | Haiku (`inlineBefore`) |
| `setProp` | Edit a literal string/number/boolean prop on the element (component props panel). | Haiku (`tweak.props`) |
| `remove` | Remove the element and its leading whitespace; if the parent becomes empty keep `null`-safe output. | Haiku |
| `move` | Reorder among JSX siblings (same parent). Cross-parent moves and `.map()` items: error, Haiku. | Haiku |
| `insert` | Insert a self-contained element (basic frame/text/button) before/after/inside a sibling; component inserts add the import only if the component is already exported from a known path. | Haiku |

Anything the AST layer cannot do exactly returns an `error`, and the tweak keeps going to Haiku exactly as it does now. No behaviour gets worse; the direct set only grows.

## Locating the element

`jsxSource` (`file:line`) is only a line today. The Vite plugin's JSX runtime wrapper already has the source object from `jsxDEV(type, props, key, isStatic, source)`, which carries `lineNumber` and `columnNumber`. Extend it to pass `file:line:col`, then the locator becomes: parse the file, find the `JsxOpeningElement`/`JsxSelfClosingElement` whose start line and column match. Falls back to "first element starting on that line" when there is no column (older records), and to an error if two elements start on that line and there is no column.

## Parser choice

The kit has zero dependencies and the overlay is dependency-free, and that should stay true. Use the host project's own compiler:

1. `createRequire(root + "/")` then `require("typescript")`. Every React/TS/Vite project has it; it parses `.tsx`, `.jsx`, `.ts`, `.js` and preserves node positions, which is all `edits` needs (no printing, so no reformatting of untouched code).
2. No `typescript` in the project: `jsx-edit` reports `unavailable` and everything stays on the current path.
3. Vue/Svelte/Astro SFCs: out of scope for the first pass (their templates aren't JSX). Keep the current text path for them.

Rejected: bundling `@babel/parser` or `oxc-parser` (adds an install dependency and a version to keep in sync for little gain over the TS API), and `ts-morph` (heavy, and it wants to reprint code).

## Safety

- Edits are position-based on the original text, so formatting, comments and imports elsewhere are untouched.
- After planning, re-parse the result; if it has new syntax errors, discard the plan for that file and send the tweak to Haiku.
- The existing "overlapping edits" guard and per-file undo (`recordHistory`) stay as they are.
- The new post-apply computed-style check in the overlay (shipped with this branch) is the end-to-end net.

## Rollout

1. `jsx-edit.mjs` with `locate`, `addClass`, `setText`; switch `applyDirect` to it behind `uiTweaks({ ast: true })`, keep the text path as the fallback. Tests: fixtures for each className form, duplicate text, two elements on one line, a syntax-error result.
2. `setStyleProp`, `setProp`, `remove`.
3. `move` and `insert`.
4. Column in `jsxSource`; drop the text path for files the parser handles.
5. Make `ast` the default once the fixtures plus a run against OneQR's `main.tsx` (one large file, ~every pattern) pass.

Rough size: step 1 about 300 lines plus tests; steps 2-3 about 400 more. The large single file in OneQR is the best real-world test.
