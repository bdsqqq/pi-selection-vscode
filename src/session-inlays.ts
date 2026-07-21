import * as vscode from "vscode";
import { transformAnchor } from "./anchor";
import type { PiJob } from "./coordinator";
import { formatInlayText } from "./inlay-text";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Marker = {
  job: PiJob;
  uri: string;
  offset: number;
};

export class SessionInlays implements vscode.InlayHintsProvider, vscode.Disposable {
  private readonly markers = new Map<string, Marker>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly documentChanges: vscode.Disposable;
  private readonly timer: NodeJS.Timeout;
  private frame = 0;

  readonly onDidChangeInlayHints = this.changed.event;

  constructor() {
    this.documentChanges = vscode.workspace.onDidChangeTextDocument((event) => {
      const markers = [...this.markers.values()].filter(
        (marker) => marker.uri === event.document.uri.toString(),
      );
      if (markers.length === 0) return;
      for (const marker of markers) {
        marker.offset = transformAnchor(marker.offset, event.contentChanges);
      }
      this.refresh();
    });
    this.timer = setInterval(() => {
      if (![...this.markers.values()].some(({ job }) => ["queued", "running"].includes(job.status))) {
        return;
      }
      this.frame = (this.frame + 1) % SPINNER.length;
      this.refresh();
    }, 100);
  }

  track(job: PiJob, document: vscode.TextDocument, position: vscode.Position): void {
    this.markers.set(job.id, {
      job,
      uri: document.uri.toString(),
      offset: document.offsetAt(position),
    });
    this.refresh();
  }

  find(jobId: string): PiJob | undefined {
    return this.markers.get(jobId)?.job;
  }

  removeFinished(): void {
    for (const [jobId, { job }] of this.markers) {
      if (!["queued", "running"].includes(job.status)) this.markers.delete(jobId);
    }
    this.refresh();
  }

  refresh(): void {
    this.changed.fire();
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.ProviderResult<vscode.InlayHint[]> {
    const hints: vscode.InlayHint[] = [];
    for (const marker of this.markers.values()) {
      if (marker.uri !== document.uri.toString()) continue;
      const position = document.positionAt(Math.min(marker.offset, document.getText().length));
      if (!range.contains(position)) continue;

      const tooltip = this.tooltip(marker.job);
      const part = new vscode.InlayHintLabelPart(
        formatInlayText(this.glyph(marker.job), marker.job.latestUpdate),
      );
      part.tooltip = tooltip;
      part.command = {
        command: "piSelection.showFeed",
        title: "Show Pi session feed",
        arguments: [marker.job.id],
      };
      const hint = new vscode.InlayHint(position, [part]);
      hint.tooltip = tooltip;
      hint.paddingLeft = true;
      hints.push(hint);
    }
    return hints;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.documentChanges.dispose();
    this.changed.dispose();
  }

  private glyph(job: PiJob): string {
    if (job.status === "queued" || job.status === "running") return SPINNER[this.frame];
    if (job.status === "completed") return "✓";
    if (job.status === "aborted") return "×";
    return "!";
  }

  private tooltip(job: PiJob): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Pi: ${escapeMarkdown(job.name)}**  \n`);
    tooltip.appendText(`${job.file} · ${job.detail}`);
    const latest = job.feed.at(-1);
    if (latest && latest !== job.detail) {
      tooltip.appendMarkdown("\n\n");
      tooltip.appendText(latest.slice(0, 1_000));
    }
    tooltip.appendMarkdown("\n\n_Click to open the session feed._");
    return tooltip;
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&");
}
