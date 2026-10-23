// A review page for stakeholders: every screen captured by the studio, side by side with another
// version when comparing, which screens changed, and a note. One self-contained HTML file (the images
// are embedded), saved in .ui-tweaks/reviews/, so it can be opened locally, attached, or published.
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_IMAGE = 4_000_000; // per data URL; the studio sends compressed WebP at the fitted size

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isImage = (u) => typeof u === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length < MAX_IMAGE;

export const reviewsDir = (root) => path.join(root, ".ui-tweaks", "reviews");

/** A file name from the title and time: "checkout-flow-2026-10-23-1405". */
export function reviewSlug(title, at = new Date()) {
  // Local time, as the person making it reads the clock.
  const two = (n) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
  const base = String(title || "review").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "review";
  return `${base}-${stamp}`;
}

/**
 * The page. `data`: { title, note, project, at, versions: { here: {name, detail}, there?: {name, detail} },
 * screens: [{ name, url, size, changed?, here, there? }] } where here/there are image data URLs.
 */
export function reviewPage(data) {
  const versions = { ...(data.versions || {}) };
  versions.here = versions.here || { name: "" };
  const pair = !!versions.there;
  const screens = (data.screens || []).filter((s) => isImage(s.here));
  const changed = screens.filter((s) => s.changed).length;
  const when = new Date(data.at || Date.now());
  const date = when.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
  // A version's badge and detail; nothing for a gallery of one unnamed version.
  const side = (cls, v) => (v && v.name ? `<span class="badge ${cls}"><i></i>${esc(v.name)}</span><span class="detail">${esc(v.detail || "")}</span>` : "");
  const figure = (img, v, cls, alt) =>
    `<figure class="${cls}">${v && v.name ? `<figcaption>${side(cls, v)}</figcaption>` : ""}<button class="shot" data-full aria-label="Open ${esc(alt)} larger"><img src="${img}" alt="${esc(alt)}" loading="lazy"></button></figure>`;
  const cards = screens
    .map((s, i) => {
      const status = pair ? (s.changed ? '<span class="tag changed">Changed</span>' : '<span class="tag same">No visible change</span>') : "";
      const body = pair && isImage(s.there)
        ? `<div class="pair">${figure(s.here, versions.here, "here", `${s.name}, ${versions.here.name}`)}${figure(s.there, versions.there, "there", `${s.name}, ${versions.there.name}`)}</div>`
        : `<div class="single">${figure(s.here, versions.here, "here", s.name)}</div>`;
      return `<section class="screen${s.changed ? " is-changed" : ""}" id="s${i + 1}"><header><h2>${esc(s.name)}</h2>${status}<code>${esc(s.url || "")}</code><span class="size">${esc(s.size || "")}</span></header>${body}</section>`;
    })
    .join("\n");
  const toc = screens.map((s, i) => `<a href="#s${i + 1}" class="${s.changed ? "is-changed" : ""}">${esc(s.name)}</a>`).join("");
  const summary = pair
    ? `${screens.length} screen${screens.length === 1 ? "" : "s"} · <b>${changed} changed</b> · ${screens.length - changed} unchanged`
    : `${screens.length} screen${screens.length === 1 ? "" : "s"}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title || "Design review")}</title>
<style>
  :root { --bg: #f6f6f7; --card: #fff; --text: #18181b; --dim: #71717a; --line: rgba(0,0,0,.08); --fill: rgba(0,0,0,.04);
    --here: #1d4ed8; --here-bg: #dbeafe; --there: #b45309; --there-bg: #fef3c7; --changed: #b91c1c; --changed-bg: #fee2e2; --same: #15803d; --same-bg: #dcfce7;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #171717; --card: #212121; --text: rgba(255,255,255,.95); --dim: rgba(255,255,255,.55); --line: rgba(255,255,255,.08); --fill: rgba(255,255,255,.05);
      --here: #6cb8ff; --here-bg: rgba(13,153,255,.16); --there: #ffc46b; --there-bg: rgba(255,196,107,.16); --changed: #fca5a5; --changed-bg: rgba(239,68,68,.16); --same: #86efac; --same-bg: rgba(34,197,94,.14); }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 40px 16px 80px; }
  .top h1 { margin: 0; font-size: clamp(24px, 4vw, 34px); letter-spacing: -.02em; line-height: 1.15; }
  .meta { margin-top: 8px; color: var(--dim); font-size: 14px; }
  .meta b { color: var(--text); }
  .legend { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-top: 16px; align-items: center; }
  .note { margin-top: 18px; padding: 14px 16px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); white-space: pre-wrap; max-width: 760px; }
  .controls { position: sticky; top: 0; z-index: 5; margin: 24px -16px 0; padding: 10px 16px; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
  .controls label { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; cursor: pointer; }
  .toc { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; }
  .toc a { flex: none; padding: 4px 10px; border-radius: 999px; background: var(--fill); color: var(--dim); text-decoration: none; font-size: 13px; white-space: nowrap; }
  .toc a.is-changed { color: var(--changed); background: var(--changed-bg); }
  .screen { margin-top: 28px; padding: 18px; border-radius: 16px; background: var(--card); border: 1px solid var(--line); scroll-margin-top: 70px; }
  .screen header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; margin-bottom: 14px; }
  .screen h2 { margin: 0; font-size: 19px; letter-spacing: -.01em; }
  .screen code { font: 12.5px var(--mono); color: var(--dim); overflow-wrap: anywhere; }
  .screen .size { font: 12px var(--mono); color: var(--dim); }
  .tag { font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; }
  .tag.changed { color: var(--changed); background: var(--changed-bg); }
  .tag.same { color: var(--same); background: var(--same-bg); }
  body.only-changed .screen:not(.is-changed), body.only-changed .toc a:not(.is-changed) { display: none; }
  .pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; align-items: start; }
  .single { display: grid; grid-template-columns: minmax(0, 560px); }
  @media (max-width: 720px) { .pair { grid-template-columns: minmax(0, 1fr); } }
  figure { margin: 0; min-width: 0; }
  figcaption { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; min-width: 0; }
  .badge { flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 3px 11px; border-radius: 999px; font-weight: 600; font-size: 14px; }
  .badge i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .badge.here { color: var(--here); background: var(--here-bg); }
  .badge.there { color: var(--there); background: var(--there-bg); }
  .detail { color: var(--dim); font: 12px var(--mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend .detail { white-space: normal; }
  .shot { display: flex; justify-content: center; width: 100%; padding: 0; border: 0; background: none; cursor: zoom-in; border-radius: 12px; }
  /* Tall phone screens stay readable without filling the page: capped height, natural width. */
  .shot img { display: block; width: auto; max-width: 100%; height: auto; max-height: min(78vh, 880px); border-radius: 12px; box-shadow: 0 0 0 1px var(--line), 0 8px 30px rgba(0,0,0,.12); }
  figure.here .shot img { box-shadow: 0 0 0 2px color-mix(in srgb, var(--here) 55%, transparent), 0 8px 30px rgba(0,0,0,.12); }
  figure.there .shot img { box-shadow: 0 0 0 2px color-mix(in srgb, var(--there) 55%, transparent), 0 8px 30px rgba(0,0,0,.12); }
  .viewer { position: fixed; inset: 0; z-index: 10; display: none; place-items: center; padding: 24px 16px; background: rgba(0,0,0,.82); cursor: zoom-out; }
  .viewer.open { display: grid; }
  .viewer img { max-width: 100%; max-height: 100%; border-radius: 10px; }
  footer { margin-top: 40px; color: var(--dim); font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>${esc(data.title || "Design review")}</h1>
    <div class="meta">${esc(data.project || "")}${data.project ? " · " : ""}${esc(date)} · ${summary}</div>
    ${pair ? `<div class="legend">${side("here", versions.here)}${side("there", versions.there)}</div>` : ""}
    ${data.note ? `<div class="note">${esc(data.note)}</div>` : ""}
  </div>
  <div class="controls">
    ${pair ? '<label><input type="checkbox" class="only"> Changed screens only</label>' : ""}
    <nav class="toc" aria-label="Screens">${toc}</nav>
  </div>
  ${cards || '<p class="meta">No screens were captured.</p>'}
  <footer>Made with the UI tweak kit studio. Screens are captures of the running app at the time above.</footer>
</div>
<div class="viewer" role="dialog" aria-label="Screen, larger"><img alt=""></div>
<script>
  const viewer = document.querySelector(".viewer");
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-full]");
    if (b) { viewer.querySelector("img").src = b.querySelector("img").src; viewer.classList.add("open"); }
    else if (e.target.closest(".viewer")) viewer.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") viewer.classList.remove("open"); });
  const only = document.querySelector(".only");
  if (only) only.addEventListener("change", () => document.body.classList.toggle("only-changed", only.checked));
</script>
</body>
</html>
`;
}

