import assert from "node:assert/strict";
import test from "node:test";
import { projectSnapshot, SseParser, type AgentationSnapshot } from "./agentation";

test("SseParser handles split CRLF records and keepalives", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(": ping\r\nda"), []);
  assert.deepEqual(parser.push("ta: {\"type\":\"task.snapshot\",\r\ndata: \"taskId\":\"1\"}\r\n\r\n"), [
    '{"type":"task.snapshot",\n"taskId":"1"}',
  ]);
});

test("SseParser flushes a final event when the stream closes", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: projection\ndata: {\"type\":\"task.snapshot\"}"), []);
  assert.deepEqual(parser.end(), ['{"type":"task.snapshot"}']);
});

test("projectSnapshot replaces feed state idempotently and rejects regressions", () => {
  const running: AgentationSnapshot = {
    type: "task.snapshot",
    taskId: "task-1",
    cwd: "/work/app",
    annotations: [],
    status: "running",
    detail: "editing button.tsx",
  };
  const first = projectSnapshot(undefined, running);
  assert.deepEqual(projectSnapshot(first, running).feed, ["editing button.tsx"]);

  const completed = projectSnapshot(first, {
    ...running,
    status: "completed",
    detail: "completed",
    markdown: "done",
    sessionFile: "/sessions/task-1.jsonl",
  });
  assert.deepEqual(completed.feed, ["completed", "done"]);
  assert.equal(projectSnapshot(completed, { ...running, status: "queued" }), completed);
});
