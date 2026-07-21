import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectionUri,
  projectionUriParts,
  ProjectionUriRegistry,
  Utf8LruCache,
} from "./review-content";

test("projection review URIs namespace fetch targets by generation", () => {
  const uri = projectionUriParts("generation-1", "task & one", "src/a file.tsx", "before");
  const nextGeneration = projectionUriParts(
    "generation-2",
    "task & one",
    "src/a file.tsx",
    "before",
  );
  assert.equal(uri.path, "/src/a file.tsx");
  assert.notEqual(uri.query, nextGeneration.query);
  assert.deepEqual(parseProjectionUri(uri), {
    generation: "generation-1",
    taskId: "task & one",
    path: "src/a file.tsx",
    side: "before",
  });
  assert.equal(parseProjectionUri({ ...uri, authority: "after" }), undefined);
  assert.equal(parseProjectionUri({ ...uri, path: "/src/a file.js" }), undefined);
});

test("ProjectionUriRegistry returns every loaded URI on reset", () => {
  const registry = new ProjectionUriRegistry();
  const first = projectionUriParts("generation-1", "task-1", "a.ts", "before");
  const second = projectionUriParts("generation-1", "task-2", "b.ts", "after");
  registry.remember("first", first);
  registry.remember("second", second);
  assert.deepEqual(registry.removeTask("task-1"), [["first", first]]);
  assert.deepEqual(registry.reset(), [second]);
  assert.equal(registry.size, 0);
});

test("Utf8LruCache enforces UTF-8 byte and document budgets", () => {
  const cache = new Utf8LruCache(5, 2);
  cache.set("oldest", "é");
  cache.set("middle", "a");
  assert.equal(cache.get("oldest"), "é");
  cache.set("newest", "bb");
  assert.equal(cache.get("middle"), undefined);
  assert.equal(cache.get("oldest"), "é");
  assert.equal(cache.get("newest"), "bb");
  assert.equal(cache.bytes, 4);
  assert.equal(cache.size, 2);
  assert.equal(cache.delete("oldest"), true);
  assert.equal(cache.bytes, 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.delete("missing"), false);

  cache.set("oversized", "ééé");
  assert.equal(cache.get("oversized"), undefined);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
});
