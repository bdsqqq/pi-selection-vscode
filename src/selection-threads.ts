import * as vscode from "vscode";
import type { PiJob, SelectionRequest } from "./coordinator";
import {
  isSelectionReplyable,
  selectionDecorationStatus,
  selectionThreadItems,
  transformSelectionOffsets,
  type SelectionThreadMessage,
} from "./selection-thread-model";

type TrackedSelection = {
  job: PiJob;
  thread: vscode.CommentThread;
  requestComment: vscode.Comment;
  progressComment: vscode.Comment;
  uri: string;
  startOffset: number;
  endOffset: number;
  reviewed: boolean;
};

export class SelectionThreads implements vscode.Disposable {
  readonly comments = vscode.comments.createCommentController(
    "piSelection.selection",
    "Pi Selection Sessions",
  );
  private readonly unresolvedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.warningForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly gutterDecorations: Record<
    "queued" | "running" | "completed" | "failed",
    vscode.TextEditorDecorationType
  >;
  private readonly selections = new Map<vscode.CommentThread, TrackedSelection>();
  private readonly disposables: vscode.Disposable[];

  constructor(extensionUri: vscode.Uri) {
    this.comments.options = {
      prompt: "Reply to this Pi session",
      placeHolder: "Ask Pi to follow up…",
    };
    this.gutterDecorations = {
      queued: createGutterDecoration(extensionUri, "queued"),
      running: createGutterDecoration(extensionUri, "running"),
      completed: createGutterDecoration(extensionUri, "completed"),
      failed: createGutterDecoration(extensionUri, "failed"),
    };
    this.disposables = [
      vscode.workspace.onDidChangeTextDocument((event) => this.trackDocumentEdit(event)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
    ];
  }

  track(
    job: PiJob,
    document: vscode.TextDocument,
    range: vscode.Range,
    request: SelectionRequest,
  ): vscode.CommentThread {
    const [requestComment, ...messageComments] = renderStaticComments(
      request,
      messagesFor(job),
    );
    const progressComment: vscode.Comment = {
      author: { name: "Pi" },
      body: progressBody(job),
      mode: vscode.CommentMode.Preview,
    };
    const thread = this.comments.createCommentThread(document.uri, range, [
      requestComment,
      ...messageComments,
      progressComment,
    ]);
    thread.label = `Pi: ${job.name}`;
    thread.contextValue = "piSelection.selectionThread";
    thread.state = vscode.CommentThreadState.Unresolved;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = isSelectionReplyable(job);

    this.selections.set(thread, {
      job,
      thread,
      requestComment,
      progressComment,
      uri: document.uri.toString(),
      startOffset: document.offsetAt(range.start),
      endOffset: document.offsetAt(range.end),
      reviewed: false,
    });
    this.refreshDecorations();
    return thread;
  }

  refresh(job?: PiJob): void {
    for (const selection of this.selections.values()) {
      if (job && selection.job.id !== job.id) continue;
      if (job) selection.job = job;
      selection.progressComment.body = progressBody(selection.job);
      selection.thread.comments = [
        selection.requestComment,
        ...renderMessageComments(messagesFor(selection.job)),
        selection.progressComment,
      ];
      selection.thread.label = `Pi: ${selection.job.name}`;
      selection.thread.canReply = isSelectionReplyable(selection.job);
    }
    this.refreshDecorations();
  }

  replyTarget(thread: vscode.CommentThread): PiJob | undefined {
    const selection = this.selections.get(thread);
    return selection && isSelectionReplyable(selection.job) ? selection.job : undefined;
  }

  markReviewed(thread: vscode.CommentThread): boolean {
    const selection = this.selections.get(thread);
    if (!selection || selection.reviewed) return false;
    selection.reviewed = true;
    selection.thread.state = vscode.CommentThreadState.Resolved;
    selection.thread.contextValue = "piSelection.selectionReviewed";
    this.refreshDecorations();
    return true;
  }

  removeFinished(): void {
    for (const selection of [...this.selections.values()]) {
      if (selection.job.status === "queued" || selection.job.status === "running") continue;
      this.selections.delete(selection.thread);
      selection.thread.dispose();
    }
    this.refreshDecorations();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const selection of this.selections.values()) selection.thread.dispose();
    this.selections.clear();
    this.comments.dispose();
    this.unresolvedDecoration.dispose();
    for (const decoration of Object.values(this.gutterDecorations)) decoration.dispose();
  }

