# Pi Selection

A small VS Code/Cursor bridge for sending selected code to independent Pi sessions without interrupting editing.

## Architecture

The independent Agentation server owns annotation intake, task execution, and Pi session creation. This follows the project direction described in [the original browser/editor/canvas thread](https://x.com/bedesqui/status/2079612948931018821). The browser, editor, and canvas are projections of that server-owned work: they consume events and present task state without starting duplicate workers or introducing another webhook boundary.

On extension startup, the editor connects to `GET /projection-events` at `piSelection.agentationServerUrl` (default `http://127.0.0.1:4748`). Idempotent task snapshots replace local task state, including tasks without resolvable source locations. A projection reset removes prior projected tasks before replay without touching selection jobs; task-removal events dispose only their matching projection. Browser annotations with valid source locations become unresolved native comment threads, whole-line code review decorations, and clickable session inlays; every task also appears once in Pi Sessions. Threads show the browser annotation and server conversation in a GitHub-like review flow. After Pi finishes and a session is available, the native reply field submits follow-ups to that session. **Mark Reviewed** resolves the thread and removes its review decoration without mutating server state. Completed tasks with a `sessionFile` open through the same reused terminal-editor path as selection sessions.

When a task snapshot includes changed paths, **Review Changes** fetches generation-bound server projections and opens VS Code's native diff editor. Virtual content uses a 20 MiB, 40-document LRU cache and refetches evicted documents on demand; reset generations expire open diffs instead of reusing stale task identities. The diff editor's **Pi Selection: Reject This File** action prepares a server operation, verifies an existing workspace file still has the exact projected after state, applies one undoable `WorkspaceEdit` to restore it, verifies the result, and then acknowledges the operation. Concurrent local changes, paths outside the task cwd and open workspace, and stale generations fail without acknowledgement. VS Code has no stable version-guarded file deletion API, so task-created files are never deleted automatically: delete the file manually, then use **Mark Reviewed**. After acknowledgement, the extension invalidates both virtual documents and closes the diff; the next projection snapshot removes the change. A Pi Sessions task click opens that review directly for one changed file or asks which file to review; tasks without changes retain the session-opening behavior.

VS Code's stable Comments API, virtual-document providers, and `TextEditorDecorationType` are review projections, not editable inline suggestions or fake completions. A small status badge occupies the bottom-right of the gutter decoration so the native Comments glyph remains the interaction target where the renderer permits. Decoration icons are not clickable, and VS Code controls how much the two gutter visuals overlap.

The selected-code `Cmd+I` workflow remains independent. It starts its own constrained Pi child session and buffer bridge; projected Agentation tasks never use that path.

## Use

1. Install `pi-selection-0.4.1.vsix` with **Extensions: Install from VSIX…**.
2. Open a trusted folder where `pi` already works.
3. Select code and press `Cmd+I` (`Ctrl+I` elsewhere).
4. Enter an instruction. A clickable inlay tracks the selection and streams Pi's latest update; VSCodium's native renderer handles viewport clipping.
5. Click the inlay to view the live session feed; select a feed entry to open that session as a terminal editor. Reopening a session reveals its existing editor instead of creating another.

`Cmd+I` intentionally reuses the inline-chat slot; VSCodium's built-in AI features are disabled in this setup. Assign `piSelection.submit` another shortcut in **Preferences: Open Keyboard Shortcuts** if inline chat is enabled.

The extension creates one lightweight parent session per workspace window. Every submitted prompt becomes a named child session linked to that parent, so the sessions remain available through Pi's normal `/resume` interface.

Selection sessions replace Pi's filesystem `read`, `edit`, and `write` path with a VSCodium buffer bridge. Pi receives `read`, `grep`, `find`, `ls`, and `apply_patch`; `edit`, `write`, and `bash` are unavailable. `apply_patch` validates exact, unique, non-overlapping replacements against the current editor buffer, submits one `WorkspaceEdit`, and returns bounded post-edit context. This preserves unrelated concurrent typing and VSCodium's undo history without requiring a verification read.

## Commands

- **Pi: Prompt About Selection**
- **Pi: Open Session**
- **Pi: Open Parent Session**
- **Pi: Abort Session**
- **Pi: Clear Finished Sessions**
- **Reply** (Agentation native comment input)
- **Mark Reviewed** (Agentation comment-thread title)
- **Review Changes** (projected task or Agentation comment-thread title)
- **Pi Selection: Reject This File** (projected diff editor title)

Set `piSelection.piPath` when `pi` is not available on the extension host's `PATH`.
