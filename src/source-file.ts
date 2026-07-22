import { fileURLToPath } from "node:url";
import * as path from "node:path";

export type ParsedSourceFile = {
  file: string;
  line: number;
  column: number;
};

export type SourcePathCandidate = {
  path: string;
  realPath: string;
};

export function parseSourceFile(value: string): ParsedSourceFile | undefined {
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const line = Number(match[2]);
  const column = match[3] ? Number(match[3]) : 1;
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
    return undefined;
  }

  let file = match[1];
  if (file.startsWith("file://")) {
    try {
      file = fileURLToPath(file);
    } catch {
      return undefined;
    }
  }
  return { file, line, column };
}

export function chooseSourcePath(
  requestedPath: string,
  cwd: string,
  candidates: readonly SourcePathCandidate[],
): string | undefined {
  const root = path.resolve(cwd);
  const requested = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(root, requestedPath);
  if (!isPathWithinRoot(root, requested)) return undefined;

  const safe = candidates.filter(
    (candidate) =>
      isPathWithinRoot(root, path.resolve(candidate.path)) &&
      isPathWithinRoot(root, path.resolve(candidate.realPath)),
  );
  const exact = unique(
    safe
      .filter((candidate) => path.resolve(candidate.path) === requested)
      .map((candidate) => candidate.realPath),
  );
  if (exact.length === 1) return exact[0];
  if (path.isAbsolute(requestedPath) || exact.length > 1) return undefined;

  const requestedRelative = normalizeRelative(path.relative(root, requested));
  const suffixMatches = unique(
    safe
      .filter((candidate) => {
        const relative = normalizeRelative(path.relative(root, path.resolve(candidate.path)));
        return relative === requestedRelative || relative.endsWith(`/${requestedRelative}`);
      })
      .map((candidate) => candidate.realPath),
  );
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

export function exactReviewPath(cwd: string, changePath: string): string | undefined {
  if (!changePath || path.isAbsolute(changePath)) return undefined;
  const candidate = path.resolve(cwd, changePath);
  return isPathWithinRoot(cwd, candidate) && candidate !== path.resolve(cwd) ? candidate : undefined;
}

export function isExactReviewPathContained(
  cwdReal: string,
  candidateReal: string,
  workspaceRootsReal: readonly string[],
): boolean {
  return (
    workspaceRootsReal.some((root) => isPathWithinRoot(root, cwdReal)) &&
    isPathWithinRoot(cwdReal, candidateReal)
  );
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
