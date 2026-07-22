import assert from "node:assert/strict";
import test from "node:test";
import {
  boundSelectionStore,
  parseSelectionStore,
  selectionFingerprint,
  type PersistedSelectionThread,
} from "./selection-thread-persistence";

function record(
  id: string,
  overrides: Partial<Pick<PersistedSelectionThread, "reviewed" | "updatedAt">> = {},
): PersistedSelectionThread {
  return {
    id,
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 2,
    reviewed: overrides.reviewed ?? false,
    source: {
      uri: `file:///workspace/${id}.ts`,
      realPath: `/workspace/${id}.ts`,
      cwd: "/workspace",
      relativeFile: `${id}.ts`,
      startOffset: 0,
      endOffset: 5,
      fingerprint: "abc123",
    },
    request: {
      instruction: "explain this",
      relativeFile: `${id}.ts`,
      language: "typescript",
      startLine: 1,
      endLine: 1,
      text: "hello",
    },
    job: {
      id: `job-${id}`,
      name: "explain this",
      file: `${id}.ts`,
      cwd: "/workspace",
      status: "completed",
      detail: "done",
      sessionFile: `/tmp/${id}.jsonl`,
      sessionId: `session-${id}`,
      response: "response",
      messages: [
        { role: "user", body: "follow up" },
        { role: "assistant", body: "answer" },
      ],
      latestUpdate: "done",
    },
  };
}

test("selection stores round-trip through the strict parser", () => {
  const value = { version: 1 as const, records: [record("one")] };
  assert.deepEqual(parseSelectionStore(JSON.parse(JSON.stringify(value))), value);
});

test("wrong versions and malformed top-level values produce an empty v1 store", () => {
  for (const value of [null, [], {}, { version: 2, records: [] }, { version: 1 }]) {
    assert.deepEqual(parseSelectionStore(value), { version: 1, records: [] });
  }
});

test("malformed records and duplicate ids are dropped without affecting valid records", () => {
  const first = record("same");
  const duplicate = { ...record("same"), updatedAt: 99 };
  const invalidStatus = {
    ...record("bad-status"),
    job: { ...record("bad-status").job, status: "paused" },
  };
  const invalidRole = {
    ...record("bad-role"),
    job: { ...record("bad-role").job, messages: [{ role: "system", body: "nope" }] },
  };
  const invalidOffsets = {
    ...record("bad-offsets"),
    source: { ...record("bad-offsets").source, startOffset: 6, endOffset: 5 },
  };
  const missingRealPath = record("missing-real-path") as unknown as {
    source: Partial<PersistedSelectionThread["source"]>;
  };
  delete missingRealPath.source.realPath;
  const nonFiniteTimestamp = { ...record("bad-time"), updatedAt: Number.POSITIVE_INFINITY };
  const runtimeFields = {
    ...record("clean"),
    job: { ...record("clean").job, feed: ["runtime"], client: {} },
  };

  const parsed = parseSelectionStore({
    version: 1,
    records: [
      first,
      duplicate,
      invalidStatus,
      invalidRole,
      invalidOffsets,
      missingRealPath,
      nonFiniteTimestamp,
      runtimeFields,
    ],
  });
  assert.deepEqual(parsed.records.map(({ id }) => id), ["clean", "same"]);
  assert.equal(parsed.records.find(({ id }) => id === "same")?.updatedAt, 2);
  assert.equal("feed" in (parsed.records.find(({ id }) => id === "clean")?.job ?? {}), false);
});

test("parsing drops records missing canonical realPath identity", () => {
  const malformed = record("missing-real-path") as unknown as {
    source: Partial<PersistedSelectionThread["source"]>;
  };
  delete malformed.source.realPath;

  assert.deepEqual(parseSelectionStore({ version: 1, records: [malformed] }), {
    version: 1,
    records: [],
  });
});

test("parsing applies record count and byte bounds with deterministic priority", () => {
  const records = Array.from({ length: 1_000 }, (_, index) =>
    record(`id-${index.toString().padStart(4, "0")}`, { updatedAt: index }),
  );
  const parsed = parseSelectionStore({ version: 1, records });

  assert.equal(parsed.records.length, 100);
  assert.equal(parsed.records[0]?.id, "id-0999");
  assert.equal(parsed.records.at(-1)?.id, "id-0900");
  assert.ok(Buffer.byteLength(JSON.stringify(parsed), "utf8") <= 2 * 1024 * 1024);
});

