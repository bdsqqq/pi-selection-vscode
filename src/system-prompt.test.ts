import assert from "node:assert/strict";
import test from "node:test";
import { PI_SELECTION_SYSTEM_PROMPT } from "./system-prompt";

test("selection system prompt fixes communication and mutation protocols", () => {
  assert.match(PI_SELECTION_SYSTEM_PROMPT, /fewest tool rounds/);
  assert.match(PI_SELECTION_SYSTEM_PROMPT, /at most 72 Unicode characters/);
  assert.match(PI_SELECTION_SYSTEM_PROMPT, /apply_patch is the only mutation tool/);
  assert.match(PI_SELECTION_SYSTEM_PROMPT, /do not reread it/);
  assert.match(PI_SELECTION_SYSTEM_PROMPT, /Never replace unrelated text/);
});
