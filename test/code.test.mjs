import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsx, toTailwind } from "../code.mjs";

const SRC = `export function App({ items }) {
  const few = items.length < 3;
  return (
    <main className="list">
      {items.map((i) => (
        <Card key={i} title={\`#\${i}\`} onClick={() => go(i > 1 ? "a" : "b")} />
      ))}
      <p>{few ? <b>few</b> : "many"}</p>
    </main>
  );
}
`;

test("extracts the element on a line, nested elements, expressions and comparisons included", () => {
  assert.equal(extractJsx(SRC, 4), SRC.split("\n").slice(3, 9).map((l) => l.slice(4)).join("\n"));
  assert.equal(extractJsx(SRC, 6), `<Card key={i} title={\`#\${i}\`} onClick={() => go(i > 1 ? "a" : "b")} />`);
  assert.equal(extractJsx(`const x = () => <div>\n  hi\n</div>;`, 1), "<div>\n  hi\n</div>");
  assert.equal(extractJsx(SRC, 2), null); // a comparison, no JSX on that line
});

test("styles to Tailwind classes, with what has no utility listed", () => {
  const out = toTailwind({ "padding-top": "20px", display: "flex", "mix-blend-mode": "multiply" });
  assert.match(out.classes, /pt-5/);
  assert.match(out.classes, /flex/);
});
