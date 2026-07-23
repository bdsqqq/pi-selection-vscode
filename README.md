# Pi Selection

A VS Code/VSCodium bridge for running Pi as anchored code-review threads without interrupting editing.

## Thread inbox

**Pi Threads** is the primary surface. It combines editor-owned selection threads and server-owned Agentation tasks into one feed:

- **Needs attention** — Pi finished or failed and the loop needs a human decision.
- **Working** — Pi is queued, running, or handling a follow-up.
- **Settled** — terminal work the user has explicitly closed.

Groups are ordered by urgency, then newest activity. The view badge counts threads needing attention and reports Agentation connection state. A thread can be revealed, replied to, settled, reopened, reviewed, or opened as a Pi session without changing execution ownership.

Threads can begin from three ingress points:

1. select code and press `Cmd+I` (`Ctrl+I` elsewhere);
2. click **New Thread** in the Pi Threads title bar, which uses the active editor selection;
3. submit an annotation through Agentation in the browser.

Editor-created comment threads start folded and do not reveal the sidebar or move focus. Clicking a feed row reveals its native anchored thread. Agentation tasks with multiple anchors ask which annotation to reveal; source-less tasks open their task feed.

## Ownership and lifecycle

Local selections are owned by the editor. Each starts a constrained Pi child session; native replies resume that exact session. Local settlement is persisted in bounded workspace state and restored with the matching feed row, comment thread, gutter status, and clickable inlay.

Agentation is optional external ingress. Its server owns task execution, conversation history, changed-file projections, settlement, and timestamps. Editor settlement calls the generation-, incarnation-, and revision-guarded server API; reconnect replay restores canonical state. Replying reopens settled work before the same server-owned Pi session continues. Older Agentation servers remain readable and replyable but cannot settle tasks.

One Agentation task is one logical feed thread; its annotations are source anchors into that shared task. Settling the task resolves all of its native annotation threads.

## Safe editor integration

Selection sessions replace Pi's filesystem mutation path with a VSCodium buffer bridge. Pi receives `read`, `grep`, `find`, `ls`, and `apply_patch`; `edit`, `write`, and `bash` are unavailable. `apply_patch` validates exact, unique, non-overlapping replacements against the current editor buffer, submits one `WorkspaceEdit`, and returns bounded post-edit context. Unrelated concurrent typing and VSCodium undo history are preserved.

Persisted local anchors verify the workspace path, canonical source realpath, surrounding-content fingerprint, and immutable Pi session identity before restoration. Stale records fail closed. Storage is capped at 100 threads and 2 MiB, prioritizing unsettled recent work. Source edits move anchors but do not make old work appear newly active in the feed.

Agentation changed files open through native diff editors backed by generation-bound virtual documents. **Reject This File** verifies the exact projected state before applying one undoable buffer edit and acknowledging the server. Task-created files require manual deletion because stable VS Code APIs cannot version-guard file deletion.

## Use

1. Install `pi-selection-0.7.0.vsix` with **Extensions: Install from VSIX…**.
2. Open a trusted folder where `pi` already works.
3. Create a thread from a code selection, the Pi Threads title bar, or Agentation.
4. Work the **Needs attention** group: reveal or reply, review changes when present, then settle completed work.
5. Reopen a settled thread whenever another follow-up is needed.

`Cmd+I` intentionally reuses the inline-chat slot. Set `piSelection.piPath` when `pi` is not available on the extension host's `PATH`. Agentation defaults to `http://127.0.0.1:4748` and is configured with `piSelection.agentationServerUrl`.

## Commands

- **Pi: Prompt About Selection**
- **Reveal Thread**
- **Reply to Thread**
- **Settle Thread**
- **Reopen Thread**
- **Review Changes**
- **Pi: Open Session**
- **Pi: Open Parent Session**
- **Pi: Abort Session**
- **Pi: Clear Settled Threads**
- **Pi Selection: Reject This File**
