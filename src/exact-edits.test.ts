import assert from "node:assert/strict";
import test from "node:test";
import { applyPlannedEdits, createEditContexts, planExactEdits } from "./exact-edits";

test("exact edits preserve unrelated concurrent text", () => {
  const current = "const value = 1;\n// comment typed while Pi worked\n";
  const planned = planExactEdits(current, [{ oldText: "value = 1", newText: "value = 2" }]);

  assert.equal(
    applyPlannedEdits(current, planned),
    "const value = 2;\n// comment typed while Pi worked\n",
  );
});

test("multiple non-overlapping edits apply as one plan", () => {
  const current = "alpha beta gamma";
  const planned = planExactEdits(current, [
    { oldText: "alpha", newText: "one" },
    { oldText: "gamma", newText: "three" },
  ]);

  assert.equal(applyPlannedEdits(current, planned), "one beta three");
});

test("post-edit contexts reflect all displacement without a verification read", () => {
  const current = "zero\nalpha\nmiddle\ngamma\nend";
  const planned = planExactEdits(current, [
    { oldText: "alpha", newText: "first\nexpanded" },
    { oldText: "gamma", newText: "last" },
  ]);

  assert.deepEqual(createEditContexts(current, planned, 0), [
    { startLine: 2, endLine: 3, text: "first\nexpanded" },
    { startLine: 5, endLine: 5, text: "last" },
  ]);
});

test("stale, ambiguous, and overlapping edits fail closed", () => {
  assert.throws(
    () => planExactEdits("current", [{ oldText: "stale", newText: "next" }]),
    /not found/,
  );
  assert.throws(
    () => planExactEdits("same same", [{ oldText: "same", newText: "next" }]),
    /more than once/,
  );
  assert.throws(
    () =>
      planExactEdits("abcdef", [
        { oldText: "abcd", newText: "x" },
        { oldText: "cdef", newText: "y" },
      ]),
    /overlap/,
  );
});
