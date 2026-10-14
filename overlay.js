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
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
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

  function reactInfo(el) {
    const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (!fiberKey) return null;
    const fiber = el[fiberKey];
    const src = (f) => (f && f._debugSource ? `${relativePath(f._debugSource.fileName)}:${f._debugSource.lineNumber}` : null);
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
  function matchedRules(el, prop, st = "") {
    const names = [prop, ...(SHORTHANDS[prop] || [])];
    const found = [];
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
      all.forEach(({ rule, conditions }, order) => {
        let matchingPart = null;
        let isState = false;
        for (const part of rule.selectorText.split(",")) {
          try {
            const forState = st && part.includes(`:${st}`);
            if (el.matches(forState ? part.trim().split(`:${st}`).join(FORCE(st)) : part.trim())) {
              if (forState) isState = true;
              if (!matchingPart || selectorSpecificity(part) > selectorSpecificity(matchingPart)) matchingPart = part.trim();
            }
          } catch {}
        }
        if (!matchingPart) return;
        const conditionsHold = conditions.every((c) => (c.startsWith("@layer") ? true : (() => { try { return matchMedia(c).matches; } catch { return true; } })()));
        if (!conditionsHold) return;
        for (const name of names) {
          const value = rule.style.getPropertyValue(name);
          if (value) {
            let matches;
            try {
              matches = document.querySelectorAll(rule.selectorText).length;
            } catch {}
            found.push({
              selector: rule.selectorText.length > 200 ? matchingPart : rule.selectorText,
              matches,
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
      });
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
      state.tweaks.set(key, { key, el, element: describe(el), changes: {}, text: null, note: "", batchId: null });
    }
    return state.tweaks.get(key);
  }

  // Calls made in the same task (a linked group's four sides) share a stamp, so one undo takes them back together.
  let stamp = 0, stampCounter = 0;
  function actionStamp() {
    if (!stamp) {
      stamp = ++stampCounter;
      queueMicrotask(() => (stamp = 0));
    }
    return stamp;
  }

  function recordUndo(entry) {
    const last = state.undo[state.undo.length - 1];
    const now = Date.now();
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
      if (prop) {
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

  function applyChange(el, key, change) {
    if (change.state) return updateStateSheet();
    const prop = changeProp(key, change);
    if (el.style.getPropertyValue(prop) !== change.to || el.style.getPropertyPriority(prop) !== "important") el.style.setProperty(prop, change.to, "important");
  }

  function clearChange(el, key, change) {
    if (change && change.state) return updateStateSheet();
    restoreProp(el, changeProp(key, change), change);
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
    for (const t of state.tweaks.values()) {
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
    if (!Object.keys(tweak.changes).length && tweak.text === null && !tweak.note) state.tweaks.delete(tweak.key);
  }

  function revertTweak(tweak) {
    const changes = Object.entries(tweak.changes);
    state.tweaks.delete(tweak.key);
    for (const [key, change] of changes) clearChange(tweak.el, key, change);
    if (tweak.text) tweak.el.textContent = tweak.text.from;
  }

  function reapply(tweak) {
    for (const [key, change] of Object.entries(tweak.changes)) if (change.to !== undefined) applyChange(tweak.el, key, change);
  }

  // React may remount nodes; find them again by selector and re-apply the preview.
  setInterval(() => {
    for (const tweak of state.tweaks.values()) {
      if (!tweak.el.isConnected) {
        const again = document.querySelector(tweak.element.selector);
        if (!again) continue;
        if (state.selected === tweak.el) state.selected = again;
        tweak.el = again;
        elementKeys.set(again, tweak.key);
      }
      reapply(tweak);
    }
  }, 600);

  function persist() {
    try {
      const drafts = [...state.tweaks.values()].map((t) => ({
        selector: t.element.selector,
        changes: t.changes,
        text: t.text,
        note: t.note,
        scope: t.scope,
        batchId: t.batchId,
        sentId: t.sentId,
        skipped: t.skipped,
      }));
      localStorage.setItem(STORE_KEY, JSON.stringify({ drafts, note: state.note, sent: [...state.sentBatches] }));
    } catch {}
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!saved) return;
      state.note = saved.note || "";
      state.sentBatches = new Map(saved.sent || []);
      let waiting = saved.drafts || [];
      let tries = 0;
      const attempt = () => {
        waiting = waiting.filter((d) => {
          const el = document.querySelector(d.selector);
          if (!el) return true;
          const tweak = tweakFor(el);
          Object.assign(tweak, { changes: d.changes, text: d.text, note: d.note, scope: d.scope, batchId: d.batchId, sentId: d.sentId, skipped: d.skipped });
          reapply(tweak);
          if (d.text && d.text.to !== undefined) el.textContent = d.text.to;
          return false;
        });
        render();
        // The app may still be rendering: keep looking for a few seconds.
        if (waiting.length && ++tries < 20) setTimeout(attempt, 300);
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
    .bar .title { font-weight: 600; font-size: 12px; margin-right: auto; padding-left: 4px; }
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
    .pill.warn { background: #5a3a12; color: #ffc46b; }
    .pill { font-size: 9.5px; padding: 1px 5px; border-radius: 3px; background: #3d2f66; color: #c7b8ff; margin-left: 4px; font-weight: 600; }
    .foot { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--line); }
    .foot .btn.primary { flex: 1; }
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--bg); color: var(--text); border: 1px solid var(--line); padding: 8px 14px; border-radius: 8px; font-size: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: none; transition: opacity .2s; }
    .hidden { display: none !important; }
  </style>
  <div class="hover-box hidden"></div>
  <div class="mar m-t hidden"></div><div class="mar m-r hidden"></div><div class="mar m-b hidden"></div><div class="mar m-l hidden"></div>
  <div class="pad p-t hidden"></div><div class="pad p-r hidden"></div><div class="pad p-b hidden"></div><div class="pad p-l hidden"></div>
  <div class="sel-box hidden"></div>
  <div class="tag hidden"></div>
  <button class="launch" title="UI Tweaks (Alt+T)"><span class="dot"></span><span>Tweak</span><span class="count hidden"></span></button>
  <div class="panel hidden"></div>
  <div class="toast hidden"></div>`;

  const $ = (sel) => shadow.querySelector(sel);
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

  function drawBoxes() {
    const hoverBox = $(".hover-box");
    if (state.isOpen && state.isPicking && state.hovered && state.hovered !== state.selected) place(hoverBox, state.hovered.getBoundingClientRect());
    else hoverBox.classList.add("hidden");

    const el = state.isOpen ? state.selected : null;
    const sel = $(".sel-box");
    const tag = $(".tag");
    const sides = ["t", "r", "b", "l"];
    if (!el || !el.isConnected) {
      sel.classList.add("hidden");
      tag.classList.add("hidden");
      sides.forEach((s) => { $(".p-" + s).classList.add("hidden"); $(".m-" + s).classList.add("hidden"); });
      return;
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    place(sel, r);
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

  (function loop() {
    drawBoxes();
    requestAnimationFrame(loop);
  })();

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
  function designTokens() {
    const cacheKey = [...document.styleSheets].map((s) => (s.ownerNode && s.ownerNode.dataset && s.ownerNode.dataset.viteDevId) || s.href || "").join("|") + document.styleSheets.length;
    if (tokenCache && cacheKey === tokenCacheKey) return tokenCache;
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
      for (const { rule } of all) {
        if (!rule.selectorText.split(",").some((p) => /^(:root|html)$/.test(p.trim()))) continue;
        for (let i = 0; i < rule.style.length; i++) if (rule.style[i].startsWith("--")) names.add(rule.style[i]);
      }
    }
    const root = getComputedStyle(document.documentElement);
    const colors = [], lengths = [];
    for (const name of names) {
      const value = root.getPropertyValue(name).trim();
      if (!value) continue;
      if (/^-?[\d.]+(px|rem|em)$/.test(value)) lengths.push({ name, value });
      else if (!/^(inherit|initial|unset|currentcolor|none)$/i.test(value) && CSS.supports("color", value)) colors.push({ name, value });
    }
    tokenCache = { colors: colors.slice(0, 80), lengths: lengths.slice(0, 80) };
    tokenCacheKey = cacheKey;
    return tokenCache;
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
    solid.addEventListener("click", () => {
      const base = rgbaOf(computed(el, "background-color")).a === 0
        ? toHex(splitTopLevel(computed(el, "background-image")).map((l) => (l.match(COLOR_TOKEN) || []).slice(-1)[0]).filter(Boolean).slice(-1)[0] || "#000")
        : computed(el, "background-color");
      setStyle(el, "background-color", base, true);
      setStyle(el, "background-image", "none");
    });
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

  function section(title, ...children) {
    const sec = document.createElement("div");
    sec.className = "sec";
    const h = document.createElement("h4");
    h.textContent = title;
    sec.append(h, ...children);
    return sec;
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

  function renderPanel() {
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
    close.addEventListener("click", () => toggle(false));
    const pop = document.createElement("button");
    pop.className = "icon";
    pop.textContent = state.popup ? "⇲ Dock" : "⧉";
    pop.title = state.popup ? "Put the panel back on the page" : "Pop the panel out into its own window";
    pop.addEventListener("click", () => (state.popup ? dock() : popOut()));
    const undo = document.createElement("button");
    undo.className = "icon";
    undo.textContent = "↶";
    undo.title = "Undo the last preview edit (⌘Z / Ctrl+Z)";
    undo.disabled = state.undo.length === 0;
    undo.style.opacity = undo.disabled ? "0.35" : "1";
    undo.addEventListener("click", undoPreview);
    bar.append(title, undo, pick, pop, close);
    panel.append(bar);

    const scroll = document.createElement("div");
    scroll.className = "scroll";
    panel.append(scroll);
    const el = state.selected;

    if (!el || !el.isConnected) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = `<b>Click any element</b> to tweak it.<br/>Drag a field's label to scrub its value; Shift for ×10.<br/>Double-click text to edit it.<br/><br/>When you're happy, press <b>Send to Claude</b>. Claude edits the real source to match.`;
      scroll.append(empty);
    } else {
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
      head.append(name, meta, crumbs, layersTree(el));
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
        children.push(lbl("Alignment"));
        children.push(grid("grid2",
          selectField(el, "justify-content", "J", ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"]),
          selectField(el, "align-items", "A", ["stretch", "flex-start", "center", "flex-end", "baseline"]),
        ));
        children.push(lbl("Gap"));
        children.push(grid("grid2", numberField(el, "row-gap", "↕", { min: 0 }), numberField(el, "column-gap", "↔", { min: 0 })));
        scroll.append(section(isFlex ? "Auto layout" : "Grid layout", ...children));
      }

      scroll.append(section("Size",
        grid("grid2", numberField(el, "width", "W", { min: 0 }), numberField(el, "height", "H", { min: 0 })),
        lbl("Min / max width"),
        grid("grid2", numberField(el, "min-width", "↤", { min: 0 }), numberField(el, "max-width", "↦", { min: 0 })),
      ));

      scroll.append(section("Spacing",
        lbl("Padding"),
        linkedGroup(el, "padding", ["T", "R", "B", "L"], "▣"),
        lbl("Margin"),
        linkedGroup(el, "margin", ["T", "R", "B", "L"], "◫"),
      ));

      const hasText = (el.innerText || "").trim().length > 0;
      if (hasText) {
        scroll.append(section("Text",
          grid("grid2", numberField(el, "font-size", "Sz", { min: 1 }), selectField(el, "font-weight", "Wt", ["300", "400", "500", "600", "700", "800"])),
          grid("grid2 row", numberField(el, "line-height", "LH", { step: 0.05, min: 0 }), numberField(el, "letter-spacing", "LS", { step: 0.1 })),
          lbl("Color"),
          colorField(el, "color"),
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
      for (const [kind, label] of [["all", "All screen widths"], ["viewport", `Only at ${innerWidth}px`]]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = kind === "all" ? "Change it everywhere" : "Change it only around this screen width (Claude adds a media query)";
        if ((kind === "viewport") === isNarrow) b.classList.add("on");
        b.addEventListener("click", () => {
          const t = tweakFor(el);
          if (t.batchId) withdraw(t.batchId);
          t.scope = kind === "viewport" ? { kind, width: innerWidth } : undefined;
          cleanup(t);
          persist();
          render();
        });
        scope.append(b);
      }
      scroll.append(section("Apply to", scope, note));
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
    if (tweak.text) parts.push(`text → "${tweak.text.to.slice(0, 30)}"`);
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
      undoApply.addEventListener("click", async () => {
        undoApply.disabled = true;
        try {
          const res = await fetch(API + "/undo", { method: "POST" });
          const body = await res.json();
          toast(res.ok ? `Undid the apply: ${body.files.join(", ")} restored` : `Not undone: ${body.error}`);
          if (res.ok) state.lastApply = null;
        } catch (error) {
          toast("Couldn't reach the tweaks server (" + error.message + ")");
        }
        renderChanges();
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
    reset.addEventListener("click", () => {
      [...state.sentBatches.keys()].forEach(withdraw);
      [...state.tweaks.values()].forEach(revertTweak);
      state.undo = [];
      state.note = "";
      persist();
      render();
    });
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
    foot.append(reset, copy, sendBtn);
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
        note: t.note || undefined,
      })),
    };
  }

  async function send(list) {
    if (!list.length) return;
    try {
      // Refresh descriptions: the DOM may have changed since the first edit.
      list.forEach((t) => { if (t.el.isConnected) t.element = describe(t.el); });
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBatch(list)) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      list.forEach((t, i) => Object.assign(t, { batchId: body.id, sentId: `${body.id}-${i}`, skipped: null }));
      state.sentBatches.set(body.id, list.map((t) => t.key));
      state.note = "";
      persist();
      render();
      const direct = (body.direct || []).length, queued = (body.queued || []).length;
      toast(
        queued === 0 ? `Applied ${direct} directly ✓`
        : direct === 0 ? "Sent. Haiku is applying it to the source…"
        : `Applied ${direct} directly · Haiku is doing the other ${queued}…`,
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
      const { pendingIds, pendingTweaks = [], version, lastApply = null } = await res.json();
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
      // A sent tweak that left the queue is in the source now: drop its preview.
      const waiting = new Map(pendingTweaks.map((p) => [p.id, p.skipped || null]));
      let applied = 0;
      const newlySkipped = [];
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
        for (const [key, change] of Object.entries(t.changes)) clearChange(t.el, key, change);
        state.undo = state.undo.filter((u) => u.key !== t.key);
        applied++;
      }
      for (const id of [...state.sentBatches.keys()]) if (!pendingIds.includes(id)) state.sentBatches.delete(id);
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
  setInterval(poll, 1500);

  function renderQuiet() {
    const count = launch.querySelector(".count");
    count.textContent = String(state.tweaks.size);
    count.classList.toggle("hidden", state.tweaks.size === 0);
    renderChanges();
  }

  function render() {
    launch.classList.toggle("hidden", state.isOpen);
    panel.classList.toggle("hidden", !state.isOpen);
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
    render();
  }

  function toggle(open = !state.isOpen) {
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
    const root = doc.getElementById("ui-tweaks-root");
    if (panel.ownerDocument !== doc || panel.parentNode !== root) root.replaceChildren(doc.adoptNode(panel));
    panel.classList.remove("left");
    if (state.popup !== win) doc.addEventListener("keydown", onKey, true);
    state.popup = win;
    state.isOpen = true;
    render();
  }

  function dock(keepOpen = true) {
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
    if (state.popup && state.popup.closed) dock(false);
  }, 500);

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
  }, true);

  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "pointerup"]) {
    document.addEventListener(type, (e) => {
      if (!picking()) return;
      const t = target(e);
      if (!t) return;
      if (t.isContentEditable && t.dataset.uiTweaksEditing) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === "click") select(t);
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
    const typing = e.composedPath().some((n) => n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.isContentEditable);
    if (e.altKey && e.code === "KeyT") {
      e.preventDefault();
      toggle();
      return;
    }
    if (!state.isOpen || typing) return;
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

  // Apps often cancel wheel events (custom scrollers, scroll-snap); scroll the panel ourselves.
  panel.addEventListener("wheel", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const scroller = e.composedPath().find((n) => n.classList && (n.classList.contains("scroll") || n.classList.contains("changes")));
    if (scroller) scroller.scrollTop += e.deltaY;
  }, { passive: false });

  launch.addEventListener("click", () => toggle(true));
  addEventListener("resize", () => state.isOpen && renderPanel());

  function mount() {
    document.body.appendChild(host);
    restore();
    render();
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
  };
})();
