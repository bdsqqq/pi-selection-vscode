import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProjectionReplyResponse,
  parseAgentationEvent,
  parseProjectionRejectionPreparation,
  ProjectionReplyError,
  ProjectionRejectionError,
  projectSnapshot,
  projectionContentUrl,
  projectionReplyRequest,
  projectionRejectionAckRequest,
  projectionRejectionPrepareRequest,
  sendProjectionReplyWithRetry,
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
    revision: 2,
    status: "completed",
    detail: "completed",
  };
  const previous = projectSnapshot(undefined, completed);
  const replayed = { ...completed, revision: 1, status: "running", detail: "replayed" } as const;
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
    revision: 1,
    changes: [{ path: "src/button.tsx" }],
    status: "completed",
    detail: "completed",
  });
  assert.deepEqual(parseAgentationEvent(record).changes, [{ path: "src/button.tsx" }]);
  assert.throws(() => parseAgentationEvent(record.replace('"revision":1,', "")));
  assert.throws(() => parseAgentationEvent(record.replace('"revision":1', '"revision":0')));
  assert.throws(() => parseAgentationEvent(record.replace('"revision":1', '"revision":1.5')));
  assert.throws(() =>
    parseAgentationEvent(record.replace('{"path":"src/button.tsx"}', '{"path":"src/button.tsx","side":"after"}')),
  );
  assert.throws(() => parseAgentationEvent(record.replace('"src/button.tsx"', "null")));
});

test("task snapshots parse messages strictly", () => {
  const snapshot = {
    type: "task.snapshot",
    taskId: "task-1",
    cwd: "/work/app",
    annotations: [],
    revision: 1,
    messages: [
      { id: "message-1", role: "user", body: "follow up" },
      { id: "message-2", annotationId: "annotation-1", role: "assistant", body: "done" },
    ],
    status: "completed",
    detail: "completed",
  };
  assert.deepEqual(parseAgentationEvent(JSON.stringify(snapshot)).messages, snapshot.messages);
  assert.throws(() =>
    parseAgentationEvent(JSON.stringify({ ...snapshot, messages: [{ ...snapshot.messages[0], extra: true }] })),
  );
  assert.throws(() =>
    parseAgentationEvent(JSON.stringify({ ...snapshot, messages: [{ id: "message-1", role: "system", body: "no" }] })),
  );
});

test("projection replies build exact JSON posts and distinguish response statuses", () => {
  const request = projectionReplyRequest(
    "http://127.0.0.1:4748/base",
    "generation-1",
    "task & one",
    "annotation-1",
    "  faithful text  ",
    "request-1",
  );
  assert.equal(request.url.toString(), "http://127.0.0.1:4748/projection-replies");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(request.init.headers, { "content-type": "application/json" });
  assert.equal(
    request.init.body,
    JSON.stringify({
      generation: "generation-1",
      taskId: "task & one",
      annotationId: "annotation-1",
      text: "  faithful text  ",
      requestId: "request-1",
    }),
  );
  assert.doesNotThrow(() => assertProjectionReplyResponse(202));
  assert.throws(() => assertProjectionReplyResponse(409), ProjectionReplyError);
  assert.match(new ProjectionReplyError(409).message, /busy/);
  assert.match(new ProjectionReplyError(410).message, /expired/);
  assert.match(new ProjectionReplyError(404).message, /unavailable/);
});

