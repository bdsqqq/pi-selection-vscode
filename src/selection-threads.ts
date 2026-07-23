import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import {
  assertSessionFileIdentity,
  type PiJob,
  type RestoredPiJob,
  type SelectionRequest,
} from "./coordinator";
import {
  boundSelectionStore,
  parseSelectionStore,
  selectionFingerprint,
  SELECTION_THREAD_STORE_KEY,
  type PersistedSelectionThread,
} from "./selection-thread-persistence";
import {
  isSelectionReplyable,
  preferredSelectionStatus,
  selectionDecorationStatus,
  selectionThreadItems,
  transformSelectionOffsets,
  type SelectionThreadMessage,
} from "./selection-thread-model";

type TrackedSelection = {
  id: string;
  job: PiJob;
  thread: vscode.CommentThread;
  request: SelectionRequest;
  requestComment: vscode.Comment;
  progressComment: vscode.Comment;
  uri: string;
  realPath: string;
  startOffset: number;
  endOffset: number;
  reviewed: boolean;
  createdAt: number;
  updatedAt: number;
  fingerprint: string;
};

export type RestoredSelectionView = {
  job: PiJob;
  document: vscode.TextDocument;
  position: vscode.Position;
};

type RestoredSelection = {
  id: string;
  request: SelectionRequest;
  reviewed: boolean;
  createdAt: number;
  updatedAt: number;
  fingerprint: string;
  realPath: string;
  startOffset: number;
  endOffset: number;
};

export class SelectionThreads implements vscode.Disposable {
  readonly comments = vscode.comments.createCommentController(
    "piSelection.selection",
    "Pi Selection Sessions",
  );
  private readonly gutterDecorations: Record<
    "queued" | "running" | "completed" | "failed",
    vscode.TextEditorDecorationType
  >;
  private readonly selections = new Map<vscode.CommentThread, TrackedSelection>();
  private readonly disposables: vscode.Disposable[];
  private persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  private persistenceWrites: Promise<void> = Promise.resolve();

