import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findRoutes, routeOfFile, routesInCode } from "../routes.mjs";

test("file-routing conventions", () => {
  const r = (f) => routeOfFile(f)?.path ?? null;
  assert.equal(r("src/routes/+page.svelte"), "/");
  assert.equal(r("src/routes/(app)/settings/+page.svelte"), "/settings");
  assert.equal(r("src/routes/blog/[slug]/+page.svelte"), "/blog/[slug]");
  assert.equal(r("pages/users/[id].vue"), "/users/[id]");
  assert.equal(r("pages/index.vue"), "/");
  assert.equal(r("src/pages/about.astro"), "/about");
  assert.equal(r("src/pages/blog/index.md"), "/blog");
  assert.equal(r("app/routes/_index.tsx"), "/");
  assert.equal(r("app/routes/users.$id.edit.tsx"), "/users/$id/edit");
  assert.equal(r("app/routes/_auth.login.tsx"), "/login");
  assert.equal(r("app/routes/posts_.$slug/route.tsx"), "/posts/$slug");
  assert.equal(r("app/routes/sitemap[.]xml.tsx"), "/sitemap.xml");
  assert.equal(r("src/components/Button.tsx"), null);
});

test("route paths in code, nested children joined to their parents", () => {
  const objects = `createBrowserRouter([{ path: "/", children: [ { path: "settings", children: [{ path: "profile" }] }, { path: "help" } ] }, { path: "/login" }]);
    const icon = { path: "./icons/a.svg" };`;
  assert.deepEqual(routesInCode(objects).sort(), ["/", "/help", "/login", "/settings", "/settings/profile"]);
  const jsx = `<Routes><Route path="/app" element={<A/>}><Route path="inbox" element={<B/>} /><Route index element={<C/>} /></Route><Route path="/about" element={<D/>} /></Routes>`;
  assert.deepEqual(routesInCode(jsx), ["/app", "/app/inbox", "/about"]);
  assert.deepEqual(routesInCode(`export default [index("routes/home.tsx"), route("about", "routes/about.tsx"), route("users/:id", "routes/user.tsx")];`), ["/about", "/users/:id"]);
  assert.deepEqual(routesInCode(`export const Route = createFileRoute("/posts/$postId")({})`), ["/posts/$postId"]);
});

test("a project's routes, with parameters marked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-r-"));
  for (const [file, text] of [["src/routes/+page.svelte", ""], ["src/routes/blog/[slug]/+page.svelte", ""], ["src/lib/x.ts", "const a = 1;"]]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  assert.deepEqual(await findRoutes(root), [{ path: "/", source: "SvelteKit", params: undefined }, { path: "/blog/[slug]", source: "SvelteKit", params: true }]);
});
