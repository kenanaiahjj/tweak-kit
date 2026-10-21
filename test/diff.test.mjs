import test from "node:test";
import assert from "node:assert/strict";
import { diffHunks, unifiedDiff } from "../diff.mjs";

test("identical text has no diff", () => {
  assert.deepEqual(diffHunks("a\nb", "a\nb"), []);
  assert.equal(unifiedDiff("x.css", "a", "a"), "");
});

test("a changed line shows as a minus and a plus with context", () => {
  const out = unifiedDiff("x.css", "a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nD\ne\nf\ng", 1);
  assert.equal(out, ["--- a/x.css", "+++ b/x.css", "@@ -3,3 +3,3 @@", " c", "-d", "+D", " e"].join("\n"));
});

test("an insertion at the end", () => {
  const out = unifiedDiff("x.css", "a\nb", "a\nb\nc", 1);
  assert.match(out, /\+c/);
  assert.match(out, /@@ -2,1 \+2,2 @@/);
});

test("two far-apart edits become two hunks", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const changed = lines.slice();
  changed[2] = "X";
  changed[25] = "Y";
  const hunks = diffHunks(lines.join("\n"), changed.join("\n"), 2);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].oldStart, 1);
  assert.equal(hunks[1].oldStart, 24);
});

test("lines added in the middle keep following lines as unchanged", () => {
  const out = diffHunks("a\nb\nc", "a\nb\nNEW\nc", 5)[0].lines;
  assert.deepEqual(out, [[" ", "a"], [" ", "b"], ["+", "NEW"], [" ", "c"]]);
});