  constructor(
    extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
    private readonly log: (message: string) => void,
  ) {
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
    sourceRealPath: string,
  ): vscode.CommentThread {
    const now = Date.now();
    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);
    const thread = this.createThread(job, document, range, {
      id: job.id,
      request: copyRequest(request),
      reviewed: false,
      createdAt: now,
      updatedAt: now,
      fingerprint: selectionFingerprint(document.getText(), startOffset, endOffset),
      realPath: sourceRealPath,
      startOffset,
      endOffset,
    });
    this.schedulePersistence();
    return thread;
  }

  async restore(
    restoreJob: (folder: vscode.WorkspaceFolder, snapshot: RestoredPiJob) => PiJob,
  ): Promise<RestoredSelectionView[]> {
    const stored = parseSelectionStore(
      this.workspaceState.get<unknown>(SELECTION_THREAD_STORE_KEY),
    );
    const views: RestoredSelectionView[] = [];
    for (const record of stored.records) {
      try {
        views.push(await this.restoreRecord(record, restoreJob));
      } catch (error) {
        this.persistenceLog(`skipped ${record.id}: ${errorMessage(error)}`);
      }
    }
    await this.flush();
    return views;
  }

  async flush(): Promise<void> {
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = undefined;
    }
    await this.persistLatest();
  }

  refresh(job?: PiJob): void {
    for (const selection of this.selections.values()) {
      if (job && selection.job.id !== job.id) continue;
      if (job) {
        selection.job = job;
        selection.updatedAt = Date.now();
      }
      selection.progressComment.body = progressBody(selection.job);
      selection.thread.comments = [
        selection.requestComment,
        ...renderMessageComments(messagesFor(selection.job)),
        ...progressComments(selection.job, selection.progressComment),
      ];
      selection.thread.label = `Pi: ${selection.job.name}`;
      selection.thread.canReply = isSelectionReplyable(selection.job);
    }
    this.refreshDecorations();
    this.schedulePersistence();
  }

  replyTarget(thread: vscode.CommentThread): PiJob | undefined {
    const selection = this.selections.get(thread);
    return selection && isSelectionReplyable(selection.job) ? selection.job : undefined;
  }

  markReviewed(thread: vscode.CommentThread): boolean {
    const selection = this.selections.get(thread);
    if (!selection || selection.reviewed) return false;
    selection.reviewed = true;
    selection.updatedAt = Date.now();
    selection.thread.state = vscode.CommentThreadState.Resolved;
    selection.thread.contextValue = "piSelection.selectionReviewed";
    this.refreshDecorations();
    this.schedulePersistence();
    return true;
  }

  removeFinished(): void {
    for (const selection of [...this.selections.values()]) {
      if (selection.job.status === "queued" || selection.job.status === "running") continue;
      this.selections.delete(selection.thread);
      selection.thread.dispose();
    }
    this.refreshDecorations();
    this.schedulePersistence();
  }

  dispose(): void {
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    for (const selection of this.selections.values()) selection.thread.dispose();
    this.selections.clear();
    this.comments.dispose();
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
      selection.updatedAt = Date.now();
      selection.fingerprint = selectionFingerprint(
        event.document.getText(),
        offsets.start,
        offsets.end,
      );
      selection.thread.range = rangeAtOffsets(event.document, offsets.start, offsets.end);
    }
    this.refreshDecorations();
    this.schedulePersistence();
  }

  private createThread(
    job: PiJob,
    document: vscode.TextDocument,
    range: vscode.Range,
    restored: RestoredSelection,
  ): vscode.CommentThread {
    const [requestComment, ...messageComments] = renderStaticComments(
      restored.request,
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
      ...progressComments(job, progressComment),
    ]);
    thread.label = `Pi: ${job.name}`;
    thread.contextValue = restored.reviewed
      ? "piSelection.selectionReviewed"
      : "piSelection.selectionThread";
    thread.state = restored.reviewed
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    thread.canReply = isSelectionReplyable(job);

    this.selections.set(thread, {
      id: restored.id,
      job,
      thread,
      request: copyRequest(restored.request),
      requestComment,
      progressComment,
      uri: document.uri.toString(),
      realPath: restored.realPath,
      startOffset: restored.startOffset,
      endOffset: restored.endOffset,
      reviewed: restored.reviewed,
      createdAt: restored.createdAt,
      updatedAt: restored.updatedAt,
      fingerprint: restored.fingerprint,
    });
    this.refreshDecorations();
    return thread;
  }

  private async restoreRecord(
    record: PersistedSelectionThread,
    restoreJob: (folder: vscode.WorkspaceFolder, snapshot: RestoredPiJob) => PiJob,
  ): Promise<RestoredSelectionView> {
    const uri = vscode.Uri.parse(record.source.uri, true);
    if (uri.scheme !== "file") throw new Error("source is not a file URI");
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) throw new Error("source is outside the workspace");

    const folderPath = folder.uri.fsPath;
    const currentRelativeFile = relative(folderPath, uri.fsPath);
    if (
      record.source.cwd !== folderPath ||
      record.source.relativeFile !== currentRelativeFile ||
      record.request.relativeFile !== currentRelativeFile ||
      record.job.file !== currentRelativeFile ||
      record.job.cwd !== folderPath
    ) {
      throw new Error("stored source path differs from workspace path");
    }

    const [workspaceRealPath, sourceRealPath] = await Promise.all([
      realpath(folderPath),
      realpath(uri.fsPath),
    ]);
    const realRelativeFile = relative(workspaceRealPath, sourceRealPath);
    if (
      record.source.realPath !== sourceRealPath ||
      realRelativeFile === ".." ||
      realRelativeFile.startsWith(`..${sep}`) ||
      isAbsolute(realRelativeFile) ||
      resolve(workspaceRealPath, realRelativeFile) !== sourceRealPath
    ) {
      throw new Error("source realpath is outside the workspace");
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const length = document.getText().length;
    if (record.source.startOffset > length || record.source.endOffset > length) {
      throw new Error("selection offsets are out of bounds");
    }
    if (
      selectionFingerprint(
        document.getText(),
        record.source.startOffset,
        record.source.endOffset,
      ) !== record.source.fingerprint
    ) {
      throw new Error("selection fingerprint changed");
    }

    const snapshot = await restoredJobSnapshot(record);
    const currentText = document.getText();
    if (
      record.source.startOffset > currentText.length ||
      record.source.endOffset > currentText.length ||
      selectionFingerprint(currentText, record.source.startOffset, record.source.endOffset) !==
        record.source.fingerprint
    ) {
      throw new Error("selection changed during restore");
    }
    const job = restoreJob(folder, snapshot);
    const range = rangeAtOffsets(document, record.source.startOffset, record.source.endOffset);
    this.createThread(job, document, range, {
      id: record.id,
      request: copyRequest(record.request),
      reviewed: record.reviewed,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      fingerprint: record.source.fingerprint,
      realPath: sourceRealPath,
      startOffset: record.source.startOffset,
      endOffset: record.source.endOffset,
    });
    return { job, document, position: range.end };
  }

  private schedulePersistence(): void {
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      void this.persistLatest();
    }, 250);
  }

  private persistLatest(): Promise<void> {
    const records = [...this.selections.values()].map(toPersistedSelection);
    const store = boundSelectionStore(records);
    const write = this.persistenceWrites.then(() =>
      Promise.resolve(this.workspaceState.update(SELECTION_THREAD_STORE_KEY, store)),
    );
    this.persistenceWrites = write.catch((error) => {
      this.persistenceLog(`write failed: ${errorMessage(error)}`);
    });
    return this.persistenceWrites;
  }

  private persistenceLog(message: string): void {
    this.log(`[Selection persistence] ${message}`);
  }

  private refreshDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const byStatus: Record<
        "queued" | "running" | "completed" | "failed",
        vscode.Range[]
      > = {
        queued: [],
        running: [],
        completed: [],
        failed: [],
      };
      const byLine = new Map<
        number,
        { position: vscode.Position; status: keyof typeof byStatus }
      >();
      for (const selection of this.selections.values()) {
        if (selection.uri !== editor.document.uri.toString() || selection.reviewed) continue;
        const position = rangeAtOffsets(
          editor.document,
          selection.startOffset,
          selection.endOffset,
        ).start;
        const candidate = selectionDecorationStatus(selection.job.status);
        const current = byLine.get(position.line);
        byLine.set(position.line, {
          position,
          status: preferredSelectionStatus(current?.status, candidate),
        });
      }
      for (const { position, status } of byLine.values()) {
        byStatus[status].push(new vscode.Range(position, position));
      }
      for (const status of ["queued", "running", "completed", "failed"] as const) {
        editor.setDecorations(this.gutterDecorations[status], byStatus[status]);
      }
    }
  }
}

