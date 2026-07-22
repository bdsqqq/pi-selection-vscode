import { createHash } from "node:crypto";
import type { JobStatus, PiJobMessage, SelectionRequest } from "./coordinator";

export const SELECTION_THREAD_STORE_KEY = "piSelection.selectionThreads.v1";

export type PersistedSelectionThread = {
  id: string;
  createdAt: number;
  updatedAt: number;
  reviewed: boolean;
  source: {
    uri: string;
    realPath: string;
    cwd: string;
    relativeFile: string;
    startOffset: number;
    endOffset: number;
    fingerprint: string;
  };
  request: SelectionRequest;
  job: {
    id: string;
    name: string;
    file: string;
    cwd: string;
    status: JobStatus;
    detail: string;
    sessionFile?: string;
    sessionId?: string;
    response?: string;
    error?: string;
    messages: PiJobMessage[];
    latestUpdate: string;
  };
};

export type PersistedSelectionStore = {
  version: 1;
  records: PersistedSelectionThread[];
};

const EMPTY_STORE = (): PersistedSelectionStore => ({ version: 1, records: [] });
const MAX_STRING_LENGTH = 512 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 100;
const MAX_RAW_RECORDS = 1_000;
const MAX_MESSAGES = 1_000;
const JOB_STATUSES = new Set<JobStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "aborted",
]);
const MESSAGE_ROLES = new Set<PiJobMessage["role"]>(["user", "assistant"]);

type JsonObject = Record<string, unknown>;

function boundedJsonByteLength(value: unknown, limit: number): number | undefined {
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= limit;
  };
  const addString = (valueString: string): boolean => {
    if (!add(2)) return false;
    for (let index = 0; index < valueString.length; index += 1) {
      const code = valueString.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
        if (!add(2)) return false;
      } else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff && !(code <= 0xdbff && index + 1 < valueString.length && valueString.charCodeAt(index + 1) >= 0xdc00 && valueString.charCodeAt(index + 1) <= 0xdfff))) {
        if (!add(6)) return false;
      } else if (code <= 0x7f) {
        if (!add(1)) return false;
      } else if (code <= 0x7ff) {
        if (!add(2)) return false;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        index += 1;
        if (!add(4)) return false;
      } else if (!add(3)) {
        return false;
      }
    }
    return true;
  };
  const visit = (current: unknown): boolean | undefined => {
    if (current === null) return add(4);
    if (typeof current === "string") return addString(current);
    if (typeof current === "boolean") return add(current ? 4 : 5);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return undefined;
      return add(String(current).length);
    }
    if (typeof current !== "object") return undefined;
    if (ancestors.has(current)) return undefined;
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) return undefined;

    ancestors.add(current);
    if (!add(1)) return false;
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0 && !add(1)) return false;
        if (!(index in current)) {
          if (!add(4)) return false;
        } else {
          const visited = visit(current[index]);
          if (visited !== true) return visited;
        }
      }
    } else {
      let first = true;
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor)) return undefined;
        if (!first && !add(1)) return false;
        first = false;
        if (!addString(key) || !add(1)) return false;
        const visited = visit(descriptor.value);
        if (visited !== true) return visited;
      }
    }
    ancestors.delete(current);
    return add(1);
  };

  try {
    const visited = visit(value);
    return visited === undefined ? undefined : bytes;
  } catch {
    return undefined;
  }
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_STRING_LENGTH ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined | null {
  return value === undefined ? undefined : (string(value) ?? null);
}

function parseRequest(value: unknown): SelectionRequest | undefined {
  const input = object(value);
  if (!input) return undefined;
  const instruction = string(input.instruction);
  const relativeFile = string(input.relativeFile);
  const language = string(input.language);
  const startLine = integer(input.startLine);
  const endLine = integer(input.endLine);
  const text = string(input.text);
  if (
    instruction === undefined ||
    relativeFile === undefined ||
    language === undefined ||
    startLine === undefined ||
    endLine === undefined ||
    endLine < startLine ||
    text === undefined
  ) {
    return undefined;
  }
  return { instruction, relativeFile, language, startLine, endLine, text };
}

function parseMessages(value: unknown): PiJobMessage[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) return undefined;
  const messages: PiJobMessage[] = [];
  for (const valueMessage of value) {
    const input = object(valueMessage);
    const role = input?.role;
    const body = string(input?.body);
    if (!MESSAGE_ROLES.has(role as PiJobMessage["role"]) || body === undefined) return undefined;
    messages.push({ role: role as PiJobMessage["role"], body });
  }
  return messages;
}