/** Saves a review: { slug, file } (file relative to the project). */
export async function saveReview(root, data) {
  if (!data || !Array.isArray(data.screens) || !data.screens.some((s) => isImage(s && s.here))) throw Object.assign(new Error("No screens to put in the review"), { status: 400 });
  const at = new Date(data.at || Date.now());
  const slug = reviewSlug(data.title, at);
  await fs.mkdir(reviewsDir(root), { recursive: true });
  const file = path.join(reviewsDir(root), `${slug}.html`);
  await fs.writeFile(file, reviewPage({ ...data, at: at.getTime() }));
  return { slug, file: path.relative(root, file), screens: data.screens.length };
}

/** Saved reviews, newest first: [{ slug, file, at }]. */
export async function listReviews(root) {
  const names = await fs.readdir(reviewsDir(root)).catch(() => []);
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".html")) continue;
    const stat = await fs.stat(path.join(reviewsDir(root), n)).catch(() => null);
    if (stat) out.push({ slug: n.slice(0, -5), file: path.join(".ui-tweaks", "reviews", n), at: stat.mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function readReview(root, slug) {
  if (!/^[a-z0-9-]+$/.test(slug || "")) return null;
  return fs.readFile(path.join(reviewsDir(root), `${slug}.html`), "utf8").catch(() => null);
}
