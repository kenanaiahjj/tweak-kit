/* UI Tweaks overlay: Figma-style visual tweaks that Claude Code turns into source edits.
 * Loaded in dev only (Vite plugin, static server, or a <script> for other dev servers).
 * Toggle with the floating button or Alt+T. While picking: click selects, double-click edits text,
 * Esc deselects, V toggles picking. Tweaks are previewed as inline styles, then sent to
 * <root>/.ui-tweaks/pending.json for Claude to apply in the real source. */
(() => {
  if (window.__uiTweaks) return;

  const script = document.currentScript;
  const ROOT = (script && script.dataset.root) || "";
  const API = ((script && script.dataset.api) || "") + "/__ui-tweaks";
  const LIVE_RELOAD = !!(script && script.dataset.liveReload);
  const STORE_KEY = "ui-tweaks:drafts:" + location.pathname;
  // The screen a tweak was made on: apps often keep every screen at one path and switch by query or #hash.
  const here = () => location.pathname + location.search + location.hash;
  // Screens this page has held drafts for: their saved drafts are whatever it holds now (a reset there sticks).
  const heldScreens = new Set();
  // When both are known, an element must come from the same JSX line to inherit a saved tweak.
  const sameSource = (el, jsx) => {
    const own = jsx && reactInfo(el);
    return !own || !own.jsxSource || own.jsxSource === jsx;
  };
  // Docked mode: the page runs in the studio's frame and its panel docks beside it (same origin).
  const STUDIO = (() => {
    try {
      return window.parent !== window && window.parent.document.documentElement.hasAttribute("data-ui-tweaks-studio") ? window.parent : null;
    } catch {
      return null;
    }
  })();
  // With several devices in the studio, each frame runs an overlay; the one whose panel is docked owns it.
  const IS_PRIMARY = (() => {
    try {
      return !window.frameElement || window.frameElement.dataset.primary === "1";
    } catch {
      return true;
    }
  })();
  // The studio is served by the dev server the page came from; a sidecar on another origin can't frame it.
  const CAN_DOCK = !(script && script.dataset.api);

  // ---------- state ----------
  const state = {
    isOpen: false,
    isPicking: true,
    editState: "", // "", "hover", "active" or "focus-visible": which state edits apply to
    selected: null, // Element
    hovered: null,
    tweaks: new Map(), // key -> tweak
    sentBatches: new Map(), // batch id -> tweak keys
    undo: [], // preview edits, newest last: { stamp, at, el, key, prop | text, before }
    lastApply: null, // Haiku's newest undoable apply, from the server
    codePreview: null, // dry run of the next Send: { files: [{ path, diff }], direct, queued }
    verifyIssues: [], // applied tweaks whose source didn't reproduce the preview: { selector, label, prop, expected, got }
    update: null, // a newer kit on GitHub, from the server
    note: "",
  };
  const elementKeys = new WeakMap();
  let keyCounter = 0;

  // ---------- helpers ----------
  const PX_PROPS = new Set([
    "width", "height", "min-width", "max-width", "min-height", "max-height",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "gap", "row-gap", "column-gap", "font-size", "letter-spacing",
    "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "top", "right", "bottom", "left",
  ]);
  const SHORTHANDS = {
    "padding-top": ["padding", "padding-block", "padding-block-start", "padding-inline"],
    "padding-bottom": ["padding", "padding-block", "padding-block-end"],
    "padding-left": ["padding", "padding-inline", "padding-inline-start"],
    "padding-right": ["padding", "padding-inline", "padding-inline-end"],
    "margin-top": ["margin", "margin-block", "margin-block-start"],
    "margin-bottom": ["margin", "margin-block", "margin-block-end"],
    "margin-left": ["margin", "margin-inline", "margin-inline-start"],
    "margin-right": ["margin", "margin-inline", "margin-inline-end"],
    "row-gap": ["gap"],
    "column-gap": ["gap"],
    "font-size": ["font"],
    "font-weight": ["font"],
    "line-height": ["font"],
    "font-family": ["font"],
    "background-color": ["background"],
    "background-image": ["background"],
    "border-top-left-radius": ["border-radius"],
    "border-top-right-radius": ["border-radius"],
    "border-bottom-right-radius": ["border-radius"],
    "border-bottom-left-radius": ["border-radius"],
    "border-top-width": ["border", "border-top", "border-width"],
    "border-right-width": ["border", "border-right", "border-width"],
    "border-bottom-width": ["border", "border-bottom", "border-width"],
    "border-left-width": ["border", "border-left", "border-width"],
    "border-top-color": ["border", "border-top", "border-color"],
    "flex-direction": ["flex-flow"],
  };
  const GROUPS = {
    padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
    margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
    "border-radius": ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
    "border-width": ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"],
    "border-color": ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"],
  };

  const isOwn = (node) => node && (node === host || (host && host.contains(node)));
  const computed = (el, prop) => getComputedStyle(el).getPropertyValue(prop).trim();

  function keyOf(el) {
    if (!elementKeys.has(el)) elementKeys.set(el, "e" + ++keyCounter);
    return elementKeys.get(el);
  }

  function shortNumber(n) {
    return String(Math.round(n * 100) / 100);
  }

  function parseNumber(value) {
    const match = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(String(value).trim());
    return match ? { n: parseFloat(match[1]), unit: match[2] } : null;
  }

  function normalizeLength(input, prop) {
    const v = String(input).trim();
    if (v === "") return "";
    if (/^-?\d*\.?\d+$/.test(v)) {
      if (prop === "line-height" || prop === "opacity" || prop === "font-weight" || prop === "flex-grow") return v;
      return v + "px";
    }
    return v;
  }

  // Paint one pixel to read any CSS color (oklch, lab, color(), named...) as RGBA.
  function rgbaOf(color) {
    const ctx = rgbaOf.ctx || (rgbaOf.ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true }));
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: Math.round((a / 255) * 100) / 100 };
  }

  function toHex(color) {
    const { r, g, b } = rgbaOf(color);
    return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  function alphaOf(color) {
    return rgbaOf(color).a;
  }

  function withAlpha(hex, a) {
    if (a >= 1) return hex;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // Split a comma list at the top level only: "a(1, 2), b" -> ["a(1, 2)", "b"].
  function splitTopLevel(value) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        parts.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(value.slice(start).trim());
    return parts.filter(Boolean);
  }

  const COLOR_TOKEN = /(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]*\)|#[0-9a-f]{3,8}\b|\b(?:white|black|transparent)\b/gi;

  function prettyColor(color) {
    if (!color) return "";
    const a = alphaOf(color);
    if (a === 0) return "transparent";
    const hex = toHex(color);
    return a < 1 ? `${hex} ${Math.round(a * 100)}%` : hex;
  }

  function parseColorInput(text) {
    const t = text.trim();
    const pct = /^(#[0-9a-f]{3,8})\s+(\d+)%$/i.exec(t);
    if (pct) {
      const hex = toHex(pct[1]);
        return withAlpha(hex, parseInt(pct[2], 10) / 100);
    }
    if (/^[0-9a-f]{6}$/i.test(t) || /^[0-9a-f]{3}$/i.test(t)) return "#" + t;
    return t;
  }

  // ---------- element description ----------
  function cssPath(el) {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      const classes = [...node.classList].filter((c) => !c.includes(":") && c.length < 40).slice(0, 3);
      if (classes.length) part += "." + classes.map((c) => CSS.escape(c)).join(".");
      const parent = node.parentElement;
      if (parent) {
        // Count in source order, so the selector still finds it after a reload puts moved siblings back.
        const orig = ORIGINAL.get(parent);
        const same = (orig && orig.includes(node) ? orig : [...parent.children]).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const selector = parts.join(" > ");
      try {
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch {}
      node = parent;
    }
    return parts.join(" > ");
  }

  function relativePath(file) {
    if (!file) return file;
    let f = String(file).replace(/^file:\/\//, "").split("?")[0];
    if (ROOT && f.startsWith(ROOT)) f = f.slice(ROOT.length).replace(/^\/+/, "");
    return f;
  }

  // Where a fiber's JSX was written: React 18 keeps it on the fiber; on React 19 the kit's Vite plugin
  // records it by the element's props object (see vite-plugin.mjs).
  function sourceOf(f) {
    if (!f) return null;
    const s = f._debugSource || (window.__uitSources && f.memoizedProps && typeof f.memoizedProps === "object" && window.__uitSources.get(f.memoizedProps));
    return s && s.fileName ? `${relativePath(s.fileName)}:${s.lineNumber}` : null;
  }

  function reactInfo(el) {
    const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (!fiberKey) return null;
    const fiber = el[fiberKey];
    const src = sourceOf;
    const components = [];
    let node = fiber.return;
    while (node && components.length < 5) {
      const type = node.type;
      if (typeof type === "function" || (type && typeof type === "object" && (type.render || type.type))) {
        const name = type.displayName || type.name || (type.render && (type.render.displayName || type.render.name)) || (type.type && (type.type.displayName || type.type.name));
        if (name) components.push({ name, usedAt: src(node) });
      }
      node = node.return;
    }
    const props = fiber.memoizedProps || {};
    return {
      jsxSource: src(fiber),
      components,
      className: typeof props.className === "string" ? props.className : undefined,
      inlineStyleProp: props.style ? Object.keys(props.style) : undefined,
    };
  }

  function selectorSpecificity(selector) {
    const s = selector.replace(/::?[a-z-]+\([^)]*\)/gi, (m) => (m.startsWith("::") ? " x" : m.startsWith(":where") ? "" : " .x"));
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
    const tags = (s.replace(/[#.:][\w-]+|\[[^\]]+\]/g, " ").match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
    return ids * 10000 + classes * 100 + tags;
  }

  function sheetSource(sheet) {
    const owner = sheet.ownerNode;
    if (owner && owner.dataset && owner.dataset.viteDevId) return relativePath(owner.dataset.viteDevId);
    if (sheet.href) return relativePath(new URL(sheet.href).pathname.replace(/^\//, ""));
    return "<style> in page";
  }

  function collectRules(list, sheet, conditions, out) {
    for (const rule of list) {
      if (rule.selectorText !== undefined && rule.style) {
        out.push({ rule, sheet, conditions });
      } else if (rule.cssRules) {
        const cond = rule.conditionText || rule.media?.mediaText || (rule.name ? `@layer ${rule.name}` : "");
        collectRules(rule.cssRules, sheet, cond ? [...conditions, cond] : conditions, out);
      }
    }
  }

  const FORCE = (st) => `[data-ui-tweak-force~="${st}"]`;
  const STATE_SHEET_ID = "ui-tweaks-states";

  // With `st` ("hover", ...), rules for that state come first, then the element's base rules.
  // ---------- which rules style an element (cached) ----------
  // The page's rules, flattened once per stylesheet change; per element, the rules that match it,
  // worked out once per render. A lookup for one property is then a filter over a short list.
  let sheetVersion = 0;
  const ourSheet = (n) => n && (n.id === STATE_SHEET_ID || n.id === "ui-tweaks-reach" || (n.parentNode && (n.parentNode.id === STATE_SHEET_ID || n.parentNode.id === "ui-tweaks-reach")));
  new MutationObserver((muts) => {
    const theirs = (m) => !ourSheet(m.target) && (m.type !== "childList" || [...m.addedNodes, ...m.removedNodes].some((n) => !ourSheet(n)));
    if (muts.some(theirs)) sheetVersion++;
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
  document.addEventListener("load", (e) => e.target && e.target.tagName === "LINK" && sheetVersion++, true);

  let flat = null, flatVersion = -1;
  function flatRules() {
    if (flat && flatVersion === sheetVersion) return flat;
    flat = [];
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && (sheet.ownerNode.id === STATE_SHEET_ID || sheet.ownerNode.id === "ui-tweaks-reach")) continue;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const all = [];
      collectRules(rules, sheet, [], all);
      for (const r of all) flat.push({ ...r, parts: r.rule.selectorText.split(",").map((p) => p.trim()), order: flat.length });
    }
    flatVersion = sheetVersion;
    matchCache = new WeakMap();
    return flat;
  }

  let matchCache = new WeakMap();
  const holds = (conditions) => conditions.every((c) => (c.startsWith("@layer") ? true : (() => { try { return matchMedia(c).matches; } catch { return true; } })()));
  // The rules matching `el` (for state `st`), with the part of each selector that matched.
  function rulesFor(el, st) {
    const rules = flatRules();
    const key = `${st}|${el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className}|${el.id}|${innerWidth}x${innerHeight}`;
    let byEl = matchCache.get(el);
    if (!byEl) matchCache.set(el, (byEl = new Map()));
    if (byEl.has(key)) return byEl.get(key);
    const out = [];
    for (const r of rules) {
      let matchingPart = null, isState = false;
      for (const part of r.parts) {
        try {
          const forState = st && part.includes(`:${st}`);
          if (el.matches(forState ? part.split(`:${st}`).join(FORCE(st)) : part)) {
            if (forState) isState = true;
            if (!matchingPart || selectorSpecificity(part) > selectorSpecificity(matchingPart)) matchingPart = part;
          }
        } catch {}
      }
      if (matchingPart && holds(r.conditions)) out.push({ ...r, matchingPart, isState });
    }
    byEl.set(key, out);
    return out;
  }
  // Selector match counts, per stylesheet version: querySelectorAll over the page is the costly part.
  let countCache = new Map(), countVersion = -1;
  function matchCount(selector) {
    if (countVersion !== sheetVersion) {
      countCache = new Map();
      countVersion = sheetVersion;
    }
    if (!countCache.has(selector)) {
      let n;
      try { n = document.querySelectorAll(selector).length; } catch {}
      countCache.set(selector, n);
      setTimeout(() => countCache.delete(selector), 2000); // the page changes too
    }
    return countCache.get(selector);
  }

  function matchedRules(el, prop, st = "") {
    const names = [prop, ...(SHORTHANDS[prop] || [])];
    const found = [];
    for (const { rule, sheet, conditions, matchingPart, isState, order } of rulesFor(el, st)) {
      for (const name of names) {
        const value = rule.style.getPropertyValue(name);
        if (!value) continue;
        found.push({
          selector: rule.selectorText.length > 200 ? matchingPart : rule.selectorText,
          part: matchingPart, // the part of a selector list that matched this element
          matches: matchCount(rule.selectorText),
          forState: isState || undefined,
          important: !!rule.style.getPropertyPriority(name),
          property: name,
          value: value.trim() + (rule.style.getPropertyPriority(name) ? " !important" : ""),
          file: sheetSource(sheet),
          conditions: conditions.length ? conditions : undefined,
          usesVariable: value.includes("var(") || undefined,
          specificity: selectorSpecificity(matchingPart),
          order,
        });
      }
    }
    // The cascade: state rules (when asked), then !important, then specificity, then order.
    found.sort((a, b) => !!b.forState - !!a.forState || b.important - a.important || b.specificity - a.specificity || b.order - a.order);
    return found.slice(0, 3).map(({ specificity, order, important, ...rest }) => rest);
  }

  function describe(el) {
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList],
      text: text.length > 80 ? text.slice(0, 77) + "..." : text,
      react: reactInfo(el) || undefined,
    };
  }

  // ---------- applying tweaks ----------
  function tweakFor(el) {
    const key = keyOf(el);
    if (!state.tweaks.has(key)) {
      // "Everywhere" picked before the first change carries over to it.
      const reach = state.pendingReach === key ? "all" : undefined;
      state.tweaks.set(key, { key, el, at: here(), element: describe(el), changes: {}, text: null, note: "", batchId: null, reach });
    }
    return state.tweaks.get(key);
  }

  // Calls made in the same task (a linked group's four sides) share a stamp, so one undo takes them back together.
  let stamp = 0, stampCounter = 0;
  function actionStamp() {
    if (state.dragStamp) return state.dragStamp; // a whole drag or resize undoes as one step
    if (!stamp) {
      stamp = ++stampCounter;
      queueMicrotask(() => (stamp = 0));
    }
    return stamp;
  }

  function recordUndo(entry) {
    const last = state.undo[state.undo.length - 1];
    const now = Date.now();
    // During a drag keep only each property's first "before".
    if (state.dragStamp && entry.prop && state.undo.some((u) => u.stamp === state.dragStamp && u.key === entry.key && u.prop === entry.prop)) return;
    // A scrub is many edits of one property in a row: keep only its starting point.
    if (last && last.key === entry.key && last.prop && last.prop === entry.prop && now - last.at < 1000) {
      last.at = now;
      return;
    }
    state.undo.push({ ...entry, stamp: actionStamp(), at: now });
    if (state.undo.length > 200) state.undo.shift();
  }

  function undoPreview() {
    const top = state.undo[state.undo.length - 1];
    if (!top) return toast("Nothing to undo");
    while (state.undo.length && state.undo[state.undo.length - 1].stamp === top.stamp) {
      const entry = state.undo.pop();
      const { prop, before, prevText } = entry;
      // React may have remounted the node since; the tweak tracks the live one.
      const el = (state.tweaks.get(entry.key) || entry).el;
      const tweak = tweakFor(el);
      if (tweak.batchId) withdraw(tweak.batchId);
      if (entry.inserted) {
        const t = state.tweaks.get(entry.key);
        if (t) {
          revertTweak(t);
          if (state.selected === t.el) state.selected = null;
        }
        continue;
      } else if (entry.prop === undefined && entry.propsKey) {
        tweak.props = { ...(tweak.props || {}) };
        if (entry.before) tweak.props[entry.propsKey] = entry.before;
        else delete tweak.props[entry.propsKey];
      } else if (entry.move) {
        placeAt(el, entry.prevIndex);
        tweak.move = entry.before ? { ...entry.before, toIndex: entry.prevIndex } : null;
        syncMoves(el.parentElement);
        layoutMoves(el.parentElement);
      } else if (entry.removal) {
        tweak.removed = false;
        clearRemoved(tweak);
      } else if (prop) {
        if (before) {
          tweak.changes[prop] = before;
          applyChange(el, prop, before);
        } else {
          const gone = tweak.changes[prop];
          delete tweak.changes[prop];
          clearChange(el, prop, gone);
        }
      } else {
        el.textContent = prevText;
        tweak.text = before;
      }
      cleanup(tweak);
    }
    persist();
    render();
  }

  // A change is keyed by its property, plus ":state" while editing a hover/active/focus state.
  const changeKey = (prop) => (state.editState ? `${prop}:${state.editState}` : prop);
  const changeProp = (key, change) => (change && change.prop) || key;

  // "Everywhere": the change previews on every element its CSS rule styles, through a rule of our own.
  const reachRule = (el, change) => {
    const t = state.tweaks.get(elementKeys.get(el));
    const r = t && t.reach === "all" && change && !change.state && change.authoredIn && change.authoredIn[0];
    return r && (r.part || r.selector) ? r : null;
  };
  function updateReachSheet() {
    let sheet = document.getElementById("ui-tweaks-reach");
    if (!sheet) {
      sheet = document.createElement("style");
      sheet.id = "ui-tweaks-reach";
      document.head.append(sheet);
    }
    const css = [];
    if (!state.comparing) {
      for (const t of state.tweaks.values()) {
        if (t.reach !== "all") continue;
        for (const [k, c] of Object.entries(t.changes)) {
          const r = !c.state && c.to !== undefined && c.authoredIn && c.authoredIn[0];
          // Same selector (all of a list, as the edit changes the whole rule), same priority and media
          // conditions, later in the page: it wins exactly where editing that rule would.
          if (!r || !(r.selector || r.part)) continue;
          let rule = `${r.selector || r.part} { ${changeProp(k, c)}: ${c.to}${/!important$/.test(r.value || "") ? " !important" : ""}; }`;
          for (const cond of [...(r.conditions || [])].reverse()) if (!cond.startsWith("@layer")) rule = `@media ${cond} { ${rule} }`;
          css.push(rule);
        }
      }
    }
    if (sheet.textContent !== css.join("\n")) sheet.textContent = css.join("\n");
    if (css.length && sheet !== document.head.lastElementChild) document.head.append(sheet); // after the app's styles
  }

  function applyChange(el, key, change) {
    if (change.state) return updateStateSheet();
    const prop = changeProp(key, change);
    if (reachRule(el, change)) {
      restoreProp(el, prop, change);
      return updateReachSheet();
    }
    if (el.style.getPropertyValue(prop) !== change.to || el.style.getPropertyPriority(prop) !== "important") el.style.setProperty(prop, change.to, "important");
  }

  function clearChange(el, key, change) {
    if (change && change.state) return updateStateSheet();
    restoreProp(el, changeProp(key, change), change);
    updateReachSheet();
  }

  // Switches a tweak between this element and everywhere its rules apply, moving the preview over.
  function setReach(el, reach) {
    if (!state.tweaks.has(keyOf(el))) {
      state.pendingReach = reach === "all" ? keyOf(el) : null;
      return render();
    }
    const t = tweakFor(el);
    if (t.batchId) withdraw(t.batchId);
    for (const [k, c] of Object.entries(t.changes)) if (!c.state) restoreProp(el, changeProp(k, c), c);
    t.reach = reach === "all" ? "all" : undefined;
    for (const [k, c] of Object.entries(t.changes)) if (c.to !== undefined) applyChange(el, k, c);
    updateReachSheet();
    cleanup(t);
    persist();
    render();
  }

  // State previews: our state changes as real :hover/:active rules, plus copies of the page's own
  // state rules keyed to a force attribute, so the selected element can show a state while you edit it.
  let stateSheetText = "";
  function updateStateSheet() {
    const lines = [];
    const st = state.editState;
    if (st && state.selected) {
      for (const sheet of document.styleSheets) {
        if (sheet.ownerNode && sheet.ownerNode.id === STATE_SHEET_ID) continue;
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        const all = [];
        collectRules(rules, sheet, [], all);
        for (const { rule } of all) {
          if (!rule.selectorText.includes(`:${st}`)) continue;
          const parts = rule.selectorText.split(",").filter((p) => p.includes(`:${st}`)).map((p) => p.trim().split(`:${st}`).join(FORCE(st)));
          try {
            if (!parts.some((p) => state.selected.matches(p))) continue;
          } catch {
            continue;
          }
          lines.push(`${parts.join(", ")} { ${rule.style.cssText} }`);
        }
      }
    }
    for (const t of state.comparing ? [] : state.tweaks.values()) {
      const byState = {};
      for (const [key, c] of Object.entries(t.changes)) if (c.state && c.to !== undefined) (byState[c.state] ||= []).push(`${c.prop}: ${c.to} !important;`);
      if (!Object.keys(byState).length) continue;
      if (t.el.dataset.uiTweak !== t.key) t.el.dataset.uiTweak = t.key;
      for (const [s, decls] of Object.entries(byState)) {
        const sel = `[data-ui-tweak="${t.key}"]`;
        lines.push(`${sel}:${s}, ${sel}${FORCE(s)} { ${decls.join(" ")} }`);
      }
    }
    const text = lines.join("\n");
    if (text === stateSheetText) return;
    stateSheetText = text;
    let tag = document.getElementById(STATE_SHEET_ID);
    if (!tag) {
      tag = document.createElement("style");
      tag.id = STATE_SHEET_ID;
      document.head.appendChild(tag);
    }
    tag.textContent = text;
  }

  function setEditState(st) {
    if (state.selected) {
      if (st) state.selected.setAttribute("data-ui-tweak-force", st);
      else state.selected.removeAttribute("data-ui-tweak-force");
    }
    state.editState = st;
    updateStateSheet();
    render();
  }

  function setStyle(el, prop, value, quiet = false) {
    const key = changeKey(prop);
    if (value === (state.tweaks.get(keyOf(el))?.changes[key]?.to ?? computed(el, prop))) return; // nothing changes
    const tweak = tweakFor(el);
    recordUndo({ el, key: tweak.key, prop: key, before: tweak.changes[key] ? { ...tweak.changes[key] } : null });
    if (tweak.batchId) withdraw(tweak.batchId); // edited again after sending: take it back, it's a draft once more
    if (!(key in tweak.changes)) {
      tweak.changes[key] = {
        prop,
        state: state.editState || undefined,
        from: computed(el, prop),
        authoredIn: matchedRules(el, prop, state.editState),
        inlineBefore: state.editState ? undefined : el.style.getPropertyValue(prop) || undefined,
      };
    }
    const change = tweak.changes[key];
    if (value === "" || value === change.from) {
      delete tweak.changes[key];
      clearChange(el, key, change);
    } else {
      change.to = value;
      applyChange(el, key, change);
    }
    cleanup(tweak);
    persist();
    if (quiet) renderQuiet();
    else render();
  }

  function restoreProp(el, prop, change) {
    if (change && change.inlineBefore) el.style.setProperty(prop, change.inlineBefore);
    else el.style.removeProperty(prop);
  }

  function cleanup(tweak) {
    if (!Object.keys(tweak.changes).length && tweak.text === null && !tweak.note && !tweak.move && !tweak.removed && !tweak.insert && !(tweak.props && Object.keys(tweak.props).length)) state.tweaks.delete(tweak.key);
  }

  function revertTweak(tweak) {
    const changes = Object.entries(tweak.changes);
    state.tweaks.delete(tweak.key);
    for (const [key, change] of changes) clearChange(tweak.el, key, change);
    if (tweak.text) tweak.el.textContent = tweak.text.from;
    if (tweak.removed) clearRemoved(tweak);
    if (tweak.insert) tweak.el.remove();
    if (tweak.move && tweak.el.parentElement) {
      tweak.move = null;
      layoutMoves(tweak.el.parentElement);
      syncMoves(tweak.el.parentElement);
    }
  }

  function reapply(tweak) {
    for (const [key, change] of Object.entries(tweak.changes)) if (change.to !== undefined) applyChange(tweak.el, key, change);
    if (tweak.removed) applyRemoved(tweak);
    if (tweak.move && tweak.el.parentElement) layoutMoves(tweak.el.parentElement);
  }

  // ---------- structure: reorder and remove ----------
  // Moves stay among the element's own siblings, so React still owns every node where it expects it.
  const kids = (parent) => [...parent.children].filter((c) => c !== host);
  const childIndex = (el) => kids(el.parentElement).indexOf(el);
  function placeAt(el, index) {
    const parent = el.parentElement;
    if (!parent) return;
    const others = kids(parent).filter((c) => c !== el);
    const ref = others[index] || (others.length ? others[others.length - 1].nextSibling : null);
    if (ref !== el && el.nextSibling !== ref) parent.insertBefore(el, ref);
  }
  // Siblings it can trade places with: visible and in the flow.
  const flowSiblings = (el) => kids(el.parentElement).filter((c) => c === el || (c.getClientRects().length > 0 && !/^(absolute|fixed)$/.test(getComputedStyle(c).position) && !/^(script|style|template|link)$/i.test(c.tagName)));

  // The order the source has, per parent, captured before anything there moves (the DOM is still in source order then).
  const ORIGINAL = new WeakMap();
  const ordered = new Set(); // parents with a saved order
  const originalOrder = (parent) => {
    if (!ORIGINAL.has(parent)) {
      ORIGINAL.set(parent, kids(parent));
      ordered.add(parent);
    }
    return ORIGINAL.get(parent);
  };

  // React replaced a child of a parent we keep an order for: the new node takes the old one's place
  // in the saved order, and inherits its tweak. Matched by tag and class, else by tag when that's unambiguous.
  function adoptRemounts(all, adopt) {
    for (const p of [...ordered]) {
      if (!p.isConnected) {
        ordered.delete(p);
        continue;
      }
      const orig = ORIGINAL.get(p);
      const stale = orig.filter((n) => n.parentElement !== p);
      if (!stale.length) continue;
      const fresh = kids(p).filter((n) => !orig.includes(n));
      for (const old of stale) {
        let i = fresh.findIndex((f) => f.tagName === old.tagName && f.className === old.className);
        if (i === -1 && fresh.filter((f) => f.tagName === old.tagName).length === 1 && stale.filter((o) => o.tagName === old.tagName).length === 1) i = fresh.findIndex((f) => f.tagName === old.tagName);
        if (i === -1) continue;
        const [node] = fresh.splice(i, 1);
        orig[orig.indexOf(old)] = node;
        const t = all.find((x) => x.el === old);
        if (t) adopt(t, node);
      }
    }
  }
  const movedIn = (parent) => [...state.tweaks.values()].filter((t) => t.move && t.el.parentElement === parent);

  // Lays a parent out from the model: siblings nobody moved in source order, moved ones at their target index.
  // Touches the DOM only where it differs, so running it often is cheap.
  function layoutMoves(parent, { original = false } = {}) {
    if (!parent) return;
    plannedOrder(parent, original ? () => false : null).forEach((n, i) => {
      const cur = kids(parent);
      if (cur[i] !== n) parent.insertBefore(n, cur[i] || null);
    });
  }

  // The order layoutMoves would produce; `keep` picks which moves count (default: all).
  function plannedOrder(parent, keep) {
    const orig = originalOrder(parent);
    const now = kids(parent);
    const moved = movedIn(parent).filter((t) => !keep || keep(t)).sort((a, b) => a.move.toIndex - b.move.toIndex);
    const movedEls = new Set(moved.map((t) => t.el));
    const free = now.filter((n) => !movedEls.has(n));
    // Known siblings go back to source order; ones React added since keep their slots.
    const known = free.filter((n) => orig.includes(n)).sort((a, b) => orig.indexOf(a) - orig.indexOf(b));
    let k = 0;
    const order = free.map((n) => (orig.includes(n) ? known[k++] : n));
    for (const t of moved) order.splice(Math.min(t.move.toIndex, order.length), 0, t.el);
    return order;
  }

  // After the DOM changed: each moved sibling's target is where it is now.
  function syncMoves(parent) {
    for (const t of movedIn(parent)) t.move = { ...t.move, toIndex: childIndex(t.el) };
  }

  const brief = (n) => {
    const d = describe(n);
    return { tag: d.tag, classes: d.classes.slice(0, 3), text: d.text.slice(0, 40), jsxSource: d.react && d.react.jsxSource };
  };

  // What Haiku needs, from the DOM as it is now: the neighbour to sit next to, and the final order of all the siblings.
  function moveInfo(el, fromIndex) {
    const list = kids(el.parentElement);
    const i = list.indexOf(el);
    const where = i > 0 ? "after" : "before";
    const anchor = list[where === "after" ? i - 1 : i + 1];
    const info = describe(el), anchorInfo = anchor ? describe(anchor) : null;
    const sameList = !!(anchorInfo && info.react && anchorInfo.react && info.react.jsxSource && info.react.jsxSource === anchorInfo.react.jsxSource);
    const order = list.filter((n) => n.getClientRects().length > 0 || n === el).map((n) => ({ ...brief(n), self: n === el || undefined }));
    return { fromIndex, toIndex: i, where, anchor: anchorInfo, parent: describe(el.parentElement), order, sameList: sameList || undefined };
  }

  function moveElement(el, toIndex) {
    const parent = el.parentElement;
    const from = childIndex(el);
    toIndex = Math.max(0, Math.min(kids(parent).length - 1, toIndex));
    if (toIndex === from) return false;
    originalOrder(parent);
    const tweak = tweakFor(el);
    recordUndo({ el, key: tweak.key, move: true, before: tweak.move ? { ...tweak.move } : null, prevIndex: from });
    if (tweak.batchId) withdraw(tweak.batchId);
    const origin = tweak.move ? tweak.move.fromIndex : originalOrder(parent).indexOf(el);
    placeAt(el, toIndex);
    tweak.move = { fromIndex: origin, toIndex };
    syncMoves(parent);
    // Back where the source has it: the layout without this move is exactly what's on screen.
    const now = kids(parent);
    if (plannedOrder(parent, (t) => t !== tweak).every((n, i) => n === now[i])) tweak.move = null;
    layoutMoves(parent);
    syncMoves(parent);
    for (const t of movedIn(parent)) if (t.batchId) withdraw(t.batchId); // their neighbours changed
    cleanup(tweak);
    persist();
    render();
    return true;
  }

  // One step earlier or later among the visible siblings.
  function moveBy(el, step) {
    const flow = flowSiblings(el);
    const i = flow.indexOf(el);
    const target = flow[i + step];
    if (!target) return toast(step < 0 ? "Already first" : "Already last");
    moveElement(el, childIndex(target));
  }

  function applyRemoved(tweak) {
    const el = tweak.el;
    if (el.style.getPropertyValue("display") === "none" && el.style.getPropertyPriority("display") === "important") return;
    if (tweak.removedInline === undefined) tweak.removedInline = el.style.getPropertyValue("display") || "";
    el.style.setProperty("display", "none", "important");
  }
  function clearRemoved(tweak) {
    const own = tweak.changes.display;
    if (own && own.to !== undefined) return applyChange(tweak.el, "display", own);
    if (tweak.removedInline) tweak.el.style.setProperty("display", tweak.removedInline);
    else tweak.el.style.removeProperty("display");
    tweak.removedInline = undefined;
  }

  function removeElement(el) {
    if (!el || !el.parentElement || el === document.body) return;
    const tweak = tweakFor(el);
    if (tweak.removed) return;
    if (tweak.insert) {
      // Not in the source yet: removing it just drops the preview.
      const parent = el.parentElement;
      revertTweak(tweak);
      persist();
      return select(parent !== document.body ? parent : null);
    }
    const flow = flowSiblings(el);
    const next = flow[flow.indexOf(el) + 1] || flow[flow.indexOf(el) - 1] || el.parentElement;
    recordUndo({ el, key: tweak.key, removal: true });
    if (tweak.batchId) withdraw(tweak.batchId);
    tweak.removed = true;
    applyRemoved(tweak);
    persist();
    toast("Removed (⌘Z to undo). Claude deletes it from the source on Send.");
    select(next !== document.body ? next : null);
  }

  // ---------- inserting new elements ----------
  // A new element is a preview node of ours (React doesn't know it) until Haiku writes its JSX.
  // It remembers its parent and index, so it can be put back after a reload or a re-render.
  const BASICS = {
    frame: { label: "Frame", tag: "div", text: "", style: "display:flex;flex-direction:column;gap:8px;padding:16px;min-height:48px;border:1px dashed #0d99ff;border-radius:8px" },
    text: { label: "Text", tag: "p", text: "New text", style: "margin:0" },
    button: { label: "Button", tag: "button", text: "Button", style: "padding:10px 16px;border-radius:8px" },
    image: { label: "Image", tag: "div", text: "Image", style: "width:160px;height:100px;border-radius:8px;background:#d9d9d9;color:#666;display:grid;place-items:center;font:12px system-ui" },
  };
  let insertCounter = 0;

  function insertWhere(node) {
    const list = kids(node.parentElement);
    const i = list.indexOf(node);
    if (i > 0) return { where: "after", anchor: describe(list[i - 1]) };
    if (list[i + 1]) return { where: "before", anchor: describe(list[i + 1]) };
    return { where: "end", anchor: null };
  }

  // Places a new element as a preview and records it as a tweak. `spec` is { kind, ... } (see insertSpec).
  function insertNode(node, parent, index, spec) {
    node.dataset.uitInsert = String(++insertCounter);
    const others = kids(parent);
    parent.insertBefore(node, others[index] || (others.length ? others[others.length - 1].nextSibling : null));
    const tweak = tweakFor(node);
    tweak.insert = { ...spec, html: node.outerHTML, parentSelector: describe(parent).selector, index: childIndex(node) };
    recordUndo({ el: node, key: tweak.key, inserted: true });
    persist();
    select(node);
    return node;
  }

  function placeInsert(tweak) {
    const ins = tweak.insert;
    const parent = document.querySelector(ins.parentSelector);
    if (!parent) return false;
    const tpl = document.createElement("template");
    tpl.innerHTML = ins.html;
    const node = tpl.content.firstElementChild;
    if (!node) return false;
    const others = kids(parent);
    parent.insertBefore(node, others[ins.index] || (others.length ? others[others.length - 1].nextSibling : null));
    if (state.selected === tweak.el) state.selected = node;
    tweak.el = node;
    elementKeys.set(node, tweak.key);
    return true;
  }

  function duplicateElement(el) {
    if (!el || !el.parentElement || el === document.body) return;
    const copy = el.cloneNode(true);
    copy.removeAttribute("data-ui-tweak-force");
    insertNode(copy, el.parentElement, childIndex(el) + 1, { kind: "copy", of: describe(el) });
    toast("Duplicated (⌘Z to undo). Claude writes the copy into the source on Send.");
  }

  // The components on this page: each instance's root element, the name and where it's used.
  function pageComponents() {
    const found = new Map();
    for (const n of document.body.querySelectorAll("*")) {
      if (n === host || host.contains(n) || n.dataset.uitInsert) continue;
      const key = Object.keys(n).find((k) => k.startsWith("__reactFiber$"));
      if (!key) continue;
      const fiber = n[key];
      const owner = fiber.return;
      const type = owner && owner.type;
      if (!type || typeof type === "string" || owner.child !== fiber) continue; // only an instance's first element
      const name = type.displayName || type.name || (type.render && (type.render.displayName || type.render.name));
      if (!name || /^[a-z_]/.test(name)) continue;
      const usedAt = sourceOf(owner);
      const entry = found.get(name) || { name, usedAt, sample: n, count: 0 };
      entry.count++;
      found.set(name, entry);
      if (found.size > 60) break;
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Click-to-place: pick something in the Insert list, then click on the page where it goes.
  function armInsert(item) {
    state.placing = item;
    state.isPicking = true;
    toast(`Click where the ${item.label} goes (Shift: one level up). Esc cancels.`);
    render();
  }
  // Where a click would put it, as in Figma: over a container's empty space (its padding or the gaps
  // between children) it goes inside, between the children nearest the pointer; over an element it goes
  // before or after that element, in its parent.
  function dropTarget(t, x, y, beside = false) {
    if (!t || t === document.body || t === document.documentElement || t === host) return null;
    const shown = kids(t).filter((c) => c.getClientRects().length > 0);
    const overChild = shown.some((c) => {
      const r = c.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    const cs = getComputedStyle(t);
    const canHold = !/^(P|SPAN|A|BUTTON|LABEL|H[1-6]|IMG|SVG|INPUT|TEXTAREA|SELECT)$/i.test(t.tagName) && !/^inline/.test(cs.display);
    if (!beside && canHold && !overChild && (shown.length > 0 || /flex|grid|block/.test(cs.display))) {
      const row = cs.display.includes("flex") && cs.flexDirection.startsWith("row");
      let index = kids(t).length;
      for (const c of shown) {
        const r = c.getBoundingClientRect();
        if (row ? x < r.left + r.width / 2 : y < r.top + r.height / 2) {
          index = kids(t).indexOf(c);
          break;
        }
      }
      return { parent: t, index, row };
    }
    const parent = t.parentElement;
    if (!parent || parent === document.documentElement) return null;
    const r = t.getBoundingClientRect();
    const pcs = getComputedStyle(parent);
    const row = pcs.display.includes("flex") && pcs.flexDirection.startsWith("row");
    const after = row ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    return { parent, index: kids(parent).indexOf(t) + (after ? 1 : 0), row };
  }
  // Shift goes one level up: drop beside the hovered element's parent (between cards, say).
  // With Shift: the nearest ancestor that is one of a repeated set (cards in a list, rows in a menu),
  // so the new element goes between those; else simply the parent.
  function placingOver(t, e) {
    if (!e.shiftKey || !t) return t;
    const sig = (n) => n.tagName + "." + (n.classList[0] || "");
    for (let n = t; n && n.parentElement && n.parentElement !== document.body; n = n.parentElement) {
      const same = kids(n.parentElement).filter((c) => c !== n && sig(c) === sig(n) && c.getClientRects().length > 0);
      if (same.length) return n;
    }
    return t.parentElement && t.parentElement !== document.body ? t.parentElement : t;
  }
  function showDrop(target) {
    const line = $(".drop-line");
    if (!target) return line.classList.add("hidden");
    const list = kids(target.parent);
    const before = list[target.index], prev = list[target.index - 1];
    const pr = target.parent.getBoundingClientRect();
    if (target.row) {
      const x = before ? before.getBoundingClientRect().left - 2 : prev ? prev.getBoundingClientRect().right + 2 : pr.left + 4;
      place(line, { left: x - 1, top: pr.top + 2, width: 3, height: Math.max(12, pr.height - 4) });
    } else {
      const y = before ? before.getBoundingClientRect().top - 2 : prev ? prev.getBoundingClientRect().bottom + 2 : pr.top + 4;
      place(line, { left: pr.left + 2, top: y - 1, width: Math.max(12, pr.width - 4), height: 3 });
    }
  }
  function placeAt_(target) {
    const item = state.placing;
    state.placing = null;
    $(".drop-line").classList.add("hidden");
    if (!target || !item) return render();
    let node;
    if (item.component) {
      node = item.component.sample.cloneNode(true);
      insertNode(node, target.parent, target.index, { kind: "component", component: { name: item.component.name, usedAt: item.component.usedAt } });
    } else {
      const b = BASICS[item.basic];
      node = document.createElement(b.tag);
      node.textContent = b.text;
      node.setAttribute("style", b.style);
      insertNode(node, target.parent, target.index, { kind: "element", tag: b.tag, text: b.text, basic: item.basic, style: b.style });
    }
  }

  // React may remount nodes; find them again by selector and re-apply the preview.
  setInterval(() => document.hidden || !state.tweaks.size || time(stats.tick, recheck), 600);
  function recheck() {
    if (state.comparing) return;
    const all = [...state.tweaks.values()];
    const lost = all.filter((t) => !t.el.isConnected);
    const adopt = (tweak, again) => {
      if (!again || all.some((t) => t.el === again)) return;
      if (tweak.at && tweak.at !== here()) return; // made on another screen
      if (!sameSource(again, tweak.element.react && tweak.element.react.jsxSource)) return;
      if (state.selected === tweak.el) state.selected = again;
      tweak.el = again;
      elementKeys.set(again, tweak.key);
    };
    adoptRemounts(all, adopt);
    // Selectors count siblings in source order. Where a match sits among moved siblings,
    // look it up again with them put back for a moment.
    const parents = new Set(all.filter((t) => t.move && t.el.isConnected).map((t) => t.el.parentElement));
    const retry = [];
    for (const tweak of lost.filter((t) => t.insert && (!t.at || t.at === here()))) placeInsert(tweak);
    for (const tweak of lost.filter((t) => !t.el.isConnected && !t.insert)) {
      const again = document.querySelector(tweak.element.selector);
      if (!again) continue; // not on the page now: try again later, without touching anything
      if ([...parents].some((p) => p.contains(again))) retry.push(tweak);
      else adopt(tweak, again);
    }
    if (retry.length) {
      parents.forEach((p) => layoutMoves(p, { original: true }));
      const found = retry.map((t) => document.querySelector(t.element.selector));
      parents.forEach((p) => layoutMoves(p));
      retry.forEach((t, i) => adopt(t, found[i]));
    }
    for (const tweak of all) if (tweak.el.isConnected) reapply(tweak);
  }

  // In the studio, only the frame whose panel is docked edits; the others mirror its previews.
  function ownsPanel() {
    return !STUDIO || (panel.isConnected && panel.ownerDocument === STUDIO.document);
  }

  function resync() {
    for (const t of [...state.tweaks.values()]) {
      for (const [key, change] of Object.entries(t.changes)) clearChange(t.el, key, change);
      if (t.text) t.el.textContent = t.text.from;
      if (t.removed) clearRemoved(t);
      if (t.insert) t.el.remove();
      if (t.move && t.el.parentElement) layoutMoves(t.el.parentElement, { original: true });
    }
    state.tweaks.clear();
    restore();
  }
  addEventListener("storage", (e) => {
    if (e.key === STORE_KEY && STUDIO && !ownsPanel()) resync();
  });

  // ---------- before / after ----------
  // Hold \ (or the studio's Compare) to see the page as the source has it, without the previews.
  function compare(on) {
    if (!!state.comparing === on) return;
    state.comparing = on;
    for (const t of state.tweaks.values()) {
      for (const [key, change] of Object.entries(t.changes)) {
        if (on) clearChange(t.el, key, change);
        else if (change.to !== undefined) applyChange(t.el, key, change);
      }
      if (t.text) t.el.textContent = on ? t.text.from : t.text.to;
      if (t.removed) on ? clearRemoved(t) : applyRemoved(t);
      if (t.insert) t.el.hidden = on;
      if (t.move && t.el.parentElement) layoutMoves(t.el.parentElement, { original: on });
    }
    updateStateSheet();
    updateReachSheet();
    host.classList.toggle("comparing", on);
  }

  // ---------- copy / paste style ----------
  const COPY_PROPS = [
    "font-size", "font-weight", "line-height", "letter-spacing", "color", "text-align",
    "background-color", "background-image", "opacity", "box-shadow",
    ...GROUPS["border-radius"], ...GROUPS["border-width"], ...GROUPS["border-color"], ...GROUPS.padding,
  ];
  const CLIP_KEY = "ui-tweaks:style-clipboard";

  function copyStyle(el) {
    const t = state.tweaks.get(keyOf(el));
    const values = Object.fromEntries(COPY_PROPS.map((p) => [p, (t && t.changes[p] && t.changes[p].to) || computed(el, p)]));
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify({ from: describe(el).selector, values }));
    } catch {}
    toast("Style copied");
  }

  function pasteStyle(el) {
    let clip = null;
    try {
      clip = JSON.parse(localStorage.getItem(CLIP_KEY) || "null");
    } catch {}
    if (!clip) return toast("Copy a style first (⌘⌥C)");
    const t = state.tweaks.get(keyOf(el));
    let n = 0;
    for (const [prop, value] of Object.entries(clip.values)) {
      const current = (t && t.changes[prop] && t.changes[prop].to) || computed(el, prop);
      if (value !== current) {
        setStyle(el, prop, value, true);
        n++;
      }
    }
    render();
    toast(n ? `Pasted ${n} propert${n === 1 ? "y" : "ies"}` : "Already the same style");
  }

  function persist() {
    state.codePreview = null; // a dry run is stale once anything changes
    try {
      const drafts = [...state.tweaks.values()].map((t) => ({
        at: t.at,
        jsx: t.element.react && t.element.react.jsxSource,
        selector: t.element.selector,
        changes: t.changes,
        text: t.text,
        note: t.note,
        move: t.move || undefined,
        removed: t.removed || undefined,
        insert: t.insert || undefined,
        props: t.props && Object.keys(t.props).length ? t.props : undefined,
        component: t.component || undefined,
        reach: t.reach || undefined,
        scope: t.scope,
        batchId: t.batchId,
        sentId: t.sentId,
        skipped: t.skipped,
      }));
      // Drafts made on other screens stay as they are until you're back on that screen.
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      const mine = new Set(drafts.map((d) => d.at + "|" + d.selector));
      for (const t of state.tweaks.values()) if (t.at) heldScreens.add(t.at);
      heldScreens.add(here());
      const elsewhere = ((saved && saved.drafts) || []).filter((d) => d.at && !heldScreens.has(d.at) && !mine.has(d.at + "|" + d.selector));
      const pending = (state.restoring || []).filter((d) => !mine.has((d.at || here()) + "|" + d.selector));
      localStorage.setItem(STORE_KEY, JSON.stringify({ drafts: [...drafts, ...pending, ...elsewhere], note: state.note, sent: [...state.sentBatches] }));
    } catch {}
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!saved) return;
      state.note = saved.note || "";
      state.sentBatches = new Map(saved.sent || []);
      let waiting = (saved.drafts || []).filter((d) => (d.at || here()) === here());
      let tries = 0;
      const attempt = () => {
        waiting = waiting.filter((d) => {
          if (d.insert) {
            // A new element: rebuild its preview where it was put.
            const t = { key: "e" + ++keyCounter, insert: d.insert, el: null };
            if (!document.querySelector(d.insert.parentSelector)) return true;
            const tweak = { key: t.key, el: document.createElement("div"), at: d.at || here(), element: null, changes: d.changes || {}, text: d.text || null, note: d.note || "", batchId: d.batchId, sentId: d.sentId, skipped: d.skipped, insert: d.insert, props: d.props, component: d.component, reach: d.reach, scope: d.scope };
            state.tweaks.set(tweak.key, tweak);
            if (!placeInsert(tweak)) {
              state.tweaks.delete(tweak.key);
              return true;
            }
            tweak.element = describe(tweak.el);
            reapply(tweak);
            if (d.text && d.text.to !== undefined) tweak.el.textContent = d.text.to;
            return false;
          }
          const el = document.querySelector(d.selector);
          if (!el || !sameSource(el, d.jsx)) return true;
          const tweak = tweakFor(el);
          Object.assign(tweak, { at: d.at || here(), changes: d.changes, text: d.text, note: d.note, move: d.move || null, removed: !!d.removed, props: d.props, component: d.component, reach: d.reach, scope: d.scope, batchId: d.batchId, sentId: d.sentId, skipped: d.skipped });
          reapply(tweak);
          if (d.text && d.text.to !== undefined) el.textContent = d.text.to;
          return false;
        });
        // Drafts not matched yet are kept by persist() meanwhile, so an early save doesn't drop them.
        state.restoring = waiting;
        render();
        // The app may still be rendering: keep looking for a few seconds.
        if (waiting.length && ++tries < 20) setTimeout(attempt, 300);
        else state.restoring = waiting.length ? waiting : null;
      };
      attempt();
    } catch {}
  }

  // ---------- UI ----------
  const host = document.createElement("ui-tweaks-overlay");
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
  <style>
    :host { --bg:#1e1e1e; --bg2:#2c2c2c; --line:#3a3a3a; --text:#e6e6e6; --dim:#9a9a9a; --accent:#0d99ff; --accent2:#7b61ff; --ok:#14ae5c; }
    * { box-sizing: border-box; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .launch { position: fixed; right: 16px; bottom: 16px; pointer-events: auto; height: 36px; padding: 0 14px 0 10px; border-radius: 18px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 8px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
    .launch:hover { background: #262626; }
    .launch .dot { width: 18px; height: 18px; border-radius: 6px; background: conic-gradient(from 200deg, #f24e1e, #ff7262, #a259ff, #1abcfe, #0acf83, #f24e1e); }
    .launch .count { background: var(--accent); color: white; border-radius: 9px; padding: 1px 7px; font-size: 11px; }
    .hover-box, .sel-box, .pad, .mar { position: fixed; pointer-events: none; }
    .hover-box { outline: 1px solid var(--accent); background: rgba(13,153,255,.06); }
    .sel-box { outline: 2px solid var(--accent); }
    .pad { background: rgba(20,174,92,.18); }
    .mar { background: rgba(255,140,40,.16); }
    .tag { position: fixed; pointer-events: none; background: var(--accent); color: #fff; font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 3px; white-space: nowrap; }
    .panel { position: fixed; top: 12px; right: 12px; bottom: 12px; width: 272px; pointer-events: auto; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.45); display: flex; flex-direction: column; font-size: 11px; overflow: hidden; }
    .panel.left { right: auto; left: 12px; }
    .bar { display: flex; align-items: center; gap: 4px; padding: 8px; border-bottom: 1px solid var(--line); }
    .bar .title { font-weight: 600; font-size: 12px; margin-right: auto; padding-left: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .bar button { flex: none; white-space: nowrap; padding: 0 6px; }
    button.icon, button.btn { background: transparent; border: 1px solid transparent; color: var(--text); border-radius: 5px; cursor: pointer; font-size: 11px; height: 26px; padding: 0 8px; }
    button.icon:hover, button.btn:hover { background: var(--bg2); }
    button.icon.on { background: var(--accent); color: #fff; }
    button.btn.primary { background: var(--accent); color: #fff; font-weight: 600; }
    button.btn.primary:hover { background: #0b85de; }
    button.btn.primary:disabled { background: #3a3a3a; color: var(--dim); cursor: default; }
    button.btn.ghost { border-color: var(--line); }
    .scroll { flex: 1; overflow-y: auto; }
    .empty { padding: 28px 18px; color: var(--dim); line-height: 1.5; text-align: center; }
    .empty b { color: var(--text); }
    .sec { padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .sec h4 { margin: 0 0 8px; font-size: 11px; font-weight: 600; color: var(--text); display: flex; align-items: center; justify-content: space-between; }
    .el-name { font-weight: 600; font-size: 12px; word-break: break-all; }
    .el-meta { color: var(--dim); margin-top: 4px; line-height: 1.45; word-break: break-all; }
    .el-meta code { color: #c7a4ff; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; }
    .crumbs { display: flex; flex-wrap: wrap; gap: 2px; margin-top: 6px; }
    .crumbs button { background: var(--bg2); border: 0; color: var(--dim); border-radius: 3px; font-size: 10px; padding: 2px 5px; cursor: pointer; }
    .crumbs button:hover { color: var(--text); }
    .layers { margin-top: 8px; border: 1px solid var(--line); border-radius: 6px; padding: 3px; max-height: 220px; overflow-y: auto; }
    .layer-row { display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; background: transparent; border: 0; border-radius: 4px; color: var(--text); font-size: 11px; cursor: pointer; text-align: left; padding-right: 6px; }
    .layer-row:hover { background: var(--bg2); }
    .layer-row.on { background: rgba(13,153,255,.22); }
    .layer-icon { width: 14px; flex: none; text-align: center; color: var(--dim); font-size: 10px; }
    .layer-icon.k-gradient { color: #a6f24a; }
    .layer-icon.k-fill { color: #c7a4ff; }
    .layer-icon.k-media { color: #1abcfe; }
    .layer-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; max-width: 120px; }
    .layer-text { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
    .layer-dot { width: 6px; height: 6px; border-radius: 3px; background: var(--accent2); flex: none; margin-left: auto; }
    .layer-more { color: var(--dim); font-size: 10px; height: 20px; line-height: 20px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    .grid4 .field label { width: 14px; }
    .grid4 .field input { padding-right: 2px; text-align: center; }
    .field { display: flex; align-items: center; height: 28px; background: var(--bg2); border: 1px solid transparent; border-radius: 5px; min-width: 0; }
    .field:hover { border-color: var(--line); }
    .field:focus-within { border-color: var(--accent); }
    .field.changed { box-shadow: inset 2px 0 0 var(--accent2); }
    .field label { color: var(--dim); width: 24px; flex: none; text-align: center; cursor: ew-resize; user-select: none; font-size: 10px; }
    .field input, .field select { flex: 1; min-width: 0; height: 100%; background: transparent; border: 0; color: var(--text); font-size: 11px; outline: none; padding: 0 6px 0 0; }
    .field select { padding-left: 6px; appearance: none; cursor: pointer; }
    .field select option { background: var(--bg); }
    .swatch { width: 16px; height: 16px; margin: 0 6px; border-radius: 3px; border: 1px solid rgba(255,255,255,.15); flex: none; position: relative; overflow: hidden; background-image: linear-gradient(45deg,#555 25%,transparent 25%,transparent 75%,#555 75%), linear-gradient(45deg,#555 25%,transparent 25%,transparent 75%,#555 75%); background-size: 8px 8px; background-position: 0 0, 4px 4px; }
    .swatch i { position: absolute; inset: 0; }
    .swatch input { position: absolute; inset: -4px; opacity: 0; cursor: pointer; width: 30px; height: 30px; }
    .row { margin-top: 6px; }
    .layer { display: flex; align-items: center; gap: 6px; height: 30px; background: var(--bg2); border-radius: 5px; padding: 0 2px 0 8px; margin-bottom: 4px; }
    .layer.changed { box-shadow: inset 2px 0 0 var(--accent2); }
    .layer-name { width: 74px; flex: none; color: var(--dim); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stops { flex: 1; display: flex; flex-wrap: wrap; gap: 3px; min-width: 0; }
    .stops .swatch { margin: 0; width: 15px; height: 15px; }
    details summary { color: var(--dim); font-size: 10px; cursor: pointer; margin-top: 6px; }
    .lbl { color: var(--dim); font-size: 10px; margin: 8px 0 4px; }
    .lbl:first-child { margin-top: 0; }
    .seg { display: flex; background: var(--bg2); border-radius: 5px; padding: 2px; gap: 2px; }
    .seg button { flex: 1; height: 24px; background: transparent; border: 0; color: var(--dim); border-radius: 4px; cursor: pointer; font-size: 10.5px; }
    .seg button.on { background: #444; color: var(--text); }
    .bm { position: relative; border: 1px dashed #5a5a5a; border-radius: 6px; padding: 22px 34px; background: rgba(246, 178, 107, .07); }
    .bm.pad { border-style: solid; border-color: #4a4a4a; padding: 20px 34px; background: rgba(147, 196, 125, .09); }
    .bm-c { height: 22px; display: flex; align-items: center; justify-content: center; background: var(--bg2); border-radius: 3px; color: var(--dim); font-size: 10px; }
    .bm-tag { position: absolute; left: 6px; top: 4px; font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; pointer-events: none; }
    .bm input { position: absolute; width: 32px; height: 18px; background: transparent; border: 1px solid transparent; border-radius: 3px; color: var(--text); font-size: 10.5px; text-align: center; outline: none; padding: 0; }
    .bm input:hover { border-color: var(--line); }
    .bm input:focus { border-color: var(--accent); background: var(--bg); }
    .bm input.changed { color: var(--accent2); }
    .bm input.t { top: 2px; left: 50%; transform: translateX(-50%); }
    .bm input.b { bottom: 2px; left: 50%; transform: translateX(-50%); }
    .bm input.l { left: 1px; top: 50%; transform: translateY(-50%); }
    .bm input.r { right: 1px; top: 50%; transform: translateY(-50%); }
    .quick { display: flex; gap: 4px; margin-top: 6px; }
    .quick button { flex: 1; height: 24px; background: var(--bg2); border: 1px solid transparent; border-radius: 4px; color: var(--text); font-size: 10.5px; cursor: pointer; padding: 0; }
    .quick button:hover { border-color: var(--line); }
    .cb-note { color: var(--dim); font-size: 10px; margin-top: 6px; line-height: 1.4; word-break: break-all; }
    textarea { width: 100%; min-height: 54px; resize: vertical; background: var(--bg2); border: 1px solid transparent; border-radius: 5px; color: var(--text); font-size: 11px; padding: 6px 8px; outline: none; }
    textarea:focus { border-color: var(--accent); }
    .changes { padding: 10px 12px; border-top: 1px solid var(--line); max-height: 34%; overflow-y: auto; }
    .change { display: flex; align-items: flex-start; gap: 6px; padding: 5px 0; border-bottom: 1px dashed #333; }
    .change:last-child { border-bottom: 0; }
    .change .what { flex: 1; min-width: 0; cursor: pointer; }
    .change .what b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .change .what span { color: var(--dim); display: block; line-height: 1.4; word-break: break-word; }
    .warn { margin: 0; padding: 8px 12px; background: #3a2a10; color: #ffc46b; font-size: 10.5px; line-height: 1.45; white-space: pre-line; border-bottom: 1px solid var(--line); }
    .token-toggle { height: 22px; padding: 0 6px; color: var(--dim); }
    .token-list { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; max-height: 120px; overflow-y: auto; }
    .token { display: flex; align-items: center; gap: 4px; background: var(--bg2); border: 0; border-radius: 4px; color: var(--text); font-size: 10px; padding: 3px 6px; cursor: pointer; }
    .token:hover { background: #3a3a3a; }
    .token i { width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(255,255,255,.2); }
    .code-preview { margin: 4px 0 8px; }
    .code-preview .diff-file { margin-top: 6px; }
    .code-preview .diff-name { font-weight: 600; font-size: 10.5px; color: var(--text); }
    .code-preview pre { margin: 2px 0 0; padding: 6px 8px; background: #141414; border-radius: 4px; font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dim); overflow-x: auto; max-height: 180px; overflow-y: auto; white-space: pre; }
    .code-preview .add { color: #7ee2a8; }
    .code-preview .del { color: #ff9b8f; }
    .code-preview .hunk { color: #8fb4ff; }
    .pill.warn { background: #5a3a12; color: #ffc46b; }
    .pill { font-size: 9.5px; padding: 1px 5px; border-radius: 3px; background: #3d2f66; color: #c7b8ff; margin-left: 4px; font-weight: 600; }
    .foot { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--line); }
    .foot .btn.primary { flex: 1; }
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--bg); color: var(--text); border: 1px solid var(--line); padding: 8px 14px; border-radius: 8px; font-size: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: none; transition: opacity .2s; }
    .measure { position: fixed; pointer-events: none; background: #f24822; }
    .measure-label { position: fixed; pointer-events: none; background: #f24822; color: #fff; font-size: 10px; font-weight: 600; padding: 1px 4px; border-radius: 3px; }
    .hover-box.measuring { outline-color: #f24822; background: rgba(242,72,34,.06); }
    :host(.comparing) .sel-box, :host(.comparing) .pad, :host(.comparing) .mar { opacity: .25; }
    .contrast { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 10.5px; color: var(--dim); }
    .contrast b { color: var(--text); font-weight: 600; }
    .contrast .ok { color: #14ae5c; }
    .contrast .no { color: #f24822; }
    .sec h4 { cursor: pointer; user-select: none; }
    .sec h4 .caret { color: var(--dim); font-size: 9px; width: 10px; display: inline-block; }
    .sec h4 .h-title { margin-right: auto; }
    .sec.collapsed > :not(h4) { display: none !important; }
    .sec.collapsed h4 { margin-bottom: 0; }
    .h-btn { background: transparent; border: 0; color: var(--dim); font-size: 10.5px; cursor: pointer; padding: 1px 4px; border-radius: 3px; }
    .h-btn:hover { color: var(--text); background: var(--bg2); }
    .align-row { display: flex; gap: 8px; align-items: stretch; }
    .pad9 { display: grid; grid-template-columns: repeat(3, 18px); grid-template-rows: repeat(3, 18px); gap: 2px; padding: 4px; background: var(--bg2); border-radius: 5px; flex: none; }
    .pad9 button { border: 0; background: transparent; border-radius: 3px; cursor: pointer; display: grid; place-items: center; padding: 0; }
    .pad9 button::after { content: ""; width: 4px; height: 4px; border-radius: 2px; background: #666; }
    .pad9 button:hover { background: #3a3a3a; }
    .pad9 button.on::after { width: 10px; height: 10px; border-radius: 2px; background: var(--accent); }
    .align-side { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .size-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; }
    .size-row > div { min-width: 0; }
    .size-row .seg button { font-size: 10px; padding: 0; min-width: 0; overflow: hidden; }
    .seg { min-width: 0; }
    .scroll { overflow-x: hidden; }
    .arrange { display: flex; gap: 2px; margin-top: 6px; }
    .arrange button { flex: 1; background: var(--bg2); border: 0; color: var(--text); border-radius: 3px; font-size: 10px; height: 22px; cursor: pointer; padding: 0 2px; }
    .arrange button:hover { background: #3a3a3a; }
    .arrange button.danger:hover { background: #5a1f1f; color: #ffb4a8; }
    .layer-row.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
    .layer-row.drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
    .layer-row.dragging { opacity: .4; }
    .ask-box textarea { min-height: 44px; }
    .ask-actions { display: flex; gap: 4px; margin-top: 6px; }
    .ask-actions button { flex: 1; height: 26px; border-radius: 5px; border: 1px solid var(--line); background: var(--bg2); color: var(--text); cursor: pointer; font-size: 11px; }
    .ask-actions button.go { background: var(--accent2); border-color: transparent; color: #fff; font-weight: 600; }
    .ask-actions button:disabled { opacity: .45; cursor: default; }
    .ask-item { margin-top: 8px; padding: 7px 8px; border-radius: 6px; background: var(--bg2); }
    .ask-top { display: flex; gap: 6px; align-items: flex-start; }
    .ask-what { flex: 1; min-width: 0; line-height: 1.35; word-break: break-word; }
    .ask-state { font-size: 9.5px; padding: 1px 6px; border-radius: 8px; background: #3a3a3a; color: var(--dim); white-space: nowrap; }
    .ask-state.running { background: #3d2f66; color: #c7b8ff; }
    .ask-state.done { background: #163d2a; color: #6fe0a0; }
    .ask-state.failed { background: #4a2a12; color: #ffc46b; }
    .ask-x { background: transparent; border: 0; color: var(--dim); cursor: pointer; padding: 0 2px; font-size: 11px; }
    .ask-sub { color: var(--dim); font-size: 10.5px; margin-top: 4px; line-height: 1.4; word-break: break-word; }
    .variant { display: flex; gap: 6px; align-items: center; margin-top: 5px; padding: 5px 6px; border-radius: 5px; border: 1px solid var(--line); cursor: pointer; }
    .variant:hover, .variant.on { border-color: var(--accent2); background: rgba(123,97,255,.12); }
    .variant .v-text { flex: 1; min-width: 0; }
    .variant .v-text b { display: block; font-size: 11px; }
    .variant .v-text span { color: var(--dim); font-size: 10px; }
    .variant button { height: 22px; padding: 0 8px; border-radius: 4px; border: 0; background: var(--accent2); color: #fff; cursor: pointer; font-size: 10.5px; }
    .ins-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    .ins-grid button, .ins-list button { background: var(--bg2); border: 1px solid transparent; border-radius: 5px; color: var(--text); cursor: pointer; font-size: 10.5px; height: 30px; }
    .ins-grid button:hover, .ins-list button:hover, .ins-list button.on, .ins-grid button.on { border-color: var(--accent); }
    .ins-list { display: flex; flex-direction: column; gap: 3px; max-height: 200px; overflow-y: auto; }
    .ins-list button { display: flex; justify-content: space-between; align-items: center; padding: 0 8px; text-align: left; height: 26px; }
    .ins-list button span { color: var(--dim); font-size: 10px; }
    .prop-row { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 6px; align-items: center; margin-top: 4px; }
    .prop-row > span { color: var(--dim); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .prop-row input { width: 100%; height: 26px; background: var(--bg2); border: 1px solid transparent; border-radius: 5px; color: var(--text); font-size: 11px; padding: 0 6px; outline: none; }
    .prop-row input:focus { border-color: var(--accent); }
    .prop-row.changed > span { color: var(--accent2); }
    .handle { position: fixed; width: 8px; height: 8px; margin: -4px 0 0 -4px; background: #fff; border: 1px solid var(--accent); border-radius: 1px; pointer-events: auto; z-index: 1; }
    .handle[data-dir=n], .handle[data-dir=s] { cursor: ns-resize; }
    .handle[data-dir=e], .handle[data-dir=w] { cursor: ew-resize; }
    .handle[data-dir=nw], .handle[data-dir=se] { cursor: nwse-resize; }
    .handle[data-dir=ne], .handle[data-dir=sw] { cursor: nesw-resize; }
    .drag-ghost { position: fixed; pointer-events: none; outline: 1px dashed var(--accent); background: rgba(13,153,255,.12); }
    .drop-line { position: fixed; pointer-events: none; background: var(--accent); border-radius: 2px; box-shadow: 0 0 0 1px #fff; }
    .guide { position: fixed; pointer-events: none; background: #f24822; }
    .drag-tip { position: fixed; pointer-events: none; background: #111; color: #fff; font-size: 10px; padding: 2px 6px; border-radius: 3px; white-space: nowrap; }
    .hidden { display: none !important; }
  </style>
  <div class="hover-box hidden"></div>
  <div class="mar m-t hidden"></div><div class="mar m-r hidden"></div><div class="mar m-b hidden"></div><div class="mar m-l hidden"></div>
  <div class="pad p-t hidden"></div><div class="pad p-r hidden"></div><div class="pad p-b hidden"></div><div class="pad p-l hidden"></div>
  <div class="sel-box hidden"></div>
  <div class="tag hidden"></div>
  <div class="drag-ghost hidden"></div><div class="drop-line hidden"></div><div class="guide gv hidden"></div><div class="guide gh hidden"></div><div class="drag-tip hidden"></div>
  ${["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((d) => `<div class="handle hidden" data-dir="${d}"></div>`).join("")}
  <div class="measure hidden"></div><div class="measure hidden"></div><div class="measure hidden"></div><div class="measure hidden"></div>
  <div class="measure-label hidden"></div><div class="measure-label hidden"></div><div class="measure-label hidden"></div><div class="measure-label hidden"></div>
  <button class="launch" title="UI Tweaks (Alt+T)"><span class="dot"></span><span class="label">Tweak</span><span class="count hidden"></span></button>
  <div class="panel hidden"></div>
  <div class="toast hidden"></div>`;

  // The overlay's own elements never change: look each one up once.
  const found$ = new Map();
  const $ = (sel) => {
    let n = found$.get(sel);
    if (!n || !n.isConnected) found$.set(sel, (n = shadow.querySelector(sel)));
    return n;
  };
  const panel = $(".panel");
  const launch = $(".launch");

  function toast(text) {
    const t = $(".toast");
    t.textContent = text;
    t.classList.remove("hidden");
    t.style.opacity = "1";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.classList.add("hidden"), 200);
    }, 2600);
  }

  function place(node, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return node.classList.add("hidden");
    node.classList.remove("hidden");
    Object.assign(node.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
  }

  // Figma-style measurements: with Alt held, red lines and distances from the selection to the hovered element.
  function drawMeasures() {
    const lines = [...shadow.querySelectorAll(".measure")];
    const labels = [...shadow.querySelectorAll(".measure-label")];
    lines.concat(labels).forEach((n) => n.classList.add("hidden"));
    const a = state.selected, b = state.hovered;
    if (!state.measuring || !a || !b || a === b || !a.isConnected || !b.isConnected || !ownsPanel()) return false;
    const r = a.getBoundingClientRect(), o = b.getBoundingClientRect();
    const segments = []; // { x1, y1, x2, y2, value }
    const inside = (p, q) => p.left >= q.left && p.right <= q.right && p.top >= q.top && p.bottom <= q.bottom;
    if (inside(r, o) || inside(o, r)) {
      // One holds the other: the four distances between their edges.
      const [inner, outer] = inside(r, o) ? [r, o] : [o, r];
      const cx = inner.left + inner.width / 2, cy = inner.top + inner.height / 2;
      segments.push({ x1: cx, y1: outer.top, x2: cx, y2: inner.top }, { x1: cx, y1: inner.bottom, x2: cx, y2: outer.bottom });
      segments.push({ x1: outer.left, y1: cy, x2: inner.left, y2: cy }, { x1: inner.right, y1: cy, x2: outer.right, y2: cy });
    } else {
      // Side by side: the gaps between them, drawn where they overlap (or from the selection's middle).
      const midY = Math.max(r.top, o.top) < Math.min(r.bottom, o.bottom) ? (Math.max(r.top, o.top) + Math.min(r.bottom, o.bottom)) / 2 : r.top + r.height / 2;
      const midX = Math.max(r.left, o.left) < Math.min(r.right, o.right) ? (Math.max(r.left, o.left) + Math.min(r.right, o.right)) / 2 : r.left + r.width / 2;
      if (o.left >= r.right) segments.push({ x1: r.right, y1: midY, x2: o.left, y2: midY });
      if (o.right <= r.left) segments.push({ x1: o.right, y1: midY, x2: r.left, y2: midY });
      if (o.top >= r.bottom) segments.push({ x1: midX, y1: r.bottom, x2: midX, y2: o.top });
      if (o.bottom <= r.top) segments.push({ x1: midX, y1: o.bottom, x2: midX, y2: r.top });
    }
    segments.slice(0, 4).forEach((g, i) => {
      const length = Math.abs(g.x2 - g.x1) + Math.abs(g.y2 - g.y1);
      if (length < 0.5) return;
      const isVertical = g.x1 === g.x2;
      place(lines[i], isVertical
        ? { left: g.x1, top: Math.min(g.y1, g.y2), width: 1, height: Math.abs(g.y2 - g.y1) }
        : { left: Math.min(g.x1, g.x2), top: g.y1, width: Math.abs(g.x2 - g.x1), height: 1 });
      labels[i].classList.remove("hidden");
      labels[i].textContent = shortNumber(length);
      Object.assign(labels[i].style, {
        left: (isVertical ? g.x1 + 4 : (g.x1 + g.x2) / 2 - 12) + "px",
        top: (isVertical ? (g.y1 + g.y2) / 2 - 8 : g.y1 + 4) + "px",
      });
    });
    return true;
  }

  function drawBoxes() {
    const isMeasuring = drawMeasures();
    const hoverBox = $(".hover-box");
    hoverBox.classList.toggle("measuring", isMeasuring);
    if (state.isOpen && (state.isPicking || isMeasuring) && state.hovered && state.hovered !== state.selected) place(hoverBox, state.hovered.getBoundingClientRect());
    else hoverBox.classList.add("hidden");

    const el = state.isOpen && ownsPanel() ? state.selected : null;
    const sel = $(".sel-box");
    const tag = $(".tag");
    const sides = ["t", "r", "b", "l"];
    if (!el || !el.isConnected) {
      sel.classList.add("hidden");
      tag.classList.add("hidden");
      sides.forEach((s) => { $(".p-" + s).classList.add("hidden"); $(".m-" + s).classList.add("hidden"); });
      drawHandles(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    place(sel, r);
    drawHandles(state.isPicking && !state.comparing && !(drag && drag.kind === "reorder") && r.width + r.height > 0 ? r : null);
    const [pt, pr, pb, pl] = ["padding-top", "padding-right", "padding-bottom", "padding-left"].map(n);
    const [mt, mr, mb, ml] = ["margin-top", "margin-right", "margin-bottom", "margin-left"].map(n);
    place($(".p-t"), { left: r.left, top: r.top, width: r.width, height: pt });
    place($(".p-b"), { left: r.left, top: r.bottom - pb, width: r.width, height: pb });
    place($(".p-l"), { left: r.left, top: r.top + pt, width: pl, height: r.height - pt - pb });
    place($(".p-r"), { left: r.right - pr, top: r.top + pt, width: pr, height: r.height - pt - pb });
    place($(".m-t"), { left: r.left, top: r.top - mt, width: r.width, height: mt });
    place($(".m-b"), { left: r.left, top: r.bottom, width: r.width, height: mb });
    place($(".m-l"), { left: r.left - ml, top: r.top, width: ml, height: r.height });
    place($(".m-r"), { left: r.right, top: r.top, width: mr, height: r.height });
    tag.classList.remove("hidden");
    tag.textContent = `${shortNumber(r.width)} × ${shortNumber(r.height)}`;
    const tagTop = r.bottom + 6 + 18 < innerHeight ? r.bottom + 6 : r.top - 24;
    Object.assign(tag.style, { left: Math.max(4, r.left + r.width / 2 - 30) + "px", top: tagTop + "px" });

    // Keep the panel off the selected element when possible.
    if (state.popup) return;
    const panelOnRight = !panel.classList.contains("left");
    if (panelOnRight && r.right > innerWidth - 290 && r.left > 300) panel.classList.add("left");
    else if (!panelOnRight && r.left < 290 && r.right < innerWidth - 300) panel.classList.remove("left");
  }

  // Timings for __uiTweaks.stats(): the per-frame drawing and the 600 ms re-check.
  const stats = { draw: { n: 0, total: 0, max: 0 }, tick: { n: 0, total: 0, max: 0 } };
  const time = (bucket, fn) => {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    bucket.n++;
    bucket.total += ms;
    if (ms > bucket.max) bucket.max = ms;
  };
  // Draws while the panel is open (or measuring); closed, it clears once and then does nothing.
  let drawnIdle = false;
  requestAnimationFrame(function loop() {
    // In the studio only the screen holding the panel, or under the pointer, has anything to draw.
    const active = (state.isOpen || state.measuring) && !document.hidden && (!STUDIO || ownsPanel() || !!state.hovered);
    if (active || !drawnIdle) time(stats.draw, drawBoxes);
    drawnIdle = !active;
    requestAnimationFrame(loop);
  });

  // ---------- controls ----------
  function numberField(el, prop, label, opts = {}) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const tweak = state.tweaks.get(keyOf(el));
    if (tweak && tweak.changes[changeKey(prop)]) wrap.classList.add("changed");
    const lab = document.createElement("label");
    lab.textContent = label;
    lab.title = prop;
    const input = document.createElement("input");
    const raw = computed(el, prop);
    const display = () => {
      const v = computed(el, prop);
      if (prop === "line-height" && v !== "normal") {
        const fs = parseFloat(computed(el, "font-size"));
        return shortNumber(parseFloat(v) / fs);
      }
      const p = parseNumber(v);
      return p && p.unit === "px" ? shortNumber(p.n) : v;
    };
    input.value = display();
    input.spellcheck = false;
    const commit = (val) => {
      setStyle(el, prop, normalizeLength(val, prop));
      input.value = display();
    };
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const p = parseNumber(input.value) || { n: 0, unit: "" };
        const step = (opts.step || 1) * (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
        commit(shortNumber(p.n + step) + (p.unit && p.unit !== "px" ? p.unit : ""));
      }
      e.stopPropagation();
    });
    // Figma-style scrubbing: drag the label left/right.
    lab.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const start = parseNumber(input.value) || { n: 0, unit: "" };
      const x0 = e.clientX;
      lab.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const step = (opts.step || 1) * (ev.shiftKey ? 10 : 1);
        let next = start.n + Math.round((ev.clientX - x0) / 2) * step;
        if (opts.min !== undefined) next = Math.max(opts.min, next);
        const val = shortNumber(next) + (start.unit && start.unit !== "px" ? start.unit : "");
        input.value = val;
        setStyle(el, prop, normalizeLength(val, prop), true);
      };
      const up = () => {
        lab.removeEventListener("pointermove", move);
        lab.removeEventListener("pointerup", up);
        renderPanel();
      };
      lab.addEventListener("pointermove", move);
      lab.addEventListener("pointerup", up);
    });
    input.title = `${prop}: ${raw}`;
    wrap.append(lab, input);
    const lengths = designTokens().lengths;
    if (lengths.length && PX_PROPS.has(prop)) {
      // Design tokens as suggestions: pick one to use the variable instead of a raw number.
      const list = document.createElement("datalist");
      list.id = `uit-len-${prop}`;
      for (const t of lengths) {
        const o = document.createElement("option");
        o.value = `var(${t.name})`;
        o.label = t.value;
        list.append(o);
      }
      input.setAttribute("list", list.id);
      input.addEventListener("input", (e) => {
        if (!e.inputType || e.inputType === "insertReplacementText") commit(input.value);
      });
      wrap.append(list);
    }
    return wrap;
  }

  // CSS variables declared on :root / html, split into colors and lengths.
  let tokenCache = null, tokenCacheKey = "";
  // Tokens declared anywhere (:root, a theme class, a component), with the values they have at `el`:
  // themes often set them on an app wrapper rather than :root.
  let tokenNames = null, tokenNamesKey = "";
  function designTokens(el = state.selected && state.selected.isConnected ? state.selected : document.documentElement) {
    const cacheKey = [...document.styleSheets].map((s) => (s.ownerNode && s.ownerNode.dataset && s.ownerNode.dataset.viteDevId) || s.href || "").join("|") + document.styleSheets.length;
    if (tokenCache && cacheKey === tokenCacheKey && tokenCache.el === el) return tokenCache;
    if (tokenNames && tokenNamesKey === cacheKey) return resolveTokens(el, cacheKey);
    const names = new Set();
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && sheet.ownerNode.id === STATE_SHEET_ID) continue;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const all = [];
      collectRules(rules, sheet, [], all);
      for (const { rule } of all) for (let i = 0; i < rule.style.length; i++) if (rule.style[i].startsWith("--")) names.add(rule.style[i]);
    }
    tokenNames = names;
    tokenNamesKey = cacheKey;
    return resolveTokens(el, cacheKey);
  }
  function resolveTokens(el, cacheKey) {
    const names = tokenNames;
    const root = getComputedStyle(el);
    const colors = [], lengths = [];
    for (const name of names) {
      const value = root.getPropertyValue(name).trim();
      if (!value) continue;
      if (/^-?[\d.]+(px|rem|em)$/.test(value)) lengths.push({ name, value });
      else if (!/^(inherit|initial|unset|currentcolor|none)$/i.test(value) && CSS.supports("color", value)) colors.push({ name, value });
    }
    tokenCache = { el, colors: colors.slice(0, 80), lengths: lengths.slice(0, 80) };
    tokenCacheKey = cacheKey;
    return tokenCache;
  }

  // ---------- contrast ----------
  function luminance({ r, g, b }) {
    const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  /** The colors behind an element's text: one solid color, or a gradient's stops (worst case wins). */
  function backdrops(el) {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/gradient\(/.test(cs.backgroundImage)) {
        const gradients = splitTopLevel(cs.backgroundImage).filter((l) => /gradient\(/.test(l));
        const stops = (gradients[gradients.length - 1].match(COLOR_TOKEN) || []).map(rgbaOf).filter((c) => c.a > 0.5);
        if (stops.length) return { colors: stops.map((c) => layers.reduceRight((acc, l) => over(l, acc), { ...c, a: 1 })), isGradient: true };
      } else if (cs.backgroundImage !== "none") {
        return { colors: [], isImage: true };
      }
      const c = rgbaOf(cs.backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 1) break;
    }
    const base = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
    return { colors: [layers.reduceRight((acc, l) => over(l, acc), base)] };
  }

  function contrastRow(el) {
    const row = document.createElement("div");
    row.className = "contrast";
    const { colors, isImage, isGradient } = backdrops(el);
    if (isImage || !colors.length) {
      row.textContent = "Contrast: can't measure over an image";
      return row;
    }
    const fg = rgbaOf(computed(el, "color"));
    const value = Math.min(...colors.map((bg) => ratio(fg.a < 1 ? over(fg, bg) : { ...fg, a: 1 }, bg)));
    const size = parseFloat(computed(el, "font-size"));
    const isLarge = size >= 24 || (size >= 18.66 && parseInt(computed(el, "font-weight"), 10) >= 700);
    const aa = value >= (isLarge ? 3 : 4.5), aaa = value >= (isLarge ? 4.5 : 7);
    row.innerHTML = `Contrast <b>${value.toFixed(2)}:1</b>${isGradient ? " (lowest over the gradient)" : ""}
      <span class="${aa ? "ok" : "no"}">AA ${aa ? "✓" : "✗"}</span><span class="${aaa ? "ok" : "no"}">AAA ${aaa ? "✓" : "✗"}</span>`;
    row.title = isLarge ? "Large text: AA needs 3:1, AAA 4.5:1" : "Body text: AA needs 4.5:1, AAA 7:1";
    return row;
  }

  // Touch targets: controls smaller than 44x44 CSS px are hard to hit on a phone (Apple's guideline; WCAG 2.2 asks for 24 at least).
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"], [onclick]';
  function tapTargetRow(el) {
    if (!el.matches(INTERACTIVE)) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const w = Math.round(r.width), h = Math.round(r.height);
    const ok = w >= 44 && h >= 44;
    const row = document.createElement("div");
    row.className = "contrast";
    row.innerHTML = `Tap target <b>${w}×${h}</b> <span class="${ok ? "ok" : "no"}">44×44 ${ok ? "✓" : "✗"}</span>`;
    row.title = ok ? "Big enough to hit comfortably on a phone" : "Under 44×44 CSS px: hard to hit on a phone. Grow it, or pad it (padding counts, the visible shape needn't change)";
    return row;
  }

  // Changes that cannot show, with why: the panel warns as you edit, and Claude gets them too.
  function opaqueGradient(image) {
    const layers = splitTopLevel(image).filter((l) => /gradient\(/.test(l));
    const last = layers[layers.length - 1];
    const colors = (last && last.match(COLOR_TOKEN)) || [];
    return colors.length > 0 && colors.every((c) => rgbaOf(c).a >= 0.99);
  }

  function hiddenReasons(t) {
    const out = [];
    const cs = getComputedStyle(t.el);
    const parentDisplay = t.el.parentElement ? getComputedStyle(t.el.parentElement).display : "";
    for (const [key, c] of Object.entries(t.changes)) {
      if (c.state) continue;
      const p = changeProp(key, c);
      let text = null;
      if (cs.display === "inline" && /^(width|height|min-width|max-width|min-height|max-height|margin-top|margin-bottom)$/.test(p)) {
        text = `${p} has no effect on an inline element (display: inline)`;
      } else if (/^(row-gap|column-gap|gap|justify-content|align-items|flex-direction)$/.test(p) && !/flex|grid/.test(cs.display)) {
        text = `${p} has no effect: this element is not a flex or grid container`;
      } else if (/^(top|right|bottom|left)$/.test(p) && cs.position === "static") {
        text = `${p} has no effect while position is static`;
      } else if (p === "z-index" && cs.position === "static" && !/flex|grid/.test(parentDisplay)) {
        text = "z-index has no effect while position is static";
      } else if (p === "background-color" && opaqueGradient(cs.backgroundImage)) {
        text = "background-color is hidden under the gradient fill; edit the gradient layers instead";
      }
      if (text) out.push({ prop: p, text });
    }
    return out;
  }

  function colorField(el, prop) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const tweak = state.tweaks.get(keyOf(el));
    if (tweak && tweak.changes[changeKey(prop)]) wrap.classList.add("changed");
    const value = computed(el, prop);
    const sw = document.createElement("span");
    sw.className = "swatch";
    const fill = document.createElement("i");
    fill.style.background = value;
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = toHex(value);
    const text = document.createElement("input");
    text.value = prettyColor(value);
    text.spellcheck = false;
    text.title = `${prop}: ${value}`;
    picker.addEventListener("input", () => {
      const a = alphaOf(computed(el, prop));
      const hex = picker.value;
      const v = a < 1 && a > 0 ? parseColorInput(`${hex} ${Math.round(a * 100)}%`) : hex;
      setStyle(el, prop, v, true);
      fill.style.background = v;
      text.value = prettyColor(computed(el, prop));
    });
    picker.addEventListener("change", () => renderPanel());
    text.addEventListener("change", () => {
      setStyle(el, prop, parseColorInput(text.value));
      renderPanel();
    });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter") text.blur();
      e.stopPropagation();
    });
    sw.append(fill, picker);
    wrap.append(sw, text);
    const colors = designTokens().colors;
    if (!colors.length) return wrap;
    const box = document.createElement("div");
    const toggle = document.createElement("button");
    toggle.className = "icon token-toggle";
    toggle.textContent = "◇";
    toggle.title = "Use a color token";
    const list = document.createElement("div");
    list.className = "token-list hidden";
    for (const t of colors) {
      const b = document.createElement("button");
      b.className = "token";
      b.title = `var(${t.name}) · ${t.value}`;
      const chip = document.createElement("i");
      chip.style.background = t.value;
      const name = document.createElement("span");
      name.textContent = t.name.replace(/^--/, "");
      b.append(chip, name);
      b.addEventListener("click", () => setStyle(el, prop, `var(${t.name})`));
      list.append(b);
    }
    toggle.addEventListener("click", () => list.classList.toggle("hidden"));
    const current = state.tweaks.get(keyOf(el))?.changes[changeKey(prop)]?.to;
    if (current && current.startsWith("var(")) text.value = current;
    wrap.append(toggle);
    box.append(wrap, list);
    return box;
  }

  function selectField(el, prop, label, options) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const tweak = state.tweaks.get(keyOf(el));
    if (tweak && tweak.changes[changeKey(prop)]) wrap.classList.add("changed");
    const lab = document.createElement("label");
    lab.textContent = label;
    lab.title = prop;
    const select = document.createElement("select");
    const current = computed(el, prop);
    const values = options.includes(current) ? options : [current, ...options];
    for (const o of values) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      if (o === current) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => setStyle(el, prop, select.value));
    wrap.append(lab, select);
    return wrap;
  }

  function segmented(el, prop, options) {
    const seg = document.createElement("div");
    seg.className = "seg";
    const current = computed(el, prop);
    for (const [value, label] of options) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = `${prop}: ${value}`;
      if (current === value) b.classList.add("on");
      b.addEventListener("click", () => setStyle(el, prop, value));
      seg.append(b);
    }
    return seg;
  }

  // Background fill: gradient layers with editable color stops, plus the solid color beneath them.
  function fillControls(el) {
    const image = computed(el, "background-image");
    const layers = image && image !== "none" ? splitTopLevel(image) : [];
    const gradients = layers.map((layer, index) => ({ layer, index })).filter(({ layer }) => /gradient\(/.test(layer));
    if (!gradients.length) return [lbl("Background"), colorField(el, "background-color")];

    const out = [lbl(`Gradient fill · ${gradients.length} layer${gradients.length > 1 ? "s" : ""} (top first)`)];
    const tweak = state.tweaks.get(keyOf(el));
    const changed = !!(tweak && tweak.changes["background-image"]);
    const write = (index, nextLayer, quiet) => {
      const current = splitTopLevel(computed(el, "background-image"));
      current[index] = nextLayer;
      setStyle(el, "background-image", current.join(", "), quiet);
    };

    for (const { layer, index } of gradients) {
      const row = document.createElement("div");
      row.className = "layer" + (changed ? " changed" : "");
      const kind = /^(repeating-)?(linear|radial|conic)/.exec(layer);
      const angle = /^linear-gradient\((-?[\d.]+deg)/.exec(layer);
      const name = document.createElement("span");
      name.className = "layer-name";
      name.textContent = kind ? kind[2][0].toUpperCase() + kind[2].slice(1) + (angle ? " " + angle[1] : "") : "Gradient";
      name.title = layer;
      const stops = document.createElement("span");
      stops.className = "stops";
      const colors = layer.match(COLOR_TOKEN) || [];
      colors.forEach((color, stopIndex) => {
        const sw = document.createElement("span");
        sw.className = "swatch";
        const fill = document.createElement("i");
        fill.style.background = color;
        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = toHex(color);
        picker.title = `Stop ${stopIndex + 1}: ${prettyColor(color)}`;
        const alpha = alphaOf(color);
        const apply = (quiet) => {
          let n = -1;
          const nextLayer = splitTopLevel(computed(el, "background-image"))[index].replace(COLOR_TOKEN, (m) => (++n === stopIndex ? withAlpha(picker.value, alpha) : m));
          fill.style.background = picker.value;
          write(index, nextLayer, quiet);
        };
        picker.addEventListener("input", () => apply(true));
        picker.addEventListener("change", () => renderPanel());
        sw.append(fill, picker);
        stops.append(sw);
      });
      const hide = document.createElement("button");
      hide.className = "icon";
      hide.textContent = "✕";
      hide.title = "Remove this layer";
      hide.addEventListener("click", () => {
        const current = splitTopLevel(computed(el, "background-image"));
        current.splice(index, 1);
        setStyle(el, "background-image", current.length ? current.join(", ") : "none");
      });
      row.append(name, stops, hide);
      out.push(row);
    }

    const solid = document.createElement("button");
    solid.className = "btn ghost";
    solid.style.cssText = "width:100%;margin-top:6px";
    solid.textContent = "Replace gradient with a solid color";
    solid.addEventListener("click", () => makeSolid(el));
    out.push(solid);

    const raw = document.createElement("textarea");
    raw.value = computed(el, "background-image");
    raw.title = "background-image (advanced)";
    raw.style.cssText = "margin-top:6px;min-height:40px;font-family:ui-monospace,Menlo,monospace;font-size:10px";
    raw.addEventListener("change", () => setStyle(el, "background-image", raw.value.trim()));
    raw.addEventListener("keydown", (e) => e.stopPropagation());
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Edit as CSS";
    details.append(summary, raw);
    out.push(details);

    out.push(lbl("Base color (under the gradient)"), colorField(el, "background-color"));
    return out;
  }

  // Figma-style layers: the selected element among its siblings, with its children below it.
  // Hovering a row outlines it on the page; clicking selects it.
  function layerLabel(n) {
    const tag = n.tagName.toLowerCase();
    const cls = n.classList[0] ? "." + n.classList[0] : "";
    const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join(" ").trim();
    const text = own || (n.children.length === 0 ? (n.textContent || "").trim() : "");
    return { name: tag + cls, text: text.length > 22 ? text.slice(0, 21) + "…" : text };
  }

  function layerKind(n) {
    const cs = getComputedStyle(n);
    if (cs.backgroundImage.includes("gradient(")) return "gradient";
    if (/^(img|svg|video|picture|canvas)$/i.test(n.tagName)) return "media";
    if (rgbaOf(cs.backgroundColor).a > 0) return "fill";
    if (n.children.length === 0 && (n.textContent || "").trim()) return "text";
    return "frame";
  }

  const KIND_ICON = { gradient: "◐", media: "▣", fill: "■", text: "T", frame: "#" };

  function layerRow(n, depth, selected) {
    const row = document.createElement("button");
    row.className = "layer-row" + (n === selected ? " on" : "");
    row.style.paddingLeft = 6 + depth * 12 + "px";
    const kind = layerKind(n);
    const icon = document.createElement("span");
    icon.className = "layer-icon k-" + kind;
    icon.textContent = KIND_ICON[kind];
    icon.title = kind === "gradient" ? "Has a gradient fill" : kind;
    const { name, text } = layerLabel(n);
    const label = document.createElement("span");
    label.className = "layer-label";
    label.textContent = name;
    row.append(icon, label);
    if (text) {
      const t = document.createElement("span");
      t.className = "layer-text";
      t.textContent = text;
      row.append(t);
    }
    if (state.tweaks.has(elementKeys.get(n))) {
      const dot = document.createElement("span");
      dot.className = "layer-dot";
      dot.title = "Has changes";
      row.append(dot);
    }
    row.addEventListener("mouseenter", () => (state.hovered = n));
    row.addEventListener("mouseleave", () => (state.hovered = null));
    row.addEventListener("click", () => select(n));
    // Drag a layer onto a sibling's row to reorder them.
    if (n.parentElement && n !== document.body) {
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        state.layerDrag = n;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "");
      });
      row.addEventListener("dragend", () => {
        state.layerDrag = null;
        row.classList.remove("dragging");
      });
      const side = (e) => (e.offsetY < row.offsetHeight / 2 ? "before" : "after");
      row.addEventListener("dragover", (e) => {
        const d = state.layerDrag;
        if (!d || d === n || d.parentElement !== n.parentElement) return;
        e.preventDefault();
        row.classList.toggle("drop-before", side(e) === "before");
        row.classList.toggle("drop-after", side(e) === "after");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
      row.addEventListener("drop", (e) => {
        const d = state.layerDrag;
        row.classList.remove("drop-before", "drop-after");
        if (!d || d === n || d.parentElement !== n.parentElement) return;
        e.preventDefault();
        const list = kids(n.parentElement).filter((c) => c !== d);
        moveElement(d, list.indexOf(n) + (side(e) === "after" ? 1 : 0));
      });
    }
    return row;
  }

  function layersTree(el) {
    const wrap = document.createElement("div");
    wrap.className = "layers";
    const visible = (n) => n !== host && n.getClientRects().length > 0 && !/^(script|style|link|meta|noscript)$/i.test(n.tagName);
    // Expand the path from two levels up down to the selection, so neighbouring blocks show too.
    const path = [el];
    while (path.length < 3 && path[0].parentElement && path[0].parentElement !== document.body) path.unshift(path[0].parentElement);
    const root = path[0];
    let rows = 0;
    const walk = (n, depth) => {
      if (rows > 60) return;
      wrap.append(layerRow(n, depth, el));
      rows++;
      const isOnPath = path.includes(n) && n !== el;
      const kids = n === el || isOnPath ? [...n.children].filter(visible) : [];
      const limit = n === el ? 12 : 20;
      kids.slice(0, limit).forEach((k) => walk(k, depth + 1));
      if (kids.length > limit) {
        const more = document.createElement("div");
        more.className = "layer-more";
        more.style.paddingLeft = 6 + (depth + 1) * 12 + "px";
        more.textContent = `+${kids.length - limit} more`;
        wrap.append(more);
      }
    };
    walk(root, 0);
    requestAnimationFrame(() => wrap.querySelector(".layer-row.on")?.scrollIntoView({ block: "nearest" }));
    return wrap;
  }

  // Sections fold on a click of their title; which ones are folded is remembered.
  const FOLD_KEY = "ui-tweaks:folded";
  let folded = new Set();
  try { folded = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || "[]")); } catch {}
  function section(title, ...children) {
    const sec = document.createElement("div");
    sec.className = "sec" + (folded.has(title) ? " collapsed" : "");
    const h = document.createElement("h4");
    const caret = Object.assign(document.createElement("span"), { className: "caret", textContent: folded.has(title) ? "▸" : "▾" });
    const name = Object.assign(document.createElement("span"), { className: "h-title", textContent: title });
    h.append(caret, name);
    h.addEventListener("click", (e) => {
      if (e.target.closest(".h-btn")) return;
      folded.has(title) ? folded.delete(title) : folded.add(title);
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch {}
      sec.classList.toggle("collapsed", folded.has(title));
      caret.textContent = folded.has(title) ? "▸" : "▾";
    });
    sec.append(h, ...children.filter(Boolean));
    return sec;
  }
  // A small action at the right end of a section title.
  function sectionAction(sec, label, title, run) {
    const b = Object.assign(document.createElement("button"), { className: "h-btn", textContent: label, title });
    b.addEventListener("click", run);
    sec.querySelector("h4").append(b);
    return sec;
  }

  // ---------- layout helpers ----------
  function toggleAutoLayout(el) {
    const d = computed(el, "display");
    if (/flex|grid/.test(d)) {
      const own = state.tweaks.get(keyOf(el))?.changes.display;
      return setStyle(el, "display", own && !/flex|grid/.test(own.from) ? own.from : "block");
    }
    // Lay children out the way they already sit: side by side means a row.
    const shown = kids(el).filter((c) => c.getClientRects().length > 0);
    const tops = shown.map((c) => Math.round(c.getBoundingClientRect().top));
    const row = shown.length > 1 && new Set(tops).size === 1;
    setStyle(el, "display", "flex", true);
    setStyle(el, "flex-direction", row ? "row" : "column", true);
    render();
  }

  const AXIS_POS = (v) => (/^(normal|stretch|flex-start|start|left|baseline|self-start)$/.test(v) ? 0 : /center/.test(v) ? 1 : /^(flex-end|end|right|self-end)$/.test(v) ? 2 : -1);
  const POS_VALUE = ["flex-start", "center", "flex-end"];
  function alignPad(el) {
    const cs = getComputedStyle(el);
    // In a grid, justify-content is horizontal, like a flex row.
    const row = cs.display.includes("grid") || cs.flexDirection.startsWith("row");
    const spaced = /space/.test(cs.justifyContent);
    const main = AXIS_POS(cs.justifyContent), cross = /stretch|normal/.test(cs.alignItems) ? -1 : AXIS_POS(cs.alignItems);
    const pad = document.createElement("div");
    pad.className = "pad9";
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const b = document.createElement("button");
        const [m, x] = row ? [c, r] : [r, c];
        if ((spaced || main === m) && cross === x) b.classList.add("on");
        b.title = `${["Top", "Middle", "Bottom"][r]} ${["left", "center", "right"][c]}`;
        b.addEventListener("click", () => {
          if (!spaced) setStyle(el, "justify-content", POS_VALUE[m], true);
          setStyle(el, "align-items", POS_VALUE[x], true);
          render();
        });
        pad.append(b);
      }
    }
    return pad;
  }

  // Figma's resizing per axis: Fixed (a length), Hug (fit the content) or Fill (take the space).
  function sizeContext(el, axis) {
    const parent = el.parentElement;
    const pcs = parent ? getComputedStyle(parent) : null;
    const pFlex = !!pcs && pcs.display.includes("flex");
    const main = pFlex && (axis === "width") === pcs.flexDirection.startsWith("row");
    return { pcs, pFlex, main };
  }
  function sizeMode(el, axis) {
    const { pcs, pFlex, main } = sizeContext(el, axis);
    const cs = getComputedStyle(el);
    const authored = authoredValue(el, axis);
    if (/^(absolute|fixed)$/.test(cs.position) && !authored) return "hug";
    if (pFlex && main && parseFloat(cs.flexGrow) > 0) return "fill";
    if (/^-?[\d.]+(px|rem|em)$/.test(authored)) return "fixed";
    if (authored === "100%") return "fill";
    if (pFlex && !main && (!authored || authored === "auto")) {
      const self = cs.alignSelf === "auto" ? pcs.alignItems : cs.alignSelf;
      return /stretch|normal/.test(self) ? "fill" : "hug";
    }
    if (axis === "width" && !pFlex && !(pcs && pcs.display.includes("grid")) && /^(block|flex|grid|table|list-item)$/.test(cs.display) && (!authored || authored === "auto")) return "fill";
    return "hug";
  }
  function setSizeMode(el, axis, mode, { quiet = false, size } = {}) {
    const { pFlex, main } = sizeContext(el, axis);
    const now = Math.round(size ?? el.getBoundingClientRect()[axis]) + "px";
    const grow = parseFloat(computed(el, "flex-grow")) > 0;
    if (mode === "fixed") {
      setStyle(el, axis, now, true);
      if (pFlex && main) {
        // A fixed size only holds once the element stops growing into the free space.
        if (grow) setStyle(el, "flex-grow", "0", true);
        if (computed(el, "flex-basis") !== "auto") setStyle(el, "flex-basis", "auto", true);
        setStyle(el, "flex-shrink", "0", true);
      }
      if (pFlex && !main && computed(el, "align-self") === "stretch") setStyle(el, "align-self", "auto", true);
    } else if (mode === "hug") {
      if (pFlex && main) {
        if (grow) setStyle(el, "flex-grow", "0", true);
        setStyle(el, "flex-basis", "auto", true);
        setStyle(el, axis, "auto", true);
      } else if (pFlex) {
        setStyle(el, axis, "auto", true);
        setStyle(el, "align-self", "flex-start", true);
      } else setStyle(el, axis, axis === "width" ? "fit-content" : "auto", true);
    } else {
      if (pFlex && main) {
        setStyle(el, "flex-grow", "1", true);
        setStyle(el, "flex-basis", "0px", true);
        setStyle(el, `min-${axis}`, "0px", true);
      } else if (pFlex) {
        setStyle(el, axis, "auto", true);
        setStyle(el, "align-self", "stretch", true);
      } else setStyle(el, axis, "100%", true);
    }
    if (!quiet) render();
  }

  // The size an element would have as Hug and as Fill, measured by trying each for a moment.
  function measureModes(el, axis) {
    const props = [axis, "flex-grow", "flex-basis", "flex-shrink", "align-self", `min-${axis}`];
    const saved = props.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
    const restore = () => saved.forEach(([p, v, pr]) => (v ? el.style.setProperty(p, v, pr) : el.style.removeProperty(p)));
    const { pFlex, main } = sizeContext(el, axis);
    const set = (p, v) => el.style.setProperty(p, v, "important");
    if (pFlex && main) { set("flex-grow", "0"); set("flex-basis", "auto"); set(axis, "auto"); }
    else if (pFlex) { set("align-self", "flex-start"); set(axis, "auto"); }
    else set(axis, axis === "width" ? "fit-content" : "auto");
    const hug = el.getBoundingClientRect()[axis];
    restore();
    if (pFlex && main) { set("flex-grow", "1"); set("flex-basis", "0px"); set(`min-${axis}`, "0px"); }
    else if (pFlex) { set("align-self", "stretch"); set(axis, "auto"); }
    else set(axis, "100%");
    const fill = el.getBoundingClientRect()[axis];
    restore();
    return { hug, fill };
  }
  function sizeControl(el, axis, label) {
    const box = document.createElement("div");
    const mode = sizeMode(el, axis);
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [m, text, title] of [["fixed", "Fixed", "A set length"], ["hug", "Hug", "Fit the content"], ["fill", "Fill", "Take the available space"]]) {
      const b = Object.assign(document.createElement("button"), { textContent: text, title: `${label}: ${title}` });
      if (m === mode) b.classList.add("on");
      b.addEventListener("click", () => setSizeMode(el, axis, m));
      seg.append(b);
    }
    box.append(numberField(el, axis, label === "Width" ? "W" : "H", { min: 0 }), seg);
    seg.style.marginTop = "4px";
    return box;
  }

  function lbl(text) {
    const d = document.createElement("div");
    d.className = "lbl";
    d.textContent = text;
    return d;
  }

  function grid(cls, ...children) {
    const d = document.createElement("div");
    d.className = cls;
    d.append(...children);
    return d;
  }

  function linkedGroup(el, group, labels, linkedLabel) {
    // One field for all four sides when they match, else four fields.
    const props = GROUPS[group];
    const values = props.map((p) => computed(el, p));
    const same = values.every((v) => v === values[0]);
    if (same && !state.expanded?.[group]) {
      const field = numberField(el, props[0], linkedLabel, { min: group === "margin" ? undefined : 0 });
      const input = field.querySelector("input");
      const applyAll = (val, quiet) => props.forEach((p) => setStyle(el, p, normalizeLength(val, p), quiet));
      input.addEventListener("change", (e) => {
        e.stopImmediatePropagation();
        applyAll(input.value);
      }, true);
      field.querySelector("label").addEventListener("pointerdown", () => {
        // Scrubbing the linked field moves all sides together.
        const watch = () => applyAll(input.value, true);
        const lab = field.querySelector("label");
        lab.addEventListener("pointermove", watch);
        lab.addEventListener("pointerup", () => lab.removeEventListener("pointermove", watch), { once: true });
      });
      const expand = document.createElement("button");
      expand.className = "icon";
      expand.textContent = "⊞";
      expand.title = "Edit each side";
      expand.addEventListener("click", () => {
        state.expanded = { ...(state.expanded || {}), [group]: true };
        renderPanel();
      });
      return grid("grid2", field, expand);
    }
    return grid("grid4", ...props.map((p, i) => numberField(el, p, labels[i], { min: group === "margin" ? undefined : 0 })));
  }

  // One side of the box-model diagram. Arrows step (Shift ×10); Alt applies the value to all four sides.
  function boxInput(el, group, side) {
    const props = GROUPS[group];
    const prop = props["trbl".indexOf(side)];
    const input = document.createElement("input");
    const tweak = state.tweaks.get(keyOf(el));
    if (tweak && tweak.changes[changeKey(prop)]) input.classList.add("changed");
    const show = () => {
      const p = parseNumber(computed(el, prop));
      return p && p.unit === "px" ? shortNumber(p.n) : computed(el, prop);
    };
    input.className += " " + side;
    input.value = show();
    input.spellcheck = false;
    input.title = `${prop}: ${computed(el, prop)}${group === "margin" ? " (auto allowed)" : ""}. Arrows step, Shift ×10, Alt sets all four sides.`;
    const commit = (val, all) => {
      const v = normalizeLength(val, prop);
      if (group === "padding" && /^-/.test(v)) return (input.value = show());
      for (const p of all ? props : [prop]) setStyle(el, p, v);
    };
    input.addEventListener("change", () => commit(input.value, false));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if (e.altKey) commit(input.value, true);
        input.blur();
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const p = parseNumber(input.value) || { n: 0, unit: "" };
        const next = p.n + (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
        commit(shortNumber(group === "padding" ? Math.max(0, next) : next) + (p.unit && p.unit !== "px" ? p.unit : ""), e.altKey);
      }
    });
    return input;
  }

  function boxModel(el) {
    const r = el.getBoundingClientRect();
    const outer = document.createElement("div");
    outer.className = "bm";
    const inner = document.createElement("div");
    inner.className = "bm pad";
    const center = document.createElement("div");
    center.className = "bm-c";
    center.textContent = `${shortNumber(r.width)} × ${shortNumber(r.height)}`;
    const tag = (t) => Object.assign(document.createElement("span"), { className: "bm-tag", textContent: t });
    inner.append(tag("padding"), center, ...[..."trbl"].map((s) => boxInput(el, "padding", s)));
    outer.append(tag("margin"), inner, ...[..."trbl"].map((s) => boxInput(el, "margin", s)));
    return outer;
  }

  function quickRow(...buttons) {
    const row = document.createElement("div");
    row.className = "quick";
    for (const [label, title, run] of buttons) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", run);
      row.append(b);
    }
    return row;
  }

  // The box an absolute or fixed element is placed against.
  function containingBlock(el) {
    if (computed(el, "position") === "fixed") return { name: "the viewport", rect: { left: 0, top: 0, width: innerWidth, height: innerHeight } };
    const cb = el.offsetParent || document.body;
    const r = cb.getBoundingClientRect(), cs = getComputedStyle(cb);
    const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
    const name = cb === document.body || cb === document.documentElement ? "the page (no positioned ancestor)" : cb.tagName.toLowerCase() + (cb.classList[0] ? "." + cb.classList[0] : "");
    return { name, rect: { left: r.left + bl, top: r.top + bt, width: cb.clientWidth, height: cb.clientHeight } };
  }

  // Switching to absolute/fixed pins the element where it is now, at its current size.
  function setPosition(el, value) {
    if (value === computed(el, "position")) return;
    if (value === "absolute" || value === "fixed") {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const ml = parseFloat(cs.marginLeft) || 0, mt = parseFloat(cs.marginTop) || 0;
      const base = value === "fixed" ? { left: 0, top: 0 } : containingBlock(el).rect;
      const w = shortNumber(r.width) + "px";
      setStyle(el, "position", value);
      setStyle(el, "left", shortNumber(r.left - base.left - ml) + "px");
      setStyle(el, "top", shortNumber(r.top - base.top - mt) + "px");
      setStyle(el, "right", "auto");
      setStyle(el, "bottom", "auto");
      if (computed(el, "width") !== w) setStyle(el, "width", w);
      // Auto margins (centering) collapse once it's out of the flow: correct for wherever it actually landed.
      const after = el.getBoundingClientRect();
      if (Math.abs(after.left - r.left) > 0.5) setStyle(el, "left", shortNumber(parseFloat(computed(el, "left")) + r.left - after.left) + "px");
      if (Math.abs(after.top - r.top) > 0.5) setStyle(el, "top", shortNumber(parseFloat(computed(el, "top")) + r.top - after.top) + "px");
    } else setStyle(el, "position", value);
  }

  // Pin to one edge or the center of the containing block, Figma constraint style.
  function alignInParent(el, edge) {
    const r = el.getBoundingClientRect();
    const horizontal = edge === "left" || edge === "right" || edge === "hcenter";
    const [a, b, size] = horizontal ? ["left", "right", r.width] : ["top", "bottom", r.height];
    if (edge === "hcenter" || edge === "vcenter") {
      setStyle(el, a, `calc(50% - ${shortNumber(size / 2)}px)`);
      setStyle(el, b, "auto");
    } else {
      setStyle(el, edge, "0px");
      setStyle(el, edge === a ? b : a, "auto");
    }
  }

  function positionSection(el) {
    const pos = computed(el, "position");
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [value, label] of [["static", "Auto"], ["relative", "Relative"], ["absolute", "Absolute"], ["fixed", "Fixed"], ["sticky", "Sticky"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = value === "static" ? "position: static (in the flow)" : `position: ${value}` + (value === "absolute" || value === "fixed" ? " — keeps its current spot and size" : "");
      if (pos === value) b.classList.add("on");
      b.addEventListener("click", () => setPosition(el, value));
      seg.append(b);
    }
    const out = [seg];
    if (pos !== "static") {
      out.push(lbl(pos === "sticky" ? "Stick at" : "Offsets"));
      out.push(grid("grid4", ...["top", "right", "bottom", "left"].map((p, i) => numberField(el, p, "TRBL"[i]))));
      out.push(grid("grid2 row", numberField(el, "z-index", "Z", { step: 1 }), document.createElement("span")));
    }
    if (pos === "absolute" || pos === "fixed") {
      out.push(lbl("Align in parent"));
      out.push(quickRow(
        ["⇤", "Pin to the left edge", () => alignInParent(el, "left")],
        ["↔", "Center horizontally", () => alignInParent(el, "hcenter")],
        ["⇥", "Pin to the right edge", () => alignInParent(el, "right")],
        ["⤒", "Pin to the top edge", () => alignInParent(el, "top")],
        ["↕", "Center vertically", () => alignInParent(el, "vcenter")],
        ["⤓", "Pin to the bottom edge", () => alignInParent(el, "bottom")],
      ));
      const note = document.createElement("div");
      note.className = "cb-note";
      note.textContent = "Positioned against " + containingBlock(el).name;
      out.push(note);
    }
    return section("Position", ...out);
  }

  // Arrow keys on the page: move a positioned element by its offsets, a static one by its margins.
  let nudgeTimer = 0;
  function nudge(el, key, big) {
    const d = (big ? 10 : 1) * (key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1);
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    if (computed(el, "position") === "static") {
      const prop = horizontal ? "margin-left" : "margin-top";
      const now = parseNumber(computed(el, prop));
      if (!now || now.unit !== "px") return toast(`Can't nudge: ${prop} is ${computed(el, prop)}`);
      setStyle(el, prop, shortNumber(now.n + d) + "px", true);
    } else {
      const a = offsetAxes(el)[horizontal ? "h" : "v"];
      setStyle(el, a.prop, shortNumber(a.start + a.sign * d) + "px", true);
    }
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(renderPanel, 150);
  }

  // How many elements on the page the "Everywhere" rules of this element's changes reach.
  function reachCount(el) {
    const t = state.tweaks.get(keyOf(el));
    const seen = new Set();
    for (const c of Object.values((t && t.changes) || {})) {
      const r = !c.state && c.authoredIn && c.authoredIn[0];
      if (!r) continue;
      try { document.querySelectorAll(r.part || r.selector).forEach((n) => seen.add(n)); } catch {}
    }
    return seen.size || null;
  }

  // ---------- Breakpoints ----------
  // "Only at this width" becomes the project's own breakpoint (from its @media rules) when there is one.
  const breakpointCache = new Map(); // width -> { query, label } | null; undefined while loading
  function breakpointScope(width) {
    if (breakpointCache.has(width)) return breakpointCache.get(width);
    breakpointCache.set(width, undefined);
    fetch(API + "/breakpoints?width=" + width, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        breakpointCache.set(width, d.scope || null);
        if (state.isOpen) renderPanel();
      })
      .catch(() => breakpointCache.set(width, null));
    return undefined;
  }

  // ---------- Tokens on this element ----------
  // The tokens behind this element's styles, editable here: saving rewrites the token itself, so
  // everything that uses it changes (in the theme that applies to this element).
  const TOKEN_PROPS = ["color", "background-color", "background-image", "border-top-color", "border-color", "box-shadow", "padding-top", "padding-left", "gap", "row-gap", "column-gap", "border-top-left-radius", "border-radius", "font-size", "font-family", "font-weight", "line-height", "width", "height"];
  let tokenScan = null, tokenScanAt = 0, tokenScanning = null;
  function loadTokenScan() {
    if (tokenScan && Date.now() - tokenScanAt < 5000) return Promise.resolve(tokenScan);
    if (!tokenScanning) tokenScanning = fetch(API + "/tokens", { cache: "no-store" }).then((r) => r.json()).then((d) => (tokenScan = d, tokenScanAt = Date.now(), tokenScanning = null, d)).catch(() => (tokenScanning = null, null));
    return tokenScanning;
  }
  function tokensUsedBy(el) {
    const used = new Map(); // name -> props
    for (const p of TOKEN_PROPS) {
      const own = state.tweaks.get(keyOf(el));
      const rule = matchedRules(el, p)[0];
      const v = (own && own.changes[p] && own.changes[p].to) || el.style.getPropertyValue(p) || (rule && rule.value) || "";
      for (const m of String(v || "").matchAll(/var\(\s*(--[\w-]+)/g)) used.set(m[1], [...(used.get(m[1]) || []), p]);
    }
    return used;
  }
  // The declaration that gives the token its value here: the mode whose selector is the nearest ancestor.
  function declarationFor(token, el) {
    let best = null, bestDepth = Infinity;
    for (const [key, v] of Object.entries(token.values)) {
      const parts = key.split(" › ");
      const media = parts.filter((p) => p.startsWith("@media"));
      if (media.some((m) => { try { return !matchMedia(m.replace(/^@media\s*/, "")).matches; } catch { return false; } })) continue;
      const sel = parts[parts.length - 1];
      let n = null;
      // :root, html, :host and Tailwind v4's @theme all put tokens on the document root.
      if (/^@theme\b/.test(sel.trim()) || sel.split(",").some((p) => /^(:root|html|:host)$/.test(p.trim()))) n = document.documentElement;
      else try { n = el.closest(sel); } catch {}
      if (!n) continue;
      let depth = 0;
      for (let x = el; x && x !== n; x = x.parentElement) depth++;
      if (depth <= bestDepth) { best = { key, ...v }; bestDepth = depth; }
    }
    return best;
  }
  function tokensSection(el) {
    const used = tokensUsedBy(el);
    if (!used.size) return null;
    const box = document.createElement("div");
    box.append(lbl("Changes here apply everywhere the token is used"));
    const rows = document.createElement("div");
    box.append(rows);
    loadTokenScan().then((scan) => {
      if (!scan) return rows.append(lbl("Couldn't read the tokens"));
      for (const [name, props] of used) {
        const token = scan.tokens.find((t) => t.name === name) || null;
        const decl = token && declarationFor(token, el);
        const row = document.createElement("div");
        row.className = "prop-row";
        row.append(Object.assign(document.createElement("span"), { textContent: name, title: `${name}, used for ${props.join(", ")}${decl ? ` · ${decl.file}:${decl.line}` : ""}` }));
        if (!decl) {
          row.append(lbl("declared in a selector the kit can't edit"));
          rows.append(row);
          continue;
        }
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;gap:4px;align-items:center;min-width:0";
        const isColor = token.category === "color";
        if (isColor) {
          const sw = document.createElement("label");
          sw.className = "swatch";
          sw.style.margin = "0";
          const fill = document.createElement("i");
          fill.style.background = getComputedStyle(el).getPropertyValue(name) || decl.value;
          const pick = Object.assign(document.createElement("input"), { type: "color", value: toHex(fill.style.background || "#000") });
          pick.addEventListener("change", () => saveToken(name, decl, inNotation(decl.value, pick.value, alphaOf(getComputedStyle(el).getPropertyValue(name).trim() || decl.value))));
          sw.append(fill, pick);
          wrap.append(sw);
        }
        const input = Object.assign(document.createElement("input"), { value: decl.value, spellcheck: false, title: `Saved to ${decl.file}:${decl.line}` });
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") input.blur();
        });
        input.addEventListener("change", () => saveToken(name, decl, input.value.trim()));
        wrap.append(input);
        row.append(wrap);
        rows.append(row);
      }
    });
    return section("Tokens on this element", box);
  }
  async function saveToken(name, decl, to) {
    if (!to || to === decl.value) return;
    try {
      const res = await fetch(API + "/tokens", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, file: decl.file, line: decl.line, from: decl.value, to }) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || res.statusText);
      tokenScanAt = 0;
      toast(`${name} → ${to}: changed everywhere it's used. Undo apply puts it back.`);
      setTimeout(render, 600);
    } catch (error) {
      toast(`Not saved: ${error.message}`);
    }
  }
  // A picked colour in the token's own notation (oklch stays oklch).
  function inNotation(original, hex, alpha) {
    const o = String(original).trim().toLowerCase();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if (o.startsWith("oklch")) {
      const lin = (u) => ((u /= 255) <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
      const [R, G, B] = [r, g, b].map(lin);
      const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B), m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B), s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
      const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      const C = Math.hypot(A, Bb);
      let H = (Math.atan2(Bb, A) * 180) / Math.PI;
      if (H < 0) H += 360;
      const f = (n, d) => +n.toFixed(d);
      return `oklch(${f(L * 100, 1)}% ${f(C, 3)} ${f(C < 0.002 ? 0 : H, 1)}${alpha < 1 ? ` / ${f(alpha, 2)}` : ""})`;
    }
    if (o.startsWith("rgb")) return alpha < 1 ? `rgba(${r}, ${g}, ${b}, ${+alpha.toFixed(2)})` : `rgb(${r}, ${g}, ${b})`;
    return alpha < 1 ? hex + Math.round(alpha * 255).toString(16).padStart(2, "0") : hex;
  }

  // ---------- Insert ----------
  function insertSection() {
    const basics = document.createElement("div");
    basics.className = "ins-grid";
    for (const [key, b] of Object.entries(BASICS)) {
      const btn = Object.assign(document.createElement("button"), { textContent: b.label, title: `Insert a ${b.label.toLowerCase()}: then click where it goes` });
      if (state.placing && state.placing.basic === key) btn.classList.add("on");
      btn.addEventListener("click", () => armInsert({ label: b.label.toLowerCase(), basic: key }));
      basics.append(btn);
    }
    const list = document.createElement("div");
    list.className = "ins-list";
    const comps = pageComponents();
    for (const c of comps) {
      const btn = document.createElement("button");
      btn.title = `Insert a <${c.name}> like the one at ${c.usedAt || "?"}: then click where it goes`;
      btn.append(Object.assign(document.createElement("b"), { textContent: c.name }), Object.assign(document.createElement("span"), { textContent: c.count > 1 ? `×${c.count}` : "" }));
      if (state.placing && state.placing.component && state.placing.component.name === c.name) btn.classList.add("on");
      btn.addEventListener("click", () => armInsert({ label: c.name, component: c }));
      list.append(btn);
    }
    const hint = lbl(state.placing ? `Click on the page where the ${state.placing.label} goes. Over empty space it goes inside; over an element, beside it. Shift: one level up. Esc cancels.` : "Pick one, then click where it goes on the page");
    return section("Insert", hint, basics, lbl(comps.length ? "Components on this page" : "No React components found on this page"), list);
  }

  // ---------- Component props ----------
  function componentInstance(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    const fiber = key && el[key];
    const owner = fiber && fiber.return;
    const type = owner && owner.type;
    if (!type || typeof type === "string" || owner.child !== fiber) return null;
    const name = type.displayName || type.name || (type.render && (type.render.displayName || type.render.name));
    if (!name || /^[a-z_]/.test(name)) return null;
    const usedAt = sourceOf(owner);
    return { name, usedAt, props: owner.memoizedProps || {} };
  }

  function setProp(el, inst, name, from, to) {
    const tweak = tweakFor(el);
    recordUndo({ el, key: tweak.key, propsKey: name, before: tweak.props && tweak.props[name] ? { ...tweak.props[name] } : null });
    if (tweak.batchId) withdraw(tweak.batchId);
    tweak.props = { ...(tweak.props || {}) };
    const original = tweak.props[name] ? tweak.props[name].from : from;
    if (to === original) delete tweak.props[name];
    else tweak.props[name] = { from: original, to };
    tweak.component = { name: inst.name, usedAt: inst.usedAt };
    cleanup(tweak);
    persist();
    render();
  }

  function componentSection(el) {
    const inst = componentInstance(el);
    if (!inst) return null;
    const tweak = state.tweaks.get(keyOf(el));
    const rows = [];
    for (const [name, raw] of Object.entries(inst.props)) {
      if (rows.length >= 14 || name === "key" || name === "ref") continue;
      const value = tweak && tweak.props && tweak.props[name] ? tweak.props[name].to : raw;
      if (!["string", "number", "boolean"].includes(typeof raw)) continue;
      const row = document.createElement("div");
      row.className = "prop-row" + (tweak && tweak.props && tweak.props[name] ? " changed" : "");
      row.append(Object.assign(document.createElement("span"), { textContent: name, title: name }));
      if (typeof raw === "boolean") {
        const seg = document.createElement("div");
        seg.className = "seg";
        for (const v of [true, false]) {
          const b = Object.assign(document.createElement("button"), { textContent: String(v) });
          if (value === v) b.classList.add("on");
          b.addEventListener("click", () => setProp(el, inst, name, raw, v));
          seg.append(b);
        }
        row.append(seg);
      } else {
        const input = Object.assign(document.createElement("input"), { value: String(value), spellcheck: false });
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") input.blur();
        });
        input.addEventListener("change", () => setProp(el, inst, name, raw, typeof raw === "number" && input.value.trim() !== "" && !isNaN(+input.value) ? +input.value : input.value));
        row.append(input);
      }
      rows.push(row);
    }
    const sub = lbl(inst.usedAt ? `Used at ${inst.usedAt}. Prop changes apply when you send.` : "Prop changes apply when you send.");
    return section(`Component · ${inst.name}`, sub, ...(rows.length ? rows : [lbl("No simple props to edit.")]));
  }

  // ---------- Ask Claude ----------
  // The element's subtree with the styles that shape it, for the variations agent.
  const CONTEXT_PROPS = ["display", "flex-direction", "gap", "justify-content", "align-items", "padding", "margin", "width", "height", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color", "background-image", "border", "border-radius", "box-shadow", "opacity", "text-align"];
  function subtreeContext(el) {
    const nodes = [];
    const walk = (n, target, depth) => {
      if (nodes.length >= 24 || n === host) return;
      const cs = getComputedStyle(n);
      const styles = {};
      for (const p of CONTEXT_PROPS) {
        const v = cs.getPropertyValue(p).trim();
        if (v && !/^(normal|none|auto|0px|rgba\(0, 0, 0, 0\)|0px none.*|static)$/.test(v)) styles[p] = v.length > 120 ? v.slice(0, 117) + "..." : v;
      }
      const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join(" ").trim();
      nodes.push({ target, tag: n.tagName.toLowerCase(), classes: [...n.classList].slice(0, 4), text: own.slice(0, 40) || undefined, styles });
      if (depth >= 3) return;
      [...n.children].forEach((c, i) => c.getClientRects().length && walk(c, `${target} > :nth-child(${i + 1})`, depth + 1));
    };
    walk(el, ":scope", 0);
    const t = designTokens();
    const jsx = describe(el).react;
    return {
      width: innerWidth,
      nodes,
      tokens: [...t.colors.slice(0, 40), ...t.lengths.slice(0, 30)].map((x) => `${x.name}: ${x.value}`),
      files: jsx && jsx.jsxSource ? [jsx.jsxSource.replace(/:\d+$/, "")] : [],
    };
  }

  async function ask(kind, el, instruction) {
    try {
      const body = { kind, instruction, element: el ? describe(el) : null, page: { url: here(), path: location.pathname }, context: kind === "variations" && el ? subtreeContext(el) : null, count: 3 };
      const res = await fetch(API + "/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || res.statusText);
      state.asks = [...(state.asks || []), { id: out.ask.id, kind, instruction, status: "waiting", page: here(), selector: body.element && body.element.selector }];
      if (kind === "edit") state.askDraft = "";
      toast(kind === "edit" ? "Sent to Claude. It edits the code in the background." : "Claude is sketching variations…");
      render();
    } catch (error) {
      toast("Couldn't reach the tweaks server (" + error.message + ")");
    }
  }

  function askSection(el) {
    const box = document.createElement("div");
    box.className = "ask-box";
    const input = document.createElement("textarea");
    input.placeholder = el ? "Ask Claude to change this, e.g. \"make it a card with an avatar and a status pill\"" : "Ask Claude to change this screen, e.g. \"add a notifications row under Settings\"";
    input.value = state.askDraft || "";
    input.addEventListener("input", () => (state.askDraft = input.value));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && input.value.trim()) ask("edit", el, input.value.trim());
    });
    const actions = document.createElement("div");
    actions.className = "ask-actions";
    const go = Object.assign(document.createElement("button"), { className: "go", textContent: "Do it", title: "Claude edits the code (⌘Enter). Undo with Undo apply" });
    go.addEventListener("click", () => input.value.trim() ? ask("edit", el, input.value.trim()) : toast("Say what to change first"));
    const vary = Object.assign(document.createElement("button"), { textContent: "3 variations", title: "Claude proposes three looks for this element (styles only); preview them and pick one. The text above, if any, sets the direction" });
    vary.disabled = !el;
    vary.addEventListener("click", () => el && ask("variations", el, input.value.trim()));
    actions.append(go, vary);
    const list = document.createElement("div");
    list.className = "ask-list";
    box.append(input, actions, list);
    renderAskList(list);
    return section("Ask Claude", box);
  }

  // Previewing a variation: its styles go on as inline styles, which come off again when it's closed.
  function previewVariant(a, v) {
    clearVariantPreview();
    const root = a.selector && document.querySelector(a.selector);
    if (!root) return toast("That element isn't on this screen any more");
    const undo = [];
    for (const c of v.changes) {
      let node = null;
      try { node = c.target === ":scope" ? root : root.querySelector(c.target); } catch {}
      if (!node) continue;
      undo.push([node, c.prop, node.style.getPropertyValue(c.prop), node.style.getPropertyPriority(c.prop)]);
      node.style.setProperty(c.prop, c.value, "important");
    }
    state.variantPreview = { id: a.id, name: v.name, undo };
  }
  function clearVariantPreview() {
    const p = state.variantPreview;
    if (!p) return;
    for (const [node, prop, value, priority] of p.undo.reverse()) value ? node.style.setProperty(prop, value, priority) : node.style.removeProperty(prop);
    state.variantPreview = null;
  }
  // Using a variation turns its styles into ordinary tweaks (one undo), ready to send.
  function useVariant(a, v) {
    clearVariantPreview();
    const root = a.selector && document.querySelector(a.selector);
    if (!root) return toast("That element isn't on this screen any more");
    state.dragStamp = ++stampCounter;
    let n = 0;
    for (const c of v.changes) {
      let node = null;
      try { node = c.target === ":scope" ? root : root.querySelector(c.target); } catch {}
      if (node) {
        setStyle(node, c.prop, c.value, true);
        n++;
      }
    }
    state.dragStamp = 0;
    select(root);
    toast(`Using "${v.name}": ${n} change${n === 1 ? "" : "s"}, ready to send`);
  }

  function renderAskList(list) {
    if (!list) return;
    list.innerHTML = "";
    const mine = (state.asks || []).filter((a) => !a.page || a.page === here()).slice(-4).reverse();
    for (const a of mine) {
      const item = document.createElement("div");
      item.className = "ask-item";
      const top = document.createElement("div");
      top.className = "ask-top";
      const what = Object.assign(document.createElement("div"), { className: "ask-what", textContent: a.kind === "variations" ? `Variations${a.instruction ? `: ${a.instruction}` : ""}` : a.instruction });
      const label = { waiting: "Queued", running: "Working…", done: a.kind === "edit" ? "Done" : "Ready", failed: a.needs ? "Question" : "Failed" }[a.status] || a.status;
      const st = Object.assign(document.createElement("span"), { className: "ask-state " + a.status, textContent: label });
      const x = Object.assign(document.createElement("button"), { className: "ask-x", textContent: "✕", title: a.status === "done" || a.status === "failed" ? "Dismiss" : "Cancel (a running request still finishes)" });
      x.addEventListener("click", () => {
        if (state.variantPreview && state.variantPreview.id === a.id) clearVariantPreview();
        state.asks = state.asks.filter((o) => o.id !== a.id);
        fetch(API + "/ask/" + encodeURIComponent(a.id), { method: "DELETE" }).catch(() => {});
        renderAskList(list);
      });
      top.append(what, st, x);
      item.append(top);
      if (a.status === "done" && a.kind === "edit") item.append(Object.assign(document.createElement("div"), { className: "ask-sub", textContent: `${a.summary ? a.summary + " · " : ""}${(a.files || []).join(", ")}. Undo apply puts it back.` }));
      if (a.status === "failed") item.append(Object.assign(document.createElement("div"), { className: "ask-sub", textContent: a.needs ? `Claude asks: ${a.needs}` : a.error || "It didn't work out." }));
      if (a.status === "done" && a.kind === "variations") {
        for (const v of a.variants || []) {
          const row = document.createElement("div");
          row.className = "variant" + (state.variantPreview && state.variantPreview.id === a.id && state.variantPreview.name === v.name ? " on" : "");
          const t = document.createElement("div");
          t.className = "v-text";
          t.append(Object.assign(document.createElement("b"), { textContent: v.name }), Object.assign(document.createElement("span"), { textContent: v.why }));
          const use = Object.assign(document.createElement("button"), { textContent: "Use" });
          use.addEventListener("click", (e) => {
            e.stopPropagation();
            useVariant(a, v);
          });
          row.title = "Click to preview it on the page; click again to go back";
          row.addEventListener("click", () => {
            const on = state.variantPreview && state.variantPreview.id === a.id && state.variantPreview.name === v.name;
            on ? clearVariantPreview() : previewVariant(a, v);
            renderAskList(list);
          });
          row.append(t, use);
          item.append(row);
        }
      }
      list.append(item);
    }
  }

  function renderPanel() {
    matchCache = new WeakMap(); // one rule match per element per render; the DOM may have changed since
    panel.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "bar";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "UI Tweaks";
    const pick = document.createElement("button");
    pick.className = "icon" + (state.isPicking ? " on" : "");
    pick.textContent = "⌖ Pick";
    pick.title = "Pick elements (V). Turn off to use the page normally.";
    pick.addEventListener("click", () => {
      state.isPicking = !state.isPicking;
      render();
    });
    const close = document.createElement("button");
    close.className = "icon";
    close.textContent = "✕";
    close.title = "Close (Alt+T). Previews stay until you reset them.";
    close.addEventListener("click", () => (STUDIO ? leaveStudio() : toggle(false)));
    const pop = document.createElement("button");
    pop.className = "icon";
    if (STUDIO) {
      pop.textContent = "⇱";
      pop.title = "Leave docked mode";
    } else {
      pop.textContent = state.popup ? "⇲ Dock" : "⧉";
      pop.title = state.popup ? "Put the panel back on the page" : CAN_DOCK ? "Dock the panel beside the page (Shift: pop out into a window)" : "Pop the panel out into its own window";
    }
    pop.addEventListener("click", (e) => {
      if (STUDIO || state.popup) return dock();
      if (CAN_DOCK && !e.shiftKey) return openStudio();
      popOut();
    });
    const undo = document.createElement("button");
    undo.className = "icon";
    undo.textContent = "↶";
    undo.title = "Undo the last preview edit (⌘Z / Ctrl+Z)";
    undo.disabled = state.undo.length === 0;
    undo.style.opacity = undo.disabled ? "0.35" : "1";
    undo.addEventListener("click", undoPreview);
    const system = document.createElement("button");
    system.className = "icon";
    system.textContent = "◧";
    system.title = "Design system: every token in your CSS, editable";
    system.addEventListener("click", () => {
      const url = API + "/system";
      if (STUDIO) STUDIO.location.href = url;
      else if (!window.open(url, "_blank")) location.href = url;
    });
    const ins = document.createElement("button");
    ins.className = "icon" + (state.showInsert ? " on" : "");
    ins.textContent = "＋";
    ins.title = "Insert an element or one of this page's components";
    ins.addEventListener("click", () => {
      state.showInsert = !state.showInsert;
      render();
    });
    bar.append(title, undo, ins, system, pick, pop, close);
    panel.append(bar);

    const scroll = document.createElement("div");
    scroll.className = "scroll";
    panel.append(scroll);
    const el = state.selected;

    if (!el || !el.isConnected) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = `<b>Click any element</b> to tweak it.<br/>Drag it to reorder or move it, drag its handles to resize. ⌘-drag places it freely.<br/>Drag a field's label to scrub its value; Shift for ×10.<br/>Double-click text to edit it.<br/><br/>When you're happy, press <b>Send to Claude</b>. Claude edits the real source to match.`;
      if (state.showInsert) scroll.append(insertSection());
      scroll.append(empty);
      scroll.append(askSection(null));
    } else {
      if (state.showInsert) scroll.append(insertSection());
      const info = describe(el);
      const cs = getComputedStyle(el);
      const head = document.createElement("div");
      head.className = "sec";
      const name = document.createElement("div");
      name.className = "el-name";
      const comp = info.react && info.react.components[0];
      name.textContent = comp ? `<${comp.name}> ${info.tag}` : info.tag;
      const meta = document.createElement("div");
      meta.className = "el-meta";
      const cls = info.classes.length ? `<code>.${info.classes.slice(0, 4).join(" .")}</code>` : "";
      const src = info.react && info.react.jsxSource ? `<br/><code>${info.react.jsxSource}</code>` : "";
      meta.innerHTML = cls + src;
      const crumbs = document.createElement("div");
      crumbs.className = "crumbs";
      const chain = [];
      for (let n = el; n && n !== document.body && chain.length < 5; n = n.parentElement) chain.unshift(n);
      chain.forEach((n) => {
        const b = document.createElement("button");
        b.textContent = n.classList[0] ? "." + n.classList[0] : n.tagName.toLowerCase();
        if (n === el) b.style.color = "#fff";
        b.addEventListener("click", () => select(n));
        crumbs.append(b);
      });
      const styleTools = document.createElement("div");
      styleTools.className = "crumbs";
      for (const [label, title, run] of [["Copy style", "Copy this element's type, fill, border, radius, shadow and padding (⌘⌥C)", copyStyle], ["Paste style", "Paste the copied style onto this element (⌘⌥V)", pasteStyle]]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", () => run(el));
        styleTools.append(b);
      }
      const arrange = document.createElement("div");
      arrange.className = "arrange";
      for (const [label, title, run, cls] of [
        ["↑", "Move before its previous sibling (⌘↑), or drag it on the page", () => moveBy(el, -1)],
        ["↓", "Move after its next sibling (⌘↓), or drag it on the page", () => moveBy(el, 1)],
        ["Parent", "Select the parent (Shift+Enter). Enter selects the first child, Tab the next sibling", () => el.parentElement && el.parentElement !== document.body && select(el.parentElement)],
        ["Duplicate", "Duplicate it (⌘D). Claude writes the copy into the source on Send", () => duplicateElement(el)],
        ["Remove", "Remove this element (Delete). Claude deletes it from the source on Send", () => removeElement(el), "danger"],
      ]) {
        const b = Object.assign(document.createElement("button"), { textContent: label, title });
        if (cls) b.className = cls;
        b.addEventListener("click", run);
        arrange.append(b);
      }
      head.append(name, meta, crumbs, arrange, styleTools, layersTree(el));
      const states = document.createElement("div");
      states.className = "seg";
      states.style.marginTop = "8px";
      for (const [st, label] of [["", "Default"], ["hover", "Hover"], ["active", "Active"], ["focus-visible", "Focus"]]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = st ? `Edit the :${st} state (shown on the page while selected)` : "Edit the resting look";
        if (state.editState === st) b.classList.add("on");
        b.addEventListener("click", () => setEditState(st));
        states.append(b);
      }
      head.append(states);
      scroll.append(head);
      scroll.append(askSection(el));
      const props = componentSection(el);
      if (props) scroll.append(props);
      const tokensHere = tokensSection(el);
      if (tokensHere) scroll.append(tokensHere);

      const current = state.tweaks.get(keyOf(el));
      const warnings = current && el.isConnected ? hiddenReasons(current) : [];
      if (warnings.length) {
        const warn = document.createElement("div");
        warn.className = "warn";
        warn.textContent = warnings.map((w) => "⚠ " + w.text).join("\n");
        scroll.append(warn);
      }

      const isFlex = cs.display.includes("flex");
      const isGrid = cs.display.includes("grid");
      if (isFlex || isGrid) {
        const children = [];
        if (isFlex) {
          children.push(segmented(el, "flex-direction", [["row", "→ Row"], ["column", "↓ Column"]]));
        }
        const side = document.createElement("div");
        side.className = "align-side";
        side.append(
          segmented(el, "justify-content", [["flex-start", "Packed"], ["space-between", "Spread"]]),
          numberField(el, isFlex && cs.flexDirection.startsWith("row") ? "column-gap" : "row-gap", "Gap", { min: 0 }),
        );
        if (isFlex) side.append(segmented(el, "flex-wrap", [["nowrap", "No wrap"], ["wrap", "Wrap"]]));
        const row = document.createElement("div");
        row.className = "align-row row";
        row.append(alignPad(el), side);
        children.push(row);
        if (isGrid || (isFlex && cs.flexWrap !== "nowrap")) {
          children.push(lbl(isGrid ? "Row and column gap" : "Gap between lines"));
          children.push(grid("grid2", numberField(el, "row-gap", "↕", { min: 0 }), numberField(el, "column-gap", "↔", { min: 0 })));
        }
        scroll.append(sectionAction(section(isFlex ? "Auto layout" : "Grid layout", ...children), "Remove", "Back to normal flow (⇧A)", () => toggleAutoLayout(el)));
      } else if (kids(el).some((c) => c.getClientRects().length > 0) && !/^(inline|contents)$/.test(cs.display)) {
        scroll.append(sectionAction(section("Auto layout"), "＋ Add", "Lay the children out in a row or column with a gap (⇧A)", () => toggleAutoLayout(el)));
      }

      // How it sits inside a flex or grid parent.
      const pcs = el.parentElement ? getComputedStyle(el.parentElement) : null;
      if (pcs && /flex|grid/.test(pcs.display) && !/^(absolute|fixed)$/.test(cs.position)) {
        const across = pcs.display.includes("grid") || pcs.flexDirection.startsWith("row") ? "Vertical" : "Horizontal";
        scroll.append(section("In parent layout",
          lbl(`${across} alignment`),
          segmented(el, "align-self", [["auto", "Auto"], ["flex-start", "Start"], ["center", "Center"], ["flex-end", "End"], ["stretch", "Stretch"]]),
        ));
      }

      scroll.append(section("Size",
        grid("size-row", sizeControl(el, "width", "Width"), sizeControl(el, "height", "Height")),
        tapTargetRow(el),
        lbl("Min / max width"),
        grid("grid2", numberField(el, "min-width", "↤", { min: 0 }), numberField(el, "max-width", "↦", { min: 0 })),
        lbl("Content"),
        segmented(el, "overflow", [["visible", "Visible"], ["hidden", "Clip"], ["auto", "Scroll"]]),
      ));

      scroll.append(positionSection(el));

      const setMargins = (pairs) => pairs.forEach(([p, v]) => setStyle(el, p, v));
      scroll.append(section("Spacing",
        boxModel(el),
        quickRow(
          ["Center", "Center horizontally with auto side margins", () => setMargins([["margin-left", "auto"], ["margin-right", "auto"]])],
          ["Margin 0", "Remove all margins", () => setMargins(GROUPS.margin.map((p) => [p, "0px"]))],
          ["Pad 0", "Remove all padding", () => setMargins(GROUPS.padding.map((p) => [p, "0px"]))],
        ),
      ));

      const hasText = (el.innerText || "").trim().length > 0;
      if (hasText) {
        scroll.append(section("Text",
          grid("grid2", numberField(el, "font-size", "Sz", { min: 1 }), selectField(el, "font-weight", "Wt", ["300", "400", "500", "600", "700", "800"])),
          grid("grid2 row", numberField(el, "line-height", "LH", { step: 0.05, min: 0 }), numberField(el, "letter-spacing", "LS", { step: 0.1 })),
          lbl("Color"),
          colorField(el, "color"),
          contrastRow(el),
          lbl("Align"),
          segmented(el, "text-align", [["left", "Left"], ["center", "Center"], ["right", "Right"]]),
        ));
      }

      scroll.append(section("Fill & border",
        ...fillControls(el),
        lbl("Corner radius"),
        linkedGroup(el, "border-radius", ["↖", "↗", "↘", "↙"], "◜"),
        lbl("Border"),
        grid("grid2", numberField(el, "border-top-width", "W", { min: 0 }), colorField(el, "border-top-color")),
        lbl("Opacity"),
        numberField(el, "opacity", "%", { step: 0.05, min: 0 }),
      ));

      const shadowInput = document.createElement("textarea");
      shadowInput.value = computed(el, "box-shadow");
      shadowInput.style.minHeight = "40px";
      shadowInput.addEventListener("change", () => setStyle(el, "box-shadow", shadowInput.value.trim()));
      shadowInput.addEventListener("keydown", (e) => e.stopPropagation());
      scroll.append(section("Shadow", shadowInput));

      const tweak = state.tweaks.get(keyOf(el));
      const note = document.createElement("textarea");
      note.placeholder = "Note for Claude about this element, e.g. \"apply to every card like this\"";
      note.value = tweak ? tweak.note : "";
      note.addEventListener("input", () => {
        const t = tweakFor(el);
        if (t.batchId) withdraw(t.batchId);
        t.note = note.value;
        cleanup(t);
        persist();
        renderChanges();
      });
      note.addEventListener("keydown", (e) => e.stopPropagation());
      const scope = document.createElement("div");
      scope.className = "seg";
      scope.style.marginBottom = "6px";
      const isNarrow = !!(tweak && tweak.scope && tweak.scope.kind === "viewport");
      const bp = breakpointScope(innerWidth);
      for (const [kind, label] of [["all", "All screen widths"], ["viewport", bp ? bp.label : `Only at ${innerWidth}px`]]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = kind === "all" ? "Change it everywhere" : bp ? `Written as @media ${bp.query}, a breakpoint this project already uses` : "Change it only around this screen width (Claude adds a media query)";
        if ((kind === "viewport") === isNarrow) b.classList.add("on");
        b.addEventListener("click", () => {
          const t = tweakFor(el);
          if (t.batchId) withdraw(t.batchId);
          t.scope = kind === "viewport" ? { kind, width: innerWidth, query: bp ? bp.query : undefined, label: bp ? bp.label : undefined } : undefined;
          cleanup(t);
          persist();
          render();
        });
        scope.append(b);
      }
      const reach = document.createElement("div");
      reach.className = "seg";
      reach.style.marginBottom = "6px";
      const everywhere = tweak ? tweak.reach === "all" : state.pendingReach === keyOf(el);
      for (const [kind, label, title] of [["one", "This element", "Only this element changes (shared styles get an override for it)"], ["all", "Everywhere", "Edit the CSS rule itself: every element and component instance that uses it changes"]]) {
        const b = Object.assign(document.createElement("button"), { textContent: label, title });
        if ((kind === "all") === everywhere) b.classList.add("on");
        b.addEventListener("click", () => setReach(el, kind));
        reach.append(b);
      }
      const shared = everywhere ? reachCount(el) : null;
      const reachNote = shared ? lbl(`Previewing on ${shared} element${shared === 1 ? "" : "s"} on this screen`) : null;
      scroll.append(section("Apply to", reach, reachNote, scope, note));
    }

    const changes = document.createElement("div");
    changes.className = "changes";
    panel.append(changes);
    const foot = document.createElement("div");
    foot.className = "foot";
    panel.append(foot);
    renderChanges();
  }

  function summarize(tweak) {
    const parts = Object.entries(tweak.changes).map(([k, c]) => `${c.state ? ":" + c.state + " " : ""}${changeProp(k, c)} ${short(c.from)} → ${short(c.to)}`);
    if (tweak.scope && tweak.scope.kind === "viewport") parts.push(`only at ${tweak.scope.width}px wide`);
    if (tweak.reach === "all") parts.push("everywhere this style is used");
    if (tweak.text) parts.push(`text → "${tweak.text.to.slice(0, 30)}"`);
    if (tweak.move && tweak.el.parentElement) {
      const list = kids(tweak.el.parentElement), i = list.indexOf(tweak.el);
      const n = list[i > 0 ? i - 1 : i + 1];
      parts.push(`moved ${i > 0 ? "after" : "before"} ${n ? n.tagName.toLowerCase() + (n.classList[0] ? "." + n.classList[0] : "") : "its sibling"}`);
    }
    if (tweak.removed) parts.push("removed");
    if (tweak.insert) parts.push(tweak.insert.kind === "copy" ? "new copy" : tweak.insert.kind === "component" ? `new <${tweak.insert.component.name}>` : `new ${tweak.insert.basic || tweak.insert.tag}`);
    for (const [name, p] of Object.entries(tweak.props || {})) parts.push(`${name}: ${short(String(p.from))} → ${short(String(p.to))}`);
    if (tweak.note) parts.push(`note: ${tweak.note.slice(0, 40)}`);
    return parts;
  }

  function short(v) {
    if (v === undefined) return "";
    if (/^rgba?\(/.test(v)) return prettyColor(v);
    return v.length > 24 ? v.slice(0, 22) + "…" : v;
  }

  function renderChanges() {
    const box = panel.querySelector(".changes");
    const foot = panel.querySelector(".foot");
    if (!box || !foot) return;
    box.innerHTML = "";
    foot.innerHTML = "";
    const list = [...state.tweaks.values()];
    const drafts = list.filter((t) => !t.batchId);
    const h = document.createElement("h4");
    h.style.cssText = "margin:0 0 4px;font-size:11px;font-weight:600;display:flex;justify-content:space-between;align-items:center";
    h.textContent = list.length ? `Changes · ${list.length} element${list.length > 1 ? "s" : ""}` : "No changes yet";
    box.append(h);
    let others = [];
    try { others = (JSON.parse(localStorage.getItem(STORE_KEY) || "null") || { drafts: [] }).drafts.filter((d) => d.at && d.at !== here() && !list.some((t) => t.at === d.at && t.element.selector === d.selector)); } catch {}
    if (others.length) {
      const o = document.createElement("div");
      o.className = "el-meta";
      o.style.margin = "0 0 6px";
      const screens = [...new Set(others.map((d) => d.at))];
      o.textContent = `+ ${others.length} unsent on ${screens.length === 1 ? "another screen" : screens.length + " other screens"}: open ${screens.length === 1 ? "it" : "them"} to see and send.`;
      o.title = screens.join("\n");
      box.append(o);
    }
    for (const t of list) {
      const row = document.createElement("div");
      row.className = "change";
      const what = document.createElement("div");
      what.className = "what";
      const b = document.createElement("b");
      const comp = t.element.react && t.element.react.components[0];
      b.textContent = (comp ? comp.name + " · " : "") + (t.element.classes[0] ? "." + t.element.classes[0] : t.element.tag);
      if (t.batchId) {
        const pill = document.createElement("span");
        pill.className = "pill" + (t.skipped ? " warn" : "");
        pill.textContent = t.skipped ? "skipped" : "applying…";
        b.append(pill);
      }
      const s = document.createElement("span");
      s.textContent = summarize(t).join(" · ") + (t.skipped ? ` — skipped: ${t.skipped}` : "");
      what.append(b, s);
      what.addEventListener("click", () => t.el.isConnected && select(t.el));
      const undo = document.createElement("button");
      undo.className = "icon";
      undo.textContent = "↺";
      undo.title = "Revert this element";
      undo.addEventListener("click", () => {
        if (t.batchId) withdraw(t.batchId);
        revertTweak(t);
        persist();
        render();
      });
      row.append(what, undo);
      box.append(row);
    }
    for (const issue of state.verifyIssues) {
      const row = document.createElement("div");
      row.className = "change";
      const what = document.createElement("div");
      what.className = "what";
      const b = document.createElement("b");
      b.textContent = issue.label;
      const pill = document.createElement("span");
      pill.className = "pill warn";
      pill.textContent = "source differs";
      b.append(pill);
      const s = document.createElement("span");
      s.textContent = `${issue.prop}: the preview had ${issue.expected}, the source gives ${issue.got}`;
      what.append(b, s);
      what.addEventListener("click", () => issue.el && issue.el.isConnected && select(issue.el));
      const fix = document.createElement("button");
      fix.className = "btn ghost";
      fix.textContent = "Re-apply";
      fix.title = "Put the preview back as a draft with a note, so Haiku finds why the written rule doesn't win";
      fix.addEventListener("click", () => {
        const el = issue.el && issue.el.isConnected ? issue.el : document.querySelector(issue.selector);
        state.verifyIssues = state.verifyIssues.filter((i) => i !== issue);
        if (!el) return render();
        setStyle(el, issue.prop, issue.expected);
        const t = tweakFor(el);
        t.note = `A previous write left ${issue.prop} at ${issue.got} but the design wants ${issue.expected}. Find which rule wins and fix that one.`;
        persist();
        render();
      });
      const dismiss = document.createElement("button");
      dismiss.className = "icon";
      dismiss.textContent = "×";
      dismiss.title = "Dismiss";
      dismiss.addEventListener("click", () => {
        state.verifyIssues = state.verifyIssues.filter((i) => i !== issue);
        renderChanges();
      });
      row.append(what, fix, dismiss);
      box.append(row);
    }
    if (state.codePreview) {
      const cp = state.codePreview;
      const wrap = document.createElement("div");
      wrap.className = "code-preview";
      const head = document.createElement("div");
      head.className = "el-meta";
      const direct = cp.direct.length, queued = cp.queued.length;
      head.textContent = (direct ? `${direct} written directly` : "Nothing written directly") + (queued ? ` · ${queued} for Haiku (${[...new Set(cp.queued.map((q) => q.reason))].filter(Boolean).join("; ")})` : "") + " · ";
      const close = document.createElement("a");
      close.textContent = "close";
      close.href = "#";
      close.style.color = "var(--accent)";
      close.addEventListener("click", (e) => {
        e.preventDefault();
        state.codePreview = null;
        renderChanges();
      });
      head.append(close);
      wrap.append(head);
      for (const f of cp.files) {
        const file = document.createElement("div");
        file.className = "diff-file";
        const name = document.createElement("div");
        name.className = "diff-name";
        name.textContent = f.path;
        const pre = document.createElement("pre");
        for (const line of f.diff.split("\n").slice(2)) {
          const span = document.createElement("span");
          span.className = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
          span.textContent = line + "\n";
          pre.append(span);
        }
        file.append(name, pre);
        wrap.append(file);
      }
      box.append(wrap);
    }
    if (state.update) {
      const u = state.update;
      const row = document.createElement("div");
      row.className = "change";
      const what = document.createElement("div");
      what.className = "what";
      const b = document.createElement("b");
      const s = document.createElement("span");
      if (u.installing) {
        b.textContent = "Updating Tweak Kit…";
        s.textContent = u.command;
      } else if (u.installed) {
        b.textContent = "Tweak Kit updated";
        s.textContent = "Restart the dev server to use it";
      } else {
        b.textContent = u.moved ? "Tweak Kit moved" : `Tweak Kit: ${u.behind} update${u.behind === 1 ? "" : "s"}`;
        s.textContent = u.error ? "Couldn't install: " + u.error : (u.latest || []).join(" · ") || "Reinstall from the new repo";
      }
      what.append(b, s);
      row.append(what);
      if (!u.installing && !u.installed) {
        const copy = document.createElement("button");
        copy.className = "btn ghost";
        copy.textContent = "Copy command";
        copy.title = u.command + ", then restart the dev server";
        copy.addEventListener("click", async () => {
          await navigator.clipboard.writeText(u.command).catch(() => {});
          toast("Copied: " + u.command);
        });
        row.append(copy);
      }
      box.append(row);
    }
    if (state.lastApply) {
      const row = document.createElement("div");
      row.className = "change";
      const what = document.createElement("div");
      what.className = "what";
      const b = document.createElement("b");
      b.textContent = `${state.lastApply.by === "direct" ? "Applied" : "Haiku applied"} ${state.lastApply.count} tweak${state.lastApply.count === 1 ? "" : "s"}`;
      const s = document.createElement("span");
      s.textContent = state.lastApply.files.join(", ");
      what.append(b, s);
      const undoApply = document.createElement("button");
      undoApply.className = "btn ghost";
      undoApply.textContent = "Undo apply";
      undoApply.title = "Put those files back as they were before this apply";
      undoApply.addEventListener("click", () => {
        undoApply.disabled = true;
        void undoLastApply();
      });
      row.append(what, undoApply);
      box.append(row);
    }
    const general = document.createElement("textarea");
    general.placeholder = "Overall note for Claude (optional)";
    general.value = state.note;
    general.style.marginTop = "6px";
    general.style.minHeight = "34px";
    general.addEventListener("input", () => {
      state.note = general.value;
      persist();
    });
    general.addEventListener("keydown", (e) => e.stopPropagation());
    if (list.length) box.append(general);

    const reset = document.createElement("button");
    reset.className = "btn ghost";
    reset.textContent = "Reset";
    reset.title = "Revert every preview";
    reset.disabled = !list.length;
    reset.addEventListener("click", resetAll);
    const copy = document.createElement("button");
    copy.className = "btn ghost";
    copy.textContent = "Copy";
    copy.title = "Copy the tweaks as JSON (paste into any chat)";
    copy.disabled = !list.length;
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(JSON.stringify(buildBatch(list), null, 2));
      toast("Copied tweaks as JSON");
    });
    const sendBtn = document.createElement("button");
    sendBtn.className = "btn primary";
    sendBtn.textContent = drafts.length ? `Send ${drafts.length} to Claude` : "Send to Claude";
    sendBtn.disabled = !drafts.length;
    sendBtn.addEventListener("click", () => send(drafts));
    const codeBtn = document.createElement("button");
    codeBtn.className = "btn ghost";
    codeBtn.textContent = "Code";
    codeBtn.title = "Show the code a Send would write directly, as a diff (nothing is written)";
    codeBtn.disabled = !drafts.length;
    codeBtn.addEventListener("click", previewCode);
    foot.append(reset, copy, codeBtn, sendBtn);
  }

  function buildBatch(list) {
    return {
      page: { url: location.href, path: location.pathname, title: document.title },
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio },
      root: ROOT || undefined,
      note: state.note || undefined,
      tweaks: list.map((t) => ({
        element: t.element,
        changes: Object.fromEntries(Object.entries(t.changes).map(([k, c]) => [k, { prop: changeProp(k, c), state: c.state, from: c.from, to: c.to, authoredIn: c.authoredIn, inlineBefore: c.inlineBefore }])),
        scope: t.scope && t.scope.kind === "viewport" ? t.scope : undefined,
        warnings: t.el.isConnected ? hiddenReasons(t).map((w) => w.text) : undefined,
        text: t.text || undefined,
        move: t.move || undefined,
        remove: t.removed || undefined,
        insert: t.insert ? { ...t.insert, html: undefined, parentSelector: undefined, ...(t.el.isConnected ? { ...insertWhere(t.el), parent: describe(t.el.parentElement) } : {}) } : undefined,
        props: t.props && Object.keys(t.props).length ? t.props : undefined,
        component: t.component || undefined,
        reach: t.reach || undefined,
        note: t.note || undefined,
      })),
    };
  }

  // Refresh descriptions: the DOM may have changed since the first edit.
  // A moved element keeps the selector of its original place, which is where the source has it.
  function refreshDescriptions(list) {
    list.forEach((t) => {
      if (!t.el.isConnected) return;
      t.element = describe(t.el);
      if (t.move) t.move = moveInfo(t.el, t.move.fromIndex);
    });
  }

  // Dry run of a Send: the code it would write, as diffs, and what is left for Haiku.
  async function previewCode() {
    const drafts = [...state.tweaks.values()].filter((t) => !t.batchId);
    if (!drafts.length) return;
    try {
      refreshDescriptions(drafts);
      const res = await fetch(API + "/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBatch(drafts)) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      state.codePreview = body;
      renderChanges();
    } catch (error) {
      toast("Couldn't preview the code. (" + error.message + ")");
    }
  }

  // A sent tweak that has left the queue is in the source now, so its preview is dropped and the page shows
  // what the source says. Compare that with what the preview showed: a difference means the write didn't
  // reproduce the design (a rule that wins, a token that resolves differently, a selector that missed).
  const sameValue = (a, b) => {
    if (a === b) return true;
    const num = /-?\d*\.?\d+/g;
    const na = String(a).match(num), nb = String(b).match(num);
    if (!na || !nb || na.length !== nb.length || String(a).replace(num, "#") !== String(b).replace(num, "#")) return false;
    const tolerance = /px/.test(String(a)) ? 0.5 : 0.01;
    return na.every((n, i) => Math.abs(parseFloat(n) - parseFloat(nb[i])) <= tolerance);
  };
  function verifyApplied(checks, attempt = 0) {
    setTimeout(() => {
      const bad = [];
      for (const c of checks) {
        let el = c.el;
        if (!el.isConnected) {
          try { el = document.querySelector(c.selector); } catch { el = null; }
        }
        if (!el) continue; // gone or re-rendered elsewhere: nothing to compare
        const got = computed(el, c.prop);
        if (!sameValue(got, c.expected)) bad.push({ ...c, el, got });
      }
      if (!bad.length) return;
      if (attempt < 3) return verifyApplied(bad, attempt + 1); // a transition may still be running
      for (const b of bad) {
        state.verifyIssues = state.verifyIssues.filter((i) => !(i.selector === b.selector && i.prop === b.prop));
        state.verifyIssues.push({ selector: b.selector, label: b.label, prop: b.prop, expected: b.expected, got: b.got, at: here(), el: b.el });
      }
      renderChanges();
      toast(`The source doesn't match the preview: ${bad[0].prop} is ${bad[0].got}, the preview had ${bad[0].expected}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ""}`);
    }, attempt ? 900 : 1200);
  }

  async function send(list) {
    if (!list.length) return;
    try {
      refreshDescriptions(list);
      state.codePreview = null;
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBatch(list)) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      list.forEach((t, i) => Object.assign(t, { batchId: body.id, sentId: `${body.id}-${i}`, skipped: null }));
      state.sentBatches.set(body.id, list.map((t) => t.key));
      state.note = "";
      persist();
      render();
      const direct = (body.direct || []).length, queued = (body.queued || []).length;
      const c = body.commit;
      const committed = c ? (c.ok ? ` · committed ${c.sha}` : ` · not committed: ${c.reason}`) : "";
      toast(
        (queued === 0 ? `Applied ${direct} directly ✓`
        : direct === 0 ? "Sent. Haiku is applying it to the source…"
        : `Applied ${direct} directly · Haiku is doing the other ${queued}…`) + committed,
      );
    } catch (error) {
      toast("Couldn't reach the tweaks server. Use Copy instead. (" + error.message + ")");
    }
  }

  // Take a sent batch back from Claude's queue; its other tweaks become drafts again.
  function withdraw(id) {
    state.sentBatches.delete(id);
    for (const t of state.tweaks.values()) if (t.batchId === id) Object.assign(t, { batchId: null, sentId: null, skipped: null });
    fetch(API + "/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
  }

  // Once Claude has applied a batch (it leaves pending.json), drop its previews: the source has them now.
  let lastVersion = null;
  async function poll() {
    try {
      const res = await fetch(API + "/status", { cache: "no-store" });
      const { pendingIds, pendingTweaks = [], version, lastApply = null, update = null, asks = [] } = await res.json();
      const asksNow = JSON.stringify(asks);
      if (asksNow !== state.asksJson) {
        state.asksJson = asksNow;
        for (const a of asks) {
          const before = (state.asks || []).find((o) => o.id === a.id);
          if (ownsPanel() && before && before.status !== a.status && a.page === here()) {
            if (a.status === "done") toast(a.kind === "edit" ? `Claude finished: ${a.summary || (a.files || []).join(", ")}` : "Variations are ready in the panel");
            if (a.status === "failed") toast(a.needs ? `Claude has a question: ${a.needs}` : `Claude couldn't do it: ${a.error || ""}`);
          }
        }
        state.asks = asks;
        if (state.isOpen) renderAskList(panel.querySelector(".ask-list"));
      }
      if (JSON.stringify(update) !== JSON.stringify(state.update)) {
        state.update = update;
        if (state.isOpen) renderChanges();
      }
      if (JSON.stringify(lastApply) !== JSON.stringify(state.lastApply)) {
        state.lastApply = lastApply;
        if (state.isOpen) renderChanges();
      }
      if (LIVE_RELOAD && version && lastVersion && version !== lastVersion) {
        persist();
        location.reload();
        return;
      }
      lastVersion = version;
      if (!ownsPanel()) return; // the owning frame settles the queue; this one mirrors it
      // A sent tweak that left the queue is in the source now: drop its preview.
      const waiting = new Map(pendingTweaks.map((p) => [p.id, p.skipped || null]));
      let applied = 0, structural = false;
      const newlySkipped = [];
      const verify = [];
      for (const t of [...state.tweaks.values()]) {
        if (!t.sentId) continue;
        if (waiting.has(t.sentId)) {
          const reason = waiting.get(t.sentId);
          if (reason !== (t.skipped || null)) {
            t.skipped = reason;
            if (reason) newlySkipped.push(reason);
          }
          continue;
        }
        state.tweaks.delete(t.key);
        if (t.el.isConnected && !t.insert && !t.removed) {
          const label = (t.element.classes[0] ? "." + t.element.classes[0] : t.element.tag);
          for (const [key, change] of Object.entries(t.changes)) {
            if (change.state || change.to === undefined) continue; // state previews can't be read without forcing the state
            const prop = changeProp(key, change);
            verify.push({ el: t.el, selector: t.element.selector, label, prop, expected: computed(t.el, prop) });
          }
        }
        for (const [key, change] of Object.entries(t.changes)) clearChange(t.el, key, change);
        if (t.insert) t.el.remove();
        if (t.move || t.removed || t.insert) structural = true;
        state.undo = state.undo.filter((u) => u.key !== t.key);
        applied++;
      }
      for (const id of [...state.sentBatches.keys()]) if (!pendingIds.includes(id)) state.sentBatches.delete(id);
      if (structural) {
        // React reuses nodes by position, so a moved or removed node can't be squared with the new source in place.
        persist();
        location.reload();
        return;
      }
      if (verify.length) verifyApplied(verify);
      if (applied || newlySkipped.length) {
        persist();
        render();
        const parts = [];
        if (applied) parts.push(`Applied ${applied} tweak${applied > 1 ? "s" : ""} to the source ✓`);
        if (newlySkipped.length) parts.push(`${newlySkipped.length} skipped: ${newlySkipped[0]}`);
        toast(parts.join(" · "));
      }
    } catch {}
  }
  // The frame showing the panel checks often; studio frames in the background less.
  (function tick() {
    (document.hidden ? Promise.resolve() : poll()).finally(() => setTimeout(tick, !STUDIO || ownsPanel() ? 1500 : 5000));
  })();

  function resetAll() {
    state.restoring = null; // drafts never matched on this screen go too
    [...state.sentBatches.keys()].forEach(withdraw);
    [...state.tweaks.values()].forEach(revertTweak);
    state.undo = [];
    state.note = "";
    persist();
    render();
  }

  /** Replaces a gradient fill with a solid color: the base color, else the gradient's last stop. */
  function makeSolid(el) {
    const base = rgbaOf(computed(el, "background-color")).a === 0
      ? toHex(splitTopLevel(computed(el, "background-image")).map((l) => (l.match(COLOR_TOKEN) || []).slice(-1)[0]).filter(Boolean).slice(-1)[0] || "#000")
      : computed(el, "background-color");
    setStyle(el, "background-color", base, true);
    setStyle(el, "background-image", "none");
  }

  async function undoLastApply() {
    try {
      const res = await fetch(API + "/undo", { method: "POST" });
      const body = await res.json();
      toast(res.ok ? `Undid the apply: ${body.files.join(", ")} restored` : `Not undone: ${body.error}`);
      if (res.ok) state.lastApply = null;
    } catch (error) {
      toast("Couldn't reach the tweaks server (" + error.message + ")");
    }
    render();
  }

  function renderQuiet() {
    const count = launch.querySelector(".count");
    count.textContent = String(state.tweaks.size);
    count.classList.toggle("hidden", state.tweaks.size === 0);
    renderChanges();
  }

  function render() {
    if (STUDIO) state.isOpen = true;
    launch.classList.toggle("hidden", state.isOpen || !!STUDIO);
    // In the studio, a frame that doesn't own the docked panel shows none of its own.
    panel.classList.toggle("hidden", !state.isOpen || (STUDIO && !ownsPanel()));
    const count = launch.querySelector(".count");
    count.textContent = String(state.tweaks.size);
    count.classList.toggle("hidden", state.tweaks.size === 0);
    if (state.isOpen) renderPanel();
  }

  function select(el) {
    if (state.selected && state.selected !== el) state.selected.removeAttribute("data-ui-tweak-force");
    state.selected = el;
    if (el && state.editState) el.setAttribute("data-ui-tweak-force", state.editState);
    updateStateSheet();
    state.expanded = {};
    if (STUDIO && el) {
      try {
        STUDIO.__studio && STUDIO.__studio.focus(window.frameElement);
      } catch {}
    }
    if (STUDIO && el && !ownsPanel()) return attachPopup(STUDIO);
    render();
  }

  function toggle(open = !state.isOpen) {
    if (STUDIO) return; // docked: the panel stays; Exit (⇱ or ✕) leaves the studio
    if (!open && state.popup) return dock(false);
    state.isOpen = open;
    if (!open) state.hovered = null;
    render();
  }

  // ---------- pop-out window ----------
  // The panel moves into a same-origin window and keeps driving this page directly.
  // The window re-attaches to the page after reloads (HMR, live reload) by polling opener.__uiTweaks.
  const POPUP_NAME = "ui-tweaks-panel";
  const POPUP_SCRIPT = `
    let api = null;
    setInterval(() => {
      try {
        const next = window.opener && !window.opener.closed ? window.opener.__uiTweaks : null;
        if (next && next !== api) { api = next; api.attachPopup(window); }
        document.title = next ? "UI Tweaks · " + window.opener.location.pathname : "UI Tweaks (page closed)";
      } catch (e) {}
    }, 400);`;

  function popOut() {
    const height = Math.min(screen.availHeight - 40, 980);
    const win = window.open("", POPUP_NAME, `popup,width=320,height=${height},left=${Math.max(0, screen.availWidth - 340)},top=20`);
    if (!win) return toast("The browser blocked the pop-out window. Allow pop-ups for this page.");
    attachPopup(win);
  }

  function attachPopup(win) {
    const doc = win.document;
    if (!doc.getElementById("ui-tweaks-root")) {
      const css = shadow.querySelector("style").textContent.replace(":host", ":root");
      doc.open();
      doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>UI Tweaks</title><style>${css}
        html, body { margin: 0; height: 100%; background: #1e1e1e; overflow: hidden; }
        .panel { position: static; inset: auto; width: 100%; height: 100vh; border: 0; border-radius: 0; box-shadow: none; }
      </style></head><body><div id="ui-tweaks-root"></div><script>${POPUP_SCRIPT}<\/script></body></html>`);
      doc.close();
    }
    if (!doc.getElementById("ui-tweaks-style")) {
      // A page that brought its own root (the studio) still needs the panel's styles.
      const style = doc.createElement("style");
      style.id = "ui-tweaks-style";
      style.textContent = shadow.querySelector("style").textContent.replace(":host", ":root") +
        "\n.panel { position: static; inset: auto; width: 100%; height: 100vh; border: 0; border-radius: 0; box-shadow: none; }";
      doc.head.appendChild(style);
    }
    const root = doc.getElementById("ui-tweaks-root");
    if (panel.ownerDocument !== doc || panel.parentNode !== root) root.replaceChildren(doc.adoptNode(panel));
    panel.classList.remove("left");
    if (state.popup !== win) {
      doc.addEventListener("keydown", onKey, true);
      doc.addEventListener("keydown", (e) => ownsPanel() && onAlt(e), true);
      doc.addEventListener("keyup", (e) => ownsPanel() && onKeyUp(e), true);
    }
    state.popup = win;
    state.isOpen = true;
    render();
  }

  function openStudio() {
    location.href = `${API}/studio?path=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  }

  function leaveStudio() {
    persist();
    STUDIO.location.href = location.href;
  }

  function dock(keepOpen = true) {
    if (STUDIO) return leaveStudio();
    const win = state.popup;
    state.popup = null;
    shadow.appendChild(document.adoptNode(panel));
    state.isOpen = keepOpen;
    if (!keepOpen) state.hovered = null;
    try { if (win && !win.closed) win.close(); } catch {}
    render();
  }

  // The person closed the pop-out window: the panel comes back closed.
  setInterval(() => {
    if (state.popup && state.popup !== STUDIO && state.popup.closed) dock(false);
  }, 500);

  // ---------- mouse: resize, move, reorder ----------
  const handles = [...shadow.querySelectorAll(".handle")];
  function drawHandles(r) {
    for (const h of handles) {
      const d = h.dataset.dir;
      // Small elements get corner handles only, so the element itself stays grabbable.
      const show = r && (d.length === 2 || (/[ns]/.test(d) ? r.width >= 28 : r.height >= 28));
      h.classList.toggle("hidden", !show);
      if (!show) continue;
      h.style.left = (d.includes("w") ? r.left : d.includes("e") ? r.right : r.left + r.width / 2) + "px";
      h.style.top = (d.includes("n") ? r.top : d.includes("s") ? r.bottom : r.top + r.height / 2) + "px";
    }
  }

  // Which offset moves an element on each axis: left/top, or right/bottom when it's pinned to that side.
  function authoredValue(el, prop) {
    const t = state.tweaks.get(keyOf(el));
    const own = t && t.changes[prop] && t.changes[prop].to;
    if (own !== undefined && own !== null) return own;
    const inline = el.style.getPropertyValue(prop);
    if (inline) return inline;
    const rule = matchedRules(el, prop)[0];
    return rule && rule.property === prop ? rule.value.replace(/\s*!important$/, "") : "";
  }
  function offsetAxes(el) {
    const set = (p) => { const v = authoredValue(el, p); return !!v && !/^auto/.test(v); };
    const pinned = computed(el, "position") !== "relative";
    const h = pinned && !set("left") && set("right") ? { prop: "right", sign: -1 } : { prop: "left", sign: 1 };
    const v = pinned && !set("top") && set("bottom") ? { prop: "bottom", sign: -1 } : { prop: "top", sign: 1 };
    for (const a of [h, v]) a.start = parseFloat(computed(el, a.prop)) || 0;
    return { h, v };
  }

  function tip(text, x, y) {
    const t = $(".drag-tip");
    if (!text) return t.classList.add("hidden");
    t.textContent = text;
    t.classList.remove("hidden");
    Object.assign(t.style, { left: x + 14 + "px", top: y + 16 + "px" });
  }
  function guide(cls, rect) {
    const g = $(cls);
    if (!rect) return g.classList.add("hidden");
    place(g, rect);
  }

  let drag = null; // pointer down on the selection, maybe dragging
  let suppressClickUntil = 0;

  function beginDrag(e, el) {
    drag = { el, x0: e.clientX, y0: e.clientY, started: false, free: e.metaKey || e.ctrlKey, kind: null };
    addEventListener("pointermove", dragMove, true);
    addEventListener("pointerup", dragEnd, true);
    addEventListener("pointercancel", dragEnd, true);
  }

  function startDrag() {
    const el = drag.el;
    const pos = computed(el, "position");
    state.dragStamp = ++stampCounter;
    drag.rect = el.getBoundingClientRect();
    if (pos === "absolute" || pos === "fixed" || drag.free) {
      // ⌘-drag frees an element in the flow: position: relative plus offsets, so nothing else moves.
      if (pos === "static") setStyle(el, "position", "relative", true);
      drag.kind = "offset";
      drag.axes = offsetAxes(el);
      drag.cb = pos === "absolute" || pos === "fixed" ? containingBlock(el).rect : null;
      return;
    }
    const flow = flowSiblings(el);
    if (flow.length < 2) {
      drag.kind = "none";
      toast("Nothing to reorder it with here. ⌘-drag to nudge it freely.");
      return;
    }
    const pcs = getComputedStyle(el.parentElement);
    const dir = pcs.flexDirection;
    const isFlex = pcs.display.includes("flex"), isGrid = pcs.display.includes("grid");
    let axis = "y";
    if (isGrid || (isFlex && dir.startsWith("row") && pcs.flexWrap !== "nowrap")) axis = "grid";
    else if (isFlex && dir.startsWith("row")) axis = "x";
    else if (!isFlex) {
      // Inline-level children sit on lines; treat them like a wrapping row.
      const tops = flow.map((c) => Math.round(c.getBoundingClientRect().top));
      if (new Set(tops).size < tops.length) axis = "grid";
    }
    drag.kind = "reorder";
    drag.axis = axis;
    drag.reverse = isFlex && dir.endsWith("reverse");
    drag.others = flow.filter((c) => c !== drag.el).map((c) => ({ el: c, r: c.getBoundingClientRect() }));
  }

  function dragMove(e) {
    if (!drag) return;
    let dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.started = true;
      startDrag();
    }
    e.preventDefault();
    e.stopPropagation();
    if (drag.kind === "offset") return dragOffset(dx, dy, e);
    if (drag.kind === "reorder") return dragReorder(dx, dy, e);
  }

  function dragOffset(dx, dy, e) {
    const { el, axes, rect, cb } = drag;
    if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    let snapX = null, snapY = null;
    if (cb && !(e.metaKey || e.ctrlKey)) {
      // Snap the element's edges and centre to the containing block's (hold ⌘/Ctrl to place freely).
      const best = (pairs) => pairs.map(([at, to]) => ({ d: to - at, to })).filter((p) => Math.abs(p.d) < 5).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
      const bx = best([[rect.left + dx, cb.left], [rect.left + dx + rect.width / 2, cb.left + cb.width / 2], [rect.right + dx, cb.left + cb.width]]);
      const by = best([[rect.top + dy, cb.top], [rect.top + dy + rect.height / 2, cb.top + cb.height / 2], [rect.bottom + dy, cb.top + cb.height]]);
      if (bx) { dx += bx.d; snapX = bx.to; }
      if (by) { dy += by.d; snapY = by.to; }
    }
    guide(".gv", snapX !== null ? { left: snapX, top: cb.top, width: 1, height: cb.height } : null);
    guide(".gh", snapY !== null ? { left: cb.left, top: snapY, width: cb.width, height: 1 } : null);
    const hv = Math.round(axes.h.start + axes.h.sign * dx), vv = Math.round(axes.v.start + axes.v.sign * dy);
    setStyle(el, axes.h.prop, hv + "px", true);
    setStyle(el, axes.v.prop, vv + "px", true);
    tip(`${axes.h.prop} ${hv} · ${axes.v.prop} ${vv}`, e.clientX, e.clientY);
  }

  function dragReorder(dx, dy, e) {
    const { rect, others, axis, reverse } = drag;
    place($(".drag-ghost"), { left: rect.left + dx, top: rect.top + dy, width: rect.width, height: rect.height });
    const x = e.clientX, y = e.clientY;
    const before = (r) => {
      let b;
      if (axis === "x") b = x < r.left + r.width / 2;
      else if (axis === "y") b = y < r.top + r.height / 2;
      else b = y < r.top || (y <= r.bottom && x < r.left + r.width / 2);
      return reverse ? !b : b;
    };
    const at = others.findIndex((o) => before(o.r));
    drag.target = at === -1 ? null : others[at].el;
    // Where it would land, unless that's where it already is.
    const flow = flowSiblings(drag.el);
    const next = flow[flow.indexOf(drag.el) + 1] || null;
    const line = $(".drop-line");
    if (drag.target === next || (!drag.target && !next)) {
      drag.noop = true;
      line.classList.add("hidden");
      tip("", 0, 0);
      return;
    }
    drag.noop = false;
    const ref = drag.target ? others[at].r : others[others.length - 1].r;
    const prev = drag.target ? others[at - 1] && others[at - 1].r : null;
    const end = !drag.target;
    if (axis === "y") {
      const yy = end ? ref.bottom + 2 : prev && prev.bottom <= ref.top ? (prev.bottom + ref.top) / 2 : ref.top - 2;
      place(line, { left: ref.left, top: yy - 1, width: ref.width, height: 3 });
    } else {
      const xx = end !== reverse ? ref.right + 2 : ref.left - 2;
      place(line, { left: xx - 1, top: ref.top, width: 3, height: ref.height });
    }
    tip("Move here", x, y);
  }

  function dragEnd(e) {
    removeEventListener("pointermove", dragMove, true);
    removeEventListener("pointerup", dragEnd, true);
    removeEventListener("pointercancel", dragEnd, true);
    const d = drag;
    drag = null;
    if (!d || !d.started) return;
    suppressClickUntil = performance.now() + 400;
    ["drag-ghost", "drop-line", "gv", "gh"].forEach((c) => $("." + c).classList.add("hidden"));
    tip("", 0, 0);
    if (d.kind === "reorder" && !d.noop && e.type === "pointerup") {
      const list = kids(d.el.parentElement).filter((c) => c !== d.el);
      const others = d.others.map((o) => o.el);
      const toIndex = d.target ? list.indexOf(d.target) : list.indexOf(others[others.length - 1]) + 1;
      moveElement(d.el, toIndex);
    }
    state.dragStamp = 0;
    render();
  }

  // Resize from the selection's handles. Shift on a corner keeps the proportions.
  for (const h of handles) {
    h.addEventListener("pointerdown", (e) => {
      const el = state.selected;
      if (!el || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const dir = h.dataset.dir;
      const w0 = parseFloat(computed(el, "width")) || el.getBoundingClientRect().width;
      const h0 = parseFloat(computed(el, "height")) || el.getBoundingClientRect().height;
      const positioned = /^(absolute|fixed)$/.test(computed(el, "position"));
      // Border-box sizes to compare with Hug and Fill, which are measured as border boxes.
      const box0 = el.getBoundingClientRect();
      const snaps = positioned ? null : { width: measureModes(el, "width"), height: measureModes(el, "height") };
      const modeNow = { width: null, height: null };
      // Resize one axis: snap to Fill or Hug near those sizes, else a fixed length.
      const sizeAxis = (axis, contentSize, borderSize) => {
        if (!snaps) {
          // Absolute or fixed: not a flex item, so just the length (no Fill/Hug, no flex properties).
          setStyle(el, axis, contentSize + "px", true);
          return "fixed";
        }
        const s = snaps && snaps[axis];
        const mode = s && Math.abs(borderSize - s.fill) < 6 && s.fill > s.hug + 6 ? "fill" : s && Math.abs(borderSize - s.hug) < 6 ? "hug" : "fixed";
        if (mode !== "fixed") {
          if (modeNow[axis] !== mode) setSizeMode(el, axis, mode, { quiet: true });
        } else {
          if (modeNow[axis] !== "fixed") setSizeMode(el, axis, "fixed", { quiet: true });
          setStyle(el, axis, contentSize + "px", true);
        }
        modeNow[axis] = mode;
        return mode;
      };
      const axes = positioned ? offsetAxes(el) : null;
      const x0 = e.clientX, y0 = e.clientY;
      state.dragStamp = ++stampCounter;
      const move = (ev) => {
        let dx = ev.clientX - x0, dy = ev.clientY - y0;
        const sx = dir.includes("e") ? 1 : dir.includes("w") ? -1 : 0;
        const sy = dir.includes("s") ? 1 : dir.includes("n") ? -1 : 0;
        let w = w0 + sx * dx, hh = h0 + sy * dy;
        if (ev.shiftKey && sx && sy) {
          const k = Math.max(w / w0, hh / h0);
          w = w0 * k;
          hh = h0 * k;
        }
        w = Math.max(1, Math.round(w));
        hh = Math.max(1, Math.round(hh));
        const mw = sx ? sizeAxis("width", w, box0.width + (w - w0)) : null;
        const mh = sy ? sizeAxis("height", hh, box0.height + (hh - h0)) : null;
        // Dragging the side an absolute element is pinned to moves that offset too.
        if (axes && sx && (axes.h.prop === "left") === (sx < 0)) setStyle(el, axes.h.prop, Math.round(axes.h.start - (w - w0)) + "px", true);
        if (axes && sy && (axes.v.prop === "top") === (sy < 0)) setStyle(el, axes.v.prop, Math.round(axes.v.start - (hh - h0)) + "px", true);
        const label = (m, v) => (m === "fill" ? "Fill" : m === "hug" ? "Hug" : v);
        tip(`${sx ? "W " + label(mw, w) : ""}${sx && sy ? " · " : ""}${sy ? "H " + label(mh, hh) : ""}`, ev.clientX, ev.clientY);
      };
      const up = () => {
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
        state.dragStamp = 0;
        tip("", 0, 0);
        render();
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
  }

  // ---------- page interaction ----------
  const picking = () => state.isOpen && state.isPicking;
  const target = (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (path.some((n) => n === host)) return null;
    const t = path[0];
    return t && t.nodeType === 1 && t !== document.documentElement && t !== document.body ? t : null;
  };

  document.addEventListener("pointermove", (e) => {
    if (!picking()) return;
    state.hovered = target(e);
    if (state.placing) showDrop(dropTarget(placingOver(state.hovered, e), e.clientX, e.clientY, e.shiftKey));
  }, true);

  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "pointerup"]) {
    document.addEventListener(type, (e) => {
      if (!picking()) return;
      const t = target(e);
      if (!t) return;
      if (t.isContentEditable && t.dataset.uiTweaksEditing) return;
      e.preventDefault();
      e.stopPropagation();
      if (state.placing) {
        if (type === "click") placeAt_(dropTarget(placingOver(t, e), e.clientX, e.clientY, e.shiftKey));
        return;
      }
      // Press on the selection (or inside it) and drag to move it; a plain click still selects.
      if (type === "pointerdown" && e.button === 0 && state.selected && state.selected.contains(t) && ownsPanel()) beginDrag(e, state.selected);
      if (type === "click" && performance.now() > suppressClickUntil) select(t);
    }, true);
  }

  document.addEventListener("dblclick", (e) => {
    if (!picking()) return;
    const t = target(e);
    if (!t || t.children.length > 0 || !(t.textContent || "").trim()) return;
    e.preventDefault();
    e.stopPropagation();
    const before = t.textContent;
    t.dataset.uiTweaksEditing = "1";
    t.contentEditable = "true";
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const finish = () => {
      t.contentEditable = "false";
      delete t.dataset.uiTweaksEditing;
      t.removeEventListener("blur", finish);
      const after = t.textContent;
      if (after === before) return;
      const tweak = tweakFor(t);
      recordUndo({ el: t, key: tweak.key, before: tweak.text ? { ...tweak.text } : null, prevText: before });
      tweak.text = { from: tweak.text ? tweak.text.from : before, to: after };
      if (tweak.text.from === after) tweak.text = null;
      if (tweak.batchId) withdraw(tweak.batchId);
      cleanup(tweak);
      persist();
      render();
    };
    t.addEventListener("blur", finish);
    t.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        t.blur();
      }
      if (ev.key === "Escape") {
        t.textContent = before;
        t.blur();
      }
    });
  }, true);

  function onKey(e) {
    if (STUDIO && e.currentTarget === STUDIO.document && !ownsPanel()) return;
    const typing = e.composedPath().some((n) => n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.isContentEditable);
    if (state.isOpen && !typing && state.selected && (e.metaKey || e.ctrlKey) && e.altKey && (e.code === "KeyC" || e.code === "KeyV")) {
      e.preventDefault();
      e.stopPropagation();
      return e.code === "KeyC" ? copyStyle(state.selected) : pasteStyle(state.selected);
    }
    if (state.isOpen && !typing && e.key === "\\" && !e.repeat) {
      e.preventDefault();
      return compare(true);
    }
    if (e.altKey && e.code === "KeyT") {
      e.preventDefault();
      if (STUDIO) return leaveStudio();
      if (CAN_DOCK && !state.isOpen) return openStudio();
      toggle();
      return;
    }
    if (!state.isOpen || typing) return;
    if (state.placing && e.key === "Escape") {
      e.preventDefault();
      state.placing = null;
      $(".drop-line").classList.add("hidden");
      return render();
    }
    const sel = state.selected && state.selected.isConnected && state.isPicking ? state.selected : null;
    const own = (run) => { e.preventDefault(); e.stopPropagation(); run(); };
    const path = e.composedPath();
    // Tab and Enter work normally on the panel's own buttons; arrows and Delete leave dropdowns alone.
    const inPanel = path.some((n) => n === host || n === panel);
    const onSelect = path.some((n) => n.tagName === "SELECT");
    if (sel && ownsPanel() && !onSelect) {
      if ((e.metaKey || e.ctrlKey) && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) return own(() => moveBy(sel, /Up|Left/.test(e.key) ? -1 : 1));
      if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !inPanel) return own(() => removeElement(sel));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && !e.shiftKey) return own(() => duplicateElement(sel));
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !inPanel) {
        const next = e.shiftKey ? sel.parentElement : kids(sel).find((c) => c.getClientRects().length > 0);
        return own(() => next && next !== document.body && next !== document.documentElement ? select(next) : toast(e.shiftKey ? "No parent to select" : "No children"));
      }
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey && !inPanel) {
        const flow = flowSiblings(sel);
        const next = flow[(flow.indexOf(sel) + (e.shiftKey ? -1 : 1) + flow.length) % flow.length];
        return own(() => next !== sel && select(next));
      }
      if (e.key === "A" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return own(() => toggleAutoLayout(sel));
    }
    if (sel && !onSelect && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      return nudge(state.selected, e.key, e.shiftKey);
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      undoPreview();
      return;
    }
    if (e.key === "Escape") {
      if (state.selected) select(null);
      else toggle(false);
    } else if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey) {
      state.isPicking = !state.isPicking;
      render();
    }
  }
  document.addEventListener("keydown", onKey, true);

  // Alt held: measure from the selection to what the pointer is over. \ released: back to the previews.
  function onKeyUp(e) {
    if (e.key === "\\") compare(false);
    if (e.key === "Alt") state.measuring = false;
  }
  function onAlt(e) {
    if (e.key === "Alt") state.measuring = true;
  }
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("keydown", onAlt, true);

  // On the studio's canvas, pinch-zoom (⌘/Ctrl + scroll) and Space-to-pan belong to the canvas, not the page.
  if (STUDIO) {
    const studio = () => {
      try {
        return STUDIO.__studio || null;
      } catch {
        return null;
      }
    };
    addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey) || !studio()) return;
      e.preventDefault();
      studio().wheel({ ctrlKey: e.ctrlKey, metaKey: e.metaKey, deltaX: e.deltaX, deltaY: e.deltaY, clientX: e.clientX, clientY: e.clientY }, window.frameElement);
    }, { passive: false });
    const isTyping = (e) => e.composedPath().some((n) => n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.isContentEditable);
    document.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || e.repeat || isTyping(e) || !studio()) return;
      e.preventDefault();
      studio().hand(true);
    }, true);
    document.addEventListener("keyup", (e) => {
      if (e.code === "Space" && studio()) studio().hand(false);
    }, true);
  }
  addEventListener("blur", () => {
    state.measuring = false;
    compare(false);
  });

  // Apps often cancel wheel events (custom scrollers, scroll-snap); scroll the panel ourselves.
  panel.addEventListener("wheel", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const scroller = e.composedPath().find((n) => n.classList && (n.classList.contains("scroll") || n.classList.contains("changes")));
    if (scroller) scroller.scrollTop += e.deltaY;
  }, { passive: false });

  // Docked beside the page by default; the in-page panel where docking isn't possible.
  launch.addEventListener("click", () => (CAN_DOCK ? openStudio() : toggle(true)));
  addEventListener("resize", () => state.isOpen && renderPanel());

  function mount() {
    document.body.appendChild(host);
    restore();
    // In the studio the screen on show holds the panel, also when it reloads; older studios used a fixed flag.
    let shown = IS_PRIMARY;
    try {
      if (STUDIO && STUDIO.__studio && STUDIO.__studio.isShown) shown = STUDIO.__studio.isShown(window.frameElement);
    } catch {}
    if (STUDIO && shown) attachPopup(STUDIO);
    else render();
  }
  if (document.body) mount();
  else addEventListener("DOMContentLoaded", mount);

  // For Claude (via the browser tools) and for debugging.
  window.__uiTweaks = {
    get tweaks() { return buildBatch([...state.tweaks.values()]); },
    open: () => toggle(true),
    attachPopup,
    close: () => toggle(false),
    select: (selector) => select(document.querySelector(selector)),
    // Scripted edits, for tests and automation: the same path as typing a value in the panel.
    setStyle: (selector, prop, value) => setStyle(document.querySelector(selector), prop, value),
    previewCode,
    verifyApplied,
    send: () => send([...state.tweaks.values()].filter((t) => !t.batchId)),
    compare,
    // Hides outlines and the launcher (for snapshots).
    hideOverlay: (on) => (host.style.visibility = on ? "hidden" : ""),
    // Average and worst times (ms) of the overlay's background work, for checking it stays light.
    stats: () => Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { runs: v.n, avg: v.n ? +(v.total / v.n).toFixed(3) : 0, max: +v.max.toFixed(3) }])),
  };
})();