function parseRecord(value: unknown): PersistedSelectionThread | undefined {
  const input = object(value);
  const sourceInput = object(input?.source);
  const jobInput = object(input?.job);
  if (!input || !sourceInput || !jobInput) return undefined;

  const id = string(input.id);
  const createdAt = integer(input.createdAt);
  const updatedAt = integer(input.updatedAt);
  const reviewed = input.reviewed;
  const uri = string(sourceInput.uri);
  const realPath = string(sourceInput.realPath);
  const cwd = string(sourceInput.cwd);
  const relativeFile = string(sourceInput.relativeFile);
  const startOffset = integer(sourceInput.startOffset);
  const endOffset = integer(sourceInput.endOffset);
  const fingerprint = string(sourceInput.fingerprint);
  const request = parseRequest(input.request);
  const jobId = string(jobInput.id);
  const name = string(jobInput.name);
  const file = string(jobInput.file);
  const jobCwd = string(jobInput.cwd);
  const status = jobInput.status;
  const detail = string(jobInput.detail);
  const sessionFile = optionalString(jobInput.sessionFile);
  const sessionId = optionalString(jobInput.sessionId);
  const response = optionalString(jobInput.response);
  const error = optionalString(jobInput.error);
  const messages = parseMessages(jobInput.messages);
  const latestUpdate = string(jobInput.latestUpdate);

  if (
    id === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    typeof reviewed !== "boolean" ||
    uri === undefined ||
    realPath === undefined ||
    cwd === undefined ||
    relativeFile === undefined ||
    startOffset === undefined ||
    endOffset === undefined ||
    endOffset < startOffset ||
    fingerprint === undefined ||
    !request ||
    jobId === undefined ||
    name === undefined ||
    file === undefined ||
    jobCwd === undefined ||
    !JOB_STATUSES.has(status as JobStatus) ||
    detail === undefined ||
    sessionFile === null ||
    sessionId === null ||
    response === null ||
    error === null ||
    !messages ||
    latestUpdate === undefined
  ) {
    return undefined;
  }

  return {
    id,
    createdAt,
    updatedAt,
    reviewed,
    source: { uri, realPath, cwd, relativeFile, startOffset, endOffset, fingerprint },
    request,
    job: {
      id: jobId,
      name,
      file,
      cwd: jobCwd,
      status: status as JobStatus,
      detail,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(response === undefined ? {} : { response }),
      ...(error === undefined ? {} : { error }),
      messages,
      latestUpdate,
    },
  };
}

export function parseSelectionStore(value: unknown): PersistedSelectionStore {
  const input = object(value);
  if (
    input?.version !== 1 ||
    !Array.isArray(input.records) ||
    input.records.length > MAX_RAW_RECORDS
  ) {
    return EMPTY_STORE();
  }

  const rawRecords: unknown[] = [];
  let rawBytes = 2;
  for (const valueRecord of input.records) {
    try {
      const rawMessages = object(valueRecord)?.job;
      const messages = object(rawMessages)?.messages;
      if (Array.isArray(messages) && messages.length > MAX_MESSAGES) continue;
    } catch {
      continue;
    }
    const recordBytes = boundedJsonByteLength(valueRecord, MAX_RECORD_BYTES);
    if (recordBytes === undefined) continue;
    rawBytes += recordBytes + (rawRecords.length === 0 ? 0 : 1);
    if (rawBytes > MAX_STORE_BYTES) return EMPTY_STORE();
    if (recordBytes > MAX_RECORD_BYTES) continue;
    rawRecords.push(valueRecord);
  }

  const records: PersistedSelectionThread[] = [];
  const ids = new Set<string>();
  for (const valueRecord of rawRecords) {
    let record: PersistedSelectionThread | undefined;
    try {
      record = parseRecord(valueRecord);
    } catch {
      continue;
    }
    if (!record || ids.has(record.id)) continue;
    ids.add(record.id);
    records.push(record);
  }
  return boundSelectionStore(records);
}

function framed(label: string, value: string): string {
  return `${label}:${value.length}:${value}`;
}

export function selectionFingerprint(text: string, start: number, end: number): string {
  const safeStart = Math.min(text.length, Math.max(0, Number.isSafeInteger(start) ? start : 0));
  const safeEnd = Math.min(
    text.length,
    Math.max(safeStart, Number.isSafeInteger(end) ? end : safeStart),
  );
  const before = text.slice(Math.max(0, safeStart - 128), safeStart);
  const selected = text.slice(safeStart, safeEnd);
  const after = text.slice(safeEnd, Math.min(text.length, safeEnd + 128));
  return createHash("sha256")
    .update([framed("before", before), framed("selected", selected), framed("after", after)].join("|"))
    .digest("hex");
}

export function boundSelectionStore(
  records: readonly PersistedSelectionThread[],
): PersistedSelectionStore {
  const prioritized = [...records].sort(
    (left, right) =>
      Number(left.reviewed) - Number(right.reviewed) ||
      right.updatedAt - left.updatedAt ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const kept: PersistedSelectionThread[] = [];
  const ids = new Set<string>();

  for (const record of prioritized) {
    if (kept.length >= MAX_RECORDS || ids.has(record.id)) continue;
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (recordBytes > MAX_RECORD_BYTES) continue;
    const candidate = { version: 1 as const, records: [...kept, record] };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_STORE_BYTES) continue;
    ids.add(record.id);
    kept.push(record);
  }
  return { version: 1, records: kept };
}