  private trackDocumentEdit(event: vscode.TextDocumentChangeEvent): void {
    const matching = [...this.selections.values()].filter(
      (selection) => selection.uri === event.document.uri.toString(),
    );
    if (matching.length === 0) return;
    for (const selection of matching) {
      const offsets = transformSelectionOffsets(
        { start: selection.startOffset, end: selection.endOffset },
        event.contentChanges,
      );
      selection.startOffset = offsets.start;
      selection.endOffset = offsets.end;
      selection.thread.range = rangeAtOffsets(event.document, offsets.start, offsets.end);
    }
    this.refreshDecorations();
  }

  private refreshDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const unresolved: vscode.Range[] = [];
      const byStatus: Record<
        "queued" | "running" | "completed" | "failed",
        vscode.Range[]
      > = {
        queued: [],
        running: [],
        completed: [],
        failed: [],
      };
      for (const selection of this.selections.values()) {
        if (selection.uri !== editor.document.uri.toString()) continue;
        const range = rangeAtOffsets(
          editor.document,
          selection.startOffset,
          selection.endOffset,
        );
        byStatus[selectionDecorationStatus(selection.job.status)].push(range);
        if (!selection.reviewed) unresolved.push(range);
      }
      editor.setDecorations(this.unresolvedDecoration, unresolved);
      for (const status of ["queued", "running", "completed", "failed"] as const) {
        editor.setDecorations(this.gutterDecorations[status], byStatus[status]);
      }
    }
  }
}

function messagesFor(job: PiJob): readonly SelectionThreadMessage[] {
  return job.messages;
}

function renderStaticComments(
  request: SelectionRequest,
  messages: readonly SelectionThreadMessage[],
): vscode.Comment[] {
  return selectionThreadItems(request, messages).map((item) => {
    if (item.kind === "request") return renderRequestComment(item.request);
    return renderMessageComment(item.message);
  });
}

function renderRequestComment(request: SelectionRequest): vscode.Comment {
  const body = markdown();
  body.appendText(request.instruction);
  body.appendMarkdown("\n\n");
  body.appendText(
    `${request.relativeFile}:${request.startLine}-${request.endLine} (${request.language})`,
  );
  body.appendMarkdown("\n\n");
  body.appendCodeblock(request.text, request.language);
  return {
    author: { name: "You" },
    body,
    mode: vscode.CommentMode.Preview,
  };
}

function renderMessageComments(messages: readonly SelectionThreadMessage[]): vscode.Comment[] {
  return messages.map(renderMessageComment);
}

function renderMessageComment(message: SelectionThreadMessage): vscode.Comment {
  const body = markdown();
  if (message.role === "assistant") body.appendMarkdown(message.body);
  else body.appendText(message.body);
  return {
    author: { name: message.role === "user" ? "You" : "Pi" },
    body,
    mode: vscode.CommentMode.Preview,
  };
}

function progressBody(job: PiJob): vscode.MarkdownString {
  const body = markdown();
  body.appendMarkdown("**");
  body.appendText(job.detail);
  body.appendMarkdown("**");
  if (job.error) {
    body.appendMarkdown("\n\n");
    body.appendText(job.error);
  }
  return body;
}

function markdown(): vscode.MarkdownString {
  const body = new vscode.MarkdownString();
  body.isTrusted = false;
  body.supportHtml = false;
  return body;
}

function rangeAtOffsets(document: vscode.TextDocument, start: number, end: number): vscode.Range {
  const length = document.getText().length;
  return new vscode.Range(
    document.positionAt(Math.min(start, length)),
    document.positionAt(Math.min(end, length)),
  );
}

function createGutterDecoration(
  extensionUri: vscode.Uri,
  status: "queued" | "running" | "completed" | "failed",
): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(extensionUri, "resources", `pi-status-${status}.svg`),
    gutterIconSize: "contain",
  });
}