function copyRequest(request: SelectionRequest): SelectionRequest {
  return {
    instruction: request.instruction,
    relativeFile: request.relativeFile,
    language: request.language,
    startLine: request.startLine,
    endLine: request.endLine,
    text: request.text,
  };
}

function toPersistedSelection(selection: TrackedSelection): PersistedSelectionThread {
  return {
    id: selection.id,
    createdAt: selection.createdAt,
    updatedAt: selection.updatedAt,
    reviewed: selection.reviewed,
    source: {
      uri: selection.uri,
      realPath: selection.realPath,
      cwd: selection.job.cwd,
      relativeFile: selection.request.relativeFile,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      fingerprint: selection.fingerprint,
    },
    request: copyRequest(selection.request),
    job: {
      id: selection.job.id,
      name: selection.job.name,
      file: selection.job.file,
      cwd: selection.job.cwd,
      status: selection.job.status,
      detail: selection.job.detail,
      ...(selection.job.sessionFile === undefined
        ? {}
        : { sessionFile: selection.job.sessionFile }),
      ...(selection.job.sessionId === undefined ? {} : { sessionId: selection.job.sessionId }),
      ...(selection.job.response === undefined ? {} : { response: selection.job.response }),
      ...(selection.job.error === undefined ? {} : { error: selection.job.error }),
      messages: selection.job.messages.map(({ role, body }) => ({ role, body })),
      latestUpdate: selection.job.latestUpdate,
    },
  };
}

async function restoredJobSnapshot(
  record: PersistedSelectionThread,
): Promise<RestoredPiJob> {
  let status = record.job.status;
  let detail = record.job.detail;
  let error = record.job.error;
  let sessionFile = record.job.sessionFile;
  let sessionId = record.job.sessionId;

  if (status === "queued" || status === "running") {
    status = "aborted";
    detail = "interrupted by editor reload";
    error = "interrupted by editor reload";
  }
  if (sessionFile !== undefined || sessionId !== undefined) {
    try {
      if (!sessionFile || !sessionId) throw new Error("incomplete session identity");
      await assertSessionFileIdentity(sessionFile, sessionId, record.job.cwd);
    } catch {
      sessionFile = undefined;
      sessionId = undefined;
      status = "failed";
      detail = "session unavailable";
      error = "session unavailable";
    }
  }

  return {
    id: record.job.id,
    name: record.job.name,
    file: record.job.file,
    cwd: record.job.cwd,
    status,
    detail,
    ...(sessionFile === undefined ? {} : { sessionFile }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(record.job.response === undefined ? {} : { response: record.job.response }),
    ...(error === undefined ? {} : { error }),
    messages: record.job.messages.map(({ role, body }) => ({ role, body })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function progressComments(job: PiJob, comment: vscode.Comment): vscode.Comment[] {
  return job.status === "completed" ? [] : [comment];
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
