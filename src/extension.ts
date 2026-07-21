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
import {
  parseProjectionUri,
  PROJECTION_SCHEME,
  projectionUriParts,
  ProjectionUriRegistry,
  Utf8LruCache,
} from "./review-content";
import { SessionInlays } from "./session-inlays";
import { PI_SELECTION_SYSTEM_PROMPT } from "./system-prompt";

class SessionTree implements vscode.TreeDataProvider<PiJob> {
  private readonly changed = new vscode.EventEmitter<PiJob | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly coordinators: Map<string, PiCoordinator>,
    private readonly projectedJobs: () => PiJob[],
    private readonly projectedHasChanges: (job: PiJob) => boolean,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(): PiJob[] {
    return [
      ...this.projectedJobs(),
      ...[...this.coordinators.values()].flatMap((coordinator) => [...coordinator.list()]),
    ];
  }

  getTreeItem(job: PiJob): vscode.TreeItem {
    const item = new vscode.TreeItem(job.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${job.file} · ${job.detail}`;
    item.contextValue = job.projected
      ? "piSelection.projected"
      : ["queued", "running"].includes(job.status)
        ? "piSelection.running"
        : "piSelection.finished";
    item.iconPath = new vscode.ThemeIcon(
      job.status === "queued" || job.status === "running"
        ? "loading~spin"
        : job.status === "completed"
          ? "pass"
          : job.status === "aborted"
            ? "circle-slash"
            : "error",
    );
    item.tooltip = new vscode.MarkdownString(
      [
        `**${job.name}**`,
        `${job.file} — ${job.detail}`,
        job.error,
        job.response ? `---\n\n${job.response}` : undefined,
      ]
        .filter((line) => line !== undefined)
        .join("\n\n"),
    );
    if (job.projected && this.projectedHasChanges(job)) {
      item.command = {
        command: "piSelection.reviewChanges",
        title: "Review Changes",
        arguments: [job],
      };
    } else if (job.sessionFile && !["queued", "running"].includes(job.status)) {
      item.command = {
        command: "piSelection.openSession",
        title: "Open Pi Session",
        arguments: [job],
      };
    }
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
    for (const [key, uri] of this.loadedUris.removeTask(taskId)) {
      this.contents.delete(key);
      this.pending.delete(key);
      this.expiredUris.add(key);
      this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
      this.changed.fire(uri);
    }
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
      const content = await client.fetchProjectionContent(target.taskId, target.path, target.side);
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

export function activate(context: vscode.ExtensionContext): void {
  const coordinators = new Map<string, PiCoordinator>();
  const output = vscode.window.createOutputChannel("Pi Selection");
  const inlays = new SessionInlays();
  const feeds = new Map<string, { job: PiJob; quickPick: vscode.QuickPick<vscode.QuickPickItem> }>();
  let projection: ProjectionController;
  const tree = new SessionTree(
    coordinators,
    () => projection?.list() ?? [],
    (job) => projection?.hasChanges(job) ?? false,
  );
  projection = new ProjectionController(
    inlays,
    () => {
      tree.refresh();
      for (const feed of feeds.values()) refreshFeed(feed.job, feed.quickPick);
    },
    (message) => output.appendLine(message),
  );
  const terminals = new Map<string, vscode.Terminal>();
  const terminalCreations = new Map<string, Promise<vscode.Terminal>>();
  let projectionClient: AgentationProjectionClient | undefined;
  const projectionContent = new ProjectionContentProvider(() => projectionClient);
  const connectProjection = (): void => {
    projectionClient?.dispose();
    const serverUrl = vscode.workspace
      .getConfiguration("piSelection")
      .get("agentationServerUrl", "http://127.0.0.1:4748");
    projectionClient = new AgentationProjectionClient(
      serverUrl,
      (event) => {
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
      },
      (message) => output.appendLine(`[Agentation] ${message}`),
    );
  };
  connectProjection();
  const treeRegistration = vscode.window.registerTreeDataProvider("piSelection.sessions", tree);
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
        onChange: () => {
          tree.refresh();
          inlays.refresh();
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

  context.subscriptions.push(
    output,
    inlays,
    projection,
    projectionContent,
    treeRegistration,
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

      const selection = editor.selection;
      const text = editor.document.getText(selection);
      const request = await vscode.window.showInputBox({
        title: "Prompt Pi about the selection",
        prompt: `${path.relative(folder.uri.fsPath, editor.document.uri.fsPath)}:${selection.start.line + 1}-${selection.end.line + 1}`,
        placeHolder: "what should change?",
        ignoreFocusOut: true,
      });
      if (!request?.trim()) return;
      if (editor.document.isDirty && !(await editor.document.save())) {
        void vscode.window.showErrorMessage("Save the file before starting Pi.");
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
      inlays.track(job, editor.document, editor.selection.end);
      void vscode.window.setStatusBarMessage(`$(hubot) Pi started: ${job.name}`, 3_000);
    }),
    vscode.commands.registerCommand("piSelection.showFeed", (jobId: string) => {
      const job = inlays.find(jobId);
      if (job) showFeed(job);
    }),
    vscode.commands.registerCommand("piSelection.openSession", (job: PiJob) => {
      if (job.sessionFile) {
        void openSession(job.sessionFile, `Pi: ${job.name}`, job.cwd, job.projected);
      }
    }),
    vscode.commands.registerCommand(
      "piSelection.markReviewed",
      (thread: vscode.CommentThread) => projection.markReviewed(thread),
    ),
    vscode.commands.registerCommand("piSelection.reviewChanges", async (target: unknown) => {
      const snapshot = projection.snapshotFor(target);
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
    vscode.commands.registerCommand("piSelection.abort", async (job: PiJob) => {
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
      for (const coordinator of coordinators.values()) coordinator.clearFinished();
      inlays.removeFinished();
    }),
    {
      dispose: () => {
        void Promise.all([...coordinators.values()].map((coordinator) => coordinator.dispose()));
      },
    },
  );
}

export function deactivate(): void {}
