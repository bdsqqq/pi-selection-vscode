import assert from "node:assert/strict";
import test from "node:test";
import type { AgentationAnnotation, AgentationMessage } from "./agentation";
import { projectThreadItems } from "./projection-comments";

const annotation: AgentationAnnotation = { id: "annotation-1", comment: "fix this" };
const messages: AgentationMessage[] = [
  { id: "global-user", role: "user", body: "first" },
  { id: "other", annotationId: "annotation-2", role: "assistant", body: "hidden" },
  { id: "local-pi", annotationId: "annotation-1", role: "assistant", body: "second" },
];

test("projectThreadItems keeps annotation first and filters messages without reordering", () => {
  const items = projectThreadItems(annotation, messages);
  assert.equal(items[0]?.kind, "annotation");
  assert.deepEqual(
    items.slice(1).map((item) => item.kind === "message" && item.message.id),
    ["global-user", "local-pi"],
  );
});
