import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { createEditContexts, planExactEdits, type ExactEdit } from "./exact-edits";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

type BridgeConnection = {
  url: string;
  token: string;
};

type ReadRequest = {
  path: string;
  offset?: number;
  limit?: number;
};

type PatchRequest = {
  path: string;
  edits: ExactEdit[];
};

export class BufferBridge implements vscode.Disposable {
  private readonly token = randomBytes(32).toString("hex");
  private readonly folder: vscode.WorkspaceFolder;
  private server?: Server;
  private connection?: Promise<BridgeConnection>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(folder: vscode.WorkspaceFolder) {
    this.folder = folder;
  }

  start(): Promise<BridgeConnection> {
    this.connection ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => void this.route(request, response));
      this.server = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Pi buffer bridge did not receive a TCP port."));
          return;
        }
        resolve({ url: `http://127.0.0.1:${address.port}`, token: this.token });
      });
    });
    return this.connection;
  }

  dispose(): void {
    this.server?.close();
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cancellation = new AbortController();
    request.once("aborted", () => cancellation.abort());
    response.once("close", () => {
      if (!response.writableEnded) cancellation.abort();
    });
    try {
      if (request.method !== "POST") throw new BridgeError(405, "Only POST is supported.");
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        throw new BridgeError(401, "Invalid bridge token.");
      }

      if (request.url === "/read") {
        const input = await this.readBody<ReadRequest>(request);
        this.send(response, 200, await this.readBuffer(input));
        return;
      }
      if (request.url === "/apply-patch") {
        const input = await this.readBody<PatchRequest>(request);
        const result = await this.enqueueMutation(() => this.applyPatch(input, cancellation.signal));
        this.send(response, 200, result);
        return;
      }
      throw new BridgeError(404, "Unknown bridge route.");
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      this.send(response, status, { error: message });
    }
  }

  private async readBuffer(input: ReadRequest): Promise<Record<string, unknown>> {
    const document = await vscode.workspace.openTextDocument(await this.resolveScopedUri(input.path));
    const lines = document.getText().split("\n");
    const offset = Math.max(1, Math.floor(input.offset ?? 1));
    if (offset > lines.length) throw new BridgeError(416, `offset exceeds ${lines.length} lines.`);
    const limit = Math.min(2_000, Math.max(1, Math.floor(input.limit ?? 500)));
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    return {
      path: input.path,
      text: selected.join("\n"),
      startLine: offset,
      totalLines: lines.length,
      truncated: offset - 1 + selected.length < lines.length,
    };
  }

  private async applyPatch(
    input: PatchRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(input.edits)) throw new BridgeError(400, "edits must be an array.");
    if (input.edits.length > 10) throw new BridgeError(400, "apply_patch accepts at most 10 edits.");
    if (signal.aborted) throw new BridgeError(499, "Patch cancelled before it reached VSCodium.");
    const uri = await this.resolveScopedUri(input.path);
    const document = await vscode.workspace.openTextDocument(uri);
    const beforeVersion = document.version;
    const beforeText = document.getText();
    let planned: ReturnType<typeof planExactEdits>;
    try {
      planned = planExactEdits(beforeText, input.edits);
    } catch (error) {
      throw new BridgeError(409, error instanceof Error ? error.message : String(error));
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of planned) {
      workspaceEdit.replace(
        uri,
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.newText,
      );
    }

    if (signal.aborted) throw new BridgeError(499, "Patch cancelled before it reached VSCodium.");
    if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
      throw new BridgeError(409, "VSCodium rejected the buffer edit; reread the file and retry.");
    }
    const contexts = createEditContexts(beforeText, planned).map((context) => ({
      ...context,
      text: context.text.slice(0, 8_000),
      truncated: context.text.length > 8_000,
    }));
    return {
      path: input.path,
      applied: planned.length,
      beforeVersion,
      afterVersion: document.version,
      dirty: document.isDirty,
      contexts,
    };
  }

  private async resolveScopedUri(requestedPath: unknown): Promise<vscode.Uri> {
    if (typeof requestedPath !== "string" || !requestedPath.trim()) {
      throw new BridgeError(400, "path must be a non-empty workspace-relative string.");
    }
    if (this.folder.uri.scheme !== "file") {
      throw new BridgeError(400, "Pi Selection currently supports local workspace folders only.");
    }
    if (path.isAbsolute(requestedPath)) {
      throw new BridgeError(400, "path must be workspace-relative.");
    }

    const root = await realpath(this.folder.uri.fsPath);
    const candidate = path.resolve(root, requestedPath.replace(/^@/, ""));
    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      throw new BridgeError(404, `File does not exist: ${requestedPath}`);
    }
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new BridgeError(403, "path resolves outside the workspace folder.");
    }
    return vscode.Uri.file(target);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readBody<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new BridgeError(413, "Bridge request is too large.");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new BridgeError(400, "Bridge request is not valid JSON.");
    }
  }

  private send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }
}

class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
