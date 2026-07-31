import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { diffLines } from "diff";
import { isLockfilePath } from "./artifacts.js";
import path from "node:path";
import { gitChangedPaths, gitNumstat, gitPathStatus, isGitIgnored, relativePath } from "./git.js";
import type { ChangeFile, ChangeSummary, FileSnapshot } from "./types.js";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export async function captureSnapshot(root: string, relative: string): Promise<FileSnapshot> {
  const filePath = path.join(root, relative);
  try {
    const buffer = await readFile(filePath);
    const limited = buffer.byteLength > MAX_SNAPSHOT_BYTES ? buffer.subarray(0, MAX_SNAPSHOT_BYTES) : buffer;
    const text = limited.toString("utf8");
    return {
      path: relative,
      exists: true,
      size: buffer.byteLength,
      lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
      hash: createHash("sha1").update(buffer).digest("hex"),
      content: buffer.includes(0) ? undefined : text,
    };
  } catch {
    return { path: relative, exists: false, size: 0, lines: 0, hash: "" };
  }
}

interface LocalLineDiff {
  addedLines: number;
  deletedLines: number;
  lineRanges: string[];
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function formatRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

function localLineDiff(previous: FileSnapshot | undefined, current: FileSnapshot): LocalLineDiff {
  if (!current.exists) {
    return {
      addedLines: 0,
      deletedLines: previous?.lines ?? 0,
      lineRanges: previous && previous.lines > 0 ? [formatRange(1, previous.lines)] : [],
    };
  }

  if (!previous?.exists || previous.content === undefined || current.content === undefined) {
    return {
      addedLines: previous?.exists ? Math.max(0, current.lines - previous.lines) : current.lines,
      deletedLines: previous?.exists ? Math.max(0, previous.lines - current.lines) : 0,
      lineRanges: current.lines > 0 ? [formatRange(1, current.lines)] : [],
    };
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let currentLine = 1;
  let addedLines = 0;
  let deletedLines = 0;

  for (const change of diffLines(previous.content, current.content)) {
    const count = change.count ?? lineCount(change.value);
    if (change.added) {
      addedLines += count;
      if (count > 0) ranges.push({ start: currentLine, end: currentLine + count - 1 });
      currentLine += count;
    } else if (change.removed) {
      deletedLines += count;
      if (count > 0) ranges.push({ start: currentLine, end: currentLine });
    } else {
      currentLine += count;
    }
  }

  const merged = ranges.sort((left, right) => left.start - right.start).reduce<Array<{ start: number; end: number }>>((result, range) => {
    const previousRange = result.at(-1);
    if (previousRange && range.start <= previousRange.end + 1) {
      previousRange.end = Math.max(previousRange.end, range.end);
    } else {
      result.push({ ...range });
    }
    return result;
  }, []);

  return {
    addedLines,
    deletedLines,
    lineRanges: merged.map((range) => formatRange(range.start, range.end)),
  };
}

export async function updateSnapshotBaseline(root: string, paths: Iterable<string>, baseline: Map<string, FileSnapshot>): Promise<void> {
  await Promise.all([...paths].map(async (relative) => baseline.set(relative, await captureSnapshot(root, relative))));
}

export async function collectChangeSummary(
  root: string,
  changedPaths: Iterable<string>,
  baseline: ReadonlyMap<string, FileSnapshot>,
  forceSource: "git" | "snapshot" = "snapshot",
  includeGitChanges = true,
  excludedPaths: Iterable<string> = [],
): Promise<ChangeSummary> {
  const excluded = new Set([...excludedPaths]
    .map((value) => relativePath(root, path.isAbsolute(value) ? value : path.join(root, value)))
    .filter(Boolean));
  const paths = new Set([...changedPaths]
    .map((value) => relativePath(root, path.isAbsolute(value) ? value : path.join(root, value)))
    .filter((value) => !excluded.has(value)));
  const gitPaths = includeGitChanges ? gitChangedPaths(root) : new Set<string>();
  for (const value of gitPaths) {
    if (!excluded.has(value)) paths.add(value);
  }

  const files: ChangeFile[] = [];
  for (const relative of paths) {
    if (!relative || relative.startsWith("..") || isLockfilePath(relative) || isGitIgnored(root, relative)) continue;
    const current = await captureSnapshot(root, relative);
    const previous = baseline.get(relative);
    const gitStats = includeGitChanges ? gitNumstat(root, relative) : undefined;
    const gitStatus = includeGitChanges ? gitPathStatus(root, relative) : undefined;
    const localDiff = localLineDiff(previous, current);
    const existsBefore = previous?.exists ?? (gitStatus !== "added");

    if (!current.exists) {
      files.push({
        path: relative,
        status: "deleted",
        addedLines: 0,
        deletedLines: previous?.lines ?? 0,
        changedBytes: previous?.size ?? 0,
        lineRanges: localDiff.lineRanges,
      });
      continue;
    }

    // Manual handoffs may scan every watched path before chokidar reports an event.
    // Do not turn unchanged baseline files into false-positive modifications.
    if (!includeGitChanges && previous?.exists && previous.size === current.size && previous.hash === current.hash) continue;

    const status: ChangeFile["status"] = gitStatus ?? (!existsBefore ? "added" : "modified");
    const addedLines = gitStats?.added ?? localDiff.addedLines;
    const deletedLines = gitStats?.deleted ?? localDiff.deletedLines;
    const changedBytes = previous ? Math.abs(current.size - previous.size) || (current.hash === previous.hash ? 0 : current.size) : current.size;
    files.push({ path: relative, status, addedLines, deletedLines, changedBytes, lineRanges: localDiff.lineRanges });
  }

  const directories = new Set(files.map((file) => file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "."));
  const perDirectory = new Map<string, number>();
  for (const file of files) {
    const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
    perDirectory.set(directory, (perDirectory.get(directory) ?? 0) + 1);
  }
  const maxDirectoryFiles = Math.max(0, ...perDirectory.values());

  return {
    root,
    source: gitPaths.size > 0 ? "git" : forceSource,
    files,
    filesChanged: files.length,
    addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    deletedLines: files.reduce((sum, file) => sum + file.deletedLines, 0),
    changedBytes: files.reduce((sum, file) => sum + file.changedBytes, 0),
    createdFiles: files.filter((file) => file.status === "added").length,
    deletedFiles: files.filter((file) => file.status === "deleted").length,
    renamedFiles: files.filter((file) => file.status === "renamed").length,
    directoriesChanged: directories.size,
    concentration: files.length === 0 ? 0 : maxDirectoryFiles / files.length,
  };
}
