export function latestUpdate(feed: readonly string[], fallback: string): string {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const lines = feed[index]
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (lines.length > 0) return lines.at(-1)!;
  }
  return fallback.replace(/\s+/g, " ").trim();
}

export function formatInlayText(glyph: string, update: string): string {
  return update ? `${glyph} ${update}` : glyph;
}
