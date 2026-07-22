import type { AgentationAnnotation, AgentationMessage } from "./agentation";

export type ProjectedThreadItem =
  | { kind: "annotation"; annotation: AgentationAnnotation }
  | { kind: "message"; message: AgentationMessage };

export function projectThreadItems(
  annotation: AgentationAnnotation,
  messages: readonly AgentationMessage[] = [],
): ProjectedThreadItem[] {
  return [
    { kind: "annotation", annotation },
    ...messages
      .filter((message) => message.annotationId === undefined || message.annotationId === annotation.id)
      .map((message) => ({ kind: "message" as const, message })),
  ];
}
