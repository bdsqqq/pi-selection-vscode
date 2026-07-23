import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  projectSnapshot,
  type AgentationAnnotation,
  type AgentationEvent,
  type AgentationMessage,
  type AgentationSnapshot,
  type SnapshotProjectionState,
} from "./agentation";
import { transformAnchor } from "./anchor";
import { jobName, type PiJob } from "./coordinator";
import { latestUpdate } from "./inlay-text";
import { projectThreadItems } from "./projection-comments";
import { SessionInlays } from "./session-inlays";
import { preferredSelectionStatus } from "./selection-thread-model";
import {
  chooseSourcePath,
  isPathWithinRoot,
  parseSourceFile,
  type SourcePathCandidate,
} from "./source-file";

type ProjectedReview = {
  key: string;
  taskId: string;
  annotationId: string;
  signature: string;
  job: PiJob;
  thread: vscode.CommentThread;
  progress: vscode.Comment;
  uri: vscode.Uri;
  offset: number;
};

type ProjectedTask = {
  id: string;
  state: SnapshotProjectionState;
  job: PiJob;
  reviews: Map<string, ProjectedReview>;
  desiredAnchors: Map<string, string>;
  attemptedAnchors: Map<string, string>;
  pendingAnchors: Map<string, symbol>;
};

export type ProjectionReplyTarget = {
  generation: string;
  taskId: string;
  annotationId: string;
};

export type ProjectionSettlementTarget = {
  generation: string;
  taskId: string;
  revision: number;
  settled: boolean;
  incarnationId: string;
};

export type ProjectedThreadView = {
  taskId: string;
  job: PiJob;
  title: string;
  location: string;
  updatedAt: number;
  settled?: boolean;
  settlementCapability: boolean;
  revision: number;
  status: AgentationSnapshot["status"];
  hasChanges: boolean;
  anchorCount: number;
};

export class ProjectionController implements vscode.Disposable {
  private readonly comments = vscode.comments.createCommentController(
    "piSelection.agentation",
    "Agentation Reviews",
  );
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.warningForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  readonly queuedGutterDecoration: vscode.TextEditorDecorationType;
  readonly runningGutterDecoration: vscode.TextEditorDecorationType;
  readonly completedGutterDecoration: vscode.TextEditorDecorationType;
  readonly failedGutterDecoration: vscode.TextEditorDecorationType;
  private readonly tasks = new Map<string, ProjectedTask>();
  private readonly reviews = new Map<vscode.CommentThread, ProjectedReview>();
  private readonly disposables: vscode.Disposable[];
  private generation?: string;

