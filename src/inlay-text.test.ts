import assert from "node:assert/strict";
import test from "node:test";
import { formatInlayText, latestUpdate } from "./inlay-text";

test("latestUpdate returns the latest non-empty single line", () => {
  assert.equal(latestUpdate(["read", "first line\ndone: changed value\n"], "running"), "done: changed value");
});

test("inlay text delegates responsive clipping to VSCodium", () => {
  assert.equal(formatInlayText("✓", "done: changed value"), "✓ done: changed value");
  assert.equal(formatInlayText("⠋", ""), "⠋");
});
