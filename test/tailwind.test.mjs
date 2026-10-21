import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTailwind, planUtilities, splitVariants, utilityFor, variantFor } from "../tailwind.mjs";

const plan = (classes, changes, opts) => planUtilities(classes.split(" "), changes, opts);

test("padding on the scale becomes a scale class and replaces the same side", () => {
  const out = plan("flex pt-2 text-sm", [{ prop: "padding-top", to: "20px" }]);
  assert.deepEqual(out.classes, ["flex", "text-sm", "pt-5"]);
  assert.deepEqual(out.applied, ["padding-top"]);
});

test("a broader utility stays when one side is set: p-4 + pt-5", () => {
  assert.deepEqual(plan("p-4", [{ prop: "padding-top", to: "20px" }]).classes, ["p-4", "pt-5"]);
});

test("off-scale values use arbitrary utilities, spaces become underscores", () => {
  assert.equal(utilityFor("padding-top", "18px").cls, "pt-[18px]");
  assert.equal(utilityFor("box-shadow", "0 4px 12px rgba(0, 0, 0, 0.2)").cls, "shadow-[0_4px_12px_rgba(0,_0,_0,_0.2)]");
});

test("font-size is always arbitrary (text-lg would change line-height) and keeps color and align", () => {
  const out = plan("text-white text-center text-sm", [{ prop: "font-size", to: "18px" }]);
  assert.deepEqual(out.classes, ["text-white", "text-center", "text-[18px]"]);
});

test("text color replaces the old color but not size or align", () => {
  const out = plan("text-sm text-center text-red-500", [{ prop: "color", to: "#111" }]);
  assert.deepEqual(out.classes, ["text-sm", "text-center", "text-[#111]"]);
});

test("var() values carry a type hint where Tailwind needs one", () => {
  assert.equal(utilityFor("color", "var(--brand)").cls, "text-[color:var(--brand)]");
  assert.equal(utilityFor("background-color", "var(--brand)").cls, "bg-[color:var(--brand)]");
  assert.equal(utilityFor("font-size", "var(--fs)").cls, "text-[length:var(--fs)]");
  assert.equal(utilityFor("gap", "var(--space-4)").cls, "gap-[var(--space-4)]");
});

test("font weight uses the named classes, background keeps cover/none etc.", () => {
  assert.deepEqual(plan("font-bold", [{ prop: "font-weight", to: "600" }]).classes, ["font-semibold"]);
  assert.deepEqual(plan("bg-cover bg-red-500", [{ prop: "background-color", to: "#fff" }]).classes, ["bg-cover", "bg-[#fff]"]);
});

test("keyword props swap within their group", () => {
  assert.deepEqual(plan("flex items-start justify-between", [{ prop: "align-items", to: "center" }]).classes, ["flex", "justify-between", "items-center"]);
  assert.deepEqual(plan("block", [{ prop: "display", to: "none" }]).classes, ["hidden"]);
});

test("state and width become variants, and only same-variant classes are replaced", () => {
  const hover = plan("bg-red-500 hover:bg-red-600", [{ prop: "background-color", to: "#000", state: "hover" }]);
  assert.deepEqual(hover.classes, ["bg-red-500", "hover:bg-[#000]"]);
  assert.deepEqual(plan("pt-2 max-md:pt-1", [{ prop: "padding-top", to: "12px" }], { query: "(max-width: 767px)" }).classes, ["pt-2", "max-md:pt-3"]);
  assert.deepEqual(plan("pt-2", [{ prop: "padding-top", to: "12px" }], { query: "(min-width: 640px)" }).classes, ["pt-2", "sm:pt-3"]);
  assert.equal(variantFor({ query: "(max-width: 430px)" }).prefix, "max-[430px]:");
});

test("props with no utility are skipped with a reason, the rest still apply", () => {
  const out = plan("p-2", [{ prop: "backdrop-filter", to: "blur(4px)" }, { prop: "padding-left", to: "8px" }]);
  assert.deepEqual(out.applied, ["padding-left"]);
  assert.match(out.skipped[0].reason, /no Tailwind class for backdrop-filter/);
  assert.equal(variantFor({ state: "visited" }).error.includes("no Tailwind variant"), true);
});

test("splitVariants keeps arbitrary variants whole", () => {
  assert.deepEqual(splitVariants("max-[430px]:hover:pt-4"), { variants: "max-[430px]:hover:", base: "pt-4" });
  assert.deepEqual(splitVariants("bg-[color:var(--x)]"), { variants: "", base: "bg-[color:var(--x)]" });
});

test("detectTailwind reads package.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uitk-tw-"));
  assert.equal(await detectTailwind(root), null);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { tailwindcss: "^4.1.0" } }));
  assert.deepEqual(await detectTailwind(root), { major: 4 });
});
