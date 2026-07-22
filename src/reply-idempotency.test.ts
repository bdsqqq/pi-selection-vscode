import assert from "node:assert/strict";
import test from "node:test";
import { PendingReplyIds } from "./reply-idempotency";

test("PendingReplyIds reuses ambiguous requests until acceptance", () => {
  const replies = new PendingReplyIds<object>();
  const thread = {};
  let sequence = 0;
  const create = () => `request-${++sequence}`;

  const first = replies.requestId(thread, "same", create);
  assert.equal(replies.requestId(thread, "same", create), first);
  const changed = replies.requestId(thread, "changed", create);
  assert.notEqual(changed, first);
  replies.confirm(thread, "changed", changed);
  assert.notEqual(replies.requestId(thread, "changed", create), changed);
});
