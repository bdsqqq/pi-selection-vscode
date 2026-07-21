export type ContentChange = {
  rangeOffset: number;
  rangeLength: number;
  text: string;
};

export function transformAnchor(offset: number, changes: readonly ContentChange[]): number {
  for (const change of [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset)) {
    const end = change.rangeOffset + change.rangeLength;
    if (change.rangeLength === 0 && change.rangeOffset === offset) {
      continue;
    }
    if (end <= offset) {
      offset += change.text.length - change.rangeLength;
    } else if (change.rangeOffset < offset) {
      offset = change.rangeOffset + change.text.length;
    }
  }
  return offset;
}
