import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isLockfilePath } from "./artifacts.js";
import { relativePath } from "./git.js";
import { isSensitivePath, limitText } from "./redaction.js";

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function safePaths(root: string, paths: Iterable<string>): string[] {
  return [...new Set([...paths]
    .map((value) => relativePath(root, path.isAbsolute(value) ? value : path.join(root, value)))
    .filter((value) => value && !value.startsWith("..") && !isLockfilePath(value) && !isSensitivePath(value)))];
}

function gitDiff(root: string, paths: string[]): string {
  if (paths.length === 0) return "";
  return runGit(root, ["diff", "--no-ext-diff", "--unified=2", "HEAD", "--", ...paths]);
}

function gitUntracked(root: string, paths: string[]): Set<string> {
  const repository = runGit(root, ["rev-parse", "--show-toplevel"]).trim();
  if (!repository) return new Set(paths);
  const output = runGit(root, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
  return new Set(output.split("\n").map((value) => value.trim()).filter(Boolean));
}

async function formatUntrackedFile(root: string, relative: string): Promise<string> {
  try {
    const buffer = await readFile(path.join(root, relative));
    if (buffer.includes(0)) return `--- /dev/null\n+++ b/${relative}\n（二进制文件，未发送内容）`;
    const text = buffer.toString("utf8");
    const body = text.split(/\r?\n/).map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${relative} b/${relative}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relative}`,
      `@@ -0,0 +1,${text.length === 0 ? 0 : text.split(/\r?\n/).length} @@`,
      body,
    ].join("\n");
  } catch {
    return `--- /dev/null\n+++ b/${relative}\n（无法读取当前文件内容）`;
  }
}

/** Build a bounded, redacted diff for an explicit user request or guided handoff. */
export async function buildCurrentDiff(root: string, paths: Iterable<string>, maxChars: number): Promise<string> {
  if (maxChars <= 0) return "";
  const safe = safePaths(root, paths);
  if (safe.length === 0) return "";

  const sections: string[] = [];
  const trackedDiff = gitDiff(root, safe).trim();
  if (trackedDiff) sections.push(trackedDiff);

  const untracked = gitUntracked(root, safe);
  for (const relative of safe) {
    if (untracked.has(relative)) sections.push(await formatUntrackedFile(root, relative));
  }

  return limitText(sections.join("\n\n"), maxChars);
}
