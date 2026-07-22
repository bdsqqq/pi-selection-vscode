export type AgentationAnnotation = {
  id: string;
  comment: string;
  sourceFile?: string;
  element?: string;
  elementPath?: string;
  selectedText?: string;
  reactComponents?: string;
};

export type AgentationChange = {
  path: string;
};

export type AgentationSnapshot = {
  type: "task.snapshot";
  taskId: string;
  cwd: string;
  url?: string;
  annotations: AgentationAnnotation[];
  changes?: AgentationChange[];
  status: "queued" | "running" | "completed" | "failed";
  detail: string;
  markdown?: string;
  sessionFile?: string;
  error?: string;
};

export type AgentationReset = {
  type: "projection.reset";
  generation: string;
};

export type AgentationRemove = {
  type: "task.remove";
  taskId: string;
};

export type AgentationEvent = AgentationRemove | AgentationReset | AgentationSnapshot;

export type SnapshotProjectionState = {
  snapshot: AgentationSnapshot;
  feed: string[];
};

export type ProjectionRejectionPreparation = {
  operationId: string;
  beforeExists: boolean;
  afterExists: boolean;
};

export function projectSnapshot(
  previous: SnapshotProjectionState | undefined,
  snapshot: AgentationSnapshot,
): SnapshotProjectionState {
  if (previous && isSnapshotRegression(previous.snapshot, snapshot)) return previous;
  const feed = [snapshot.detail, snapshot.markdown, snapshot.error].filter(
    (entry, index, entries): entry is string => Boolean(entry) && entries.indexOf(entry) === index,
  );
  return { snapshot, feed };
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = this.consumeLine(line);
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  end(): string[] {
    const events = this.buffer ? this.push("\n") : [];
    const final = this.consumeLine("");
    if (final !== undefined) events.push(final);
    return events;
  }

  private consumeLine(line: string): string | undefined {
    if (line === "") {
      if (this.data.length === 0) return undefined;
      const event = this.data.join("\n");
      this.data = [];
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    return undefined;
  }
}

export class AgentationProjectionClient {
  private readonly controller = new AbortController();
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly serverUrl: string,
    private readonly onEvent: (event: AgentationEvent) => void,
    private readonly onError: (message: string) => void,
  ) {
    void this.run();
  }

  dispose(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.controller.abort();
  }

  private async run(): Promise<void> {
    let backoffMs = 1_000;
    while (!this.controller.signal.aborted) {
      try {
        await this.connect();
        backoffMs = 1_000;
      } catch (error) {
        if (this.controller.signal.aborted) return;
        this.onError(error instanceof Error ? error.message : String(error));
      }
      if (this.controller.signal.aborted) return;
      await this.delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  private async connect(): Promise<void> {
    const endpoint = new URL("/projection-events", ensureTrailingSlash(this.serverUrl));
    const response = await fetch(endpoint, {
      headers: { accept: "text/event-stream" },
      signal: this.controller.signal,
    });
    if (!response.ok) throw new Error(`agentation projection stream returned HTTP ${response.status}`);
    if (!response.body) throw new Error("agentation projection stream has no response body");

    const parser = new SseParser();
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      this.consume(parser.push(decoder.decode(chunk, { stream: true })));
    }
    this.consume(parser.push(decoder.decode()));
    this.consume(parser.end());
  }

  private consume(records: readonly string[]): void {
    for (const record of records) {
      try {
        this.onEvent(parseAgentationEvent(record));
      } catch (error) {
        this.onError(`invalid agentation projection event: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async fetchProjectionContent(
    generation: string,
    taskId: string,
    changePath: string,
    side: "before" | "after",
  ): Promise<string> {
    const response = await fetch(
      projectionContentUrl(this.serverUrl, generation, taskId, changePath, side),
      {
        headers: { accept: "text/plain" },
        signal: this.controller.signal,
      },
    );
    if (response.status !== 200) {
      throw projectionRequestError("content", response.status);
    }
    return response.text();
  }

  async prepareProjectionRejection(
    generation: string,
    taskId: string,
    changePath: string,
    requestId: string,
  ): Promise<ProjectionRejectionPreparation> {
    const { url, init } = projectionRejectionPrepareRequest(
      this.serverUrl,
      generation,
      taskId,
      changePath,
      requestId,
    );
    const response = await fetch(url, { ...init, signal: this.controller.signal });
    if (response.status !== 200) throw projectionRequestError("prepare", response.status);
    return parseProjectionRejectionPreparation(await response.json());
  }

  async acknowledgeProjectionRejection(generation: string, operationId: string): Promise<void> {
    const { url, init } = projectionRejectionAckRequest(
      this.serverUrl,
      generation,
      operationId,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, { ...init, signal: this.controller.signal });
        if (response.status !== 200) throw projectionRequestError("ack", response.status);
        return;
      } catch (error) {
        if (attempt === 1 || error instanceof ProjectionRejectionError || this.controller.signal.aborted) {
          throw error;
        }
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.controller.signal.removeEventListener("abort", done);
        resolve();
      };
      this.reconnectTimer = setTimeout(done, ms);
      this.controller.signal.addEventListener("abort", done, { once: true });
    });
  }
}

function isSnapshotRegression(
  previous: AgentationSnapshot,
  next: AgentationSnapshot,
): boolean {
  if (previous.taskId !== next.taskId) return false;
  if (["completed", "failed"].includes(previous.status) && previous.status !== next.status) return true;
  const rank = { queued: 0, running: 1, completed: 2, failed: 2 } as const;
  return rank[next.status] < rank[previous.status];
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function projectionContentUrl(
  serverUrl: string,
  generation: string,
  taskId: string,
  changePath: string,
  side: "before" | "after",
): URL {
  const endpoint = new URL("/projection-content", ensureTrailingSlash(serverUrl));
  endpoint.searchParams.set("generation", generation);
  endpoint.searchParams.set("taskId", taskId);
  endpoint.searchParams.set("path", changePath);
  endpoint.searchParams.set("side", side);
  return endpoint;
}

export function projectionRejectionPrepareRequest(
  serverUrl: string,
  generation: string,
  taskId: string,
  changePath: string,
  requestId: string,
): { url: URL; init: RequestInit } {
  return jsonPostRequest(serverUrl, "/projection-rejections/prepare", {
    generation,
    taskId,
    path: changePath,
    requestId,
  });
}

export function projectionRejectionAckRequest(
  serverUrl: string,
  generation: string,
  operationId: string,
): { url: URL; init: RequestInit } {
  return jsonPostRequest(serverUrl, "/projection-rejections/ack", { generation, operationId });
}

export class ProjectionRejectionError extends Error {
  constructor(
    readonly phase: "content" | "prepare" | "ack",
    readonly status: number,
  ) {
    super(
      status === 409 || status === 410
        ? "This review expired because the server projection generation changed. Reopen Review Changes and try again."
        : status === 404
          ? `Agentation projection rejection ${phase} is unavailable (HTTP 404).`
          : `Agentation projection rejection ${phase} returned HTTP ${status}.`,
    );
    this.name = "ProjectionRejectionError";
  }
}

export function parseProjectionRejectionPreparation(
  value: unknown,
): ProjectionRejectionPreparation {
  if (!value || typeof value !== "object") throw new Error("invalid rejection preparation response");
  const preparation = value as Partial<ProjectionRejectionPreparation>;
  if (
    Object.keys(preparation).length !== 3 ||
    typeof preparation.operationId !== "string" ||
    preparation.operationId.length === 0 ||
    typeof preparation.beforeExists !== "boolean" ||
    typeof preparation.afterExists !== "boolean"
  ) {
    throw new Error("invalid rejection preparation response");
  }
  return preparation as ProjectionRejectionPreparation;
}

function projectionRequestError(
  phase: "content" | "prepare" | "ack",
  status: number,
): ProjectionRejectionError {
  return new ProjectionRejectionError(phase, status);
}

function jsonPostRequest(
  serverUrl: string,
  pathname: string,
  body: Record<string, string>,
): { url: URL; init: RequestInit } {
  return {
    url: new URL(pathname, ensureTrailingSlash(serverUrl)),
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

export function parseAgentationEvent(record: string): AgentationEvent {
  const event: unknown = JSON.parse(record);
  if (isAgentationRemove(event) || isAgentationReset(event) || isAgentationSnapshot(event)) {
    return event;
  }
  throw new Error("event is not a projection.reset, task.remove, or task.snapshot");
}

function isAgentationRemove(value: unknown): value is AgentationRemove {
  if (!value || typeof value !== "object") return false;
  const remove = value as Partial<AgentationRemove>;
  return (
    remove.type === "task.remove" &&
    typeof remove.taskId === "string" &&
    remove.taskId.length > 0 &&
    Object.keys(remove).length === 2
  );
}

function isAgentationReset(value: unknown): value is AgentationReset {
  if (!value || typeof value !== "object") return false;
  const reset = value as Partial<AgentationReset>;
  return (
    reset.type === "projection.reset" &&
    typeof reset.generation === "string" &&
    reset.generation.length > 0 &&
    Object.keys(reset).length === 2
  );
}

function isAgentationSnapshot(value: unknown): value is AgentationSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<AgentationSnapshot>;
  return (
    snapshot.type === "task.snapshot" &&
    typeof snapshot.taskId === "string" &&
    typeof snapshot.cwd === "string" &&
    Array.isArray(snapshot.annotations) &&
    snapshot.annotations.every(
      (annotation) =>
        annotation &&
        typeof annotation === "object" &&
        typeof annotation.id === "string" &&
        typeof annotation.comment === "string" &&
        (annotation.reactComponents === undefined || typeof annotation.reactComponents === "string"),
    ) &&
    (snapshot.changes === undefined ||
      (Array.isArray(snapshot.changes) &&
        snapshot.changes.every(
          (change) =>
            change !== null &&
            typeof change === "object" &&
            Object.keys(change).length === 1 &&
            typeof (change as { path?: unknown }).path === "string" &&
            (change as { path: string }).path.length > 0,
        ))) &&
    ["queued", "running", "completed", "failed"].includes(snapshot.status ?? "") &&
    typeof snapshot.detail === "string" &&
    (snapshot.markdown === undefined || typeof snapshot.markdown === "string") &&
    (snapshot.sessionFile === undefined || typeof snapshot.sessionFile === "string") &&
    (snapshot.error === undefined || typeof snapshot.error === "string")
  );
}
