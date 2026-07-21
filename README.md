# Pi Selection

A small VS Code/Cursor bridge for sending selected code to independent Pi sessions without interrupting editing.

## Direction

Browser-preview annotations should anchor themselves to the code they affect. Each annotation becomes a live Pi task in an in-editor feed; navigating the feed returns to the relevant code and session so every change can be reviewed in context.

## Use

1. Install `pi-selection-0.0.6.vsix` with **Extensions: Install from VSIX…**.
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

Set `piSelection.piPath` when `pi` is not available on the extension host's `PATH`.
