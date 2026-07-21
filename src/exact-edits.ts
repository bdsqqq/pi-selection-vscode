export type ExactEdit = {
  oldText: string;
  newText: string;
};

export type PlannedEdit = ExactEdit & {
  start: number;
  end: number;
};

export type EditContext = {
  startLine: number;
  endLine: number;
  text: string;
};

export function planExactEdits(content: string, edits: readonly ExactEdit[]): PlannedEdit[] {
  if (edits.length === 0) throw new Error("At least one edit is required.");

  const planned = edits.map((edit) => {
    if (!edit.oldText) throw new Error("oldText must not be empty.");
    if (edit.oldText === edit.newText) throw new Error("oldText and newText must differ.");

    const start = content.indexOf(edit.oldText);
    if (start === -1) throw new Error("oldText was not found in the current editor buffer.");
    if (content.indexOf(edit.oldText, start + 1) !== -1) {
      throw new Error("oldText occurs more than once in the current editor buffer.");
    }
    return { ...edit, start, end: start + edit.oldText.length };
  });

  const ordered = [...planned].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new Error("Edits overlap in the current editor buffer.");
    }
  }
  return planned;
}

export function applyPlannedEdits(content: string, edits: readonly PlannedEdit[]): string {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) => `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`,
      content,
    );
}

export function createEditContexts(
  original: string,
  edits: readonly PlannedEdit[],
  surroundingLines = 2,
): EditContext[] {
  const result = applyPlannedEdits(original, edits);
  const lines = result.split("\n");
  let displacement = 0;

  return [...edits]
    .sort((left, right) => left.start - right.start)
    .map((edit) => {
      const finalStart = edit.start + displacement;
      const finalEnd = finalStart + edit.newText.length;
      displacement += edit.newText.length - edit.oldText.length;
      const changedStartLine = lineAtOffset(result, finalStart);
      const changedEndLine = lineAtOffset(result, finalEnd);
      const startLine = Math.max(1, changedStartLine - surroundingLines);
      const endLine = Math.min(lines.length, changedEndLine + surroundingLines);
      return {
        startLine,
        endLine,
        text: lines.slice(startLine - 1, endLine).join("\n"),
      };
    });
}

function lineAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, content.length); index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
