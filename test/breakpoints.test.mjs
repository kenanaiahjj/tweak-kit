import test from "node:test";
import assert from "node:assert/strict";
import { breakpointsIn, scopeFor, summarize } from "../breakpoints.mjs";

test("reads max-width, min-width, rem and range syntax from @media rules", () => {
  const css = `@media (max-width: 430px) { a { x: y } }
@media screen and (min-width: 48rem) and (max-width: 1024px) { b { x: y } }
@media (width <= 600px) { c { x: y } }
/* @media (max-width: 111px) { } */`;
  assert.deepEqual(breakpointsIn(css), [
    { kind: "max", px: 430 }, { kind: "min", px: 768 }, { kind: "max", px: 1024 }, { kind: "max", px: 600 },
  ]);
});

test("a desktop-first project scopes to the nearest max-width breakpoint above the width", () => {
  const s = summarize(breakpointsIn("@media (max-width: 430px){a{x:y}} @media (max-width: 768px){a{x:y}} @media (max-width: 768px){b{x:y}}"));
  assert.equal(s.style, "max");
  assert.deepEqual(scopeFor(s, 375), { query: "(max-width: 430px)", label: "At 430px and below", px: 430 });
  assert.equal(scopeFor(s, 600).px, 768);
  assert.equal(scopeFor(s, 1317), null);
});

test("a mobile-first project scopes to the largest min-width breakpoint at or below the width", () => {
  const s = summarize(breakpointsIn("@media (min-width: 640px){a{x:y}} @media (min-width: 1024px){a{x:y}}"));
  assert.equal(s.style, "min");
  assert.deepEqual(scopeFor(s, 800), { query: "(min-width: 640px)", label: "From 640px up", px: 640 });
  assert.equal(scopeFor(s, 1317).px, 1024);
  assert.deepEqual(scopeFor(s, 375), { query: "(max-width: 639px)", label: "Below 640px", px: 639 });
});

test("no breakpoints means no scope", () => {
  assert.equal(summarize([]).style, null);
  assert.equal(scopeFor(summarize([]), 375), null);
});