test("parsing rejects raw record arrays over the hydration cap", () => {
  const repeated = record("repeated");
  assert.deepEqual(
    parseSelectionStore({ version: 1, records: Array(1_001).fill(repeated) }),
    { version: 1, records: [] },
  );
});

test("parsing skips oversized strings and excessive message arrays", () => {
  const huge = record("huge");
  huge.job.response = "x".repeat(4 * 1024 * 1024);
  const excessiveMessages = record("messages");
  excessiveMessages.job.messages = Array(1_001).fill({ role: "assistant", body: "ok" });

  const parsed = parseSelectionStore({
    version: 1,
    records: [huge, excessiveMessages, record("valid")],
  });
  assert.deepEqual(parsed.records.map(({ id }) => id), ["valid"]);
});

test("parsing rejects aggregate raw input over the byte cap", () => {
  const records = Array.from({ length: 10 }, (_, index) => {
    const value = record(`aggregate-${index}`);
    value.job.response = "x".repeat(230 * 1024);
    return value;
  });
  assert.deepEqual(parseSelectionStore({ version: 1, records }), { version: 1, records: [] });
});

test("parsing drops cyclic records without traversing indefinitely", () => {
  const cyclic = record("cyclic") as PersistedSelectionThread & { cycle?: unknown };
  cyclic.cycle = cyclic;

  assert.deepEqual(
    parseSelectionStore({ version: 1, records: [cyclic, record("valid")] }).records.map(
      ({ id }) => id,
    ),
    ["valid"],
  );
});

test("bounding prioritizes unreviewed, then newest, then id", () => {
  const bounded = boundSelectionStore([
    record("reviewed", { reviewed: true, updatedAt: 100 }),
    record("b", { updatedAt: 5 }),
    record("a", { updatedAt: 5 }),
    record("newest", { updatedAt: 6 }),
  ]);
  assert.deepEqual(bounded.records.map(({ id }) => id), ["newest", "a", "b", "reviewed"]);
});

test("bounding keeps at most 100 records and skips oversized records", () => {
  const oversized = record("oversized", { updatedAt: 10_000 });
  oversized.job.response = "x".repeat(256 * 1024);
  const records = [oversized, ...Array.from({ length: 110 }, (_, index) => record(`id-${index}`))];
  const bounded = boundSelectionStore(records);

  assert.equal(bounded.records.length, 100);
  assert.equal(bounded.records.some(({ id }) => id === "oversized"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 2 * 1024 * 1024);
});

test("bounding enforces the total byte limit without truncating transcripts", () => {
  const records = Array.from({ length: 20 }, (_, index) => {
    const value = record(`large-${index}`);
    value.job.messages = [{ role: "assistant", body: `${index}:`.padEnd(150_000, "x") }];
    return value;
  });
  const bounded = boundSelectionStore(records);

  assert.ok(bounded.records.length > 0 && bounded.records.length < records.length);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 2 * 1024 * 1024);
  for (const value of bounded.records) {
    assert.equal(value.job.messages[0]?.body.length, 150_000);
  }
});

test("selection fingerprints are stable and sensitive only to selection context", () => {
  const before = "b".repeat(160);
  const selected = "selected text";
  const after = "a".repeat(160);
  const text = before + selected + after;
  const start = before.length;
  const end = start + selected.length;
  const fingerprint = selectionFingerprint(text, start, end);

  assert.equal(selectionFingerprint(text, start, end), fingerprint);

  const inside = before + "selected next" + after;
  assert.notEqual(selectionFingerprint(inside, start, start + "selected next".length), fingerprint);

  const nearby = `${before.slice(0, -1)}x${selected}${after}`;
  assert.notEqual(selectionFingerprint(nearby, start, end), fingerprint);

  const distant = `z${text.slice(1)}`;
  assert.equal(selectionFingerprint(distant, start, end), fingerprint);
});
