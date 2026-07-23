import type { JobStatus } from "./coordinator";

export type ThreadSource = "local" | "agentation";

export type ThreadRef =
  | { kind: "local"; id: string }
  | { kind: "agentation"; serverUrl: string; taskId: string };

export type ThreadLifecycle = "working" | "needsAttention" | "settled";

export type ThreadSummary = {
  ref: ThreadRef;
  title: string;
  source: ThreadSource;
  location: string;
  lifecycle: ThreadLifecycle;
  execution: JobStatus;
  updatedAt: number;
  latestUpdate: string;
  canReply: boolean;
  canSettle: boolean;
  canAbort: boolean;
  hasChanges: boolean;
  settlementCapability: boolean;
  capabilityMessage?: string;
};

export type ThreadGroup = {
  lifecycle: ThreadLifecycle;
  threads: ThreadSummary[];
};

const WORKING_STATUSES = new Set<JobStatus>(["queued", "running"]);
const LIFECYCLE_ORDER: readonly ThreadLifecycle[] = ["needsAttention", "working", "settled"];

export function serializeThreadRef(ref: ThreadRef): string {
  return ref.kind === "local"
    ? JSON.stringify(["local", ref.id])
    : JSON.stringify(["agentation", ref.serverUrl, ref.taskId]);
}

export function deriveThreadLifecycle(
  execution: JobStatus,
  settled: boolean | undefined,
): ThreadLifecycle {
  if (WORKING_STATUSES.has(execution)) return "working";
  return settled === true ? "settled" : "needsAttention";
}

export function supportsThreadSettlement(
  ref: ThreadRef,
  settled: boolean | undefined,
  agentationCapability = settled !== undefined,
): boolean {
  return ref.kind === "local" || agentationCapability;
}

export function canSettleThread(
  ref: ThreadRef,
  execution: JobStatus,
  settled: boolean | undefined,
  agentationCapability?: boolean,
): boolean {
  return (
    supportsThreadSettlement(ref, settled, agentationCapability) &&
    !WORKING_STATUSES.has(execution) &&
    settled !== true
  );
}

export function groupThreadSummaries(summaries: readonly ThreadSummary[]): ThreadGroup[] {
  return LIFECYCLE_ORDER.flatMap((lifecycle) => {
    const threads = summaries
      .filter((summary) => summary.lifecycle === lifecycle)
      .sort((left, right) => {
        const recency = right.updatedAt - left.updatedAt;
        if (recency !== 0) return recency;
        const leftIdentity = serializeThreadRef(left.ref);
        const rightIdentity = serializeThreadRef(right.ref);
        return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
      });
    return threads.length === 0 ? [] : [{ lifecycle, threads }];
  });
}
