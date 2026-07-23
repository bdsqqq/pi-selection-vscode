import assert from "node:assert/strict";
import test from "node:test";
import type { JobStatus } from "./coordinator";
import {
  canSettleThread,
  deriveThreadLifecycle,
  groupThreadSummaries,
  serializeThreadRef,
  supportsThreadSettlement,
  type ThreadRef,
  type ThreadSummary,
} from "./thread-model";

const local = (id: string): ThreadRef => ({ kind: "local", id });
const agentation = (taskId: string): ThreadRef => ({
  kind: "agentation",
  serverUrl: "http://127.0.0.1:4748",
  taskId,
});

function summary(
  ref: ThreadRef,
  lifecycle: ThreadSummary["lifecycle"],
  updatedAt: number,
): ThreadSummary {
  return {
    ref,
    title: serializeThreadRef(ref),
    source: ref.kind,
    location: "src/example.ts:1",
    lifecycle,
    execution: lifecycle === "working" ? "running" : "completed",
    updatedAt,
    latestUpdate: "update",
    canReply: lifecycle !== "working",
    canSettle: lifecycle === "needsAttention",
    canAbort: lifecycle === "working",
    hasChanges: false,
    settlementCapability: true,
  };
}

test("thread identities are stable and distinguish ref fields", () => {
  const ref = agentation("task-1");
  assert.equal(serializeThreadRef(ref), serializeThreadRef({ ...ref }));
  assert.notEqual(serializeThreadRef(local("task-1")), serializeThreadRef(ref));
  assert.notEqual(serializeThreadRef(agentation("task-1")), serializeThreadRef(agentation("task-2")));
  assert.notEqual(
    serializeThreadRef({ kind: "agentation", serverUrl: "http://other", taskId: "task-1" }),
    serializeThreadRef(ref),
  );
});

test("lifecycle follows execution before settlement", () => {
  const expected: Record<JobStatus, [ThreadSummary["lifecycle"], ThreadSummary["lifecycle"]]> = {
    queued: ["working", "working"],
    running: ["working", "working"],
    completed: ["needsAttention", "settled"],
    failed: ["needsAttention", "settled"],
    aborted: ["needsAttention", "settled"],
  };

  for (const [execution, [unsettled, settled]] of Object.entries(expected) as Array<
    [JobStatus, [ThreadSummary["lifecycle"], ThreadSummary["lifecycle"]]]
  >) {
    assert.equal(deriveThreadLifecycle(execution, undefined), unsettled);
    assert.equal(deriveThreadLifecycle(execution, false), unsettled);
    assert.equal(deriveThreadLifecycle(execution, true), settled);
  }
});

test("groups omit empty lifecycles and sort by recency then identity", () => {
  const tiedA = summary(local("a"), "needsAttention", 20);
  const tiedB = summary(local("b"), "needsAttention", 20);
  const groups = groupThreadSummaries([
    summary(local("old"), "needsAttention", 10),
    summary(local("done"), "settled", 30),
    tiedB,
    tiedA,
  ]);

  assert.deepEqual(groups.map((group) => group.lifecycle), ["needsAttention", "settled"]);
  assert.deepEqual(
    groups[0]?.threads.map((thread) => thread.ref),
    [tiedA.ref, tiedB.ref, local("old")],
  );
});

test("legacy agentation refs expose no settlement capability", () => {
  const legacy = agentation("legacy");
  assert.equal(supportsThreadSettlement(legacy, undefined), false);
  assert.equal(canSettleThread(legacy, "completed", undefined), false);
  assert.equal(deriveThreadLifecycle("completed", undefined), "needsAttention");

  assert.equal(supportsThreadSettlement(legacy, false), true);
  assert.equal(canSettleThread(legacy, "completed", false), true);
  assert.equal(canSettleThread(legacy, "running", false), false);
  assert.equal(supportsThreadSettlement(local("local"), undefined), true);
});