  constructor(
    extensionUri: vscode.Uri,
    private readonly inlays: SessionInlays,
    private readonly onChange: () => void,
    private readonly log: (message: string) => void,
  ) {
    this.comments.options = {
      prompt: "Reply to this Pi session",
      placeHolder: "Ask Pi to follow up…",
    };
    this.queuedGutterDecoration = createGutterDecoration(extensionUri, "queued");
    this.runningGutterDecoration = createGutterDecoration(extensionUri, "running");
    this.completedGutterDecoration = createGutterDecoration(extensionUri, "completed");
    this.failedGutterDecoration = createGutterDecoration(extensionUri, "failed");
    this.disposables = [
      vscode.workspace.onDidChangeTextDocument((event) => this.trackDocumentEdit(event)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
    ];
  }

  list(): PiJob[] {
    return [...this.tasks.values()].map(({ job }) => job);
  }

  listThreads(): ProjectedThreadView[] {
    return [...this.tasks.values()].map((task) => {
      const snapshot = task.state.snapshot;
      return {
        taskId: task.id,
        job: task.job,
        title: task.job.name,
        location: task.job.file,
        updatedAt: snapshot.updatedAt ?? 0,
        settled: snapshot.settled,
        settlementCapability: hasSettlementCapability(snapshot),
        revision: snapshot.revision,
        status: snapshot.status,
        hasChanges: Boolean(snapshot.changes?.length),
        anchorCount: task.reviews.size,
      };
    });
  }

  snapshotByTaskId(taskId: string): AgentationSnapshot | undefined {
    return this.tasks.get(taskId)?.state.snapshot;
  }

  snapshotFor(target: unknown): AgentationSnapshot | undefined {
    const threadReview = this.reviews.get(target as vscode.CommentThread);
    if (threadReview) return this.tasks.get(threadReview.taskId)?.state.snapshot;
    const targetId = (target as { id?: unknown })?.id;
    const anchorReview = [...this.reviews.values()].find(
      (review) => review.job === target || review.job.id === targetId,
    );
    if (anchorReview) return this.tasks.get(anchorReview.taskId)?.state.snapshot;
    return [...this.tasks.values()].find(
      (task) => task.job === target || task.job.id === targetId,
    )?.state.snapshot;
  }

  hasChanges(job: PiJob): boolean {
    return Boolean(this.snapshotFor(job)?.changes?.length);
  }

  taskIdForThread(thread: vscode.CommentThread): string | undefined {
    return this.reviews.get(thread)?.taskId;
  }

  settlementTarget(taskId: string): ProjectionSettlementTarget | undefined {
    if (!this.generation) return undefined;
    const snapshot = this.tasks.get(taskId)?.state.snapshot;
    if (!snapshot || !isTerminal(snapshot) || !hasSettlementCapability(snapshot)) return undefined;
    return {
      generation: this.generation,
      taskId,
      revision: snapshot.revision,
      settled: snapshot.settled,
      incarnationId: snapshot.incarnationId,
    };
  }

  assertGeneration(generation: string): void {
    if (!this.generation || this.generation !== generation) {
      throw new Error("This Agentation projection generation expired. Refresh and try again.");
    }
  }

  assertSettlementTarget(target: ProjectionSettlementTarget): void {
    const current = this.settlementTarget(target.taskId);
    if (
      !current ||
      current.generation !== target.generation ||
      current.revision !== target.revision ||
      current.settled !== target.settled ||
      current.incarnationId !== target.incarnationId
    ) {
      throw new Error("This settlement target expired. Refresh the review and try again.");
    }
  }

  applySettlement(snapshot: AgentationSnapshot): void {
    this.handle(snapshot);
  }

  async replyTargetForTask(taskId: string): Promise<ProjectionReplyTarget | undefined> {
    if (!this.generation) return undefined;
    const snapshot = this.tasks.get(taskId)?.state.snapshot;
    if (!snapshot || !isReplyable(snapshot)) return undefined;
    const annotation =
      snapshot.annotations.length === 1
        ? snapshot.annotations[0]
        : (
            await vscode.window.showQuickPick(
              snapshot.annotations.map((candidate) => ({
                label: jobName(candidate.comment),
                description: candidate.sourceFile,
                annotation: candidate,
              })),
              { title: "Reply to Agentation thread", placeHolder: "Choose an annotation" },
            )
          )?.annotation;
    return annotation
      ? { generation: this.generation, taskId, annotationId: annotation.id }
      : undefined;
  }

  replyTarget(thread: vscode.CommentThread): ProjectionReplyTarget | undefined {
    const review = this.reviews.get(thread);
    if (!review || !this.generation) return undefined;
    const snapshot = this.tasks.get(review.taskId)?.state.snapshot;
    if (!snapshot || !isReplyable(snapshot)) return undefined;
    return { generation: this.generation, taskId: review.taskId, annotationId: review.annotationId };
  }

  assertReplyTarget(thread: vscode.CommentThread, target: ProjectionReplyTarget): void {
    const current = this.replyTarget(thread);
    if (
      !current ||
      current.generation !== target.generation ||
      current.taskId !== target.taskId ||
      current.annotationId !== target.annotationId
    ) {
      throw new Error("This reply target expired. Try again from the current comment thread.");
    }
  }

  handle(event: AgentationEvent): void {
    if (event.type === "projection.reset") {
      this.generation = event.generation;
      this.reset();
      return;
    }
    if (event.type === "task.remove") {
      this.removeTask(event.taskId);
      return;
    }
    const task = this.tasks.get(event.taskId);
    if (!task) {
      const state = projectSnapshot(undefined, event);
      const created: ProjectedTask = {
        id: event.taskId,
        state,
        job: createTaskJob(state.snapshot, state.feed),
        reviews: new Map(),
        desiredAnchors: new Map(),
        attemptedAnchors: new Map(),
        pendingAnchors: new Map(),
      };
      this.tasks.set(event.taskId, created);
      this.syncAnchors(created);
      this.onChange();
      return;
    }

    task.state = projectSnapshot(task.state, event);
    updateTaskJob(task.job, task.state.snapshot, task.state.feed);
    for (const review of task.reviews.values()) this.updateReview(review, task);
    this.syncAnchors(task);
    this.inlays.refresh();
    this.onChange();
  }

  reset(): void {
    for (const task of [...this.tasks.values()]) this.disposeTask(task);
    this.reviews.clear();
    this.refreshProjectionViews();
  }

  disconnect(): void {
    this.generation = undefined;
    this.reset();
  }

  markReviewed(thread: vscode.CommentThread): ProjectionSettlementTarget | undefined {
    const taskId = this.taskIdForThread(thread);
    return taskId ? this.settlementTarget(taskId) : undefined;
  }

  async revealTask(taskId: string): Promise<boolean> {
    const reviews = [...(this.tasks.get(taskId)?.reviews.values() ?? [])].sort((left, right) =>
      `${left.job.file}\0${left.annotationId}`.localeCompare(`${right.job.file}\0${right.annotationId}`),
    );
    if (reviews.length === 0) return false;

    const review =
      reviews.length === 1
        ? reviews[0]
        : (
            await vscode.window.showQuickPick(
              reviews.map((candidate) => ({
                label: candidate.job.name,
                description: candidate.job.file,
                review: candidate,
              })),
              { title: "Reveal Agentation review", placeHolder: "Select a source anchor" },
            )
          )?.review;
    if (!review) return false;

    const document = await vscode.workspace.openTextDocument(review.uri);
    const position = document.positionAt(Math.min(review.offset, document.getText().length));
    const range = document.lineAt(position.line).range;
    review.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const editor = await vscode.window.showTextDocument(document, { preview: true, selection: range });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const review of this.reviews.values()) review.thread.dispose();
    this.reviews.clear();
    this.comments.dispose();
    this.decoration.dispose();
    this.queuedGutterDecoration.dispose();
    this.runningGutterDecoration.dispose();
    this.completedGutterDecoration.dispose();
    this.failedGutterDecoration.dispose();
  }

