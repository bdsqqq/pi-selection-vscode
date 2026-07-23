import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  AgentationProjectionClient,
  type AgentationChange,
  type AgentationSnapshot,
} from "./agentation";
import { BufferBridge } from "./bridge";
import { PiCoordinator, type PiJob, type SelectionRequest } from "./coordinator";
import { ProjectionController } from "./projection";
import { PendingReplyIds } from "./reply-idempotency";
import {
  decideRejectionState,
  parseProjectionUri,
  PROJECTION_SCHEME,
  projectionUriParts,
  ProjectionUriRegistry,
  Utf8LruCache,
} from "./review-content";
import { SessionInlays } from "./session-inlays";
import { isSelectionReplyable } from "./selection-thread-model";
import { SelectionThreads } from "./selection-threads";
import { exactReviewPath, isExactReviewPathContained } from "./source-file";
import { PI_SELECTION_SYSTEM_PROMPT } from "./system-prompt";
import {
  canSettleThread,
  deriveThreadLifecycle,
  groupThreadSummaries,
  serializeThreadRef,
  supportsThreadSettlement,
  type ThreadGroup,
  type ThreadSummary,
} from "./thread-model";

type ThreadInboxNode = ThreadGroup | ThreadSummary;

class ThreadInbox implements vscode.TreeDataProvider<ThreadInboxNode> {
  private readonly changed = new vscode.EventEmitter<ThreadInboxNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly summaries: () => ThreadSummary[]) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  attentionCount(): number {
    return this.summaries().filter(({ lifecycle }) => lifecycle === "needsAttention").length;
  }

  getChildren(element?: ThreadInboxNode): ThreadInboxNode[] {
    if (!element) return groupThreadSummaries(this.summaries());
    return "threads" in element ? element.threads : [];
  }

  getTreeItem(node: ThreadInboxNode): vscode.TreeItem {
    if ("threads" in node) {
      const labels = {
        needsAttention: "Needs attention",
        working: "Working",
        settled: "Settled",
      } as const;
      const item = new vscode.TreeItem(
        `${labels[node.lifecycle]} (${node.threads.length})`,
        node.lifecycle === "settled"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = `piSelection.threadGroup.${node.lifecycle}`;
      return item;
    }

    const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.None);
    item.id = serializeThreadRef(node.ref);
    item.description = `${node.location} · ${node.latestUpdate}`;
    item.contextValue = [
      "piSelection.thread",
      node.ref.kind,
      node.lifecycle,
      node.canReply ? "canReply" : "noReply",
      node.canSettle ? "canSettle" : "noSettle",
      node.canAbort ? "canAbort" : "noAbort",
      node.hasChanges ? "hasChanges" : "noChanges",
    ].join(".");
    item.iconPath = new vscode.ThemeIcon(
      node.lifecycle === "working"
        ? "loading~spin"
        : node.lifecycle === "needsAttention"
          ? "bell-dot"
          : "pass",
    );
    item.tooltip = new vscode.MarkdownString(
      [`**${node.title}**`, `${node.location} — ${node.latestUpdate}`, node.capabilityMessage]
        .filter((line) => line !== undefined)
        .join("\n\n"),
    );
    item.command = {
      command: "piSelection.revealThread",
      title: "Reveal Thread",
      arguments: [node],
    };
    return item;
  }
}

class ProjectionContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Utf8LruCache(20 * 1024 * 1024, 40);
  private readonly pending = new Map<string, Promise<string>>();
  private readonly loadedUris = new ProjectionUriRegistry<vscode.Uri>();
  private readonly expiredUris = new Set<string>();
  private readonly keyEpochs = new Map<string, number>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private generation?: string;
  private epoch = 0;
  readonly onDidChange = this.changed.event;

  constructor(private readonly client: () => AgentationProjectionClient | undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return this.fetch(uri, false);
  }

  targetFor(uri: vscode.Uri): NonNullable<ReturnType<typeof parseProjectionUri>> {
    const target = parseProjectionUri(uri);
    if (!target) throw new Error("Open a projected review file before rejecting changes.");
    this.assertGeneration(target.generation);
    return target;
  }

  assertGeneration(generation: string): void {
    if (generation !== this.generation) {
      throw new Error("This review expired when the server projection reset. Reopen Review Changes and try again.");
    }
  }

  async load(
    snapshot: AgentationSnapshot,
    change: AgentationChange,
  ): Promise<{ before: vscode.Uri; after: vscode.Uri }> {
    if (!this.generation) throw new Error("Projection generation is not available yet.");
    const before = vscode.Uri.from(
      projectionUriParts(this.generation, snapshot.taskId, change.path, "before"),
    );
    const after = vscode.Uri.from(
      projectionUriParts(this.generation, snapshot.taskId, change.path, "after"),
    );
    this.expiredUris.delete(before.toString());
    this.expiredUris.delete(after.toString());
    await Promise.all([this.fetch(before, true), this.fetch(after, true)]);
    return { before, after };
  }

  reset(generation: string): void {
    const staleUris = this.loadedUris.reset();
    this.epoch += 1;
    this.generation = generation;
    this.contents.clear();
    this.pending.clear();
    this.expiredUris.clear();
    this.keyEpochs.clear();
    for (const uri of staleUris) this.changed.fire(uri);
  }

  removeTask(taskId: string): void {
    this.invalidate(this.loadedUris.removeTask(taskId));
  }

  removeChange(generation: string, taskId: string, changePath: string): void {
    this.invalidate(this.loadedUris.removeChange(generation, taskId, changePath));
  }

  dispose(): void {
    this.epoch += 1;
    this.contents.clear();
    this.pending.clear();
    this.loadedUris.clear();
    this.expiredUris.clear();
    this.keyEpochs.clear();
    this.changed.dispose();
  }

  private invalidate(entries: Array<[string, vscode.Uri]>): void {
    for (const [key, uri] of entries) {
      this.contents.delete(key);
      this.pending.delete(key);
      this.expiredUris.add(key);
      this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
      this.changed.fire(uri);
    }
  }

  private async fetch(uri: vscode.Uri, refresh: boolean): Promise<string> {
    const key = uri.toString();
    const target = parseProjectionUri(uri);
    if (!target) throw new Error(`invalid projection content URI: ${key}`);
    if (target.generation !== this.generation) {
      throw new Error("This review expired when the server projection reset.");
    }
    if (this.expiredUris.has(key)) throw new Error("This review task was removed.");
    this.loadedUris.remember(key, uri);
    const previous = this.contents.get(key);
    if (!refresh && previous !== undefined) return previous;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const client = this.client();
    if (!client) throw new Error("Agentation projection client is not connected.");
    const epoch = this.epoch;
    const keyEpoch = this.keyEpochs.get(key) ?? 0;
    const request = (async () => {
      const content = await client.fetchProjectionContent(
        target.generation,
        target.taskId,
        target.path,
        target.side,
      );
      if (this.epoch !== epoch) throw new Error("This review expired when the server projection reset.");
      if ((this.keyEpochs.get(key) ?? 0) !== keyEpoch) {
        throw new Error("This review task was removed.");
      }
      this.contents.set(key, content);
      if (refresh && previous !== undefined && previous !== content) this.changed.fire(uri);
      return content;
    })();
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }
}

