import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  projectSnapshot,
  type AgentationAnnotation,
  type AgentationEvent,
  type AgentationSnapshot,
  type SnapshotProjectionState,
} from "./agentation";
import { transformAnchor } from "./anchor";
import { jobName, type PiJob } from "./coordinator";
import { latestUpdate } from "./inlay-text";
import { SessionInlays } from "./session-inlays";
import {
  chooseSourcePath,
  isPathWithinRoot,
  parseSourceFile,
  type SourcePathCandidate,
} from "./source-file";

type ProjectedReview = {
  key: string;
  taskId: string;
  signature: string;
  job: PiJob;
  thread: vscode.CommentThread;
  progress: vscode.Comment;
  uri: vscode.Uri;
  offset: number;
  reviewed: boolean;
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
  private readonly tasks = new Map<string, ProjectedTask>();
  private readonly reviews = new Map<vscode.CommentThread, ProjectedReview>();
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly inlays: SessionInlays,
    private readonly onChange: () => void,
    private readonly log: (message: string) => void,
  ) {
    this.comments.options = { prompt: "", placeHolder: "" };
    this.disposables = [
      vscode.workspace.onDidChangeTextDocument((event) => this.trackDocumentEdit(event)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
    ];
  }

  list(): PiJob[] {
    return [...this.tasks.values()].map(({ job }) => job);
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

  handle(event: AgentationEvent): void {
    if (event.type === "projection.reset") {
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

  markReviewed(thread: vscode.CommentThread): void {
    const review = this.reviews.get(thread);
    if (!review || review.reviewed) return;
    review.reviewed = true;
    review.thread.state = vscode.CommentThreadState.Resolved;
    review.thread.contextValue = "piSelection.reviewed";
    this.refreshDecorations();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const review of this.reviews.values()) review.thread.dispose();
    this.reviews.clear();
    this.comments.dispose();
    this.decoration.dispose();
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
      const annotationComment: vscode.Comment = {
        author: { name: "Browser annotation" },
        body: annotationBody(annotation),
        mode: vscode.CommentMode.Preview,
      };
      const progress: vscode.Comment = {
        author: { name: "Agentation server" },
        body: progressBody(task.state.snapshot),
        mode: vscode.CommentMode.Preview,
      };
      const thread = this.comments.createCommentThread(
        document.uri,
        document.lineAt(line).range,
        [annotationComment, progress],
      );
      thread.label = `Agentation: ${jobName(annotation.comment)}`;
      thread.contextValue = "piSelection.agentationReview";
      thread.state = vscode.CommentThreadState.Unresolved;
      thread.canReply = false;

      const job = createAnchorJob(task, annotation, key, resolved);
      const review: ProjectedReview = {
        key,
        taskId: task.id,
        signature,
        job,
        thread,
        progress,
        uri: document.uri,
        offset: document.offsetAt(position),
        reviewed: false,
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
    updateJob(review.job, snapshot, task.state.feed);
    review.progress = { ...review.progress, body: progressBody(snapshot) };
    review.thread.comments = [review.thread.comments[0], review.progress];
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
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = [...this.reviews.values()]
        .filter((review) => !review.reviewed && review.uri.toString() === editor.document.uri.toString())
        .map((review) => {
          const position = editor.document.positionAt(
            Math.min(review.offset, editor.document.getText().length),
          );
          return editor.document.lineAt(position.line).range;
        });
      editor.setDecorations(this.decoration, ranges);
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

function annotationBody(annotation: AgentationAnnotation): vscode.MarkdownString {
  const body = new vscode.MarkdownString();
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
  body.appendMarkdown(`**${snapshot.detail}**`);
  if (snapshot.error) {
    body.appendMarkdown("\n\n");
    body.appendText(snapshot.error);
  } else if (snapshot.markdown) {
    body.appendMarkdown(`\n\n${snapshot.markdown}`);
  }
  return body;
}
