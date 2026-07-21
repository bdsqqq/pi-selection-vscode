import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const bridgeUrl = process.env.PI_SELECTION_BRIDGE_URL;
const bridgeToken = process.env.PI_SELECTION_BRIDGE_TOKEN;
if (!bridgeUrl || !bridgeToken) throw new Error("Pi Selection buffer bridge is not configured.");

function truncateOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  return bytes.length <= 50 * 1024
    ? output
    : `${bytes.subarray(0, 50 * 1024).toString("utf8")}\n\n[Output truncated at 50KB.]`;
}

async function request<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${bridgeUrl}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `VSCodium bridge returned HTTP ${response.status}`);
  return result;
}

const pathParameter = Type.String({
  description: "Workspace-relative path. Absolute paths and paths outside the workspace are rejected.",
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "Read VSCodium Buffer",
    description:
      "Read the current VSCodium editor buffer for a workspace file, including unsaved user edits. Returns at most 500 lines by default.",
    promptSnippet: "Read current VSCodium buffers, including unsaved edits",
    parameters: Type.Object({
      path: pathParameter,
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-indexed)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Maximum lines" })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await request<{
        path: string;
        text: string;
        startLine: number;
        totalLines: number;
        truncated: boolean;
      }>("/read", params, signal);
      const outputLines = result.text.split("\n");
      const numbered = outputLines
        .map((line, index) => `${result.startLine + index}: ${line}`)
        .join("\n");
      const suffix = result.truncated
        ? `\n\n[Showing lines ${result.startLine}-${result.startLine + outputLines.length - 1} of ${result.totalLines}.]`
        : "";
      const output = `${numbered}${suffix}`;
      const text = truncateOutput(output);
      return {
        content: [{ type: "text", text }],
        details: {
          path: result.path,
          startLine: result.startLine,
          totalLines: result.totalLines,
          truncated: result.truncated || Buffer.byteLength(output, "utf8") > 50 * 1024,
        },
      };
    },
  });

  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch to VSCodium Buffer",
    description:
      "Atomically apply one or more exact, non-overlapping text replacements to one current VSCodium editor buffer. Every oldText must occur exactly once. The whole call is rejected if any match is stale, ambiguous, or overlapping. Reread and retry after rejection.",
    promptSnippet: "Apply exact replacements atomically to the current VSCodium buffer",
    promptGuidelines: [
      "Use apply_patch for every source-file mutation; edit, write, and bash are unavailable in Pi Selection sessions.",
      "Prefer one direct apply_patch from selected text; read only when missing context or retrying a rejected patch.",
      "Treat successful apply_patch result contexts as authoritative; do not reread after success.",
      "Keep apply_patch oldText large enough to identify one location, but exclude unrelated surrounding text that the user may edit concurrently.",
    ],
    parameters: Type.Object({
      path: pathParameter,
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text currently present exactly once in the buffer" }),
          newText: Type.String({ description: "Replacement text" }),
        }),
        { minItems: 1, maxItems: 10, description: "Exact replacements matched against one buffer snapshot" },
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await request<{
        path: string;
        applied: number;
        beforeVersion: number;
        afterVersion: number;
        dirty: boolean;
        contexts: Array<{
          startLine: number;
          endLine: number;
          text: string;
          truncated: boolean;
        }>;
      }>("/apply-patch", params, signal);
      const contexts = result.contexts
        .map((context, index) => {
          const numbered = context.text
            .split("\n")
            .map((line, lineIndex) => `${context.startLine + lineIndex}: ${line}`)
            .join("\n");
          return `result ${index + 1}, lines ${context.startLine}-${context.endLine}:\n${numbered}${context.truncated ? "\n[Context truncated.]" : ""}`;
        })
        .join("\n\n");
      const summary = `Applied ${result.applied} replacement${result.applied === 1 ? "" : "s"} atomically to ${result.path}; buffer version ${result.beforeVersion}→${result.afterVersion}.`;
      return {
        content: [{ type: "text", text: truncateOutput(`${summary}\n\n${contexts}`) }],
        details: result,
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      return { block: true, reason: "Pi Selection requires apply_patch so edits use VSCodium buffers." };
    }
  });

  pi.on("session_start", () => {
    const allowed = new Set(["read", "grep", "find", "ls", "apply_patch"]);
    pi.setActiveTools(pi.getActiveTools().filter((name) => allowed.has(name)));
  });
}
