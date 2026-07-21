# Pi Selection

A small VS Code/Cursor bridge for sending selected code to independent Pi sessions without interrupting editing.

## Architecture

The independent Agentation server owns annotation intake, task execution, and Pi session creation. This follows the project direction described in [the original browser/editor/canvas thread](https://x.com/bedesqui/status/2079612948931018821). The browser, editor, and canvas are projections of that server-owned work: they consume events and present task state without starting duplicate workers or introducing another webhook boundary.

On extension startup, the editor connects to `GET /projection-events` at `piSelection.agentationServerUrl` (default `http://127.0.0.1:4748`). Idempotent task snapshots replace local task state, including tasks without resolvable source locations. Browser annotations with valid source locations become unresolved native comment threads, whole-line code review decorations, and clickable session inlays; every task also appears once in Pi Sessions. **Mark Reviewed** resolves the thread and removes its review decoration without mutating server state. Completed tasks with a `sessionFile` open through the same reused terminal-editor path as selection sessions.

VS Code's stable Comments API and `TextEditorDecorationType` are review projections, not editable inline suggestions or fake completions. SCM QuickDiff or a native diff review is the next integration boundary if server-owned edits need patch-level inspection.

The selected-code `Cmd+K` workflow remains independent. It starts its own constrained Pi child session and buffer bridge; projected Agentation tasks never use that path.

## Use

1. Install `pi-selection-0.1.0.vsix` with **Extensions: Install from VSIX…**.
2. Open a trusted folder where `pi` already works.
3. Select code and press `Cmd+K` (`Ctrl+K` elsewhere).
4. Enter an instruction. A clickable inlay tracks the selection and streams Pi's latest update; VSCodium's native renderer handles viewport clipping.
5. Click the inlay to view the live session feed; select a feed entry to open that session as a terminal editor. Reopening a session reveals its existing editor instead of creating another.

Cursor owns `Cmd+K` by default. Disable Cursor's binding, or assign `piSelection.submit` another shortcut in **Preferences: Open Keyboard Shortcuts**.

The extension creates one lightweight parent session per workspace window. Every submitted prompt becomes a named child session linked to that parent, so the sessions remain available through Pi's normal `/resume` interface.

Selection sessions replace Pi's filesystem `read`, `edit`, and `write` path with a VSCodium buffer bridge. Pi receives `read`, `grep`, `find`, `ls`, and `apply_patch`; `edit`, `write`, and `bash` are unavailable. `apply_patch` validates exact, unique, non-overlapping replacements against the current editor buffer, submits one `WorkspaceEdit`, and returns bounded post-edit context. This preserves unrelated concurrent typing and VSCodium's undo history without requiring a verification read.

## Commands

- **Pi: Prompt About Selection**
- **Pi: Open Session**
- **Pi: Open Parent Session**
- **Pi: Abort Session**
- **Pi: Clear Finished Sessions**
- **Mark Reviewed** (Agentation comment-thread title)

Set `piSelection.piPath` when `pi` is not available on the extension host's `PATH`.
