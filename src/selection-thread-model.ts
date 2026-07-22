import type { JobStatus, PiJobMessage, SelectionRequest } from "./coordinator";

export type SelectionThreadMessage = PiJobMessage;

export type SelectionThreadItem =
  | { kind: "request"; request: SelectionRequest }
  | { kind: "message"; message: SelectionThreadMessage };

export type SelectionOffsets = {
  start: number;
  end: number;
};

export type SelectionContentChange = {
  rangeOffset: number;
  rangeLength: number;
  text: string;
};

export function selectionThreadItems(
  request: SelectionRequest,
  messages: readonly SelectionThreadMessage[] = [],
): SelectionThreadItem[] {
  return [
    { kind: "request", request },
    ...messages.map((message) => ({ kind: "message" as const, message })),
  ];
}

export function isSelectionReplyable(job: {
  status: JobStatus;
  sessionFile?: string;
}): boolean {
  return (
    Boolean(job.sessionFile) &&
    (job.status === "completed" || job.status === "failed" || job.status === "aborted")
  );
}

export function selectionDecorationStatus(
  status: JobStatus,
): "queued" | "running" | "completed" | "failed" {
  return status === "aborted" ? "failed" : status;
}

export function transformSelectionOffsets(
  offsets: SelectionOffsets,
  changes: readonly SelectionContentChange[],
): SelectionOffsets {
  const ordered = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset);
  const start = transformBoundary(offsets.start, ordered, "right");
  const end = transformBoundary(offsets.end, ordered, "left");
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function transformBoundary(
  offset: number,
  changes: readonly SelectionContentChange[],
  insertionAffinity: "left" | "right",
): number {
  for (const change of changes) {
    const changeEnd = change.rangeOffset + change.rangeLength;
    if (change.rangeLength === 0 && change.rangeOffset === offset) {
      if (insertionAffinity === "right") offset += change.text.length;
    } else if (changeEnd <= offset) {
      offset += change.text.length - change.rangeLength;
    } else if (change.rangeOffset < offset) {
      offset = change.rangeOffset + change.text.length;
    }
  }
  return offset;
}