test("projection reply retry preserves body and request id after a transport failure", async () => {
  const request = projectionReplyRequest(
    "http://127.0.0.1:4748",
    "generation-1",
    "task-1",
    "annotation-1",
    "same text",
    "stable-request",
  );
  const bodies: BodyInit[] = [];
  let validations = 0;
  await sendProjectionReplyWithRetry(
    async (_url, init) => {
      bodies.push(init.body!);
      if (bodies.length === 1) throw new Error("socket closed after write");
      return { status: 202 };
    },
    request.url,
    request.init,
    new AbortController().signal,
    () => { validations += 1; },
  );
  assert.equal(validations, 2);
  assert.deepEqual(bodies, [request.init.body, request.init.body]);
  assert.match(String(bodies[0]), /"requestId":"stable-request"/);

  let httpAttempts = 0;
  await assert.rejects(
    sendProjectionReplyWithRetry(
      async () => {
        httpAttempts += 1;
        return { status: 409 };
      },
      request.url,
      request.init,
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof ProjectionReplyError && /busy/.test(error.message),
  );
  assert.equal(httpAttempts, 1);
});

test("projectionContentUrl encodes task, path, and side without an Origin parameter", () => {
  const url = projectionContentUrl(
    "http://127.0.0.1:4748/base",
    "generation-1",
    "task & one",
    "src/a file.ts",
    "before",
  );
  assert.equal(url.origin, "http://127.0.0.1:4748");
  assert.equal(url.pathname, "/projection-content");
  assert.equal(url.searchParams.get("generation"), "generation-1");
  assert.equal(url.searchParams.get("taskId"), "task & one");
  assert.equal(url.searchParams.get("path"), "src/a file.ts");
  assert.equal(url.searchParams.get("side"), "before");
  assert.equal(url.searchParams.has("origin"), false);
});

test("projection rejection prepare and ack build generation-bound JSON posts", () => {
  const prepared = projectionRejectionPrepareRequest(
    "http://127.0.0.1:4748/base",
    "generation-1",
    "task & one",
    "src/a file.ts",
    "request-1",
  );
  assert.equal(prepared.url.toString(), "http://127.0.0.1:4748/projection-rejections/prepare");
  assert.equal(prepared.init.method, "POST");
  assert.deepEqual(prepared.init.headers, { "content-type": "application/json" });
  assert.equal(
    prepared.init.body,
    JSON.stringify({
      generation: "generation-1",
      taskId: "task & one",
      path: "src/a file.ts",
      requestId: "request-1",
    }),
  );

  const ack = projectionRejectionAckRequest(
    "http://127.0.0.1:4748/base",
    "generation-1",
    "operation-1",
  );
  assert.equal(ack.url.toString(), "http://127.0.0.1:4748/projection-rejections/ack");
  assert.equal(
    ack.init.body,
    JSON.stringify({ generation: "generation-1", operationId: "operation-1" }),
  );
  assert.equal(JSON.stringify([prepared.init, ack.init]).includes("origin"), false);
});

test("projection rejection preparation responses parse strictly", () => {
  const preparation = { operationId: "operation-1", beforeExists: true, afterExists: true };
  assert.deepEqual(parseProjectionRejectionPreparation(preparation), preparation);
  assert.throws(() => parseProjectionRejectionPreparation({ ...preparation, extra: true }));
  assert.throws(() =>
    parseProjectionRejectionPreparation({ ...preparation, operationId: "" }),
  );
});

test("projection rejection errors distinguish stale and unavailable requests", () => {
  assert.match(new ProjectionRejectionError("prepare", 409).message, /review expired/);
  assert.match(new ProjectionRejectionError("ack", 404).message, /ack is unavailable \(HTTP 404\)/);
  assert.equal(
    new ProjectionRejectionError("prepare", 204).message,
    "Agentation projection rejection prepare returned HTTP 204.",
  );
});

test("projectSnapshot replaces feed state idempotently and rejects regressions", () => {
  const running: AgentationSnapshot = {
    type: "task.snapshot",
    taskId: "task-1",
    cwd: "/work/app",
    annotations: [],
    revision: 1,
    status: "running",
    detail: "editing button.tsx",
  };
  const first = projectSnapshot(undefined, running);
  assert.deepEqual(projectSnapshot(first, running).feed, ["editing button.tsx"]);

  const completed = projectSnapshot(first, {
    ...running,
    revision: 2,
    status: "completed",
    detail: "completed",
    markdown: "done",
    sessionFile: "/sessions/task-1.jsonl",
  });
  assert.deepEqual(completed.feed, ["completed", "done"]);

  const queued = projectSnapshot(completed, {
    ...running,
    revision: 3,
    status: "queued",
    detail: "follow-up queued",
  });
  assert.equal(queued.snapshot.status, "queued");
  const rerunning = projectSnapshot(queued, { ...running, revision: 4 });
  assert.equal(rerunning.snapshot.status, "running");
  assert.equal(projectSnapshot(rerunning, { ...completed.snapshot, revision: 2 }), rerunning);
  assert.equal(projectSnapshot(rerunning, { ...running, revision: 4 }), rerunning);
});
