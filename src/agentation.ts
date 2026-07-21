export type AgentationAnnotation = {
  id: string;
  comment: string;
  sourceFile?: string;
  element?: string;
  elementPath?: string;
  selectedText?: string;
  reactComponents?: string;
};

export type AgentationSnapshot = {
  type: "task.snapshot";
  taskId: string;
  cwd: string;
  url?: string;
  annotations: AgentationAnnotation[];
  status: "queued" | "running" | "completed" | "failed";
  detail: string;
  markdown?: string;
  sessionFile?: string;
  error?: string;
};

export type AgentationEvent = AgentationSnapshot;

export type SnapshotProjectionState = {
  snapshot: AgentationSnapshot;
  feed: string[];
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
        const event = JSON.parse(record) as AgentationEvent;
        if (!isAgentationSnapshot(event)) throw new Error("event is not a task.snapshot");
        this.onEvent(event);
      } catch (error) {
        this.onError(`invalid agentation projection event: ${error instanceof Error ? error.message : String(error)}`);
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
    ["queued", "running", "completed", "failed"].includes(snapshot.status ?? "") &&
    typeof snapshot.detail === "string" &&
    (snapshot.markdown === undefined || typeof snapshot.markdown === "string") &&
    (snapshot.sessionFile === undefined || typeof snapshot.sessionFile === "string") &&
    (snapshot.error === undefined || typeof snapshot.error === "string")
  );
}
