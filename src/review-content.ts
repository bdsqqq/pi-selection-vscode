export const PROJECTION_SCHEME = "pi-selection-review";
export type ProjectionSide = "before" | "after";

export type ProjectionUriParts = {
  scheme: string;
  authority: string;
  path: string;
  query: string;
};

export type ProjectionContentTarget = {
  generation: string;
  taskId: string;
  path: string;
  side: ProjectionSide;
};

export function projectionUriParts(
  generation: string,
  taskId: string,
  changePath: string,
  side: ProjectionSide,
): ProjectionUriParts {
  const sourcePath = changePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return {
    scheme: PROJECTION_SCHEME,
    authority: side,
    path: `/${sourcePath}`,
    query: new URLSearchParams({ generation, taskId, path: changePath, side }).toString(),
  };
}

export function parseProjectionUri(uri: ProjectionUriParts): ProjectionContentTarget | undefined {
  if (uri.scheme !== PROJECTION_SCHEME || !isProjectionSide(uri.authority)) return undefined;
  const query = new URLSearchParams(uri.query);
  const generation = query.get("generation");
  const taskId = query.get("taskId");
  const changePath = query.get("path");
  const side = query.get("side");
  if (
    !generation ||
    !taskId ||
    !changePath ||
    side !== uri.authority ||
    !isProjectionSide(side)
  ) {
    return undefined;
  }
  const expected = projectionUriParts(generation, taskId, changePath, side);
  if (uri.path !== expected.path) return undefined;
  return { generation, taskId, path: changePath, side };
}

function isProjectionSide(value: string): value is ProjectionSide {
  return value === "before" || value === "after";
}

export class ProjectionUriRegistry<T extends ProjectionUriParts> {
  private readonly uris = new Map<string, T>();

  get size(): number {
    return this.uris.size;
  }

  remember(key: string, uri: T): void {
    this.uris.set(key, uri);
  }

  removeTask(taskId: string): Array<[string, T]> {
    const removed: Array<[string, T]> = [];
    for (const [key, uri] of this.uris) {
      if (parseProjectionUri(uri)?.taskId !== taskId) continue;
      this.uris.delete(key);
      removed.push([key, uri]);
    }
    return removed;
  }

  reset(): T[] {
    const stale = [...this.uris.values()];
    this.uris.clear();
    return stale;
  }

  clear(): void {
    this.uris.clear();
  }
}

export class Utf8LruCache {
  private readonly entries = new Map<string, { value: string; bytes: number }>();
  private byteCount = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries: number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.byteCount;
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.byteCount -= previous.bytes;
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > this.maxBytes || this.maxEntries === 0) return;
    this.entries.set(key, { value, bytes });
    this.byteCount += bytes;
    while (this.byteCount > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value as
        | [string, { value: string; bytes: number }]
        | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.byteCount -= oldest[1].bytes;
    }
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.byteCount -= entry.bytes;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.byteCount = 0;
  }
}
