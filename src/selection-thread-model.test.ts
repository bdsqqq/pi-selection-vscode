import assert from "node:assert/strict";
import test from "node:test";
import type { SelectionRequest } from "./coordinator";
import {
  isSelectionReplyable,
  selectionDecorationStatus,
  selectionThreadItems,
  transformSelectionOffsets,
  type SelectionThreadMessage,
} from "./selection-thread-model";

const request: SelectionRequest = {
  instruction: "explain this",
  relativeFile: "src/example.ts",
  language: "typescript",
  startLine: 3,
  endLine: 4,
  text: "const answer = 42;",
};

const messages: SelectionThreadMessage[] = [
  { role: "user", body: "first follow-up" },
  { role: "assistant", body: "first answer" },
  { role: "user", body: "second follow-up" },
];

test("selection thread items keep the request first and messages ordered", () => {
  const items = selectionThreadItems(request, messages);
  assert.equal(items[0]?.kind, "request");
  assert.deepEqual(
    items.slice(1).map((item) => item.kind === "message" && item.message.body),
    ["first follow-up", "first answer", "second follow-up"],
  );
});

test("only terminal jobs with a complete session identity are replyable", () => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    assert.equal(
      isSelectionReplyable({ status, sessionFile: "/tmp/session.jsonl", sessionId: "session-1" }),
      true,
    );
  }
  for (const status of ["queued", "running"] as const) {
    assert.equal(
      isSelectionReplyable({ status, sessionFile: "/tmp/session.jsonl", sessionId: "session-1" }),
      false,
    );
  }
  assert.equal(isSelectionReplyable({ status: "completed" }), false);
  assert.equal(isSelectionReplyable({ status: "completed", sessionFile: "/tmp/session.jsonl" }), false);
});

test("aborted jobs use the packaged failure status decoration", () => {
  assert.equal(selectionDecorationStatus("aborted"), "failed");
  assert.equal(selectionDecorationStatus("completed"), "completed");
  assert.equal(selectionDecorationStatus("running"), "running");
});

test("selection offsets follow edits without absorbing boundary insertions", () => {
  assert.deepEqual(
    transformSelectionOffsets(
      { start: 10, end: 20 },
      [
        { rangeOffset: 2, rangeLength: 0, text: "abc" },
        { rangeOffset: 10, rangeLength: 0, text: "start" },
        { rangeOffset: 20, rangeLength: 0, text: "end" },
      ],
    ),
    { start: 18, end: 28 },
  );
});

test("selection offsets collapse safely when an edit consumes the selection", () => {
  assert.deepEqual(
    transformSelectionOffsets(
      { start: 10, end: 20 },
      [{ rangeOffset: 5, rangeLength: 20, text: "replacement" }],
    ),
    { start: 16, end: 16 },
  );
});
