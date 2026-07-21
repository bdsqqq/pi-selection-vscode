import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentationEvent,
  projectSnapshot,
  projectionContentUrl,
  SseParser,
  type AgentationSnapshot,
} from "./agentation";

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

test("projection resets parse strictly and create a fresh snapshot regression boundary", () => {
  const reset = parseAgentationEvent(
    JSON.stringify({ type: "projection.reset", generation: "generation-2" }),
  );
  assert.deepEqual(reset, { type: "projection.reset", generation: "generation-2" });
  assert.throws(() =>
    parseAgentationEvent(JSON.stringify({ type: "projection.reset", generation: "" })),
  );
  assert.throws(() =>
    parseAgentationEvent(
      JSON.stringify({ type: "projection.reset", generation: "generation-2", taskId: "stale" }),
    ),
  );

  const completed: AgentationSnapshot = {
    type: "task.snapshot",
    taskId: "task-1",
    cwd: "/work/app",
    annotations: [],
    status: "completed",
    detail: "completed",
  };
  const previous = projectSnapshot(undefined, completed);
  const replayed = { ...completed, status: "running", detail: "replayed" } as const;
  assert.equal(projectSnapshot(previous, replayed), previous);
  assert.equal(projectSnapshot(undefined, replayed).snapshot.status, "running");
});

test("task removals parse strictly", () => {
  assert.deepEqual(parseAgentationEvent(JSON.stringify({ type: "task.remove", taskId: "task-1" })), {
    type: "task.remove",
    taskId: "task-1",
  });
  assert.throws(() => parseAgentationEvent(JSON.stringify({ type: "task.remove", taskId: "" })));
  assert.throws(() =>
    parseAgentationEvent(
      JSON.stringify({ type: "task.remove", taskId: "task-1", generation: "extra" }),
    ),
  );
});

test("task snapshots parse changed paths strictly", () => {
  const record = JSON.stringify({
    type: "task.snapshot",
    taskId: "task-1",
    cwd: "/work/app",
    annotations: [],
    changes: [{ path: "src/button.tsx" }],
    status: "completed",
    detail: "completed",
  });
  assert.deepEqual(parseAgentationEvent(record).changes, [{ path: "src/button.tsx" }]);
  assert.throws(() =>
    parseAgentationEvent(record.replace('{"path":"src/button.tsx"}', '{"path":"src/button.tsx","side":"after"}')),
  );
  assert.throws(() => parseAgentationEvent(record.replace('"src/button.tsx"', "null")));
});

test("projectionContentUrl encodes task, path, and side without an Origin parameter", () => {
  const url = projectionContentUrl(
    "http://127.0.0.1:4748/base",
    "task & one",
    "src/a file.ts",
    "before",
  );
  assert.equal(url.origin, "http://127.0.0.1:4748");
  assert.equal(url.pathname, "/projection-content");
  assert.equal(url.searchParams.get("taskId"), "task & one");
  assert.equal(url.searchParams.get("path"), "src/a file.ts");
  assert.equal(url.searchParams.get("side"), "before");
  assert.equal(url.searchParams.has("origin"), false);
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
