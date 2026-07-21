import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const REQUEST_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 30 * 60_000;

type RpcCommand = { type: string; [key: string]: unknown };
export type RpcRecord = {
  type?: string;
  id?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
  method?: string;
  [key: string]: unknown;
};

type PendingRequest = {
  resolve: (record: RpcRecord) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type EventWaiter = {
  resolve: (record: RpcRecord) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type RpcLaunchOptions = {
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

export class RpcClient {
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();
  private readonly waiters = new Map<string, Set<EventWaiter>>();
  private readonly onEvent?: (record: RpcRecord) => void;
  private buffer = "";
  private stderr = "";
  private sequence = 0;
  private exited = false;

  readonly process: ChildProcessWithoutNullStreams;

  constructor(
    command: string,
    cwd: string,
    onEvent?: (record: RpcRecord) => void,
    launch: RpcLaunchOptions = {},
  ) {
    this.onEvent = onEvent;
    this.process = spawn(command, [...(launch.args ?? []), "--mode", "rpc"], {
      cwd,
      env: { ...process.env, ...launch.env, PI_SELECTION_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdin.on("error", (error) => this.failAll(error));
    this.process.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) => {
      this.exited = true;
      this.consumeEnd();
      this.failAll(
        new Error(
          `pi rpc exited (${signal ?? `code ${code ?? "unknown"}`})${this.stderr ? `\n${this.stderr}` : ""}`,
        ),
      );
    });
  }

  request<T = unknown>(command: RpcCommand): Promise<RpcRecord & { data?: T }> {
    if (this.exited || !this.process.stdin.writable) {
      return Promise.reject(new Error("pi rpc is not writable"));
    }

    const id = `pi-selection-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi rpc request timed out: ${command.type}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (record) => resolve(record as RpcRecord & { data?: T }),
        reject,
        timeout,
      });
      this.write({ ...command, id });
    });
  }

  waitForEvent(type: string, timeoutMs = RUN_TIMEOUT_MS): Promise<RpcRecord> {
    return new Promise((resolve, reject) => {
      const waiter: EventWaiter = {
        resolve: (record) => {
          clearTimeout(waiter.timeout);
          this.waiters.get(type)?.delete(waiter);
          resolve(record);
        },
        reject,
        timeout: setTimeout(() => {
          this.waiters.get(type)?.delete(waiter);
          reject(new Error(`pi rpc event timed out: ${type}`));
        }, timeoutMs),
      };
      const waiters = this.waiters.get(type) ?? new Set<EventWaiter>();
      waiters.add(waiter);
      this.waiters.set(type, waiters);
    });
  }

  async abort(): Promise<void> {
    if (!this.exited) await this.request({ type: "abort" });
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.process.stdin.end();
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        const onExit = () => {
          if (timeout) clearTimeout(timeout);
          resolve();
        };
        this.process.once("exit", onExit);
        if (this.exited) {
          this.process.removeListener("exit", onExit);
          onExit();
        }
      }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          if (!this.exited) this.process.kill("SIGTERM");
          resolve();
        }, 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  terminate(): void {
    if (!this.exited) this.process.kill("SIGTERM");
  }

  private write(record: Record<string, unknown>): void {
    try {
      this.process.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
        if (error) this.failAll(error);
      });
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consume(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) this.handleLine(line);
    }
  }

  private consumeEnd(): void {
    this.buffer += this.decoder.end();
    if (this.buffer) this.handleLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
    this.buffer = "";
  }

  private handleLine(line: string): void {
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch {
      this.failAll(new Error(`invalid pi rpc record: ${line.slice(0, 500)}`));
      this.terminate();
      return;
    }

    if (record.type === "response" && record.id) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(record.id);
      if (record.success === false) pending.reject(new Error(record.error ?? "pi rpc request failed"));
      else pending.resolve(record);
      return;
    }

    if (record.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(record.method ?? "") && record.id) {
        this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
      }
    }

    try {
      this.onEvent?.(record);
    } catch {
      // UI reporting must not break the transport.
    }
    if (!record.type) return;
    for (const waiter of [...(this.waiters.get(record.type) ?? [])]) waiter.resolve(record);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }
}
