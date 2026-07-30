import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ChangeFile } from "./types.js";

function runGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

export function gitRoot(cwd: string): string | undefined {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result?.trim() || undefined;
}

export function gitChangedPaths(root: string): Set<string> {
  const paths = new Set<string>();
  const status = runGit(root, ["status", "--porcelain=v1", "-z"]);
  if (status) {
    for (const entry of status.split("\0")) {
      if (!entry) continue;
      const value = entry.slice(3);
      if (value.includes(" -> ")) {
        paths.add(value.split(" -> ").at(-1) ?? value);
      } else {
        paths.add(value);
      }
    }
  }

  const diff = runGit(root, ["diff", "--name-only", "HEAD", "--"]);
  if (diff) {
    for (const value of diff.split("\n")) {
      if (value.trim()) paths.add(value.trim());
    }
  }
  return paths;
}

export function gitPathStatus(root: string, relativePath: string): ChangeFile["status"] | undefined {
  const status = runGit(root, ["status", "--porcelain=v1", "--", relativePath]);
  const code = status?.slice(0, 2);
  if (!code) return undefined;
  if (code === "??" || code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  return "modified";
}

export interface GitNumstat {
  added: number;
  deleted: number;
}

export function gitNumstat(root: string, relativePath: string): GitNumstat | undefined {
  const output = runGit(root, ["diff", "--no-ext-diff", "--numstat", "HEAD", "--", relativePath]);
  const line = output?.trim().split("\n").at(-1);
  if (!line) return undefined;
  const [added, deleted] = line.split("\t");
  const parsedAdded = Number(added);
  const parsedDeleted = Number(deleted);
  if (!Number.isFinite(parsedAdded) || !Number.isFinite(parsedDeleted)) return undefined;
  return { added: parsedAdded, deleted: parsedDeleted };
}

export function isGitIgnored(root: string, relativePath: string): boolean {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", relativePath], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function relativePath(root: string, input: string): string {
  return path.relative(root, input).split(path.sep).join("/");
}
