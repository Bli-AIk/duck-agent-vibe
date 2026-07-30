import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
    };
  } catch {
    return { path: relative, exists: false, size: 0, lines: 0, hash: "" };
  }
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
): Promise<ChangeSummary> {
  const paths = new Set([...changedPaths].map((value) => relativePath(root, path.isAbsolute(value) ? value : path.join(root, value))));
  const gitPaths = includeGitChanges ? gitChangedPaths(root) : new Set<string>();
  for (const value of gitPaths) paths.add(value);

  const files: ChangeFile[] = [];
  for (const relative of paths) {
    if (!relative || relative.startsWith("..") || isGitIgnored(root, relative)) continue;
    const current = await captureSnapshot(root, relative);
    const previous = baseline.get(relative);
    const gitStats = includeGitChanges ? gitNumstat(root, relative) : undefined;
    const gitStatus = includeGitChanges ? gitPathStatus(root, relative) : undefined;
    const existsBefore = previous?.exists ?? (gitStatus !== "added");

    if (!current.exists) {
      files.push({ path: relative, status: "deleted", addedLines: 0, deletedLines: previous?.lines ?? 0, changedBytes: previous?.size ?? 0 });
      continue;
    }

    const status: ChangeFile["status"] = gitStatus ?? (!existsBefore ? "added" : "modified");
    const addedLines = gitStats?.added ?? (previous ? Math.max(0, current.lines - previous.lines) : current.lines);
    const deletedLines = gitStats?.deleted ?? (previous ? Math.max(0, previous.lines - current.lines) : 0);
    const changedBytes = previous ? Math.abs(current.size - previous.size) || (current.hash === previous.hash ? 0 : current.size) : current.size;
    files.push({ path: relative, status, addedLines, deletedLines, changedBytes });
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