async function resolveExactReviewChangePath(
  snapshot: AgentationSnapshot,
  changePath: string,
): Promise<string> {
  const candidate = exactReviewPath(snapshot.cwd, changePath);
  if (!candidate) throw new Error("The projected change path is not a relative path inside its task cwd.");

  const cwdReal = await realpath(snapshot.cwd);
  const workspaceRootsReal = (
    await Promise.all(
      (vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
        try {
          return await realpath(folder.uri.fsPath);
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((root): root is string => root !== undefined);
  const candidateReal = await realpathBoundary(candidate);
  if (!isExactReviewPathContained(cwdReal, candidateReal, workspaceRootsReal)) {
    throw new Error("The projected change path escapes its task cwd or open workspace.");
  }
  return candidate;
}

async function realpathBoundary(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
    return realpath(path.dirname(candidate));
  }
}

async function localFileExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function rejectionConflict(message: string): Error {
  return new Error(`${message} No changes were acknowledged; newer local state was preserved.`);
}

async function applyPreparedRejection(
  client: AgentationProjectionClient,
  projectionContent: ProjectionContentProvider,
  target: NonNullable<ReturnType<typeof parseProjectionUri>>,
  preparation: Awaited<ReturnType<AgentationProjectionClient["prepareProjectionRejection"]>>,
  filePath: string,
): Promise<void> {
  if (!preparation.beforeExists) {
    throw new Error("Automatic rejection cannot safely delete a task-created file.");
  }
  if (!preparation.afterExists) {
    throw rejectionConflict("This task deleted the file, which cannot be rejected by this editor flow.");
  }

  const uri = vscode.Uri.file(filePath);
  const [beforeText, afterText] = await Promise.all([
    client.fetchProjectionContent(target.generation, target.taskId, target.path, "before"),
    client.fetchProjectionContent(target.generation, target.taskId, target.path, "after"),
  ]);
  if (!(await localFileExists(filePath))) {
    throw rejectionConflict("The local file no longer exists.");
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const decision = decideRejectionState({
    beforeExists: true,
    currentExists: true,
    dirty: document.isDirty,
    currentText: document.getText(),
    beforeText,
    afterText,
  });
  if (decision === "conflict") {
    throw rejectionConflict("The local file no longer exactly matches the prepared change.");
  }
  if (decision === "replace-with-before") {
    projectionContent.assertGeneration(target.generation);
    if (document.getText() !== afterText) {
      throw rejectionConflict("The local file changed immediately before rejection.");
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), beforeText);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw rejectionConflict("VS Code refused the rejection edit.");
    }
  }
  if (document.getText() !== beforeText) {
    throw rejectionConflict("The local file did not reach the verified before state.");
  }
}

async function closeActiveReviewDiff(uri: vscode.Uri): Promise<void> {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!(tab?.input instanceof vscode.TabInputTextDiff)) return;
  if (
    tab.input.original.toString() !== uri.toString() &&
    tab.input.modified.toString() !== uri.toString()
  ) {
    return;
  }
  await vscode.window.tabGroups.close(tab);
}

function refreshFeed(job: PiJob, quickPick: vscode.QuickPick<vscode.QuickPickItem>): void {
  quickPick.title = `Pi: ${job.name} · ${job.detail}`;
  quickPick.placeholder = job.sessionFile
    ? "Select any feed entry to open this session in its terminal editor"
    : "The Pi session is still being created";
  quickPick.items = job.feed.map((entry, index) => {
    const [firstLine, ...rest] = entry.split("\n");
    return {
      label: `${index === job.feed.length - 1 ? "$(circle-filled)" : "$(circle-outline)"} ${firstLine || job.detail}`,
      detail: rest.join("\n").slice(0, 2_000) || undefined,
    };
  });
}

let shutdownExtension: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const coordinators = new Map<string, PiCoordinator>();
  const output = vscode.window.createOutputChannel("Pi Selection");
  const inlays = new SessionInlays();
  let refreshInbox = (): void => {};
  const selectionThreads = new SelectionThreads(
    context.extensionUri,
    context.workspaceState,
    (message) => output.appendLine(message),
    () => refreshInbox(),
  );
  const pendingReplyIds = new PendingReplyIds<vscode.CommentThread>();
  const feeds = new Map<string, { job: PiJob; quickPick: vscode.QuickPick<vscode.QuickPickItem> }>();
  const agentationServerUrl = (): string =>
    vscode.workspace
      .getConfiguration("piSelection")
      .get("agentationServerUrl", "http://127.0.0.1:4748");
  let projection: ProjectionController;
  const tree = new ThreadInbox(() => [
    ...selectionThreads.listThreads().map(({ job, id, title, location, updatedAt, settled }) => {
      const ref = { kind: "local" as const, id };
      return {
        ref,
        title,
        source: "local" as const,
        location,
        lifecycle: deriveThreadLifecycle(job.status, settled),
        execution: job.status,
        updatedAt,
        latestUpdate: job.latestUpdate,
        canReply: isSelectionReplyable(job),
        canSettle: canSettleThread(ref, job.status, settled),
        canAbort: job.status === "queued" || job.status === "running",
        hasChanges: false,
        settlementCapability: true,
      };
    }),
    ...(projection?.listThreads() ?? []).map((view) => {
      const ref = {
        kind: "agentation" as const,
        serverUrl: agentationServerUrl(),
        taskId: view.taskId,
      };
      const settlementCapability = supportsThreadSettlement(
        ref,
        view.settled,
        view.settlementCapability,
      );
      return {
        ref,
        title: view.title,
        source: "agentation" as const,
        location: view.location,
        lifecycle: deriveThreadLifecycle(view.status, view.settled),
        execution: view.status,
        updatedAt: view.updatedAt,
        latestUpdate: view.job.latestUpdate,
        canReply:
          Boolean(view.job.sessionFile) &&
          view.status !== "queued" &&
          view.status !== "running",
        canSettle: canSettleThread(
          ref,
          view.status,
          view.settled,
          view.settlementCapability,
        ),
        canAbort: false,
        hasChanges: view.hasChanges,
        settlementCapability,
        capabilityMessage: settlementCapability
          ? undefined
          : "Agentation server update required to settle this thread.",
      };
    }),
  ]);
  refreshInbox = () => tree.refresh();
  projection = new ProjectionController(
    context.extensionUri,
    inlays,
    () => {
      refreshInbox();
      for (const feed of feeds.values()) refreshFeed(feed.job, feed.quickPick);
    },
    (message) => output.appendLine(message),
  );
  const treeView = vscode.window.createTreeView("piSelection.sessions", { treeDataProvider: tree });
  let projectionConnection: "connecting" | "connected" | "disconnected" = "connecting";
  refreshInbox = () => {
    tree.refresh();
    const attention = tree.attentionCount();
    treeView.badge = {
      value: attention,
      tooltip: `${attention} thread${attention === 1 ? "" : "s"} need attention · Agentation ${projectionConnection}`,
    };
  };
  const terminals = new Map<string, vscode.Terminal>();
  const terminalCreations = new Map<string, Promise<vscode.Terminal>>();
  let projectionClient: AgentationProjectionClient | undefined;
  const projectionContent = new ProjectionContentProvider(() => projectionClient);
  const connectProjection = (): void => {
    projectionClient?.dispose();
    projectionConnection = "connecting";
    projection.disconnect();
    projectionClient = new AgentationProjectionClient(
      agentationServerUrl(),
      (event) => {
        projectionConnection = "connected";
        if (event.type === "projection.reset") {
          projectionContent.reset(event.generation);
          for (const feed of feeds.values()) {
            if (feed.job.projected) feed.quickPick.hide();
          }
        } else if (event.type === "task.remove") {
          projectionContent.removeTask(event.taskId);
          for (const feed of feeds.values()) {
            if (
              feed.job.projected &&
              projection.snapshotFor(feed.job)?.taskId === event.taskId
            ) {
              feed.quickPick.hide();
            }
          }
        }
        projection.handle(event);
        refreshInbox();
      },
      (message) => {
        projectionConnection = "disconnected";
        output.appendLine(`[Agentation] ${message}`);
        refreshInbox();
      },
    );
  };
  connectProjection();
  refreshInbox();
  const inlayRegistration = vscode.languages.registerInlayHintsProvider({ scheme: "file" }, inlays);
  const projectionContentRegistration = vscode.workspace.registerTextDocumentContentProvider(
    PROJECTION_SCHEME,
    projectionContent,
  );

  const coordinatorFor = (folder: vscode.WorkspaceFolder): PiCoordinator => {
    const cwd = folder.uri.fsPath;
    let coordinator = coordinators.get(cwd);
    if (!coordinator) {
      const piPath = vscode.workspace.getConfiguration("piSelection", folder.uri).get("piPath", "pi");
      const bridge = new BufferBridge(folder);
      coordinator = new PiCoordinator({
        cwd,
        piPath,
        onChange: (job) => {
          tree.refresh();
          inlays.refresh();
          selectionThreads.refresh(job);
          for (const feed of feeds.values()) refreshFeed(feed.job, feed.quickPick);
        },
        log: (message) => output.appendLine(message),
        childLaunch: async () => {
          const connection = await bridge.start();
          return {
            args: [
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--extension",
              context.asAbsolutePath("resources/pi-buffer-bridge.ts"),
              "--tools",
              "read,grep,find,ls,apply_patch",
              "--system-prompt",
              PI_SELECTION_SYSTEM_PROMPT,
            ],
            env: {
              PI_SELECTION_BRIDGE_URL: connection.url,
              PI_SELECTION_BRIDGE_TOKEN: connection.token,
            },
          };
        },
        disposeChild: () => bridge.dispose(),
      });
      coordinators.set(cwd, coordinator);
      tree.refresh();
    }
    return coordinator;
  };

  const restoredSelections = await selectionThreads.restore((folder, snapshot) =>
    coordinatorFor(folder).restoreJob(snapshot),
  );
  for (const { job, document, position } of restoredSelections) {
    inlays.track(job, document, position);
  }

  let shutdownPromise: Promise<void> | undefined;
  shutdownExtension = () => {
    shutdownPromise ??= (async () => {
      await Promise.all([...coordinators.values()].map((coordinator) => coordinator.dispose()));
      selectionThreads.refresh();
      await selectionThreads.flush();
    })();
    return shutdownPromise;
  };

  const activeCoordinator = (): PiCoordinator | undefined => {
    const editorFolder = vscode.window.activeTextEditor
      ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
      : undefined;
    const folder = editorFolder ?? vscode.workspace.workspaceFolders?.[0];
    return folder ? coordinatorFor(folder) : undefined;
  };

  const openSession = async (
    sessionFile: string,
    name: string,
    cwd: string,
    projected = false,
  ): Promise<void> => {
    const existing = terminals.get(sessionFile);
    if (existing && !existing.exitStatus) {
      existing.show(false);
      return;
    }
    const pending = terminalCreations.get(sessionFile);
    if (pending) {
      (await pending).show(false);
      return;
    }

    const creation = (async () => {
      const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.fsPath === cwd);
      const piPath = vscode.workspace.getConfiguration("piSelection", folder?.uri).get("piPath", "pi");
      const launch = projected ? undefined : await coordinators.get(cwd)?.childLaunchOptions();
      const raced = terminals.get(sessionFile);
      if (raced && !raced.exitStatus) return raced;
      const terminal = vscode.window.createTerminal({
        name,
        cwd,
        shellPath: piPath,
        shellArgs: [...(launch?.args ?? []), "--session", sessionFile],
        env: launch?.env,
        location: vscode.TerminalLocation.Editor,
      });
      terminals.set(sessionFile, terminal);
      return terminal;
    })();
    terminalCreations.set(sessionFile, creation);
    try {
      (await creation).show(false);
    } finally {
      if (terminalCreations.get(sessionFile) === creation) terminalCreations.delete(sessionFile);
    }
  };

  const showFeed = (job: PiJob): void => {
    const existing = feeds.get(job.id);
    if (existing) {
      existing.quickPick.show();
      return;
    }
    const quickPick = vscode.window.createQuickPick();
    feeds.set(job.id, { job, quickPick });
    refreshFeed(job, quickPick);
    quickPick.onDidAccept(() => {
      if (job.sessionFile) {
        void openSession(job.sessionFile, `Pi: ${job.name}`, job.cwd, job.projected);
      }
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      feeds.delete(job.id);
      quickPick.dispose();
    });
    quickPick.show();
  };

  const agentationRef = (
    taskId: string,
  ): Extract<ThreadSummary["ref"], { kind: "agentation" }> => ({
    kind: "agentation",
    serverUrl: agentationServerUrl(),
    taskId,
  });

  const assertCurrentAgentationRef = (
    ref: Extract<ThreadSummary["ref"], { kind: "agentation" }>,
  ): void => {
    if (ref.serverUrl !== agentationServerUrl()) {
      throw new Error("This thread belongs to a different Agentation server.");
    }
  };

  const jobForThread = (thread: ThreadSummary): PiJob | undefined => {
    if (thread.ref.kind === "local") return selectionThreads.findJob(thread.ref.id);
    assertCurrentAgentationRef(thread.ref);
    const taskId = thread.ref.taskId;
    return projection.listThreads().find((view) => view.taskId === taskId)?.job;
  };

  const updateAgentationSettlement = async (
    ref: Extract<ThreadSummary["ref"], { kind: "agentation" }>,
    settled: boolean,
  ): Promise<void> => {
    assertCurrentAgentationRef(ref);
    const target = projection.settlementTarget(ref.taskId);
    if (!target) {
      throw new Error("Agentation server update required to change settlement state.");
    }
    if (target.settled === settled) return;
    const client = projectionClient;
    if (!client) throw new Error("Agentation projection client is not connected.");
    projection.assertSettlementTarget(target);
    const snapshot = await client.postProjectionSettlement(
      target.generation,
      target.incarnationId,
      target.taskId,
      target.revision,
      settled,
    );
    assertCurrentAgentationRef(ref);
    projection.assertGeneration(target.generation);
    const current = projection.snapshotByTaskId(target.taskId);
    if (
      current?.incarnationId !== target.incarnationId ||
      snapshot.taskId !== target.taskId ||
      snapshot.incarnationId !== target.incarnationId ||
      snapshot.settled !== settled ||
      snapshot.revision <= target.revision
    ) {
      throw new Error("Agentation returned an invalid settlement snapshot.");
    }
    projection.applySettlement(snapshot);
  };

  const replyToThread = async (thread?: ThreadSummary): Promise<void> => {
    if (!thread?.ref) return;
    const text = await vscode.window.showInputBox({
      title: `Reply: ${thread.title}`,
      placeHolder: "Ask Pi to follow up…",
      ignoreFocusOut: true,
    });
    if (!text?.trim()) return;
    if (thread.ref.kind === "local") {
      const job = selectionThreads.findJob(thread.ref.id);
      const coordinator = job ? coordinators.get(job.cwd) : undefined;
      if (!job || !coordinator) throw new Error("The Pi selection session is no longer available.");
      selectionThreads.reopen(job);
      coordinator.reply(job, text.trim());
      return;
    }
    const ref = thread.ref;
    assertCurrentAgentationRef(ref);
    const target = await projection.replyTargetForTask(ref.taskId);
    if (!target) throw new Error("This Agentation thread is not ready for replies.");
    const client = projectionClient;
    if (!client) throw new Error("Agentation projection client is not connected.");
    projection.assertGeneration(target.generation);
    await client.postProjectionReply(
      target.generation,
      target.taskId,
      target.annotationId,
      text.trim(),
      randomUUID(),
      () => {
        assertCurrentAgentationRef(ref);
        projection.assertGeneration(target.generation);
      },
    );
  };

  context.subscriptions.push(
    output,
    inlays,
    selectionThreads,
    projection,
    projectionContent,
    treeView,
    inlayRegistration,
    projectionContentRegistration,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("piSelection.agentationServerUrl")) connectProjection();
    }),
    { dispose: () => projectionClient?.dispose() },
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [sessionFile, candidate] of terminals) {
        if (candidate === terminal) terminals.delete(sessionFile);
      }
    }),
    vscode.commands.registerCommand("piSelection.submit", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage("Select some text first.");
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!folder) {
        void vscode.window.showErrorMessage("Open the file inside a workspace folder first.");
        return;
      }

      if (editor.document.isDirty && !(await editor.document.save())) {
        void vscode.window.showErrorMessage("Save the file before starting Pi.");
        return;
      }
      const selection = editor.selection;
      if (selection.isEmpty) {
        void vscode.window.showInformationMessage("The selection changed while saving; select the code again.");
        return;
      }
      const text = editor.document.getText(selection);
      const documentVersion = editor.document.version;
      let sourceRealPath: string;
      try {
        sourceRealPath = await realpath(editor.document.uri.fsPath);
      } catch {
        void vscode.window.showErrorMessage("The selected file is no longer available.");
        return;
      }
      const request = await vscode.window.showInputBox({
        title: "Prompt Pi about the selection",
        prompt: `${path.relative(folder.uri.fsPath, editor.document.uri.fsPath)}:${selection.start.line + 1}-${selection.end.line + 1}`,
        placeHolder: "what should change?",
        ignoreFocusOut: true,
      });
      if (!request?.trim()) return;
      let currentSourceRealPath: string | undefined;
      try {
        currentSourceRealPath = await realpath(editor.document.uri.fsPath);
      } catch {}
      if (
        editor.document.version !== documentVersion ||
        !editor.selection.isEqual(selection) ||
        currentSourceRealPath !== sourceRealPath
      ) {
        void vscode.window.showInformationMessage(
          "The code, selection, or source file changed while entering the prompt; submit it again.",
        );
        return;
      }

      const submission: SelectionRequest = {
        instruction: request.trim(),
        relativeFile: path.relative(folder.uri.fsPath, editor.document.uri.fsPath),
        language: editor.document.languageId,
        startLine: selection.start.line + 1,
        endLine: selection.end.line + 1,
        text,
      };
      const job = coordinatorFor(folder).submit(submission);
      selectionThreads.track(job, editor.document, selection, submission, sourceRealPath);
      inlays.track(job, editor.document, selection.end);
      void vscode.window.setStatusBarMessage(`$(hubot) Pi started: ${job.name}`, 3_000);
    }),
    vscode.commands.registerCommand("piSelection.showFeed", (jobId: string) => {
      const job = inlays.find(jobId);
      if (job) showFeed(job);
    }),
    vscode.commands.registerCommand("piSelection.openSession", (target?: PiJob | ThreadSummary) => {
      if (!target) return;
      const job = "ref" in target ? jobForThread(target) : target;
      if (job?.sessionFile) {
        void openSession(job.sessionFile, `Pi: ${job.name}`, job.cwd, job.projected);
      }
    }),
    vscode.commands.registerCommand("piSelection.revealThread", async (thread?: ThreadSummary) => {
      if (!thread?.ref) return;
      if (thread.ref.kind === "local") {
        await selectionThreads.reveal(thread.ref.id);
      } else {
        assertCurrentAgentationRef(thread.ref);
        if (await projection.revealTask(thread.ref.taskId)) return;
        const job = jobForThread(thread);
        if (job) showFeed(job);
      }
    }),
    vscode.commands.registerCommand("piSelection.replyThread", replyToThread),
    vscode.commands.registerCommand("piSelection.settleThread", async (thread?: ThreadSummary) => {
      if (!thread?.ref) return;
      if (thread.ref.kind === "local") {
        if (!selectionThreads.settle(thread.ref.id)) throw new Error("This thread is not ready to settle.");
      } else {
        await updateAgentationSettlement(thread.ref, true);
      }
      tree.refresh();
    }),
    vscode.commands.registerCommand(
      "piSelection.reopenThread",
      async (target?: ThreadSummary | vscode.CommentThread) => {
        if (!target) return;
        if ("ref" in target) {
          if (target.ref.kind === "local") selectionThreads.reopen(target.ref.id);
          else await updateAgentationSettlement(target.ref, false);
        } else if (!selectionThreads.reopenComment(target)) {
          const taskId = projection.taskIdForThread(target);
          if (taskId) await updateAgentationSettlement(agentationRef(taskId), false);
        }
        tree.refresh();
      },
    ),
    vscode.commands.registerCommand("piSelection.markReviewed", async (thread: vscode.CommentThread) => {
      if (selectionThreads.markReviewed(thread)) {
        tree.refresh();
        return;
      }
      const target = projection.markReviewed(thread);
      if (!target) throw new Error("This thread cannot be settled.");
      await updateAgentationSettlement(agentationRef(target.taskId), true);
    }),
    vscode.commands.registerCommand("piSelection.reply", async (reply: vscode.CommentReply) => {
      if (!reply.text.trim()) throw new Error("Enter a reply before submitting.");
      const selectionJob = selectionThreads.replyTarget(reply.thread);
      if (selectionJob) {
        const coordinator = coordinators.get(selectionJob.cwd);
        if (!coordinator) throw new Error("The Pi selection session is no longer available.");
        selectionThreads.reopen(selectionJob);
        coordinator.reply(selectionJob, reply.text);
        return;
      }
      const target = projection.replyTarget(reply.thread);
      if (!target) {
        throw new Error("Replies are available only after Pi finishes and a session is ready.");
      }
      const client = projectionClient;
      if (!client) throw new Error("Agentation projection client is not connected.");
      const requestId = pendingReplyIds.requestId(reply.thread, reply.text, randomUUID);
      projection.assertReplyTarget(reply.thread, target);
      await client.postProjectionReply(
        target.generation,
        target.taskId,
        target.annotationId,
        reply.text,
        requestId,
        () => projection.assertReplyTarget(reply.thread, target),
      );
      pendingReplyIds.confirm(reply.thread, reply.text, requestId);
    }),
    vscode.commands.registerCommand("piSelection.reviewChanges", async (target: unknown) => {
      const resolved =
        target && typeof target === "object" && "ref" in target
          ? jobForThread(target as ThreadSummary)
          : target;
      const snapshot = projection.snapshotFor(resolved);
      if (!snapshot?.changes?.length) {
        void vscode.window.showInformationMessage("This task has no projected changes.");
        return;
      }
      const change =
        snapshot.changes.length === 1
          ? snapshot.changes[0]
          : (
              await vscode.window.showQuickPick(
                snapshot.changes.map((candidate) => ({
                  label: candidate.path,
                  change: candidate,
                })),
                { title: "Review projected changes", placeHolder: "Select a changed file" },
              )
            )?.change;
      if (!change) return;
      try {
        const { before, after } = await projectionContent.load(snapshot, change);
        await vscode.commands.executeCommand(
          "vscode.diff",
          before,
          after,
          `${change.path} (Before ↔ After)`,
        );
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand("piSelection.rejectChange", async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!uri) return;
      try {
        const target = projectionContent.targetFor(uri);
        const snapshot = projection.snapshotByTaskId(target.taskId);
        if (!snapshot?.changes?.some((change) => change.path === target.path)) {
          throw new Error("This projected change is no longer available. Reopen Review Changes and try again.");
        }
        const confirmed = await vscode.window.showWarningMessage(
          `Reject projected changes to ${target.path}?`,
          {
            modal: true,
            detail: "The editor will restore the exact projected before state as one undoable workspace edit.",
          },
          "Reject This File",
        );
        if (confirmed !== "Reject This File") return;
        const client = projectionClient;
        if (!client) throw new Error("Agentation projection client is not connected.");

        projectionContent.assertGeneration(target.generation);
        const preparation = await client.prepareProjectionRejection(
          target.generation,
          target.taskId,
          target.path,
          randomUUID(),
        );
        if (!preparation.beforeExists) {
          void vscode.window.showWarningMessage(
            `Automatic rejection cannot safely delete the task-created file ${target.path} because VS Code has no version-guarded delete. Delete it manually, then Mark Reviewed.`,
          );
          return;
        }
        const filePath = await resolveExactReviewChangePath(snapshot, target.path);
        await applyPreparedRejection(client, projectionContent, target, preparation, filePath);
        await client.acknowledgeProjectionRejection(target.generation, preparation.operationId);
        projectionContent.removeChange(target.generation, target.taskId, target.path);
        await closeActiveReviewDiff(uri);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand("piSelection.abort", async (target?: PiJob | ThreadSummary) => {
      if (!target) return;
      const job = "ref" in target ? jobForThread(target) : target;
      if (!job) return;
      const coordinator = [...coordinators.values()].find((candidate) => candidate.list().includes(job));
      await coordinator?.abort(job);
    }),
    vscode.commands.registerCommand("piSelection.openParent", async () => {
      const coordinator = activeCoordinator();
      if (!coordinator) {
        void vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }
      try {
        const folder = vscode.window.activeTextEditor
          ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
          : vscode.workspace.workspaceFolders?.[0];
        const cwd = folder?.uri.fsPath ?? process.cwd();
        const sessionFile = await coordinator.parentSession();
        await openSession(sessionFile, "Pi: selection parent", cwd);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand("piSelection.clearCompleted", () => {
      const removed = selectionThreads.removeSettled();
      for (const coordinator of coordinators.values()) coordinator.removeJobs(removed);
      for (const jobId of removed) inlays.remove(jobId);
    }),
  );
}

export async function deactivate(): Promise<void> {
  await shutdownExtension?.();
  shutdownExtension = undefined;
}
