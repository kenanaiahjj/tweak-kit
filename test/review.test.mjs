import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addAsk } from "../asks.mjs";
import { listReviews, readReview, reviewPage, reviewSlug, saveReview } from "../review.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("a slug from the title and time", () => {
  assert.equal(reviewSlug("Checkout flow: v2!", new Date(2026, 9, 23, 14, 5)), "checkout-flow-v2-2026-10-23-1405");
  assert.equal(reviewSlug("", new Date(2026, 9, 23, 14, 5)), "review-2026-10-23-1405");
});

test("the page pairs both versions, counts changes and escapes what people typed", () => {
  const html = reviewPage({
    title: "Main <vs> experiment",
    note: "Look at the CTA",
    versions: { here: { name: "main", detail: "uncommitted" }, there: { name: "experiment", detail: "a1b2c3d" } },
    screens: [
      { name: "Home", url: "/", size: "393×852", here: PNG, there: PNG, changed: true },
      { name: "Settings", url: "/settings", size: "393×852", here: PNG, there: PNG, changed: false },
      { name: "Broken", url: "/x", here: "javascript:alert(1)" },
    ],
  });
  assert.match(html, /<title>Main &lt;vs&gt; experiment<\/title>/);
  assert.match(html, /2 screens · <b>1 changed<\/b> · 1 unchanged/);
  assert.equal((html.match(/class="tag changed"/g) || []).length, 1);
  assert.match(html, /Changed screens only/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.match(html, /badge there"><i><\/i>experiment/);
});

test("a single version is a gallery without change tags", () => {
  const html = reviewPage({ title: "Screens", versions: { here: { name: "" } }, screens: [{ name: "Home", url: "/", here: PNG }] });
  assert.doesNotMatch(html, /class="tag /);
  assert.doesNotMatch(html, /Changed screens only/);
  assert.match(html, /1 screen</);
});

test("saves, lists and reads reviews; refuses an empty one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uit-review-"));
  await assert.rejects(saveReview(root, { title: "x", screens: [] }), /No screens/);
  const out = await saveReview(root, { title: "First look", screens: [{ name: "Home", url: "/", here: PNG }] });
  assert.match(out.file, /^\.ui-tweaks\/reviews\/first-look-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);
  assert.equal((await listReviews(root))[0].slug, out.slug);
  assert.match(await readReview(root, out.slug), /First look/);
  assert.equal(await readReview(root, "../../etc/passwd"), null);
});

test("a publish request needs a review file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uit-review-ask-"));
  await assert.rejects(addAsk(root, { kind: "publish", file: "../secrets.html" }), /review file/);
  const ask = await addAsk(root, { kind: "publish", file: ".ui-tweaks/reviews/first-look-2026-10-23-1405.html", title: "First look", instruction: "Publish" });
  assert.equal(ask.kind, "publish");
  assert.equal(ask.title, "First look");
});
