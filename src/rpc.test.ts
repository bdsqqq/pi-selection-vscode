import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RpcClient } from "./rpc";

test("RpcClient preserves strict LF framing and cancels unsupported background dialogs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-selection-rpc-"));
  const fakePi = join(directory, "fake-pi.mjs");
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "probe") {
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { value: command.value } }) + "\\n");
    }
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true }) + "\\n");
    }
    if (command.type === "extension_ui_response" && command.id === "ui-1" && command.cancelled) {
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
`,
  );
  await chmod(fakePi, 0o755);

  const client = new RpcClient(fakePi, directory);
  try {
    const value = "before\u2028after";
    const response = await client.request<{ value: string }>({ type: "probe", value });
    assert.equal(response.data?.value, value);

    const settled = client.waitForEvent("agent_settled", 2_000);
    await client.request({ type: "prompt", message: "test" });
    await settled;
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