  private removeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) this.disposeTask(task);
    this.refreshProjectionViews();
  }

  private disposeTask(task: ProjectedTask): void {
    task.desiredAnchors.clear();
    task.pendingAnchors.clear();
    for (const review of [...task.reviews.values()]) this.removeReview(task, review);
    this.tasks.delete(task.id);
  }

  private refreshProjectionViews(): void {
    this.refreshDecorations();
    this.inlays.refresh();
    this.onChange();
  }

  private syncAnchors(task: ProjectedTask): void {
    const snapshot = task.state.snapshot;
    const wanted = new Map<string, { annotation: AgentationAnnotation; signature: string }>();
    for (const annotation of snapshot.annotations) {
      if (!annotation.sourceFile) continue;
      const key = `${snapshot.taskId}:${annotation.id}`;
      wanted.set(key, { annotation, signature: anchorSignature(snapshot, annotation) });
    }
    task.desiredAnchors = new Map([...wanted].map(([key, value]) => [key, value.signature]));

    for (const [key, attempted] of task.attemptedAnchors) {
      if (wanted.get(key)?.signature !== attempted) {
        task.attemptedAnchors.delete(key);
        task.pendingAnchors.delete(key);
      }
    }
    for (const [key, review] of task.reviews) {
      if (wanted.get(key)?.signature !== review.signature) this.removeReview(task, review);
    }
    for (const [key, { annotation, signature }] of wanted) {
      if (task.reviews.has(key) || task.attemptedAnchors.get(key) === signature) continue;
      const attempt = Symbol(key);
      task.attemptedAnchors.set(key, signature);
      task.pendingAnchors.set(key, attempt);
      void this.anchor(task, annotation, key, signature, attempt);
    }
    this.refreshDecorations();
  }

  private async anchor(
    task: ProjectedTask,
    annotation: AgentationAnnotation,
    key: string,
    signature: string,
    attempt: symbol,
  ): Promise<void> {
    try {
      const parsed = parseSourceFile(annotation.sourceFile!);
      if (!parsed) throw new Error(`invalid sourceFile: ${annotation.sourceFile}`);
      const resolved = await resolveSourcePath(parsed.file, task.state.snapshot.cwd);
      if (!resolved) throw new Error(`sourceFile did not resolve uniquely inside cwd: ${parsed.file}`);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
      if (parsed.line > document.lineCount) {
        throw new Error(`source line ${parsed.line} exceeds ${document.lineCount}: ${parsed.file}`);
      }
      const line = parsed.line - 1;
      const lineText = document.lineAt(line).text;
      if (parsed.column > lineText.length + 1) {
        throw new Error(`source column ${parsed.column} exceeds line ${parsed.line}: ${parsed.file}`);
      }
      if (
        task.desiredAnchors.get(key) !== signature ||
        task.pendingAnchors.get(key) !== attempt
      ) {
        return;
      }

      const position = new vscode.Position(line, parsed.column - 1);
      const progress: vscode.Comment = {
        author: { name: "Agentation server" },
        body: progressBody(task.state.snapshot),
        mode: vscode.CommentMode.Preview,
      };
      const thread = this.comments.createCommentThread(
        document.uri,
        document.lineAt(line).range,
        [...staticComments(annotation, task.state.snapshot.messages), progress],
      );
      thread.label = `Agentation: ${jobName(annotation.comment)}`;
      applyThreadSettlement(thread, task.state.snapshot);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      thread.canReply = isReplyable(task.state.snapshot);

      const job = createAnchorJob(task, annotation, key, resolved);
      const review: ProjectedReview = {
        key,
        taskId: task.id,
        annotationId: annotation.id,
        signature,
        job,
        thread,
        progress,
        uri: document.uri,
        offset: document.offsetAt(position),
      };
      task.reviews.set(key, review);
      this.reviews.set(thread, review);
      this.inlays.track(job, document, position);
      this.refreshDecorations();
      this.onChange();
    } catch (error) {
      this.log(`[Agentation ${task.id}] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (task.pendingAnchors.get(key) === attempt) task.pendingAnchors.delete(key);
    }
  }

  private updateReview(review: ProjectedReview, task: ProjectedTask): void {
    const snapshot = task.state.snapshot;
    const annotation = snapshot.annotations.find((candidate) => candidate.id === review.annotationId);
    if (!annotation) return;
    updateJob(review.job, snapshot, task.state.feed);
    review.progress.body = progressBody(snapshot);
    review.thread.comments = [
      ...staticComments(annotation, snapshot.messages),
      review.progress,
    ];
    applyThreadSettlement(review.thread, snapshot);
    review.thread.canReply = isReplyable(snapshot);
  }

  private removeReview(task: ProjectedTask, review: ProjectedReview): void {
    task.reviews.delete(review.key);
    this.reviews.delete(review.thread);
    this.inlays.remove(review.job.id);
    review.thread.dispose();
  }

  private trackDocumentEdit(event: vscode.TextDocumentChangeEvent): void {
    const matching = [...this.reviews.values()].filter(
      (review) => review.uri.toString() === event.document.uri.toString(),
    );
    if (matching.length === 0) return;
    for (const review of matching) {
      review.offset = transformAnchor(review.offset, event.contentChanges);
      const position = event.document.positionAt(Math.min(review.offset, event.document.getText().length));
      review.thread.range = event.document.lineAt(position.line).range;
    }
    this.refreshDecorations();
  }

  private refreshDecorations(): void {
    const gutterDecorations = {
      queued: this.queuedGutterDecoration,
      running: this.runningGutterDecoration,
      completed: this.completedGutterDecoration,
      failed: this.failedGutterDecoration,
    } as const;
    for (const editor of vscode.window.visibleTextEditors) {
      const byLine = new Map<
        number,
        { range: vscode.Range; status: AgentationSnapshot["status"] }
      >();
      for (const review of this.reviews.values()) {
        if (review.uri.toString() !== editor.document.uri.toString()) continue;
        const snapshot = this.tasks.get(review.taskId)?.state.snapshot;
        if (!snapshot || isCanonicallySettled(snapshot)) continue;
        const position = editor.document.positionAt(
          Math.min(review.offset, editor.document.getText().length),
        );
        const range = editor.document.lineAt(position.line).range;
        byLine.set(position.line, {
          range,
          status: preferredSelectionStatus(byLine.get(position.line)?.status, snapshot.status),
        });
      }
      const byStatus: Record<AgentationSnapshot["status"], vscode.Range[]> = {
        queued: [],
        running: [],
        completed: [],
        failed: [],
      };
      for (const { range, status } of byLine.values()) byStatus[status].push(range);
      editor.setDecorations(this.decoration, [...byLine.values()].map(({ range }) => range));
      for (const status of ["queued", "running", "completed", "failed"] as const) {
        editor.setDecorations(gutterDecorations[status], byStatus[status]);
      }
    }
  }
}

function createTaskJob(snapshot: AgentationSnapshot, feed: string[]): PiJob {
  const annotation = snapshot.annotations[0];
  const source = annotation?.sourceFile ? parseSourceFile(annotation.sourceFile)?.file : undefined;
  return {
    id: `agentation-task:${snapshot.taskId}`,
    name: jobName(annotation?.comment ?? snapshot.detail),
    file: source ?? snapshot.url ?? "browser annotation",
    cwd: snapshot.cwd,
    status: snapshot.status,
    detail: snapshot.detail,
    sessionFile: snapshot.sessionFile,
    response: snapshot.markdown,
    error: snapshot.error,
    feed,
    messages: (snapshot.messages ?? []).map(({ role, body }) => ({ role, body })),
    latestUpdate: latestUpdate(feed, snapshot.detail),
    activeToolCalls: new Map(),
    projected: true,
  };
}

function createAnchorJob(
  task: ProjectedTask,
  annotation: AgentationAnnotation,
  key: string,
  resolved: string,
): PiJob {
  return {
    ...task.job,
    id: `agentation-anchor:${key}`,
    name: jobName(annotation.comment),
    file: path.relative(task.state.snapshot.cwd, resolved) || path.basename(resolved),
    activeToolCalls: new Map(),
  };
}

function updateTaskJob(job: PiJob, snapshot: AgentationSnapshot, feed: string[]): void {
  const annotation = snapshot.annotations[0];
  const source = annotation?.sourceFile ? parseSourceFile(annotation.sourceFile)?.file : undefined;
  updateJob(job, snapshot, feed);
  job.name = jobName(annotation?.comment ?? snapshot.detail);
  job.file = source ?? snapshot.url ?? "browser annotation";
}

function updateJob(job: PiJob, snapshot: AgentationSnapshot, feed: string[]): void {
  Object.assign(job, {
    cwd: snapshot.cwd,
    status: snapshot.status,
    detail: snapshot.detail,
    sessionFile: snapshot.sessionFile,
    response: snapshot.markdown,
    error: snapshot.error,
    feed,
    messages: (snapshot.messages ?? []).map(({ role, body }) => ({ role, body })),
    latestUpdate: latestUpdate(feed, snapshot.detail),
  });
}

async function resolveSourcePath(requestedPath: string, cwd: string): Promise<string | undefined> {
  let cwdReal: string;
  try {
    cwdReal = await realpath(cwd);
  } catch {
    return undefined;
  }
  const workspaceRoots = await Promise.all(
    (vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
      try {
        return await realpath(folder.uri.fsPath);
      } catch {
        return undefined;
      }
    }),
  );
  if (!workspaceRoots.some((root) => root && isPathWithinRoot(root, cwdReal))) return undefined;

  const lexical = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(cwdReal, requestedPath);
  if (!isPathWithinRoot(cwdReal, lexical)) return undefined;

  const candidates: SourcePathCandidate[] = [];
  const addCandidate = async (candidatePath: string): Promise<void> => {
    try {
      const candidateReal = await realpath(candidatePath);
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidateReal));
      if (stat.type === vscode.FileType.File) {
        candidates.push({ path: candidatePath, realPath: candidateReal });
      }
    } catch {
      // Missing candidates are expected while trying the supported path forms.
    }
  };
  await addCandidate(lexical);
  if (!path.isAbsolute(requestedPath)) {
    const basename = path.basename(requestedPath).replace(/[\[\]{}*?]/g, "[$&]");
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(cwdReal, `**/${basename}`),
      "**/{node_modules,.git}/**",
    );
    await Promise.all(found.map((uri) => addCandidate(uri.fsPath)));
  }
  return chooseSourcePath(requestedPath, cwdReal, candidates);
}

function anchorSignature(snapshot: AgentationSnapshot, annotation: AgentationAnnotation): string {
  return JSON.stringify([snapshot.cwd, annotation]);
}

function staticComments(
  annotation: AgentationAnnotation,
  messages: readonly AgentationMessage[] = [],
): vscode.Comment[] {
  return projectThreadItems(annotation, messages).map((item) => ({
    author: {
      name:
        item.kind === "annotation"
          ? "Browser annotation"
          : item.message.role === "user"
            ? "You"
            : "Pi",
    },
    body:
      item.kind === "annotation"
        ? annotationBody(item.annotation)
        : messageBody(item.message),
    mode: vscode.CommentMode.Preview,
  }));
}

function messageBody(message: AgentationMessage): vscode.MarkdownString {
  const body = new vscode.MarkdownString();
  body.isTrusted = false;
  body.supportHtml = false;
  if (message.role === "assistant") body.appendMarkdown(message.body);
  else body.appendText(message.body);
  return body;
}

function annotationBody(annotation: AgentationAnnotation): vscode.MarkdownString {
  const body = new vscode.MarkdownString();
  body.isTrusted = false;
  body.supportHtml = false;
  body.appendText(annotation.comment);
  const context = [annotation.element, annotation.elementPath, annotation.reactComponents]
    .filter(Boolean)
    .join(" · ");
  if (context) {
    body.appendMarkdown("\n\n");
    body.appendText(context);
  }
  if (annotation.selectedText) {
    body.appendMarkdown("\n\n");
    body.appendCodeblock(annotation.selectedText);
  }
  return body;
}

function progressBody(snapshot: AgentationSnapshot): vscode.MarkdownString {
  const body = new vscode.MarkdownString();
  body.isTrusted = false;
  body.supportHtml = false;
  body.appendMarkdown("**");
  body.appendText(snapshot.detail);
  body.appendMarkdown("**");
  if (snapshot.error) {
    body.appendMarkdown("\n\n");
    body.appendText(snapshot.error);
  }
  return body;
}

type SettlementCapableSnapshot = AgentationSnapshot & {
  settled: boolean;
  incarnationId: string;
};

function hasSettlementCapability(
  snapshot: AgentationSnapshot,
): snapshot is SettlementCapableSnapshot {
  return typeof snapshot.settled === "boolean" && typeof snapshot.incarnationId === "string";
}

function isTerminal(snapshot: AgentationSnapshot): boolean {
  return snapshot.status === "completed" || snapshot.status === "failed";
}

function isCanonicallySettled(snapshot: AgentationSnapshot): boolean {
  return hasSettlementCapability(snapshot) && snapshot.settled;
}

function applyThreadSettlement(
  thread: vscode.CommentThread,
  snapshot: AgentationSnapshot,
): void {
  thread.state = vscode.CommentThreadState.Unresolved;
  if (!isTerminal(snapshot)) {
    thread.contextValue = "piSelection.agentationWorking";
    return;
  }
  if (!hasSettlementCapability(snapshot)) {
    thread.contextValue = "piSelection.agentationLegacy";
    return;
  }
  if (!snapshot.settled) {
    thread.contextValue = "piSelection.agentationNeedsAttention";
    return;
  }
  thread.state = vscode.CommentThreadState.Resolved;
  thread.contextValue = "piSelection.agentationSettled";
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
}

function isReplyable(snapshot: AgentationSnapshot): boolean {
  return (
    Boolean(snapshot.sessionFile) &&
    (snapshot.status === "completed" || snapshot.status === "failed")
  );
}

function createGutterDecoration(
  extensionUri: vscode.Uri,
  status: AgentationSnapshot["status"],
): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(extensionUri, "resources", `pi-status-${status}.svg`),
    gutterIconSize: "contain",
  });
}
