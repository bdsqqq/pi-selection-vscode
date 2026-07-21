import assert from "node:assert/strict";
import test from "node:test";
import { transformAnchor } from "./anchor";

test("typing exactly at an anchor leaves it attached to the preceding selection", () => {
  assert.equal(transformAnchor(10, [{ rangeOffset: 10, rangeLength: 0, text: "typed" }]), 10);
});

test("changes before an anchor move it with its selected text", () => {
  assert.equal(transformAnchor(10, [{ rangeOffset: 2, rangeLength: 0, text: "new" }]), 13);
  assert.equal(transformAnchor(10, [{ rangeOffset: 2, rangeLength: 3, text: "longer" }]), 13);
});

test("replacing text through an anchor attaches it to the replacement end", () => {
  assert.equal(transformAnchor(10, [{ rangeOffset: 6, rangeLength: 4, text: "replacement" }]), 17);
  assert.equal(transformAnchor(10, [{ rangeOffset: 6, rangeLength: 8, text: "new" }]), 9);
});
